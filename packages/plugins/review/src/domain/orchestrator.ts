/**
 * Orchestrator — runs every enabled agent against one PR, each in its own
 * process, and collects the results.
 *
 * Separate processes are the point. Two reviewers genuinely run in parallel, a
 * CLI that hangs waiting for input can be killed, and a provider that crashes
 * costs one review instead of the whole watcher.
 *
 * Workers are reached by re-invoking our own binary with a hidden subcommand.
 * The compiled binary has no source files on disk, so spawning
 * `bun workers/review-agent.ts` only works in development and would break the
 * shipped artefact.
 */

import type { AgentConfig } from "@lgtm/core/store/agents.js";
import type { ProviderId, ProviderStatus } from "@lgtm/core/ai/providers.js";
import type { RawFinding, Verdict } from "./providers.js";
import type { WorkerJob, WorkerResult } from "../workers/review-agent.js";
import { selfCommand, isChildProcess, childEnv } from "@lgtm/core/cli/self.js";

// ─── Types ──────────────────────────────────────────────────────────────────

export interface OrchestrateInput {
  agents: AgentConfig[];
  diff: string;
  prUrl?: string;
  repoPath?: string;
  priorFindings?: Array<{ file: string; line: number; severity?: string; comment: string }>;
  ruleContext?: string;
}

export interface AgentRun {
  agent: string;
  provider: ProviderId | null;
  findings: RawFinding[];
  verdicts: Verdict[];
  durationMs: number;
  dropped: number;
  /** Raw provider output, only kept when it could not be parsed. */
  raw: string;
  error: string | null;
}

export interface OrchestrateResult {
  runs: AgentRun[];
  /** Findings from every agent, deduplicated. */
  findings: RawFinding[];
  durationMs: number;
  /** True when no agent produced anything and at least one errored. */
  failed: boolean;
}

export interface Logger {
  info: (msg: string) => void;
  warn: (msg: string) => void;
  error: (msg: string) => void;
}

const noopLogger: Logger = { info: () => {}, warn: () => {}, error: () => {} };

// ─── Self-invocation ────────────────────────────────────────────────────────

/** The argv that reaches the worker entry point in this same program. */
export function workerCommand(): string[] {
  return selfCommand(["review", "internal-worker"]);
}

// ─── Running one worker ─────────────────────────────────────────────────────

/**
 * Spawn one worker and wait for its result.
 *
 * The timeout is enforced here rather than inside the worker: a provider that
 * ignores its own timeout, or a CLI blocked on a TTY prompt, would otherwise
 * hang the cycle forever. `agent.timeout` is the provider's budget, so the
 * process gets a small grace period on top to finish writing its result.
 */
async function runWorkerProcess(job: WorkerJob, log: Logger): Promise<WorkerResult> {
  const startedAt = Date.now();
  const graceSeconds = 15;
  const budgetMs = (job.agent.timeout + graceSeconds) * 1000;

  const failed = (error: string): WorkerResult => ({
    agent: job.agent.name,
    provider: job.provider ?? null,
    findings: [],
    verdicts: [],
    stats: { durationMs: Date.now() - startedAt, dropped: 0, rawLength: 0 },
    raw: "",
    error,
  });

  // A worker must never spawn workers. If the command ever resolves to
  // something that re-enters the orchestrator, this turns a fork bomb into one
  // failed review.
  if (isChildProcess()) {
    return failed("refusing to spawn a worker from inside a worker");
  }

  let stdout = "";
  let stderr = "";
  let timedOut = false;

  try {
    const proc = Bun.spawn({
      cmd: workerCommand(),
      stdin: new TextEncoder().encode(JSON.stringify(job)),
      stdout: "pipe",
      stderr: "pipe",
      env: childEnv(),
    });

    // The timeout races the read rather than gating it. A killed process does
    // not necessarily close its stdout pipe, because the CLI it spawned inherits
    // that pipe and may outlive it, so reading to completion after a kill can
    // block forever. See the same reasoning in providers.ts run().
    const drain = async (stream: ReadableStream<Uint8Array>, onChunk: (s: string) => void) => {
      const decoder = new TextDecoder();
      for await (const chunk of stream) onChunk(decoder.decode(chunk, { stream: true }));
    };

    const reading = Promise.all([
      drain(proc.stdout as ReadableStream<Uint8Array>, (s) => { stdout += s; }),
      drain(proc.stderr as ReadableStream<Uint8Array>, (s) => { stderr += s; }),
      proc.exited,
    ]);
    reading.catch(() => {});

    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), budgetMs);
    });

    try {
      const outcome = await Promise.race([reading.then(() => "done" as const), deadline]);
      if (outcome === "timeout") {
        timedOut = true;
        proc.kill("SIGKILL");
      }
    } finally {
      clearTimeout(timer);
    }
  } catch (err) {
    return failed(`could not run worker: ${(err as Error).message}`);
  }

  if (timedOut) {
    return failed(`timed out after ${job.agent.timeout + graceSeconds}s`);
  }

  try {
    const parsed = JSON.parse(stdout.trim()) as WorkerResult;
    // Guard against a worker that wrote something JSON-shaped but wrong.
    if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.findings)) {
      return failed("worker returned a malformed result");
    }
    return parsed;
  } catch {
    // stderr is the only clue when the worker died before writing anything.
    const detail = stderr.trim().split("\n").slice(-3).join(" ").slice(0, 300);
    log.warn(`${job.agent.name}: worker produced no parseable result${detail ? ` (${detail})` : ""}`);
    return failed(detail ? `worker crashed: ${detail}` : "worker produced no output");
  }
}

// ─── Deduplication ──────────────────────────────────────────────────────────

/**
 * Collapse findings that two agents raised about the same place.
 *
 * Keyed on file, line and a normalised prefix of the comment. Two agents
 * wording the same bug differently will still produce two comments, which is
 * the safer failure: a duplicate is noise, a dropped real finding is a bug
 * shipped. The higher severity and its comment win when they do collide.
 */
export function dedupeFindings(findings: RawFinding[]): RawFinding[] {
  const order = { low: 0, medium: 1, high: 2, critical: 3 } as const;
  const byKey = new Map<string, RawFinding>();

  for (const finding of findings) {
    const fingerprint = finding.comment.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().slice(0, 60);
    const key = `${finding.file}:${finding.line}:${fingerprint}`;

    const existing = byKey.get(key);
    if (!existing || order[finding.severity] > order[existing.severity]) {
      byKey.set(key, finding);
    }
  }

  return [...byKey.values()];
}

// ─── Orchestration ──────────────────────────────────────────────────────────

/**
 * Assign a provider to each agent before spawning.
 *
 * Detection runs once here instead of once per worker. Five `which` calls and
 * an Ollama ping per agent is wasted work, and worse, two agents both set to
 * `auto` would independently resolve to the same provider and produce two
 * identical reviews. When several agents are on `auto` and several providers are
 * available, they are spread across them so a second agent adds a second
 * opinion rather than a duplicate.
 */
export function assignProviders(
  agents: AgentConfig[],
  statuses: ProviderStatus[]
): Array<{ agent: AgentConfig; provider: ProviderId | null; error: string | null }> {
  const available = statuses.filter((s) => s.available).map((s) => s.id);
  const pinned = new Set(
    agents.filter((a) => a.provider !== "auto").map((a) => a.provider as ProviderId)
  );

  // Prefer providers no agent pinned, so an `auto` agent does not duplicate a
  // pinned one while another backend sits idle.
  const preferred = available.filter((id) => !pinned.has(id));
  const rotation = [...preferred, ...available.filter((id) => pinned.has(id))];

  let next = 0;

  return agents.map((agent) => {
    if (agent.provider !== "auto") {
      const status = statuses.find((s) => s.id === agent.provider);
      if (!status) return { agent, provider: null, error: `unknown provider "${agent.provider}"` };
      if (!status.available) {
        return { agent, provider: null, error: `${agent.provider} is not available: ${status.detail}` };
      }
      return { agent, provider: agent.provider as ProviderId, error: null };
    }

    if (rotation.length === 0) {
      const summary = statuses.map((s) => `${s.id}: ${s.detail}`).join("; ");
      return { agent, provider: null, error: `no review provider available. ${summary}` };
    }

    const provider = rotation[next % rotation.length];
    next++;
    return { agent, provider, error: null };
  });
}

/**
 * Review one PR with every given agent, in parallel, one process each.
 */
export async function orchestrate(
  input: OrchestrateInput,
  log: Logger = noopLogger
): Promise<OrchestrateResult> {
  const startedAt = Date.now();

  if (input.agents.length === 0) {
    return { runs: [], findings: [], durationMs: 0, failed: true };
  }

  const { detectProviders } = await import("@lgtm/core/ai/providers.js");
  const assignments = assignProviders(input.agents, await detectProviders());

  const runs = await Promise.all(
    assignments.map(async ({ agent, provider, error }): Promise<AgentRun> => {
      if (error || !provider) {
        log.error(`${agent.name}: ${error}`);
        return {
          agent: agent.name,
          provider: null,
          findings: [],
          verdicts: [],
          durationMs: 0,
          dropped: 0,
          raw: "",
          error: error ?? "no provider",
        };
      }

      log.info(`${agent.name} → ${provider}`);

      const result = await runWorkerProcess(
        {
          mode: "review",
          agent,
          provider,
          diff: input.diff,
          prUrl: input.prUrl,
          repoPath: input.repoPath,
          priorFindings: input.priorFindings,
          ruleContext: input.ruleContext,
        },
        log
      );

      if (result.error) log.warn(`${agent.name}: ${result.error}`);

      return {
        agent: result.agent,
        provider: result.provider,
        findings: result.findings,
        verdicts: [],
        durationMs: result.stats.durationMs,
        dropped: result.stats.dropped,
        // Only worth storing when we could not read it.
        raw: result.error ? result.raw : "",
        error: result.error,
      };
    })
  );

  const findings = dedupeFindings(runs.flatMap((r) => r.findings));

  return {
    runs,
    findings,
    durationMs: Date.now() - startedAt,
    // Findings from any agent means the round is usable, even if another failed.
    failed: findings.length === 0 && runs.every((r) => r.error !== null),
  };
}

/**
 * Ask one agent whether earlier findings have been addressed.
 *
 * Only one agent runs. Verification is a yes-or-no question about specific
 * lines, so a second opinion costs a provider call without adding much.
 */
export async function orchestrateVerify(
  agent: AgentConfig,
  prior: Array<{ file: string; line: number; severity?: string; comment: string }>,
  input: Omit<OrchestrateInput, "agents" | "priorFindings">,
  log: Logger = noopLogger
): Promise<{ verdicts: Verdict[]; error: string | null }> {
  if (prior.length === 0) return { verdicts: [], error: null };

  const { detectProviders } = await import("@lgtm/core/ai/providers.js");
  const [assignment] = assignProviders([agent], await detectProviders());

  if (assignment.error || !assignment.provider) {
    return { verdicts: [], error: assignment.error ?? "no provider" };
  }

  const result = await runWorkerProcess(
    {
      mode: "verify",
      agent,
      provider: assignment.provider,
      diff: input.diff,
      prUrl: input.prUrl,
      repoPath: input.repoPath,
      priorFindings: prior,
    },
    log
  );

  return { verdicts: result.verdicts, error: result.error };
}

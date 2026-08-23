/**
 * Review worker — one review, one process.
 *
 * Reads a single JSON job on stdin, runs one provider, writes a single JSON
 * result on stdout. Nothing else may be written to stdout, or the orchestrator
 * cannot parse the result; diagnostics go to stderr.
 *
 * A separate process per agent buys three things a in-process loop would not:
 * two reviewers genuinely run in parallel, a CLI that hangs is killable, and a
 * provider that crashes takes down one review instead of the whole watcher.
 *
 * The worker is reached by re-invoking our own binary with a hidden subcommand,
 * because the compiled binary has no source files on disk to spawn.
 */

import type { AgentConfig } from "@lgtm/core/store/agents.js";
import type { ProviderId } from "@lgtm/core/ai/providers.js";
import type { RawFinding, Verdict } from "../domain/providers.js";

// ─── Protocol ───────────────────────────────────────────────────────────────

export interface WorkerJob {
  /** "review" asks for new findings, "verify" checks earlier ones. */
  mode: "review" | "verify";

  agent: AgentConfig;

  diff: string;

  /** Lets a CLI with a built-in review command fetch the PR itself. */
  prUrl?: string;

  /** Working directory for the CLI, so it can read the repo. */
  repoPath?: string;

  /**
   * In review mode: findings already raised, so the agent does not repeat them.
   * In verify mode: the findings to return verdicts on.
   */
  priorFindings?: Array<{ file: string; line: number; severity?: string; comment: string }>;

  /** Extra instructions from LLM-enforced rules. */
  ruleContext?: string;

  /** Pin the provider, skipping detection. Used to keep two agents distinct. */
  provider?: ProviderId;
}

export interface WorkerResult {
  agent: string;
  provider: ProviderId | null;

  /** Populated in review mode. */
  findings: RawFinding[];

  /** Populated in verify mode. */
  verdicts: Verdict[];

  stats: {
    durationMs: number;
    dropped: number;
    rawLength: number;
    /** Providers passed over before the one that ran. */
    fallbackFrom?: ProviderId[];
  };

  /** Raw provider output, kept so unparseable results can be debugged. */
  raw: string;

  error: string | null;
}

// ─── Execution ──────────────────────────────────────────────────────────────

/**
 * Run one job. Never throws: every failure becomes a result with `error` set,
 * so the orchestrator always gets parseable output.
 */
export async function runJob(job: WorkerJob): Promise<WorkerResult> {
  const startedAt = Date.now();

  const fail = (error: string, provider: ProviderId | null = null): WorkerResult => ({
    agent: job.agent?.name ?? "unknown",
    provider,
    findings: [],
    verdicts: [],
    stats: { durationMs: Date.now() - startedAt, dropped: 0, rawLength: 0 },
    raw: "",
    error,
  });

  if (!job.agent) return fail("job has no agent config");

  const { detectProviders, resolveProvider, invokeProvider, verifyWithProvider } = await import(
    "../domain/providers.js"
  );

  // A pinned provider skips detection. That is how the orchestrator keeps two
  // agents on different backends without racing each other's detection.
  let providerId: ProviderId;
  let skipped: ProviderId[] = [];

  if (job.provider) {
    providerId = job.provider;
  } else {
    const resolved = resolveProvider(job.agent.provider, await detectProviders());
    if ("error" in resolved) return fail(resolved.error);
    providerId = resolved.id;
    skipped = resolved.skipped;
  }

  const input = {
    agent: job.agent,
    diff: job.diff ?? "",
    prUrl: job.prUrl,
    repoPath: job.repoPath,
    priorFindings: job.priorFindings,
    ruleContext: job.ruleContext,
  };

  if (job.mode === "verify") {
    const prior = job.priorFindings ?? [];
    if (prior.length === 0) {
      return { ...fail("verify mode with no prior findings", providerId), error: null };
    }

    const result = await verifyWithProvider(providerId, input, prior);

    return {
      agent: job.agent.name,
      provider: providerId,
      findings: [],
      verdicts: result.verdicts,
      stats: {
        durationMs: Date.now() - startedAt,
        dropped: 0,
        rawLength: result.raw.length,
        ...(skipped.length > 0 ? { fallbackFrom: skipped } : {}),
      },
      raw: result.raw,
      error: result.error,
    };
  }

  const result = await invokeProvider(providerId, input);

  return {
    agent: job.agent.name,
    provider: providerId,
    findings: result.findings,
    verdicts: [],
    stats: {
      ...result.stats,
      ...(skipped.length > 0 ? { fallbackFrom: skipped } : {}),
    },
    raw: result.raw,
    error: result.error,
  };
}

// ─── stdin / stdout ─────────────────────────────────────────────────────────

/**
 * Worker entry point. Reads one job from stdin, writes one result to stdout.
 *
 * Exit code is 0 for a usable result and 1 when the job could not run at all,
 * but the orchestrator reads the JSON either way rather than trusting the code.
 */
export async function runWorker(): Promise<number> {
  let raw = "";
  try {
    raw = await new Response(Bun.stdin.stream()).text();
  } catch (err) {
    emit(errorResult(`could not read stdin: ${(err as Error).message}`));
    return 1;
  }

  let job: WorkerJob;
  try {
    job = JSON.parse(raw) as WorkerJob;
  } catch {
    emit(errorResult(`stdin was not valid JSON (${raw.length} bytes)`));
    return 1;
  }

  const result = await runJob(job);
  emit(result);
  return result.error ? 1 : 0;
}

function errorResult(error: string): WorkerResult {
  return {
    agent: "unknown",
    provider: null,
    findings: [],
    verdicts: [],
    stats: { durationMs: 0, dropped: 0, rawLength: 0 },
    raw: "",
    error,
  };
}

/** stdout carries the result and nothing else. */
function emit(result: WorkerResult): void {
  process.stdout.write(JSON.stringify(result));
}

/**
 * The Claude CLI Provider: assemble the prompt, spawn the binary in print
 * mode, and hand whatever it printed to the parser.
 *
 * Shelling out to the CLI is the whole point. Its bundled review command
 * already runs a multi-agent pass with false-positive filtering, and
 * subscription auth lives inside the binary. Anthropic forbids third-party
 * use of the OAuth tokens it stores, so spawning the tool the user already
 * pays for is the only honest way to reach it (docs/adr/0002).
 *
 * The M0 spike (docs/spec/spike-provider.md) settled the two things this file
 * rests on. The CLI fetches a PR from its URL alone, with no local checkout
 * anywhere above the working directory. And it inherits the session's default
 * model unless told otherwise, which cost twice as much for the same review,
 * so --model is never omitted here.
 *
 * The working directory still matters for a different reason. Print-mode
 * sessions persist under ~/.claude/projects/<cwd-slug>/, keyed by where the
 * CLI ran, and `claude --resume <session-id>` only finds one from the same
 * place. So the daemon hands every Round one directory it owns, and the
 * outcome reports both the id and the directory back.
 */

import { formatFindingKey } from "@/core";
import { extractFindings, extractSessionMeta, validateFindings, type SessionMeta } from "./parse";
import type { AgentConfig, Provider, PriorFinding, ReviewInput, ReviewOutcome } from "./index";

/**
 * The model a Round runs on when the Agent file does not pin one.
 *
 * Sonnet, not the session default. The spike's two runs over the same PR
 * produced comparable findings for $0.77 pinned against $1.55 inherited, and
 * a daemon reviewing every PR pays that difference on every PR. Users who
 * want a bigger model set `model` in `agents/reviewer.md` deliberately.
 */
export const DEFAULT_MODEL = "sonnet";

/**
 * Appended to every prompt, per design.md's prompt assembly.
 *
 * With this block the spike's CLI answered in the exact schema inside a
 * fenced JSON block. The two lines after the shape are not decoration. An
 * explicit empty result is what keeps a clean PR from arriving as prose that
 * fails to parse and becomes a failed Round.
 */
const JSON_CONTRACT = [
  'Respond with JSON only: {"findings":[{"file","line","severity","comment","suggestion"}]}',
  "severity is one of low, medium, high, critical. line must be a line the PR's diff touches.",
  'Return {"findings": []} when there is nothing to report.',
].join("\n");

// ─── Prompt assembly ────────────────────────────────────────────────────────

/**
 * Prior Findings replayed as context, keyed so a repeat can be traced back to
 * the Round that raised it. "Verify silently" because v1 has no verification
 * pass, so the Agent should check its old calls without writing verdicts
 * nobody reads (requirements R3.6).
 */
function priorFindingsBlock(prior: PriorFinding[]): string {
  const lines = prior.map(
    (f) => `- ${f.file}:${f.line} [${f.severity}] ${f.comment}   (${formatFindingKey(f.key)})`
  );

  return ["Already raised in earlier reviews. Verify silently; do not repeat:", ...lines].join("\n");
}

/** The full print-mode prompt for one Round. */
export function buildPrompt(input: ReviewInput): string {
  const parts = [`/review ${input.prUrl}`];

  const instructions = input.agent.prompt.trim();
  if (instructions) parts.push(`Additional instructions:\n${instructions}`);

  const prior = input.priorFindings ?? [];
  if (prior.length > 0) parts.push(priorFindingsBlock(prior));

  parts.push(JSON_CONTRACT);

  return parts.join("\n\n");
}

/**
 * The argv for one Round.
 *
 * --model is always present. An Agent file with the field blank still gets a
 * pinned model rather than the session default, because the failure mode of
 * omitting it is invisible: correct findings at several times the cost.
 */
export function claudeArgs(agent: AgentConfig, prompt: string, binPath = "claude"): string[] {
  const model = agent.model.trim() || DEFAULT_MODEL;
  return [binPath, "-p", prompt, "--output-format", "json", "--model", model];
}

// ─── Spawning ───────────────────────────────────────────────────────────────

export interface SpawnOutcome {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
}

/**
 * Run a command with a hard timeout.
 *
 * The timeout races the output read rather than gating it. Killing the child
 * is not enough to unblock the read: the CLI spawns subprocesses of its own,
 * those inherit the stdout pipe, and the pipe stays open while any of them
 * lives. Reading to completion after a kill can therefore block forever,
 * which would eat one of the daemon's two concurrency slots silently and
 * permanently. Whatever output arrived before the deadline is returned; a
 * grandchild may outlive us, but it can no longer hold the queue hostage.
 *
 * stdin is closed rather than inherited. The spike's runs warned "no stdin
 * data received in 3s" until it was, and a daemon has no terminal to offer.
 */
export async function run(
  cmd: string[],
  opts: { cwd?: string; env?: Record<string, string>; timeoutSeconds: number }
): Promise<SpawnOutcome> {
  const proc = Bun.spawn({
    cmd,
    cwd: opts.cwd,
    env: opts.env ? { ...process.env, ...opts.env } : process.env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });

  // Buffer incrementally so a timeout still yields whatever was written.
  let stdout = "";
  let stderr = "";

  const drain = async (stream: ReadableStream<Uint8Array>, onChunk: (s: string) => void) => {
    const decoder = new TextDecoder();
    for await (const chunk of stream) {
      onChunk(decoder.decode(chunk, { stream: true }));
    }
  };

  const reading = Promise.all([
    drain(proc.stdout as ReadableStream<Uint8Array>, (s) => {
      stdout += s;
    }),
    drain(proc.stderr as ReadableStream<Uint8Array>, (s) => {
      stderr += s;
    }),
    proc.exited,
  ]);

  // Swallow late failures. Once we time out nobody is awaiting this, and an
  // unhandled rejection would take the daemon down.
  reading.catch(() => {});

  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), opts.timeoutSeconds * 1000);
  });

  try {
    const outcome = await Promise.race([reading.then(() => "done" as const), deadline]);

    if (outcome === "timeout") {
      proc.kill("SIGKILL");
      return { stdout, stderr, exitCode: null, timedOut: true };
    }

    return { stdout, stderr, exitCode: proc.exitCode, timedOut: false };
  } finally {
    clearTimeout(timer);
  }
}

/** Turn a spawn outcome into output or an error string. */
function fromSpawn(outcome: SpawnOutcome, timeoutMinutes: number): { output: string; error: string | null } {
  if (outcome.timedOut) {
    return { output: outcome.stdout, error: `claude timed out after ${timeoutMinutes}m` };
  }

  // A non-zero exit with usable stdout still gets parsed. The CLI can exit
  // non-zero having found problems, which is exactly the case we want.
  if (outcome.exitCode !== 0 && !outcome.stdout.trim()) {
    const detail =
      outcome.stderr.trim().split("\n").slice(0, 3).join(" ") || `exit ${outcome.exitCode}`;
    return { output: "", error: `claude failed: ${detail}` };
  }

  return { output: outcome.stdout, error: null };
}

// ─── The Provider ───────────────────────────────────────────────────────────

async function review(input: ReviewInput): Promise<ReviewOutcome> {
  const startedAt = Date.now();

  // Filled in from the envelope once the CLI has printed one. Until then the
  // Round genuinely has no session, and every outcome below says so honestly
  // rather than leaving the fields off.
  let session: SessionMeta = { sessionId: null, costUsd: null, turns: null };

  const outcome = (
    findings: ReviewOutcome["findings"],
    raw: string,
    error: string | null,
    dropped = 0
  ): ReviewOutcome => ({
    provider: "claude-cli",
    status: error === null ? "ok" : "failed",
    findings,
    raw,
    error,
    durationMs: Date.now() - startedAt,
    dropped,
    sessionId: session.sessionId,
    costUsd: session.costUsd,
    turns: session.turns,
    // Echoed back rather than assumed by the caller: this is where the CLI
    // actually ran, and therefore the only directory a resume will find the
    // session under.
    sessionCwd: input.sessionCwd ?? null,
  });

  try {
    const prompt = buildPrompt(input);
    const timeoutMinutes = input.agent.timeoutMinutes;

    const spawned = await run(claudeArgs(input.agent, prompt, input.binPath), {
      timeoutSeconds: timeoutMinutes * 60,
      cwd: input.sessionCwd,
    });

    // Read before the failure branches below. A Round that timed out or whose
    // output would not parse is exactly the one worth resuming by hand, so the
    // session id is salvaged from whatever arrived, not only from a clean run.
    session = extractSessionMeta(spawned.stdout);

    // Partial output after a timeout is kept as raw, so the failed Round has
    // something to dump next to it. It is not parsed: a truncated answer that
    // happened to parse would be recorded as a complete review.
    const { output, error } = fromSpawn(spawned, timeoutMinutes);
    if (error) return outcome([], output, error);

    const extracted = extractFindings(output);
    if (extracted === null) return outcome([], output, "could not parse provider output");

    const { findings, dropped } = validateFindings(extracted, input.agent.severityFloor);
    return outcome(findings, output, null, dropped);
  } catch (err) {
    // A missing binary lands here as ENOENT. The daemon re-probes its paths
    // on this and retries the PR on the next cycle.
    return outcome([], "", (err as Error).message);
  }
}

export const claudeProvider: Provider = {
  id: "claude-cli",
  review,
};

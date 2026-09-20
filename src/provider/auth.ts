/**
 * Is the Provider logged in? Asked before a Round rather than discovered
 * after one.
 *
 * This file exists because of a failure that cost eight Rounds across four
 * PRs. The CLI's OAuth session expired, the daemon kept dispatching into it,
 * and every Round came back looking like a Round: exit 0, `is_error: false`,
 * `subtype: "success"`, and the sentence "Failed to authenticate: OAuth
 * session expired and could not be refreshed" sitting where the review should
 * have been. The parser found no findings in that sentence and each Round was
 * filed as "could not parse provider output", which is the one diagnosis that
 * invites a retry. Nothing short of opening a `.raw.txt` by hand said
 * otherwise.
 *
 * The probe is cheap enough to be unremarkable. Measured on CLI 2.1.260,
 * `claude auth status --json` prints
 *
 *   {"loggedIn": false, "authMethod": "none", "apiProvider": "firstParty"}
 *
 * in 0.19 seconds, costs no tokens, and exits 0 either way. `loggedIn` is the
 * field that decides it; the exit code decides nothing, which is exactly the
 * trap the review path fell into.
 *
 * Three states, not a boolean. A probe that could not run (no binary, a
 * timeout, output that will not parse) answers `unknown`, and `unknown` is
 * never `authenticated`: guessing yes on no evidence rebuilds the failure
 * this module was written to stop, and guessing no would strand a working
 * daemon on a CLI whose output moved.
 */

import { run, type SpawnOutcome } from "./claude";

/**
 * The probe's own deadline, separate from the Round's ten minutes. A probe
 * measured in fractions of a second has no business holding a cycle, and this
 * ceiling exists so a wedged CLI cannot make it one.
 */
export const AUTH_TIMEOUT_SECONDS = 10;

/** The documented subcommand. `--json` is its default output; say it anyway. */
export const AUTH_STATUS_ARGS = ["auth", "status", "--json"];

export type ProviderAuthState = "authenticated" | "unauthenticated" | "unknown";

export interface ProviderAuthResult {
  state: ProviderAuthState;

  /**
   * What the CLI called its login, e.g. "claude.ai". Null when it reported
   * none, which includes the literal "none" it prints while logged out.
   */
  method: string | null;

  /** Why the probe could not answer. Null unless `state` is "unknown". */
  error: string | null;
}

/** Injectable pieces, for tests that want neither a process nor a wait. */
export interface CheckAuthOptions {
  timeoutSeconds?: number;
  /** Defaults to the provider's own spawn helper. */
  spawn?: (cmd: string[], opts: { timeoutSeconds: number }) => Promise<SpawnOutcome>;
}

/**
 * True only when the probe saw a logged-in CLI.
 *
 * A function rather than a field, so no caller can write `if (auth.ok)` and
 * quietly let `unknown` through as a yes.
 */
export function isAuthenticated(result: ProviderAuthResult): boolean {
  return result.state === "authenticated";
}

/**
 * Ask the CLI whether it is logged in.
 *
 * Never throws and never blocks past its deadline. Spawning goes through
 * `run` in claude.ts, which already closes stdin and kills on the deadline
 * without waiting for a grandchild to release the pipe. A second spawn helper
 * here would be a second place for that lesson to be forgotten.
 */
export async function checkProviderAuth(
  binPath: string | null,
  options: CheckAuthOptions = {}
): Promise<ProviderAuthResult> {
  if (!binPath || !binPath.trim()) return unknown("claude binary not resolved");

  const spawn = options.spawn ?? run;
  const timeoutSeconds = options.timeoutSeconds ?? AUTH_TIMEOUT_SECONDS;

  let spawned: SpawnOutcome;
  try {
    spawned = await spawn([binPath, ...AUTH_STATUS_ARGS], { timeoutSeconds });
  } catch (error) {
    // A missing binary lands here as ENOENT.
    return unknown((error as Error).message);
  }

  if (spawned.timedOut) {
    return unknown(`claude auth status timed out after ${timeoutSeconds}s`);
  }

  // Read the output before judging the exit code. Logged out is exit 0, so a
  // non-zero exit says the probe failed, not that the user is logged out, and
  // a CLI that answers and then exits non-zero has still answered.
  const answer = readAuthStatus(spawned.stdout);
  if (answer) return answer;

  if (spawned.exitCode !== 0) {
    const detail = spawned.stderr.trim().split("\n").slice(0, 3).join(" ") || `exit ${spawned.exitCode}`;
    return unknown(`claude auth status failed: ${detail}`);
  }

  return unknown("claude auth status reported no loggedIn field");
}

function unknown(error: string): ProviderAuthResult {
  return { state: "unknown", method: null, error };
}

/**
 * The answer in the probe's stdout, or null when there is none to read.
 *
 * Null covers every shape that is not a verdict: empty output, prose, JSON
 * without the field, or a `loggedIn` that is not a boolean. All of those are
 * the caller's `unknown`, and none of them may collapse into a false.
 */
function readAuthStatus(stdout: string): ProviderAuthResult | null {
  const data = parseObject(stdout);
  if (!data) return null;

  const loggedIn = data.loggedIn ?? data.logged_in;
  if (typeof loggedIn !== "boolean") return null;

  return {
    state: loggedIn ? "authenticated" : "unauthenticated",
    method: readMethod(data),
    error: null,
  };
}

/** "none" is the CLI's way of saying there is no method, so it reads as null. */
function readMethod(data: Record<string, unknown>): string | null {
  const raw = data.authMethod ?? data.auth_method;
  if (typeof raw !== "string") return null;

  const method = raw.trim();
  if (!method || method.toLowerCase() === "none") return null;
  return method;
}

/**
 * The JSON object the probe printed.
 *
 * The slice between the outer braces is what survives a CLI that prints a
 * deprecation warning above its JSON. Without it such a line would turn a
 * perfectly readable "logged out" into an `unknown`.
 */
function parseObject(text: string): Record<string, unknown> | null {
  const trimmed = text.trim();
  if (!trimmed) return null;

  const direct = asObject(trimmed);
  if (direct) return direct;

  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start >= 0 && end > start) return asObject(trimmed.slice(start, end + 1));

  return null;
}

function asObject(text: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

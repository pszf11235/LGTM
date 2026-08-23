/**
 * Re-invoking ourselves as a subprocess.
 *
 * The review orchestrator runs each agent in its own process, and the only
 * reliable way to reach that code is to run this same program again with a
 * different subcommand. A compiled binary has no source files on disk, so
 * spawning `bun some/worker.ts` works in development and breaks the artefact we
 * actually ship.
 */

import { fileURLToPath } from "node:url";

/**
 * Set on a subprocess's environment. Its presence means "you are already inside
 * a spawned child", which is the guard against recursive spawning.
 */
export const CHILD_ENV_FLAG = "LGTM_CHILD_PROCESS";

/** True when running as a compiled binary rather than source under `bun`. */
export function isCompiledBinary(): boolean {
  // A compiled Bun executable reports its embedded entry under a virtual path.
  const entry = process.argv[1] ?? "";
  return (
    entry.includes("$bunfs") ||
    entry.includes("~BUN") ||
    import.meta.path.includes("$bunfs") ||
    import.meta.url.includes("$bunfs")
  );
}

/**
 * Absolute path to the LGTM entry point, for spawning from source.
 *
 * Resolved from this module's own location, not from `process.argv[1]`. argv[1]
 * means "whatever file started this process", so calling the orchestrator from a
 * test or a scratch script re-spawned *that* file with the worker subcommand
 * appended. The file ignored the extra arguments, ran the orchestrator again,
 * and spawned itself again: a fork bomb.
 */
export function entryPath(): string {
  // This file lives at packages/core/src/cli/self.ts, so the entry is one level up.
  // fileURLToPath, not .pathname: a URL percent-encodes, so a checkout under
  // "~/My Projects" produced ".../My%20Projects/index.ts", which does not exist,
  // and every spawned worker died with "Module not found".
  return fileURLToPath(new URL("../index.ts", import.meta.url));
}

/**
 * Build the argv to run this program again with the given arguments.
 *
 * @example selfCommand(["review", "internal-worker"])
 */
export function selfCommand(args: string[]): string[] {
  return isCompiledBinary()
    ? [process.execPath, ...args]
    : [process.execPath, entryPath(), ...args];
}

/** True when this process was itself spawned by `selfCommand`. */
export function isChildProcess(): boolean {
  return process.env[CHILD_ENV_FLAG] === "1";
}

/** Environment for a child, carrying the recursion guard. */
export function childEnv(): Record<string, string | undefined> {
  return { ...process.env, [CHILD_ENV_FLAG]: "1" };
}

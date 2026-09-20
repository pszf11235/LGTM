/**
 * The preflight probe, against throwaway binaries rather than the real CLI.
 *
 * Every payload here was measured on CLI 2.1.260, including the one that
 * matters most: logged out prints a perfectly ordinary JSON object and exits
 * 0. A probe that read the exit code would call that a healthy login, which
 * is the mistake the review path already made once.
 *
 * The binaries are real shell scripts, so the probe goes through the same
 * `run` helper a Round does. That is the point of not writing a second spawn:
 * the stdin close and the deadline are exercised here too.
 */

import { describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";
import {
  AUTH_STATUS_ARGS,
  checkProviderAuth,
  isAuthenticated,
  type ProviderAuthResult,
} from "./auth";
import type { SpawnOutcome } from "./claude";

/** An executable stand-in for the CLI, written to a scratch directory. */
async function fakeBinary(body: string): Promise<string> {
  const dir = await fs.mkdtemp(join(os.tmpdir(), "lgtm-fake-auth-"));
  const binPath = join(dir, "claude");
  await fs.writeFile(binPath, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  return binPath;
}

/** A binary that prints `payload` on stdout and exits 0, like the real one. */
function printing(payload: string): Promise<string> {
  return fakeBinary(`cat <<'JSON'\n${payload}\nJSON`);
}

/** The logged-out payload, verbatim from the CLI this was built against. */
const LOGGED_OUT = '{"loggedIn": false, "authMethod": "none", "apiProvider": "firstParty"}';

const LOGGED_IN = '{"loggedIn": true, "authMethod": "claude.ai", "apiProvider": "firstParty"}';

function spawning(outcome: Partial<SpawnOutcome>): SpawnOutcome {
  return { stdout: "", stderr: "", exitCode: 0, timedOut: false, ...outcome };
}

describe("checkProviderAuth", () => {
  test("reads a logged-in CLI, and the method it is logged in with", async () => {
    const result = await checkProviderAuth(await printing(LOGGED_IN));

    expect(result).toEqual({ state: "authenticated", method: "claude.ai", error: null });
    expect(isAuthenticated(result)).toBe(true);
  });

  test("reads the logged-out payload the CLI actually prints", async () => {
    // Exit 0 and no error field anywhere. The whole reason this probe exists
    // is that nothing except `loggedIn` says what is wrong.
    const result = await checkProviderAuth(await printing(LOGGED_OUT));

    expect(result).toEqual({ state: "unauthenticated", method: null, error: null });
    expect(isAuthenticated(result)).toBe(false);
  });

  test("asks the documented subcommand, at the path it was given", async () => {
    let cmd: string[] = [];
    await checkProviderAuth("/opt/bin/claude", {
      spawn: async (given) => {
        cmd = given;
        return spawning({ stdout: LOGGED_IN });
      },
    });

    expect(cmd).toEqual(["/opt/bin/claude", ...AUTH_STATUS_ARGS]);
    expect(cmd).toEqual(["/opt/bin/claude", "auth", "status", "--json"]);
  });

  test("a binary that cannot be run is unknown, never a yes", async () => {
    const result = await checkProviderAuth("/nonexistent/claude");

    expect(result.state).toBe("unknown");
    expect(result.error).toBeTruthy();
    expect(isAuthenticated(result)).toBe(false);
  });

  test("an unresolved binary path is unknown without spawning anything", async () => {
    let spawned = false;
    const result = await checkProviderAuth(null, {
      spawn: async () => {
        spawned = true;
        return spawning({ stdout: LOGGED_IN });
      },
    });

    expect(result).toEqual({
      state: "unknown",
      method: null,
      error: "claude binary not resolved",
    });
    expect(spawned).toBe(false);
  });

  test("output that is not a verdict is unknown, not a logged-out reading", async () => {
    // A CLI whose output moved must not be read as "the user is logged out",
    // which would stop a daemon that is working perfectly well.
    const result = await checkProviderAuth(await printing("Logged in as pascal@example.com"));

    expect(result.state).toBe("unknown");
    expect(result.error).toContain("loggedIn");
  });

  test("a loggedIn that is not a boolean does not collapse into false", async () => {
    const result = await checkProviderAuth(await printing('{"loggedIn": "false"}'));

    expect(result.state).toBe("unknown");
  });

  test("a warning line above the JSON does not cost us the answer", async () => {
    const result = await checkProviderAuth(
      await printing(`npm warn: update available\n${LOGGED_OUT}`)
    );

    expect(result.state).toBe("unauthenticated");
  });

  test("an answer counts even when the CLI exits non-zero afterwards", async () => {
    const result = await checkProviderAuth(await fakeBinary(`echo '${LOGGED_OUT}'\nexit 1`));

    expect(result.state).toBe("unauthenticated");
  });

  test("a non-zero exit with nothing readable is unknown, and says what it saw", async () => {
    const result = await checkProviderAuth(
      await fakeBinary(`echo "unknown command: auth" >&2\nexit 2`)
    );

    expect(result.state).toBe("unknown");
    expect(result.error).toContain("unknown command: auth");
  });

  test("gives up on its own deadline rather than holding the cycle", async () => {
    // A probe measured at 0.19s has no business blocking a Round. This one
    // hangs; the deadline is the whole test.
    const startedAt = Date.now();

    const result = await checkProviderAuth(await fakeBinary("sleep 20"), {
      timeoutSeconds: 0.25,
    });

    expect(result.state).toBe("unknown");
    expect(result.error).toContain("timed out");
    expect(Date.now() - startedAt).toBeLessThan(5000);
  });

  test("closes stdin, so a CLI that reads it answers instead of hanging", async () => {
    // Inherited from `run` rather than reimplemented, which is why the probe
    // reuses it. A daemon has no terminal to feed a prompt.
    const result = await checkProviderAuth(
      await fakeBinary(`cat > /dev/null\necho '${LOGGED_IN}'`),
      { timeoutSeconds: 5 }
    );

    expect(result.state).toBe("authenticated");
  });

  test("a spawn that throws is unknown, not a crash in the caller", async () => {
    const result = await checkProviderAuth("/usr/bin/claude", {
      spawn: async () => {
        throw new Error("EMFILE: too many open files");
      },
    });

    expect(result.state).toBe("unknown");
    expect(result.error).toContain("EMFILE");
  });
});

describe("isAuthenticated", () => {
  test("only an actual login is a yes", () => {
    const states: ProviderAuthResult[] = [
      { state: "authenticated", method: "claude.ai", error: null },
      { state: "unauthenticated", method: null, error: null },
      { state: "unknown", method: null, error: "no idea" },
    ];

    expect(states.map(isAuthenticated)).toEqual([true, false, false]);
  });
});

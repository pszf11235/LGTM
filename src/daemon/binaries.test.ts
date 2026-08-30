/**
 * These run against a fake login shell, never the real one: a real `$SHELL
 * -l` sources whatever rc files happen to exist on the machine running the
 * tests, which is exactly the non-determinism a boot-time probe test cannot
 * afford. The fake shell is a tiny POSIX script that accepts the same `-l -c
 * "<script>"` argv shape, points PATH at a throwaway bin directory of stub
 * executables, and evals the script it's given — so it exercises the real
 * `command -v` parsing path in binaries.ts, just against a controlled PATH.
 */
import { afterEach, describe, expect, test } from "bun:test";
import fs from "fs";
import os from "os";
import path from "path";
import { createBinaryResolver } from "./binaries";

const cleanups: Array<() => void> = [];

afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!();
});

/**
 * Builds a fake bin directory containing an executable stub for each name in
 * `present`, plus a fake login shell that scopes PATH to that directory
 * before evaluating the `-c` script. Also emits a line of rc-style noise on
 * its own stderr, standing in for the motd/nvm/direnv chatter a real login
 * shell's profile can print, to exercise the discard requirement.
 */
function makeFakeShell(present: readonly string[]): { shellPath: string; binDir: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lgtm-binaries-test-"));
  cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));

  const binDir = path.join(root, "bin");
  fs.mkdirSync(binDir);
  for (const name of present) {
    const stub = path.join(binDir, name);
    fs.writeFileSync(stub, "#!/bin/sh\necho stub\n");
    fs.chmodSync(stub, 0o755);
  }

  const shellPath = path.join(root, "fake-shell.sh");
  fs.writeFileSync(
    shellPath,
    [
      "#!/bin/sh",
      `PATH="${binDir}"`,
      "export PATH",
      "echo 'stub profile: welcome to fakeshell' >&2",
      "shift 2",
      'eval "$1"',
      "",
    ].join("\n")
  );
  fs.chmodSync(shellPath, 0o755);

  return { shellPath, binDir };
}

describe("createBinaryResolver / probe", () => {
  test("resolves binaries present on the login shell's PATH to absolute paths", async () => {
    const { shellPath, binDir } = makeFakeShell(["claude", "gh"]);
    const resolver = createBinaryResolver({ shell: shellPath });

    await resolver.probe();

    expect(resolver.resolve("claude")).toBe(path.join(binDir, "claude"));
    expect(resolver.resolve("gh")).toBe(path.join(binDir, "gh"));
  });

  test("a binary missing from the login shell's PATH resolves to null", async () => {
    const { shellPath } = makeFakeShell(["claude", "gh"]); // no terminal-notifier stub
    const resolver = createBinaryResolver({ shell: shellPath });

    await resolver.probe();

    expect(resolver.resolve("terminal-notifier")).toBeNull();
  });

  test("a binary missing in the middle of the list doesn't shift the ones after it", async () => {
    // gh is the one missing here, sitting between claude and terminal-notifier
    // in BINARY_NAMES order — a positional (unlabeled) parse of `command -v`
    // output would misattribute terminal-notifier's path to gh in this case.
    const { shellPath, binDir } = makeFakeShell(["claude", "terminal-notifier"]);
    const resolver = createBinaryResolver({ shell: shellPath });

    await resolver.probe();

    expect(resolver.resolve("claude")).toBe(path.join(binDir, "claude"));
    expect(resolver.resolve("gh")).toBeNull();
    expect(resolver.resolve("terminal-notifier")).toBe(path.join(binDir, "terminal-notifier"));
  });

  test("status() reports name, source, and path for every binary, in order", async () => {
    const { shellPath, binDir } = makeFakeShell(["claude"]);
    const resolver = createBinaryResolver({ shell: shellPath });

    await resolver.probe();

    expect(resolver.status()).toEqual([
      { name: "claude", source: "probed", path: path.join(binDir, "claude") },
      { name: "gh", source: "missing", path: null },
      { name: "terminal-notifier", source: "missing", path: null },
    ]);
  });

  test("rc-file chatter on the login shell's stderr never reaches the daemon's own stderr", async () => {
    const { shellPath } = makeFakeShell(["claude", "gh", "terminal-notifier"]);
    const resolver = createBinaryResolver({ shell: shellPath });

    const originalWrite = process.stderr.write.bind(process.stderr);
    const writes: unknown[] = [];
    process.stderr.write = ((...args: unknown[]) => {
      writes.push(args[0]);
      return true;
    }) as typeof process.stderr.write;

    try {
      await resolver.probe();
    } finally {
      process.stderr.write = originalWrite;
    }

    expect(writes).toEqual([]);
    // and detection still worked despite the noise on the shell's own stderr
    expect(resolver.resolve("claude")).not.toBeNull();
  });

  test("a shell that cannot be spawned at all leaves every unpinned binary missing, without throwing", async () => {
    const resolver = createBinaryResolver({ shell: "/no/such/shell-binary-anywhere" });

    await expect(resolver.probe()).resolves.toBeUndefined();

    for (const status of resolver.status()) {
      expect(status.source).toBe("missing");
    }
  });
});

describe("createBinaryResolver / precedence rule (pins beat the probe)", () => {
  test("a pin resolves immediately at construction, before probe() ever runs", () => {
    const resolver = createBinaryResolver({ pins: { claude: "/opt/pinned/claude" } });

    expect(resolver.resolve("claude")).toBe("/opt/pinned/claude");
    expect(resolver.status()).toContainEqual({ name: "claude", source: "pinned", path: "/opt/pinned/claude" });
  });

  test("probe() never overwrites a pin, even when the real PATH disagrees with it", async () => {
    // The fake PATH resolves claude to a different, real, executable file —
    // if the probe ran for claude at all and won, this would observe that
    // path instead of the pin.
    const { shellPath, binDir } = makeFakeShell(["claude"]);
    const resolver = createBinaryResolver({
      shell: shellPath,
      pins: { claude: "/opt/pinned/claude" },
    });

    await resolver.probe();

    expect(resolver.resolve("claude")).toBe("/opt/pinned/claude");
    expect(resolver.resolve("claude")).not.toBe(path.join(binDir, "claude"));
    expect(resolver.status()).toContainEqual({ name: "claude", source: "pinned", path: "/opt/pinned/claude" });
  });

  test("probe() never spawns the shell to resolve a pinned binary in the first place", async () => {
    // Every pinnable binary is pinned, and the shell is guaranteed to fail if
    // invoked at all. If pins were resolved by asking the shell and merely
    // preferring the pin afterward, this would still observe a spawn
    // attempt; instead the pinned ones must never reach runLoginShellProbe.
    const resolver = createBinaryResolver({
      shell: "/no/such/shell-binary-anywhere",
      pins: { claude: "/opt/pinned/claude", gh: "/opt/pinned/gh" },
    });

    await resolver.probe();

    expect(resolver.resolve("claude")).toBe("/opt/pinned/claude");
    expect(resolver.resolve("gh")).toBe("/opt/pinned/gh");
    // terminal-notifier isn't pinnable, so it's the one that actually hit
    // (and survived) the broken shell.
    expect(resolver.resolve("terminal-notifier")).toBeNull();
  });

  test("reportSpawnFailure on a pinned binary is a no-op: an ENOENT re-probe cannot override a deliberate pin", async () => {
    const { shellPath, binDir } = makeFakeShell(["claude"]);
    const resolver = createBinaryResolver({
      shell: shellPath,
      pins: { claude: "/opt/pinned/claude" },
    });

    await resolver.reportSpawnFailure("claude");

    expect(resolver.resolve("claude")).toBe("/opt/pinned/claude");
    expect(resolver.resolve("claude")).not.toBe(path.join(binDir, "claude"));
    expect(resolver.status()).toContainEqual({ name: "claude", source: "pinned", path: "/opt/pinned/claude" });
  });
});

describe("createBinaryResolver / re-probe on ENOENT", () => {
  test("reportSpawnFailure re-resolves an unpinned binary that just became available", async () => {
    const { shellPath, binDir } = makeFakeShell(["claude"]); // terminal-notifier not installed yet
    const resolver = createBinaryResolver({ shell: shellPath });

    await resolver.probe();
    expect(resolver.resolve("terminal-notifier")).toBeNull();

    // simulate the user installing it after the daemon booted
    const stub = path.join(binDir, "terminal-notifier");
    fs.writeFileSync(stub, "#!/bin/sh\necho stub\n");
    fs.chmodSync(stub, 0o755);

    await resolver.reportSpawnFailure("terminal-notifier");

    expect(resolver.resolve("terminal-notifier")).toBe(stub);
  });

  test("reportSpawnFailure only re-probes the failing binary, leaving other resolutions untouched", async () => {
    const { shellPath, binDir } = makeFakeShell(["claude", "gh"]);
    const resolver = createBinaryResolver({ shell: shellPath });
    await resolver.probe();

    const claudeBefore = resolver.resolve("claude");

    // gh disappears from PATH entirely (moved, uninstalled) — probing it
    // again should not disturb claude's already-cached resolution.
    fs.rmSync(path.join(binDir, "gh"));

    await resolver.reportSpawnFailure("gh");

    expect(resolver.resolve("claude")).toBe(claudeBefore);
    expect(resolver.resolve("gh")).toBeNull();
  });
});

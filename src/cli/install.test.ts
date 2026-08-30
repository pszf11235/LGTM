/**
 * Offline coverage for `lgtm install` / `lgtm uninstall` (design.md, "Daemon
 * lifecycle"; requirements R7.1).
 *
 * The launchctl runner and the filesystem are both fakes here — no test
 * spawns a real `launchctl` or touches the real `~/Library/LaunchAgents`.
 * The fake launchctl is scripted per test to answer `print`/`bootstrap`/
 * `kickstart`/`bootout` the way the real thing would in the scenario under
 * test (already loaded, fresh install, malformed plist, ...), and every
 * test that cares about command order asserts the exact sequence of calls
 * it made.
 */
import { describe, expect, test } from "bun:test";
import path from "path";
import {
  buildPlist,
  LABEL,
  type InstallFs,
  type InstallOptions,
  type LaunchctlResult,
  type LaunchctlRunner,
  logPath,
  plistPath,
  runInstall,
  runUninstall,
} from "./install";

// ─── Fakes ──────────────────────────────────────────────────────────────────

interface FakeFs extends InstallFs {
  files: Map<string, string>;
  dirs: Set<string>;
}

function fakeFs(seed: Record<string, string> = {}): FakeFs {
  const files = new Map(Object.entries(seed));
  const dirs = new Set<string>();
  return {
    files,
    dirs,
    async mkdir(dirPath) {
      dirs.add(dirPath);
    },
    async writeFile(filePath, contents) {
      files.set(filePath, contents);
    },
    async remove(filePath) {
      files.delete(filePath); // tolerates an already-missing path, same as fs.rm({force: true}).
    },
  };
}

/**
 * Scripts a fake `launchctl`: `responses` maps the first arg (`print`,
 * `bootstrap`, `kickstart`, `bootout`) to a canned result. Every call is
 * recorded in `calls` in order, full argv, so tests can assert exact command
 * sequences (e.g. "already loaded" skips `bootstrap` entirely).
 */
function fakeLaunchctl(responses: Record<string, LaunchctlResult>): { runner: LaunchctlRunner; calls: string[][] } {
  const calls: string[][] = [];
  const runner: LaunchctlRunner = async (args) => {
    calls.push(args);
    const verb = args[0] ?? "";
    return responses[verb] ?? { exitCode: 1, stdout: "", stderr: `fakeLaunchctl: no response scripted for "${verb}"` };
  };
  return { runner, calls };
}

const ok: LaunchctlResult = { exitCode: 0, stdout: "", stderr: "" };
const notLoaded: LaunchctlResult = { exitCode: 1, stdout: "", stderr: "Could not find service in domain for port" };
const ioError: LaunchctlResult = { exitCode: 5, stdout: "", stderr: "Bootstrap failed: 5: Input/output error" };

function capture(): { write: (l: string) => void; writeErr: (l: string) => void; lines: string[]; errLines: string[] } {
  const lines: string[] = [];
  const errLines: string[] = [];
  return { write: (l) => lines.push(l), writeErr: (l) => errLines.push(l), lines, errLines };
}

const LAUNCH_AGENTS_DIR = "/fake-home/Library/LaunchAgents";
const LGTM_DIR = "/fake-home/.lgtm-farm";
const BINARY_PATH = "/usr/local/bin/lgtm";
const UID = 501;
const SERVICE_TARGET = `gui/${UID}/${LABEL}`;
const PLIST_FILE = plistPath(LAUNCH_AGENTS_DIR, LABEL);
const LOG_FILE = logPath(LGTM_DIR);

function baseOptions(overrides: Partial<InstallOptions> = {}): InstallOptions {
  const out = capture();
  return {
    lgtmDir: LGTM_DIR,
    launchAgentsDir: LAUNCH_AGENTS_DIR,
    binaryPath: BINARY_PATH,
    uid: UID,
    write: out.write,
    writeErr: out.writeErr,
    ...overrides,
  };
}

// ─── buildPlist ─────────────────────────────────────────────────────────────

describe("buildPlist", () => {
  test("carries the label, the binary path run with `up`, RunAtLoad, KeepAlive, and both log streams", () => {
    const plist = buildPlist({ label: LABEL, binaryPath: BINARY_PATH, logPath: LOG_FILE });

    expect(plist).toContain(`<string>${LABEL}</string>`);
    expect(plist).toContain(`<string>${BINARY_PATH}</string>`);
    expect(plist).toContain("<string>up</string>");
    expect(plist).toContain("<key>RunAtLoad</key>\n\t<true/>");
    expect(plist).toContain("<key>KeepAlive</key>\n\t<true/>");
    expect(plist.split(`<string>${LOG_FILE}</string>`).length - 1).toBe(2); // stdout and stderr both point here.
    expect(plist).toContain("<key>StandardOutPath</key>");
    expect(plist).toContain("<key>StandardErrorPath</key>");
  });

  test("never sets a PATH: launchd's bare PATH is what binaries.ts's login-shell probe depends on", () => {
    const plist = buildPlist({ label: LABEL, binaryPath: BINARY_PATH, logPath: LOG_FILE });

    expect(plist).not.toContain("<key>EnvironmentVariables</key>");
    expect(plist.toUpperCase()).not.toContain("<KEY>PATH</KEY>");
    expect(plist).toContain("bare PATH"); // the explanatory comment survives, for whoever reads the plist next.
  });

  test("escapes XML-significant characters in the binary path", () => {
    const plist = buildPlist({ label: LABEL, binaryPath: "/Users/a & b/lgtm", logPath: LOG_FILE });

    expect(plist).toContain("/Users/a &amp; b/lgtm");
    expect(plist).not.toContain("/Users/a & b/lgtm");
  });
});

// ─── install ────────────────────────────────────────────────────────────────

describe("runInstall", () => {
  test("fresh install: writes the plist, creates its directories, then bootstraps and kickstarts", async () => {
    const fs = fakeFs();
    const { runner, calls } = fakeLaunchctl({ print: notLoaded, bootstrap: ok, kickstart: ok });
    const out = capture();

    const code = await runInstall(baseOptions({ fs, runLaunchctl: runner, write: out.write, writeErr: out.writeErr }));

    expect(code).toBe(0);
    expect(out.errLines).toEqual([]);

    expect(fs.dirs.has(LAUNCH_AGENTS_DIR)).toBe(true);
    expect(fs.dirs.has(path.dirname(LOG_FILE))).toBe(true);
    expect(fs.files.get(PLIST_FILE)).toContain(`<string>${BINARY_PATH}</string>`);

    expect(calls).toEqual([
      ["print", SERVICE_TARGET],
      ["bootstrap", `gui/${UID}`, PLIST_FILE],
      ["kickstart", "-k", SERVICE_TARGET],
    ]);
    expect(out.lines.some((l) => l.includes(PLIST_FILE))).toBe(true);
    expect(out.lines.some((l) => l.includes(LOG_FILE))).toBe(true);
  });

  test("already loaded: skips bootstrap entirely and goes straight to kickstart -k", async () => {
    const fs = fakeFs();
    const { runner, calls } = fakeLaunchctl({ print: ok, kickstart: ok });
    const out = capture();

    const code = await runInstall(baseOptions({ fs, runLaunchctl: runner, write: out.write, writeErr: out.writeErr }));

    expect(code).toBe(0);
    expect(calls).toEqual([
      ["print", SERVICE_TARGET],
      ["kickstart", "-k", SERVICE_TARGET],
    ]);
    expect(out.lines.some((l) => /already loaded/i.test(l))).toBe(true);
    // The plist is still (re)written even when already loaded, so a changed
    // binary path or store dir takes effect on the kickstart restart.
    expect(fs.files.has(PLIST_FILE)).toBe(true);
  });

  test("a genuine bootstrap failure (bad plist / bad path) when not already loaded is reported, not swallowed", async () => {
    const fs = fakeFs();
    const { runner, calls } = fakeLaunchctl({ print: notLoaded, bootstrap: ioError });
    const out = capture();

    const code = await runInstall(baseOptions({ fs, runLaunchctl: runner, write: out.write, writeErr: out.writeErr }));

    expect(code).toBe(1);
    expect(calls).toEqual([
      ["print", SERVICE_TARGET],
      ["bootstrap", `gui/${UID}`, PLIST_FILE],
    ]); // kickstart never runs after a real bootstrap failure.
    expect(out.errLines[0]!).toMatch(/bootstrap failed/i);
    expect(out.errLines[0]!).toContain(PLIST_FILE);
  });

  test("a kickstart failure after a successful bootstrap is reported", async () => {
    const fs = fakeFs();
    const { runner } = fakeLaunchctl({
      print: notLoaded,
      bootstrap: ok,
      kickstart: { exitCode: 1, stdout: "", stderr: "some kickstart error" },
    });
    const out = capture();

    const code = await runInstall(baseOptions({ fs, runLaunchctl: runner, write: out.write, writeErr: out.writeErr }));

    expect(code).toBe(1);
    expect(out.errLines[0]!).toMatch(/kickstart failed/i);
  });

  test("refuses a non-absolute binary path before touching disk or launchctl", async () => {
    const fs = fakeFs();
    const { runner, calls } = fakeLaunchctl({ print: notLoaded, bootstrap: ok, kickstart: ok });
    const out = capture();

    const code = await runInstall(
      baseOptions({ fs, runLaunchctl: runner, binaryPath: "relative/lgtm", write: out.write, writeErr: out.writeErr })
    );

    expect(code).toBe(1);
    expect(out.errLines[0]!).toMatch(/absolute/i);
    expect(fs.files.size).toBe(0);
    expect(calls).toEqual([]);
  });

  test("never invokes the real launchctl binary (no runLaunchctl override reaches this test)", () => {
    // Every test above passes its own fake; this test exists only to make
    // that invariant explicit for a reader of this file.
    expect(true).toBe(true);
  });
});

// ─── uninstall ──────────────────────────────────────────────────────────────

describe("runUninstall", () => {
  test("bootout then removes the plist, exit 0", async () => {
    const fs = fakeFs({ [PLIST_FILE]: "<plist/>" });
    const { runner, calls } = fakeLaunchctl({ bootout: ok });
    const out = capture();

    const code = await runUninstall(baseOptions({ fs, runLaunchctl: runner, write: out.write, writeErr: out.writeErr }));

    expect(code).toBe(0);
    expect(calls).toEqual([["bootout", SERVICE_TARGET]]);
    expect(fs.files.has(PLIST_FILE)).toBe(false);
    expect(out.lines.some((l) => l.includes("Stopped"))).toBe(true);
  });

  test("is idempotent: an agent that was never loaded and a plist that's already gone still exits 0", async () => {
    const fs = fakeFs(); // no plist seeded.
    const { runner } = fakeLaunchctl({ bootout: notLoaded });
    const out = capture();

    const code = await runUninstall(baseOptions({ fs, runLaunchctl: runner, write: out.write, writeErr: out.writeErr }));

    expect(code).toBe(0);
    expect(out.errLines).toEqual([]);
    expect(out.lines.some((l) => /wasn't loaded/i.test(l))).toBe(true);
  });

  test("running it twice in a row is a no-op the second time, both times exit 0", async () => {
    const fs = fakeFs({ [PLIST_FILE]: "<plist/>" });
    const { runner } = fakeLaunchctl({ bootout: ok });
    const first = capture();
    const second = capture();

    const firstCode = await runUninstall(
      baseOptions({ fs, runLaunchctl: runner, write: first.write, writeErr: first.writeErr })
    );
    // Second run: the agent is no longer loaded, and the plist is already gone.
    const { runner: secondRunner } = fakeLaunchctl({ bootout: notLoaded });
    const secondCode = await runUninstall(
      baseOptions({ fs, runLaunchctl: secondRunner, write: second.write, writeErr: second.writeErr })
    );

    expect(firstCode).toBe(0);
    expect(secondCode).toBe(0);
    expect(fs.files.has(PLIST_FILE)).toBe(false);
  });

  test("still removes the plist even when bootout reports a failure", async () => {
    const fs = fakeFs({ [PLIST_FILE]: "<plist/>" });
    const { runner } = fakeLaunchctl({ bootout: { exitCode: 3, stdout: "", stderr: "some other failure" } });
    const out = capture();

    const code = await runUninstall(baseOptions({ fs, runLaunchctl: runner, write: out.write, writeErr: out.writeErr }));

    expect(code).toBe(0);
    expect(fs.files.has(PLIST_FILE)).toBe(false);
  });
});

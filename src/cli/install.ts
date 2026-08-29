/**
 * `lgtm install` / `lgtm uninstall`: writes and bootstraps (or removes) the
 * launchd LaunchAgent that keeps the daemon running across reboots and
 * crashes (design.md, "Daemon lifecycle"; requirements R7.1).
 *
 * launchd's `bootstrap` returns the same unhelpful "Bootstrap failed: 5:
 * Input/output error" for a malformed plist, a wrong binary path, AND for a
 * service that is already loaded. There is no way to tell those apart from
 * `bootstrap`'s own exit code, so this module checks `launchctl print` for
 * the already-loaded case *before* attempting `bootstrap` at all: already
 * loaded skips straight to `kickstart -k` (which restarts the service against
 * whatever the plist and binary path say right now); not loaded runs
 * `bootstrap` and treats a failure there as the real thing it usually is —
 * a bad plist or a bad path — and reports it as such.
 *
 * The plist deliberately carries no `EnvironmentVariables`/`PATH` key.
 * launchd hands every user LaunchAgent a bare PATH, and
 * src/daemon/binaries.ts's login-shell probe exists precisely because of
 * that bareness; hardcoding a PATH here would just substitute one guess for
 * another and quietly break that probe. The plist says so in a comment, for
 * whoever reads it next.
 *
 * The launchctl runner and the filesystem are both injected so tests never
 * touch the real `~/Library/LaunchAgents` or spawn a real `launchctl`.
 */
import path from "path";
import os from "os";
import fs from "fs/promises";
import { getStorePath } from "../store/paths";

// ─── Injected dependencies ──────────────────────────────────────────────────

/** One `launchctl` invocation's outcome. Never thrown; every caller reads `exitCode`. */
export interface LaunchctlResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/** Runs `launchctl <args>`. Injectable so tests never spawn the real thing. */
export type LaunchctlRunner = (args: string[]) => Promise<LaunchctlResult>;

/**
 * The filesystem calls install/uninstall need, minimal and injectable so
 * tests assert plist contents and directory creation without touching disk.
 * `mkdir` is always recursive; `remove` always tolerates a missing path —
 * that tolerance is what makes `runUninstall` idempotent.
 */
export interface InstallFs {
  mkdir(dirPath: string): Promise<void>;
  writeFile(filePath: string, contents: string): Promise<void>;
  remove(filePath: string): Promise<void>;
}

const defaultFs: InstallFs = {
  async mkdir(dirPath) {
    await fs.mkdir(dirPath, { recursive: true });
  },
  async writeFile(filePath, contents) {
    await fs.writeFile(filePath, contents, "utf-8");
  },
  async remove(filePath) {
    await fs.rm(filePath, { force: true });
  },
};

const defaultLaunchctl: LaunchctlRunner = async (args) => {
  const proc = Bun.spawn(["launchctl", ...args], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exitCode, stdout, stderr };
};

// ─── Paths ──────────────────────────────────────────────────────────────────

/**
 * `com.lgtm.daemon`: the LaunchAgent's `Label`, and the name macOS 13+ shows
 * in "Login Items" under Background Items ("Background items added") when
 * this agent loads — kept short and legible as "lgtm" there on purpose.
 */
export const LABEL = "com.lgtm.daemon";

function homeDir(): string {
  return process.env.HOME || os.homedir();
}

/** `~/Library/LaunchAgents`, honoring `HOME` the same way store/paths.ts does, so tests can relocate it. */
export function defaultLaunchAgentsDir(): string {
  return path.join(homeDir(), "Library", "LaunchAgents");
}

/** `<launchAgentsDir>/<label>.plist`. */
export function plistPath(launchAgentsDir: string, label: string = LABEL): string {
  return path.join(launchAgentsDir, `${label}.plist`);
}

/** `<lgtmDir>/logs/daemon.log` — the store's log file (design.md, "Store layout"), stdout and stderr both land here. */
export function logPath(lgtmDir: string): string {
  return path.join(lgtmDir, "logs", "daemon.log");
}

function resolveUid(): number {
  // v1 is macOS-only (requirements.md, "Premise"); process.getuid is always
  // present there. The `?? 0` only matters for a typecheck run on a
  // platform without it, never for a real `lgtm install`.
  return process.getuid?.() ?? 0;
}

// ─── Plist ──────────────────────────────────────────────────────────────────

export interface PlistParams {
  label: string;
  /** Absolute path to the installed `lgtm` binary; becomes `ProgramArguments[0]`, run with `up`. */
  binaryPath: string;
  /** Where stdout and stderr both go. */
  logPath: string;
}

function xmlEscape(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/** Renders the LaunchAgent plist. Pure, so its contents are directly testable without touching disk. */
export function buildPlist(params: PlistParams): string {
  const label = xmlEscape(params.label);
  const binaryPath = xmlEscape(params.binaryPath);
  const log = xmlEscape(params.logPath);

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key>
	<string>${label}</string>
	<key>ProgramArguments</key>
	<array>
		<string>${binaryPath}</string>
		<string>up</string>
	</array>
	<key>RunAtLoad</key>
	<true/>
	<key>KeepAlive</key>
	<true/>
	<key>StandardOutPath</key>
	<string>${log}</string>
	<key>StandardErrorPath</key>
	<string>${log}</string>
	<!--
	  No EnvironmentVariables / PATH key here, on purpose. launchd hands every
	  user LaunchAgent a bare PATH, and src/daemon/binaries.ts's login-shell
	  probe (\`$SHELL -l -c 'command -v ...'\`) depends on exactly that
	  bareness to resolve claude/gh/terminal-notifier the way the user's own
	  shell would. A hardcoded PATH here would only replace one guess with
	  another and break that probe silently. If a binary goes unresolved
	  under launchd, fix the probe or pin it in config.md — don't add PATH
	  here.
	-->
</dict>
</plist>
`;
}

// ─── Shared helpers ─────────────────────────────────────────────────────────

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** launchctl's real failures are one useful line buried in a wall of stderr; this is that line, or a fallback. */
function firstLine(text: string): string {
  const line = text.split("\n")[0]?.trim();
  return line && line.length > 0 ? line : "(no output)";
}

function defaultWrite(line: string): void {
  console.log(line);
}

function defaultWriteErr(line: string): void {
  console.error(line);
}

export interface InstallOptions {
  /** The store directory; only its `logs/` path matters here. Defaults to `getStorePath()`. */
  lgtmDir?: string;
  /** Defaults to `~/Library/LaunchAgents`. */
  launchAgentsDir?: string;
  /** Absolute path to the running `lgtm` binary. Defaults to `process.execPath`, which for a Bun-compiled standalone binary is that binary's own path. */
  binaryPath?: string;
  /** Defaults to the real user id. */
  uid?: number;
  fs?: InstallFs;
  runLaunchctl?: LaunchctlRunner;
  write?: (line: string) => void;
  writeErr?: (line: string) => void;
}

// ─── install ────────────────────────────────────────────────────────────────

export async function runInstall(options: InstallOptions = {}): Promise<number> {
  const write = options.write ?? defaultWrite;
  const writeErr = options.writeErr ?? defaultWriteErr;
  const lgtmDir = options.lgtmDir ?? getStorePath();
  const launchAgentsDir = options.launchAgentsDir ?? defaultLaunchAgentsDir();
  const binaryPath = options.binaryPath ?? process.execPath;
  const uid = options.uid ?? resolveUid();
  const fsImpl = options.fs ?? defaultFs;
  const launchctl = options.runLaunchctl ?? defaultLaunchctl;

  if (!path.isAbsolute(binaryPath)) {
    writeErr(
      `lgtm install needs an absolute path to the installed binary, got "${binaryPath}". ` +
        "Run the installed `lgtm` binary directly (not `bun run src/main.ts`) so it can find itself."
    );
    return 1;
  }

  const plistFile = plistPath(launchAgentsDir, LABEL);
  const logFile = logPath(lgtmDir);
  const plist = buildPlist({ label: LABEL, binaryPath, logPath: logFile });

  try {
    await fsImpl.mkdir(launchAgentsDir);
    await fsImpl.mkdir(path.dirname(logFile));
    await fsImpl.writeFile(plistFile, plist);
  } catch (err) {
    writeErr(`could not write ${plistFile}: ${describeError(err)}`);
    return 1;
  }

  const domain = `gui/${uid}`;
  const serviceTarget = `${domain}/${LABEL}`;

  const alreadyLoaded = (await launchctl(["print", serviceTarget])).exitCode === 0;

  if (!alreadyLoaded) {
    const bootstrap = await launchctl(["bootstrap", domain, plistFile]);
    if (bootstrap.exitCode !== 0) {
      writeErr(
        `launchctl bootstrap failed (exit ${bootstrap.exitCode}): ${firstLine(bootstrap.stderr)}. ` +
          `Check that ${plistFile} is well-formed and that ${binaryPath} exists and is executable.`
      );
      return 1;
    }
  }

  const kickstart = await launchctl(["kickstart", "-k", serviceTarget]);
  if (kickstart.exitCode !== 0) {
    writeErr(`launchctl kickstart failed (exit ${kickstart.exitCode}): ${firstLine(kickstart.stderr)}`);
    return 1;
  }

  write(`Installed the LaunchAgent at ${plistFile}.`);
  write(
    alreadyLoaded
      ? "It was already loaded; restarted it against the current binary and settings."
      : "Loaded and started it."
  );
  write(`Logs: ${logFile}`);
  return 0;
}

// ─── uninstall ──────────────────────────────────────────────────────────────

export async function runUninstall(options: InstallOptions = {}): Promise<number> {
  const write = options.write ?? defaultWrite;
  const writeErr = options.writeErr ?? defaultWriteErr;
  const launchAgentsDir = options.launchAgentsDir ?? defaultLaunchAgentsDir();
  const uid = options.uid ?? resolveUid();
  const fsImpl = options.fs ?? defaultFs;
  const launchctl = options.runLaunchctl ?? defaultLaunchctl;

  const plistFile = plistPath(launchAgentsDir, LABEL);
  const serviceTarget = `gui/${uid}/${LABEL}`;

  // `bootout` fails whenever the agent isn't currently loaded — never
  // installed, already removed, or uninstalled twice in a row. That's the
  // normal idempotent case, not a bug, so its exit code only changes the
  // message below, never whether this command proceeds or succeeds.
  const wasLoaded = (await launchctl(["bootout", serviceTarget])).exitCode === 0;

  try {
    await fsImpl.remove(plistFile);
  } catch (err) {
    writeErr(`could not remove ${plistFile}: ${describeError(err)}`);
    return 1;
  }

  write(
    wasLoaded
      ? `Stopped the daemon and removed the LaunchAgent at ${plistFile}.`
      : `The LaunchAgent wasn't loaded. Removed ${plistFile}.`
  );
  return 0;
}

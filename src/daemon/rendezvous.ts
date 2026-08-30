/**
 * Daemon rendezvous: how a freshly started `lgtm up` finds its own token,
 * claims the store as a single instance, recovers from a crashed prior run,
 * and picks a port (design.md, "Daemon lifecycle" and "HTTP API"; R7.2, R7.5).
 *
 * Two files live at the store root, deliberately kept apart:
 *
 *   token        bearer token, 32 random bytes hex-encoded, mode 0600.
 *                Minted once, on first run, and never regenerated after —
 *                a browser tab keeps this in localStorage once `lgtm open`
 *                hands it over, so a new token on every restart would lock
 *                that tab out silently.
 *   daemon.json  ephemeral rendezvous info: {port, pid, startedAt}, mode
 *                0600. Written on bind, removed on clean exit, overwritten
 *                at boot whenever the recorded pid turns out to be dead.
 *
 * Folding the token into daemon.json would regenerate it every restart,
 * which is exactly the failure this split avoids — see the "token survives
 * a restart while daemon.json does not" test below.
 *
 * Single-instance lock: `daemon.json`'s pid is the lock. `acquireLock`
 * checks it with signal 0 (no signal actually sent, just the existence /
 * permission check — see `isPidAlive`) and refuses to start when that pid
 * is alive. When it is dead, or the file cannot be trusted at all (missing,
 * or corrupt JSON), this boot takes over and repairs whatever a crash left
 * behind: any PR frozen mid-flight in `queued` or `reviewing` is reset to
 * `queued` so the next poll cycle retries it rather than leaving it
 * stranded forever (design.md, "Poll cycle").
 */

import { randomBytes } from "crypto";
import fs from "fs/promises";
import path from "path";
import type { PRRef } from "@/core";
import { listReviewedPRs, loadMeta, saveMeta } from "../store/reviews";

// ─── Paths ──────────────────────────────────────────────────────────────────

/** The bearer token file, absolute: `<lgtmDir>/token`. */
export function tokenPath(lgtmDir: string): string {
  return path.join(lgtmDir, "token");
}

/** The ephemeral rendezvous file, absolute: `<lgtmDir>/daemon.json`. */
export function daemonJsonPath(lgtmDir: string): string {
  return path.join(lgtmDir, "daemon.json");
}

// ─── Token ──────────────────────────────────────────────────────────────────

const TOKEN_BYTES = 32;

/**
 * Read the existing bearer token, or mint one on first run.
 *
 * Hex-encoded so it is also safe to carry unescaped in a URL fragment
 * (`lgtm open` launches `#t=<token>`). An empty or unreadable token file is
 * treated the same as a missing one and regenerated — a zero-byte file is
 * what an interrupted first write can leave behind, and there is no reading
 * it as a deliberate empty token.
 */
export async function ensureToken(lgtmDir: string): Promise<string> {
  const file = tokenPath(lgtmDir);

  const existing = await readExistingToken(file);
  if (existing) return existing;

  const token = randomBytes(TOKEN_BYTES).toString("hex");
  await fs.mkdir(lgtmDir, { recursive: true });
  await fs.writeFile(file, token, { mode: 0o600 });
  // writeFile's `mode` option only governs a newly-created file; chmod makes
  // 0600 certain even if the file already existed (e.g. left over at some
  // other mode by a manual edit).
  await fs.chmod(file, 0o600);
  return token;
}

async function readExistingToken(file: string): Promise<string | null> {
  let raw: string;
  try {
    raw = await fs.readFile(file, "utf-8");
  } catch {
    return null;
  }
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

// ─── daemon.json ────────────────────────────────────────────────────────────

export interface DaemonInfo {
  port: number;
  pid: number;
  /** ISO timestamp. */
  startedAt: string;
}

async function readDaemonFileRaw(lgtmDir: string): Promise<string | null> {
  try {
    return await fs.readFile(daemonJsonPath(lgtmDir), "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

/**
 * Hand-editable in principle, so every field is checked before it's trusted.
 * Anything short of a complete, well-typed record is treated as absent
 * (`null`) rather than partially believed — a lock decision built on a
 * guessed pid or port is worse than one that just falls through to
 * "nothing to recover".
 */
function parseDaemonInfo(raw: string): DaemonInfo | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;

  const { port, pid, startedAt } = parsed as Record<string, unknown>;
  if (typeof port !== "number" || !Number.isFinite(port)) return null;
  if (typeof pid !== "number" || !Number.isInteger(pid)) return null;
  if (typeof startedAt !== "string" || startedAt.length === 0) return null;

  return { port, pid, startedAt };
}

/** Read daemon.json. Null when it's missing, or present but not trustworthy (corrupt JSON, malformed fields). */
export async function readDaemonInfo(lgtmDir: string): Promise<DaemonInfo | null> {
  const raw = await readDaemonFileRaw(lgtmDir);
  return raw === null ? null : parseDaemonInfo(raw);
}

/** Write daemon.json at mode 0600. Called on bind, and again whenever the port changes. */
export async function writeDaemonInfo(lgtmDir: string, info: DaemonInfo): Promise<void> {
  const file = daemonJsonPath(lgtmDir);
  await fs.mkdir(lgtmDir, { recursive: true });
  await fs.writeFile(file, JSON.stringify(info, null, 2) + "\n", { mode: 0o600 });
  await fs.chmod(file, 0o600);
}

/** Remove daemon.json on clean exit. Missing file is a no-op, not an error. */
export async function removeDaemonInfo(lgtmDir: string): Promise<void> {
  try {
    await fs.unlink(daemonJsonPath(lgtmDir));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
}

// ─── Liveness ───────────────────────────────────────────────────────────────

/**
 * Whether `pid` names a live process, via signal 0: POSIX sends nothing,
 * only runs the existence/permission check (design.md's chosen liveness
 * probe).
 *
 * `pid <= 0` is rejected outright rather than handed to `process.kill`:
 * signalling 0 or a negative pid targets a whole process *group*, and would
 * report "alive" merely because the caller's own group exists — not the
 * question a stale-pid check is asking.
 */
export function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;

  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means the process exists but is owned by someone else — still alive.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

// ─── Stale-pid recovery ─────────────────────────────────────────────────────

/**
 * Reset every PR whose meta is frozen in `queued` or `reviewing` back to
 * `queued`, across every repo the store has ever reviewed. Called once at
 * boot when there is no live daemon to defer to (see `acquireLock`), so a
 * process that died mid-round never leaves a PR stuck forever.
 *
 * A PR already `queued` needs no write — flipping it to `queued` again would
 * only bump `updatedAt` for no observable change — but it is still reported
 * back to the caller as "stranded", since it is exactly the state a crash
 * mid-dispatch (queued, but the in-memory queue that would have drained it
 * is gone) leaves behind.
 */
export async function resetStrandedPRs(lgtmDir: string): Promise<PRRef[]> {
  const refs = await listReviewedPRs(lgtmDir);
  const stranded: PRRef[] = [];

  for (const ref of refs) {
    const meta = await loadMeta(lgtmDir, ref);
    if (!meta) continue;
    if (meta.state !== "queued" && meta.state !== "reviewing") continue;

    stranded.push(ref);
    if (meta.state === "reviewing") {
      await saveMeta(lgtmDir, ref, { state: "queued" });
    }
  }

  return stranded;
}

// ─── Single-instance lock ───────────────────────────────────────────────────

export type LockOutcome =
  | {
      status: "acquired";
      /** The daemon.json content this boot is taking over from, if any could be read at all. */
      recoveredFrom: DaemonInfo | null;
      /** PRs reset out of `queued`/`reviewing` as part of taking over. */
      strandedPRs: PRRef[];
    }
  | {
      status: "refused";
      /** The still-alive daemon this boot is deferring to. */
      existing: DaemonInfo;
    };

/**
 * Claim the store as the one running daemon, or refuse to start.
 *
 * - daemon.json missing entirely: nothing to take over from, lock acquired.
 * - daemon.json names a live pid: refused — a second `lgtm up` must not run
 *   alongside the first (R7's single-writer rule depends on this).
 * - daemon.json names a dead pid, or cannot be trusted at all (corrupt
 *   JSON, malformed fields): lock acquired, and `resetStrandedPRs` runs to
 *   repair whatever that dead process left mid-flight. A file that can't be
 *   parsed can never prove a daemon is alive, so it can never block startup
 *   forever either.
 *
 * `isAlive` is injectable so tests exercise the decision logic without
 * depending on real OS pids; it defaults to the real signal-0 check.
 */
export async function acquireLock(
  lgtmDir: string,
  isAlive: (pid: number) => boolean = isPidAlive
): Promise<LockOutcome> {
  const raw = await readDaemonFileRaw(lgtmDir);
  if (raw === null) {
    return { status: "acquired", recoveredFrom: null, strandedPRs: [] };
  }

  const info = parseDaemonInfo(raw);
  if (info && isAlive(info.pid)) {
    return { status: "refused", existing: info };
  }

  const strandedPRs = await resetStrandedPRs(lgtmDir);
  return { status: "acquired", recoveredFrom: info, strandedPRs };
}

// ─── Port selection ─────────────────────────────────────────────────────────

/** design.md, "HTTP API": "default port 4747". */
export const DEFAULT_PORT = 4747;

/** design.md, "HTTP API": "scan to 4757 on conflict" — 4747..4757 inclusive is 11 ports. */
const DEFAULT_PORT_SCAN_COUNT = 11;

export interface SelectPortDeps {
  /**
   * Attempt to claim `port` for real. Resolves `true` on success, `false`
   * on EADDRINUSE. Injected so tests never touch a real socket; the
   * daemon's actual implementation binds with `Bun.serve`.
   */
  tryBind: (port: number) => Promise<boolean>;
  /**
   * Best-effort classification of whatever is occupying an unavailable
   * port, by probing its `/api/health` for the LGTM signature
   * (`{app:"lgtm",...}`, design.md's "HTTP API" table). This never changes
   * which port gets chosen — a bound socket is never forcibly taken over
   * either way — it only labels the skipped port for logs and `/api/status`,
   * so an operator can tell "another LGTM daemon is already on 4747" from
   * "something unrelated is squatting on it". Omit it to skip classification
   * entirely and label every occupied port `"foreign"`.
   */
  probeOccupant?: (port: number) => Promise<boolean>;
}

export interface PortScanEntry {
  port: number;
  occupant: "lgtm" | "foreign";
}

export interface SelectPortResult {
  port: number;
  /** Every occupied port skipped on the way to `port`, in scan order. */
  skipped: PortScanEntry[];
}

/**
 * Find a port to bind, starting at `startPort` (default 4747) and scanning
 * forward through a small range (default 11 ports, matching design.md's
 * "scan to 4757") on conflict.
 */
export async function selectPort(
  deps: SelectPortDeps,
  startPort: number = DEFAULT_PORT,
  scanCount: number = DEFAULT_PORT_SCAN_COUNT
): Promise<SelectPortResult> {
  const skipped: PortScanEntry[] = [];

  for (let i = 0; i < scanCount; i++) {
    const port = startPort + i;
    if (await deps.tryBind(port)) {
      return { port, skipped };
    }

    const isLgtm = deps.probeOccupant ? await deps.probeOccupant(port).catch(() => false) : false;
    skipped.push({ port, occupant: isLgtm ? "lgtm" : "foreign" });
  }

  throw new Error(
    `no free port in range ${startPort}-${startPort + scanCount - 1}: every port in range was occupied`
  );
}

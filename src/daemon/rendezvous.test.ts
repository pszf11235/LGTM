/**
 * Offline, deterministic coverage for the rendezvous module (design.md,
 * "Daemon lifecycle" and "HTTP API"; R7.2, R7.5).
 *
 * "Dead pid" fixtures never guess a large, probably-unused pid number —
 * that is exactly the kind of hidden dependency on the host's process table
 * this suite has to avoid. Instead `deadPid()` spawns a real child, waits
 * for it to exit, and hands back its now-reaped pid: a number that
 * definitely used to be valid and, once `.exited` resolves, definitely is
 * not anymore.
 */
import { afterEach, describe, expect, test } from "bun:test";
import fs from "fs/promises";
import os from "os";
import path from "path";
import {
  acquireLock,
  daemonJsonPath,
  DEFAULT_PORT,
  ensureToken,
  isPidAlive,
  readDaemonInfo,
  removeDaemonInfo,
  resetStrandedPRs,
  selectPort,
  tokenPath,
  writeDaemonInfo,
  type DaemonInfo,
} from "./rendezvous";
import { loadMeta, saveMeta } from "../store/reviews";
import type { PRRef, PRState } from "@/core";

let store: string;
const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!();
});

async function tempStore(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lgtm-rendezvous-test-"));
  cleanups.push(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

/** A pid that used to be valid and, by the time this resolves, no longer is. */
async function deadPid(): Promise<number> {
  const proc = Bun.spawn(["true"], { stdout: "ignore", stderr: "ignore" });
  const pid = proc.pid;
  await proc.exited;
  return pid;
}

async function modeOf(file: string): Promise<number> {
  const stat = await fs.stat(file);
  return stat.mode & 0o777;
}

function daemonInfo(over: Partial<DaemonInfo> = {}): DaemonInfo {
  return { port: 4747, pid: process.pid, startedAt: "2026-08-29T10:00:00.000Z", ...over };
}

// ─── Token ──────────────────────────────────────────────────────────────────

describe("ensureToken", () => {
  test("mints a 32-byte (64 hex char) token on first run, at mode 0600", async () => {
    store = await tempStore();

    const token = await ensureToken(store);

    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(await modeOf(tokenPath(store))).toBe(0o600);
  });

  test("returns the same token on a later call — it survives a restart", async () => {
    store = await tempStore();

    const first = await ensureToken(store);
    const second = await ensureToken(store);

    expect(second).toBe(first);
    expect(await fs.readFile(tokenPath(store), "utf-8")).toBe(first);
  });

  test("an empty token file is treated as absent and regenerated", async () => {
    store = await tempStore();
    await fs.mkdir(store, { recursive: true });
    await fs.writeFile(tokenPath(store), "");

    const token = await ensureToken(store);

    expect(token).toMatch(/^[0-9a-f]{64}$/);
  });
});

// ─── daemon.json ────────────────────────────────────────────────────────────

describe("daemon.json read/write/remove", () => {
  test("writeDaemonInfo writes port, pid, startedAt at mode 0600", async () => {
    store = await tempStore();
    const info = daemonInfo({ port: 5000, pid: 4242 });

    await writeDaemonInfo(store, info);

    expect(await readDaemonInfo(store)).toEqual(info);
    expect(await modeOf(daemonJsonPath(store))).toBe(0o600);
  });

  test("readDaemonInfo returns null when the file is missing", async () => {
    store = await tempStore();
    expect(await readDaemonInfo(store)).toBeNull();
  });

  test("readDaemonInfo returns null for corrupt JSON rather than throwing", async () => {
    store = await tempStore();
    await fs.mkdir(store, { recursive: true });
    await fs.writeFile(daemonJsonPath(store), "{ this is not json ][");

    await expect(readDaemonInfo(store)).resolves.toBeNull();
  });

  test("readDaemonInfo returns null when a required field is missing or the wrong type", async () => {
    store = await tempStore();
    await fs.mkdir(store, { recursive: true });

    await fs.writeFile(daemonJsonPath(store), JSON.stringify({ port: 4747, pid: "not-a-number", startedAt: "x" }));
    expect(await readDaemonInfo(store)).toBeNull();

    await fs.writeFile(daemonJsonPath(store), JSON.stringify({ port: 4747, pid: 123 })); // startedAt missing
    expect(await readDaemonInfo(store)).toBeNull();
  });

  test("removeDaemonInfo deletes the file", async () => {
    store = await tempStore();
    await writeDaemonInfo(store, daemonInfo());

    await removeDaemonInfo(store);

    expect(await readDaemonInfo(store)).toBeNull();
    await expect(fs.access(daemonJsonPath(store))).rejects.toThrow();
  });

  test("removeDaemonInfo on a missing file is a no-op, not an error", async () => {
    store = await tempStore();
    await expect(removeDaemonInfo(store)).resolves.toBeUndefined();
  });

  test("the token survives a restart while daemon.json does not", async () => {
    store = await tempStore();

    const token = await ensureToken(store);
    await writeDaemonInfo(store, daemonInfo());

    // clean exit: daemon.json goes away, the token file is never touched
    await removeDaemonInfo(store);

    expect(await readDaemonInfo(store)).toBeNull();
    expect(await ensureToken(store)).toBe(token);
    expect(await fs.readFile(tokenPath(store), "utf-8")).toBe(token);
  });
});

// ─── Liveness ───────────────────────────────────────────────────────────────

describe("isPidAlive", () => {
  test("the current process's own pid is alive", () => {
    expect(isPidAlive(process.pid)).toBe(true);
  });

  test("a pid that has already exited is not alive", async () => {
    const pid = await deadPid();
    expect(isPidAlive(pid)).toBe(false);
  });

  test("pid 0 and negative pids are never considered alive (they'd target a process group, not a process)", () => {
    expect(isPidAlive(0)).toBe(false);
    expect(isPidAlive(-1)).toBe(false);
  });

  test("a non-integer pid is never considered alive", () => {
    expect(isPidAlive(1.5)).toBe(false);
    expect(isPidAlive(NaN)).toBe(false);
  });
});

// ─── Stale-pid recovery ─────────────────────────────────────────────────────

const ref: PRRef = { owner: "acme", repo: "api", number: 42 };
const otherRef: PRRef = { owner: "acme", repo: "api", number: 43 };

async function seedMeta(target: PRRef, state: PRState): Promise<void> {
  await saveMeta(store, target, { state, headSha: "a".repeat(40) });
}

describe("resetStrandedPRs", () => {
  test("flips a 'reviewing' PR back to 'queued'", async () => {
    store = await tempStore();
    await seedMeta(ref, "reviewing");

    const stranded = await resetStrandedPRs(store);

    expect(stranded).toEqual([ref]);
    expect((await loadMeta(store, ref))?.state).toBe("queued");
  });

  test("leaves an already-'queued' PR's state as 'queued', and still reports it as stranded", async () => {
    store = await tempStore();
    await seedMeta(ref, "queued");
    const before = await loadMeta(store, ref);

    const stranded = await resetStrandedPRs(store);

    expect(stranded).toEqual([ref]);
    const after = await loadMeta(store, ref);
    expect(after?.state).toBe("queued");
    expect(after?.updatedAt).toBe(before?.updatedAt); // no needless write when nothing actually changes
  });

  test("does not touch PRs in any other state", async () => {
    store = await tempStore();
    await seedMeta(ref, "reviewed");
    await seedMeta(otherRef, "triage");

    const stranded = await resetStrandedPRs(store);

    expect(stranded).toEqual([]);
    expect((await loadMeta(store, ref))?.state).toBe("reviewed");
    expect((await loadMeta(store, otherRef))?.state).toBe("triage");
  });

  test("resets across multiple repos, not just one", async () => {
    store = await tempStore();
    const inOtherRepo: PRRef = { owner: "other-org", repo: "web", number: 7 };
    await seedMeta(ref, "reviewing");
    await seedMeta(inOtherRepo, "reviewing");

    const stranded = await resetStrandedPRs(store);

    expect(stranded.length).toBe(2);
    expect((await loadMeta(store, inOtherRepo))?.state).toBe("queued");
  });
});

// ─── Single-instance lock ───────────────────────────────────────────────────

describe("acquireLock", () => {
  test("missing daemon.json: acquires the lock, nothing to recover from", async () => {
    store = await tempStore();

    const outcome = await acquireLock(store, () => {
      throw new Error("isAlive must not be consulted when there is no pid to check");
    });

    expect(outcome).toEqual({ status: "acquired", recoveredFrom: null, strandedPRs: [] });
  });

  test("a live pid refuses to start, and never touches the store", async () => {
    store = await tempStore();
    await seedMeta(ref, "reviewing"); // would be stranded if recovery ran
    const info = daemonInfo({ pid: 999 });
    await writeDaemonInfo(store, info);

    const outcome = await acquireLock(store, (pid) => pid === 999);

    expect(outcome).toEqual({ status: "refused", existing: info });
    expect((await loadMeta(store, ref))?.state).toBe("reviewing"); // untouched
  });

  test("a dead pid recovers: acquires the lock and resets stranded PRs", async () => {
    store = await tempStore();
    await seedMeta(ref, "reviewing");
    const info = daemonInfo({ pid: 999 });
    await writeDaemonInfo(store, info);

    const outcome = await acquireLock(store, (pid) => pid !== 999); // 999 reports dead

    expect(outcome.status).toBe("acquired");
    if (outcome.status === "acquired") {
      expect(outcome.recoveredFrom).toEqual(info);
      expect(outcome.strandedPRs).toEqual([ref]);
    }
    expect((await loadMeta(store, ref))?.state).toBe("queued");
  });

  test("a corrupt daemon.json does not block startup: acquires the lock and still recovers", async () => {
    store = await tempStore();
    await seedMeta(ref, "reviewing");
    await fs.mkdir(store, { recursive: true });
    await fs.writeFile(daemonJsonPath(store), "not valid json {{{");

    const outcome = await acquireLock(store, () => {
      throw new Error("isAlive must not be consulted when the pid can't even be read");
    });

    expect(outcome.status).toBe("acquired");
    if (outcome.status === "acquired") {
      expect(outcome.recoveredFrom).toBeNull();
      expect(outcome.strandedPRs).toEqual([ref]);
    }
    expect((await loadMeta(store, ref))?.state).toBe("queued");
  });

  test("defaults to the real signal-0 check when no isAlive is injected", async () => {
    store = await tempStore();

    // this process's own pid is alive: refused.
    await writeDaemonInfo(store, daemonInfo({ pid: process.pid }));
    const refused = await acquireLock(store);
    expect(refused.status).toBe("refused");

    // a pid that has actually exited: acquired.
    await writeDaemonInfo(store, daemonInfo({ pid: await deadPid() }));
    const acquired = await acquireLock(store);
    expect(acquired.status).toBe("acquired");
  });
});

// ─── Port selection ─────────────────────────────────────────────────────────

describe("selectPort", () => {
  test("returns the default port when it's free on the first try", async () => {
    const tryBind = async (port: number) => port === DEFAULT_PORT;

    const result = await selectPort({ tryBind });

    expect(result).toEqual({ port: DEFAULT_PORT, skipped: [] });
  });

  test("scans forward past occupied ports, classifying an LGTM occupant vs a foreign one", async () => {
    // 4747 is a stale/foreign occupant, 4748 is another LGTM instance, 4749 is free.
    const occupied = new Set([4747, 4748]);
    const lgtmPorts = new Set([4748]);
    const tryBind = async (port: number) => !occupied.has(port);
    const probeOccupant = async (port: number) => lgtmPorts.has(port);

    const result = await selectPort({ tryBind, probeOccupant });

    expect(result.port).toBe(4749);
    expect(result.skipped).toEqual([
      { port: 4747, occupant: "foreign" },
      { port: 4748, occupant: "lgtm" },
    ]);
  });

  test("without probeOccupant, every occupied port is labeled 'foreign'", async () => {
    const tryBind = async (port: number) => port !== DEFAULT_PORT;

    const result = await selectPort({ tryBind });

    expect(result.skipped).toEqual([{ port: DEFAULT_PORT, occupant: "foreign" }]);
  });

  test("throws once the whole scan range is occupied", async () => {
    const tryBind = async () => false;

    await expect(selectPort({ tryBind }, 4747, 3)).rejects.toThrow(/4747-4749/);
  });

  test("a probeOccupant that throws is treated as 'foreign' rather than failing the scan", async () => {
    const tryBind = async (port: number) => port !== DEFAULT_PORT;
    const probeOccupant = async () => {
      throw new Error("connection reset");
    };

    const result = await selectPort({ tryBind, probeOccupant });

    expect(result.skipped).toEqual([{ port: DEFAULT_PORT, occupant: "foreign" }]);
  });
});

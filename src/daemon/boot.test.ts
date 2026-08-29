/**
 * Offline, deterministic coverage for the boot sequence (design.md, "Daemon
 * lifecycle"; R7.2, R7.5).
 *
 * Every collaborator is injected: no port is bound, no process is spawned, no
 * request leaves the machine, and no timer fires on its own. The store is a
 * fresh temp directory per test, so the lock, the token file, and daemon.json
 * are the real files on disk rather than fakes.
 *
 * `waitFor` exists because two of the things worth asserting are deliberately
 * fire-and-forget: the scheduler's boot cycle, and the drain the quota gate
 * kicks when it reopens. Both settle in microtasks, so the loop polls rather
 * than sleeping for a fixed time.
 */
import { afterEach, describe, expect, test } from "bun:test";
import fs from "fs/promises";
import os from "os";
import path from "path";
import type { ForgeAdapter, PRRef } from "@/core";
import { DEFAULTS, type Config } from "@/store/config";
import { loadMeta, saveMeta } from "@/store/reviews";
import {
  createDaemon,
  type BindContext,
  type BoundServer,
  type Daemon,
  type DaemonOptions,
  type DaemonSignal,
} from "./boot";
import type { BinaryName, BinaryResolver, BinaryStatus } from "./binaries";
import type { CycleDeps, PollCycleResult } from "./cycle";
import { createEventBus, type DaemonEvent } from "./events";
import type { QuotaTimers } from "./quota";
import { daemonJsonPath, readDaemonInfo, tokenPath, writeDaemonInfo } from "./rendezvous";
import type { Clock, Ticker } from "./scheduler";

const ref: PRRef = { owner: "acme", repo: "api", number: 42 };

let store: string;
const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!();
});

async function tempStore(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lgtm-boot-test-"));
  cleanups.push(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

async function exists(file: string): Promise<boolean> {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

/** Poll until `condition` holds, or give up after ~500ms of event-loop turns. */
async function waitFor(condition: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 500; i++) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error(`timed out waiting for ${what}`);
}

// ─── Fakes ──────────────────────────────────────────────────────────────────

interface FakeBinaries extends BinaryResolver {
  probes: number;
}

function fakeBinaries(paths: Partial<Record<BinaryName, string>> = {}): FakeBinaries {
  const resolved: Partial<Record<BinaryName, string>> = {
    claude: "/opt/bin/claude",
    gh: "/opt/bin/gh",
    ...paths,
  };
  const binaries: FakeBinaries = {
    probes: 0,
    async probe() {
      binaries.probes += 1;
    },
    resolve: (name) => resolved[name] ?? null,
    async reportSpawnFailure() {},
    status: () =>
      (Object.keys(resolved) as BinaryName[]).map((name): BinaryStatus => {
        const found = resolved[name];
        return found
          ? { name, source: "probed", path: found }
          : { name, source: "missing", path: null };
      }),
  };
  return binaries;
}

/** Nothing in these tests polls a Forge; every call is a test failure. */
function fakeForge(): ForgeAdapter {
  const refuse = (method: string) => async (): Promise<never> => {
    throw new Error(`fakeForge: unexpected ${method}`);
  };
  return {
    listOpenPRs: refuse("listOpenPRs"),
    getPR: refuse("getPR"),
    getDiff: refuse("getDiff"),
    getCheckStatus: refuse("getCheckStatus"),
    createDraftReview: refuse("createDraftReview"),
    deleteDraftReview: refuse("deleteDraftReview"),
    getReview: refuse("getReview"),
    authenticatedUser: refuse("authenticatedUser"),
  };
}

interface FakeServer extends BoundServer {
  stops: number;
}

interface Harness {
  options: DaemonOptions;
  binaries: FakeBinaries;
  events: DaemonEvent[];
  /** Ports `bind` was asked for, in scan order. */
  binds: number[];
  /** What `bind` was handed alongside the port. */
  bindContexts: BindContext[];
  servers: FakeServer[];
  cycles: number;
  /** Deps the scheduler handed the poll cycle, so the wiring itself is assertable. */
  cycleDeps: CycleDeps | null;
  /** How often the quota gate asked the CLI what usage looks like. */
  probes: number;
  ghPaths: Array<string | null>;
  notifications: string[][];
  signals: Map<DaemonSignal, Array<() => void>>;
  tickerStops: number;
  quotaTimerHandles: number;
  quotaTimerClears: number;
  /** Whatever the next usage probe reports. */
  usage: { output: string; error: string | null };
  clock: Clock;
  advance(ms: number): void;
}

/**
 * A daemon whose every dependency is a fake. Individual tests override the
 * one seam they are about through `over`.
 */
function harness(over: Partial<DaemonOptions> = {}): Harness {
  const h: Harness = {
    options: {},
    binaries: fakeBinaries(),
    events: [],
    binds: [],
    bindContexts: [],
    servers: [],
    cycles: 0,
    cycleDeps: null,
    probes: 0,
    ghPaths: [],
    notifications: [],
    signals: new Map(),
    tickerStops: 0,
    quotaTimerHandles: 0,
    quotaTimerClears: 0,
    usage: { output: "Current session: 10% used", error: null },
    clock: { now: () => wall, monotonic: () => mono },
    advance(ms) {
      wall += ms;
      mono += ms;
    },
  };

  let wall = Date.parse("2026-08-29T10:00:00.000Z");
  let mono = 1_000;

  const bus = createEventBus();
  bus.on((event) => h.events.push(event));

  const ticker: Ticker = () => () => {
    h.tickerStops += 1;
  };

  const quotaTimers: QuotaTimers = {
    setInterval: () => {
      h.quotaTimerHandles += 1;
      return h.quotaTimerHandles;
    },
    clearInterval: () => {
      h.quotaTimerClears += 1;
    },
  };

  h.options = {
    lgtmDir: store,
    loadConfig: async (): Promise<Config> => ({ ...DEFAULTS }),
    pid: 4242,
    isPidAlive: () => false,
    binaries: h.binaries,
    resolveToken: (ghPath) => {
      h.ghPaths.push(ghPath);
      return "ghp_fake";
    },
    forge: fakeForge(),
    usageProbe: async () => {
      h.probes += 1;
      return h.usage;
    },
    cycle: async (deps): Promise<PollCycleResult> => {
      h.cycles += 1;
      h.cycleDeps = deps;
      return { startedAt: "2026-08-29T10:00:00.000Z", repos: [], error: null };
    },
    events: bus,
    notifySpawn: async (cmd) => {
      h.notifications.push(cmd);
      return { exitCode: 0 };
    },
    bind: async (port, context) => {
      h.binds.push(port);
      h.bindContexts.push(context);
      const server: FakeServer = {
        port,
        stops: 0,
        stop: () => {
          server.stops += 1;
        },
      };
      h.servers.push(server);
      return server;
    },
    probeOccupant: async () => false,
    clock: h.clock,
    ticker,
    random: () => 0.5,
    quotaTimers,
    setTimer: () => () => {},
    signals: {
      on: (signal, handler) => {
        const list = h.signals.get(signal) ?? [];
        list.push(handler);
        h.signals.set(signal, list);
      },
      off: (signal, handler) => {
        const list = h.signals.get(signal) ?? [];
        const index = list.indexOf(handler);
        if (index !== -1) list.splice(index, 1);
        h.signals.set(signal, list);
      },
    },
    ...over,
  };

  // An override replaces the resolver, so the handle tests assert on has to
  // follow it rather than pointing at the one that got thrown away.
  h.binaries = h.options.binaries as FakeBinaries;
  return h;
}

/** Boots, and registers the shutdown that keeps timers from leaking into the next test. */
async function boot(h: Harness): Promise<Daemon> {
  const result = await createDaemon(h.options);
  if (result.status !== "started") throw new Error("expected the daemon to start");
  cleanups.push(() => result.daemon.stop());
  return result.daemon;
}

// ─── The lock ───────────────────────────────────────────────────────────────

describe("createDaemon, single-instance lock", () => {
  test("refuses to start while a live pid holds the lock", async () => {
    store = await tempStore();
    await writeDaemonInfo(store, { port: 4747, pid: 999, startedAt: "2026-08-29T09:00:00.000Z" });
    const h = harness({ isPidAlive: (pid) => pid === 999 });

    const result = await createDaemon(h.options);

    expect(result.status).toBe("refused");
    if (result.status !== "refused") throw new Error("unreachable");
    expect(result.existing.pid).toBe(999);
    // Refused means refused: no socket, and the live daemon's rendezvous file
    // is left exactly as it was.
    expect(h.binds).toEqual([]);
    expect((await readDaemonInfo(store))?.pid).toBe(999);
  });

  test("refuses before anything is written, so the token is not minted either", async () => {
    store = await tempStore();
    await writeDaemonInfo(store, { port: 4747, pid: 999, startedAt: "2026-08-29T09:00:00.000Z" });
    const h = harness({ isPidAlive: () => true });

    await createDaemon(h.options);

    expect(await exists(tokenPath(store))).toBe(false);
    expect(h.binaries.probes).toBe(0);
  });

  test("takes over a dead pid and requeues what it stranded mid-round", async () => {
    store = await tempStore();
    await saveMeta(store, ref, { state: "reviewing", headSha: "a".repeat(40) });
    await writeDaemonInfo(store, { port: 4747, pid: 999, startedAt: "2026-08-29T09:00:00.000Z" });
    const h = harness({ isPidAlive: () => false });

    const daemon = await boot(h);

    expect(daemon.recoveredPRs).toEqual([ref]);
    expect((await loadMeta(store, ref))?.state).toBe("queued");
    // daemon.json now describes this daemon, not the corpse.
    const info = await readDaemonInfo(store);
    expect(info?.pid).toBe(4242);
    expect(info?.port).toBe(daemon.port);
    expect(daemon.status().recoveredPRs).toEqual([ref]);
  });
});

// ─── Boot order ─────────────────────────────────────────────────────────────

describe("createDaemon, boot sequence", () => {
  test("mints the token before binding, and hands the same one back", async () => {
    store = await tempStore();

    const daemon = await boot(harness());

    expect(daemon.token).toMatch(/^[0-9a-f]{64}$/);
    expect(await fs.readFile(tokenPath(store), "utf-8")).toBe(daemon.token);
  });

  test("probes the binaries and resolves the GitHub token through the resolved gh path", async () => {
    store = await tempStore();
    const h = harness({ binaries: fakeBinaries({ gh: "/nix/store/bin/gh" }) });

    const daemon = await boot(h);

    expect(h.binaries.probes).toBe(1);
    // R7.3: the token chain's `gh auth token` step is useless without an
    // absolute path, so the probe has to have run first.
    expect(h.ghPaths).toEqual(["/nix/store/bin/gh"]);
    expect(daemon.status().githubTokenPresent).toBe(true);
  });

  test("starts without a GitHub token rather than failing", async () => {
    store = await tempStore();
    const h = harness({ resolveToken: () => null });

    const daemon = await boot(h);

    expect(daemon.status().githubTokenPresent).toBe(false);
  });

  test("writes daemon.json only for the port it actually bound", async () => {
    store = await tempStore();
    const h = harness();
    h.options.bind = async (port) => {
      h.binds.push(port);
      if (port < 4749) return null; // 4747 and 4748 are taken
      const server: FakeServer = {
        port,
        stops: 0,
        stop: () => {
          server.stops += 1;
        },
      };
      h.servers.push(server);
      return server;
    };
    h.options.probeOccupant = async (port) => port === 4747;

    const daemon = await boot(h);

    expect(h.binds).toEqual([4747, 4748, 4749]);
    expect(daemon.port).toBe(4749);
    expect((await readDaemonInfo(store))?.port).toBe(4749);
    expect(daemon.status().portScan).toEqual([
      { port: 4747, occupant: "lgtm" },
      { port: 4748, occupant: "foreign" },
    ]);
  });

  test("hands the HTTP server the daemon parts its routes read", async () => {
    store = await tempStore();
    const h = harness();

    const daemon = await boot(h);

    // `/api/status`, `/api/events`, and the decision routes read these live,
    // so they have to be the daemon's own objects rather than copies.
    const context = h.bindContexts[0];
    expect(context?.lgtmDir).toBe(store);
    expect(context?.token).toBe(daemon.token);
    expect(context?.pid).toBe(4242);
    expect(context?.version).toBe(daemon.status().version);
    expect(context?.events).toBe(daemon.events);
    expect(context?.scheduler).toBe(daemon.scheduler);
    expect(context?.queue).toBe(daemon.queue);
    expect(context?.quota).toBe(daemon.quota);
    expect(context?.binaries).toBe(daemon.binaries);
    expect(context?.forge).toBe(daemon.forge);
  });

  test("does not write daemon.json when no port is free", async () => {
    store = await tempStore();
    const h = harness({ bind: async () => null, portScanCount: 3 });

    await expect(createDaemon(h.options)).rejects.toThrow(/no free port/);
    expect(await exists(daemonJsonPath(store))).toBe(false);
  });

  test("runs a poll cycle at boot and arms the scheduler", async () => {
    store = await tempStore();
    const h = harness();

    const daemon = await boot(h);

    await waitFor(() => h.cycles === 1, "the boot cycle");
    expect(daemon.scheduler.status().running).toBe(true);
    expect(daemon.status().lastCycle?.startedAt).toBe("2026-08-29T10:00:00.000Z");
    // The cycle polls this store, through this Forge, into this queue.
    expect(h.cycleDeps?.lgtmDir).toBe(store);
    expect(h.cycleDeps?.forge).toBe(h.options.forge!);
    expect(h.cycleDeps?.queue).toBe(daemon.queue);
    expect(h.cycleDeps?.events).toBe(daemon.events);
  });
});

// ─── Status ─────────────────────────────────────────────────────────────────

describe("createDaemon, status snapshot", () => {
  test("carries the tray contract", async () => {
    store = await tempStore();
    const h = harness();
    const daemon = await boot(h);
    h.advance(5_000);

    const status = daemon.status();

    expect(status.app).toBe("lgtm");
    expect(status.pid).toBe(4242);
    expect(status.port).toBe(daemon.port);
    expect(status.lgtmDir).toBe(store);
    expect(status.uptimeMs).toBe(5_000);
    expect(status.scheduler.running).toBe(true);
    expect(status.scheduler.intervalMinutes).toBe(DEFAULTS.interval_minutes);
    expect(status.queue).toEqual(daemon.queue.status());
    expect(status.quota.mode).toBe("ok");
    expect(status.quota.dailyCap).toBe(DEFAULTS.daily_cap);
    expect(status.binaries.map((entry) => entry.name)).toEqual(["claude", "gh"]);
    expect(status.version).toMatch(/^\d+\.\d+\.\d+/);
  });
});

// ─── The gate and the queue ─────────────────────────────────────────────────

describe("createDaemon, quota gate wiring", () => {
  test("holds the queue while throttled, then drains it when the gate reopens", async () => {
    store = await tempStore();
    const h = harness();
    h.usage = { output: "Current session: 92% used", error: null };
    const daemon = await boot(h);

    daemon.queue.enqueue(ref, "b".repeat(40));
    await waitFor(() => daemon.queue.status().pausedByGate, "the gate to hold the queue");
    expect(daemon.queue.status().queued).toBe(1);
    expect(daemon.status().quota.mode).toBe("throttled");

    // Usage drops. The gate reopens on the next reading, and the daemon is
    // what turns that into a drain: the queue's own hold retry is a backstop,
    // and this must not wait a minute for it.
    h.usage = { output: "Current session: 12% used", error: null };
    await daemon.quota.refresh();

    await waitFor(() => daemon.queue.status().queued === 0, "the queue to drain");
    expect(daemon.status().quota.mode).toBe("ok");
  });

  test("emits one quota-changed per transition, not one per callback", async () => {
    store = await tempStore();
    const h = harness();
    h.usage = { output: "Current session: 92% used", error: null };
    const daemon = await boot(h);

    await daemon.quota.refresh();
    const throttled = h.events.filter(
      (event) => event.type === "quota-changed" && event.mode === "throttled"
    );

    // onPause and onChange both fire on the way in. The SPA treats every
    // event as an invalidation hint, so a duplicate is a wasted refetch.
    expect(throttled.length).toBe(1);
  });
});

// ─── Shutdown ───────────────────────────────────────────────────────────────

describe("createDaemon, shutdown", () => {
  test("leaves no daemon.json and stops every moving part", async () => {
    store = await tempStore();
    const h = harness();
    const daemon = await boot(h);
    expect(await exists(daemonJsonPath(store))).toBe(true);

    await daemon.stop();

    expect(await exists(daemonJsonPath(store))).toBe(false);
    expect(h.servers[0]?.stops).toBe(1);
    expect(h.tickerStops).toBe(1);
    expect(h.quotaTimerClears).toBe(1);
    expect(daemon.scheduler.status().running).toBe(false);
    // The token outlives the daemon; a browser tab holding it must survive a
    // restart (design.md, "HTTP API").
    expect(await exists(tokenPath(store))).toBe(true);
  });

  test("stops dispatching new Rounds, without cancelling one already running", async () => {
    store = await tempStore();
    const h = harness();
    const daemon = await boot(h);
    await daemon.stop();

    const probesBefore = h.probes;
    daemon.queue.enqueue(ref, "c".repeat(40));
    await daemon.queue.drain();

    // A stopped queue holds its entries instead of handing them out, and the
    // gate is never even asked. Rounds already in flight are a different
    // matter: nothing here interrupts them, they finish or die with the
    // process.
    expect(daemon.queue.status().queued).toBe(1);
    expect(h.probes).toBe(probesBefore);
  });

  test("is idempotent", async () => {
    store = await tempStore();
    const h = harness();
    const daemon = await boot(h);

    await daemon.stop();
    await daemon.stop();
    await Promise.all([daemon.stop(), daemon.stop()]);

    expect(h.servers[0]?.stops).toBe(1);
    expect(h.quotaTimerClears).toBe(1);
    expect(await exists(daemonJsonPath(store))).toBe(false);
  });

  test("detaches its signal handlers", async () => {
    store = await tempStore();
    const h = harness();
    const daemon = await boot(h);
    expect(h.signals.get("SIGINT")?.length).toBe(1);
    expect(h.signals.get("SIGTERM")?.length).toBe(1);

    await daemon.stop();

    expect(h.signals.get("SIGINT")?.length).toBe(0);
    expect(h.signals.get("SIGTERM")?.length).toBe(0);
  });

  test("SIGTERM shuts the daemon down", async () => {
    store = await tempStore();
    const h = harness();
    await boot(h);

    h.signals.get("SIGTERM")?.[0]?.();

    await waitFor(() => h.servers[0]?.stops === 1, "the server to close");
    expect(await exists(daemonJsonPath(store))).toBe(false);
  });

  test("does not touch a live daemon's rendezvous file when it refused to start", async () => {
    store = await tempStore();
    const first = await boot(harness());
    const second = await createDaemon(harness({ isPidAlive: () => true, pid: 5555 }).options);

    expect(second.status).toBe("refused");
    const info = await readDaemonInfo(store);
    expect(info?.pid).toBe(first.pid);
    expect(info?.port).toBe(first.port);
  });
});

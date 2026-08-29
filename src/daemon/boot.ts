/**
 * Daemon boot and shutdown: the file that turns eleven independent modules
 * into one running `lgtm up` (design.md, "Architecture" and "Daemon
 * lifecycle").
 *
 * Nothing here decides anything. The Scheduler owns when a cycle runs, the
 * queue owns what runs next, the QuotaGate owns whether anything runs at all,
 * and `runCycle` owns what one poll does. This module owns the order they are
 * built in, the callbacks that connect them, and taking them all down again.
 *
 * The order is not cosmetic.
 *
 * 1. THE LOCK COMES FIRST, before a single byte is written anywhere. A second
 *    `lgtm up` next to a live one would give the store two writers, and the
 *    single-writer rule is what lets everything downstream read `meta.md`
 *    without coordination (design.md, "Architecture"). A refusal is a return
 *    value rather than a throw, because "another daemon is already running"
 *    is a normal thing for `lgtm up` to discover and report, not a crash.
 *
 * 2. BINARIES BEFORE THE TOKEN. `gh auth token` is the third step of the
 *    token chain and it needs an absolute path, since a launchd-started
 *    daemon has almost nothing on PATH (design.md, "Daemon lifecycle").
 *    Resolving the token before the probe would silently skip that step and
 *    report "no token" on a machine where `gh` is logged in.
 *
 * 3. DAEMON.JSON IS WRITTEN ON BIND, never before. The file says "a daemon is
 *    listening on this port", so writing it before the socket exists would
 *    publish a port nothing answers on, and the CLI would get ECONNREFUSED
 *    from a rendezvous file that looks perfectly healthy.
 *
 * Two connections deserve their own note, because both are easy to leave out
 * and neither fails loudly.
 *
 * THE GATE KICKS THE QUEUE. When the QuotaGate leaves `throttled`, the queue
 * is sitting on entries it was refused. The queue does schedule its own retry
 * a minute later, but that is a backstop for a gate that never reports
 * anything, not the path. Draining on the transition is what makes usage
 * dropping below `resume_below_pct` feel immediate instead of arriving up to
 * a minute late.
 *
 * SHUTDOWN NEVER CANCELS AN IN-FLIGHT ROUND. A Round takes minutes and writes
 * its result at the end. Killing one halfway leaves `meta.md` reading
 * `reviewing` with nothing on the way, which is exactly the stranded state
 * the next boot has to repair. So `stop()` stops new work starting and leaves
 * running Rounds to finish or to die with the process.
 *
 * Every collaborator is injectable, so the tests in boot.test.ts run the
 * whole sequence with no port bound, no process spawned, and no network.
 */

import packageJson from "../../package.json" with { type: "json" };
import type { ForgeAdapter, PRRef } from "@/core";
import { formatRef } from "@/core/pr-ref";
import { createGitHubAdapter, type EtagStore } from "@/forge/github/adapter";
import { resolveGitHubToken } from "@/forge/github/auth";
import { loadConfig as loadStoreConfig, type Config } from "@/store/config";
import { getStorePath } from "@/store/paths";
import { loadMeta } from "@/store/reviews";
import { createBinaryResolver, type BinaryResolver, type BinaryStatus } from "./binaries";
import {
  createDispatch,
  runCycle,
  type CycleDeps,
  type DispatchDeps,
  type PollCycleResult,
} from "./cycle";
import { createEventBus, type DaemonEvent, type EventBus } from "./events";
import { createNotifier, setUiPort, type SpawnFn } from "./notify";
import { createReviewQueue, type QueueSnapshot, type ReviewQueue } from "./queue";
import {
  createClaudeUsageProbe,
  createQuotaGate,
  type QuotaGate,
  type QuotaMode,
  type QuotaState,
  type QuotaTimers,
  type UsageProbe,
} from "./quota";
import {
  acquireLock,
  DEFAULT_PORT,
  ensureToken,
  isPidAlive as systemIsPidAlive,
  removeDaemonInfo,
  selectPort,
  writeDaemonInfo,
  type DaemonInfo,
  type PortScanEntry,
  type SelectPortResult,
} from "./rendezvous";
import {
  createScheduler,
  systemClock,
  systemTicker,
  type Clock,
  type Scheduler,
  type SchedulerStatus,
  type Ticker,
} from "./scheduler";

// ─── The HTTP seam ──────────────────────────────────────────────────────────

/** design.md, "HTTP API": the daemon binds to the loopback address only. */
export const HOSTNAME = "127.0.0.1";

/** What `bind` hands back once a port is claimed. Structurally a `Bun.Server`. */
export interface BoundServer {
  readonly port: number;
  stop(): void | Promise<void>;
}

/**
 * Everything a real HTTP server needs from the daemon, handed to `bind`.
 *
 * The API's routes read these parts directly, and every one of them exists by
 * the time the port is picked. Passing them in keeps the wiring one way, so
 * the daemon is never built around a server it has to hand itself to
 * afterwards through a mutable holder.
 *
 * No status snapshot here on purpose. The port is not known until `bind`
 * returns, and the API assembles its own `/api/status` from these parts.
 */
export interface BindContext {
  lgtmDir: string;
  token: string;
  pid: number;
  version: string;
  events: EventBus;
  scheduler: Scheduler;
  queue: ReviewQueue;
  quota: QuotaGate;
  binaries: BinaryResolver;
  forge: ForgeAdapter;
}

/**
 * Claim one port. Resolves to null when that port is taken, which is what
 * turns it into the next step of the scan, and rejects only on a failure
 * that retrying elsewhere would not fix.
 */
export type Bind = (port: number, context: BindContext) => Promise<BoundServer | null>;

export type FetchHandler = (request: Request) => Response | Promise<Response>;

/**
 * The daemon's HTTP handler, which arrives from src/api once that lands
 * (design.md, "HTTP API"). Until then the default answers `/api/health` and
 * nothing else, because the port scan's handshake needs a signature to read.
 * Two LGTM daemons racing for 4747 have to be able to tell each other apart
 * from a foreign process squatting on the port.
 */
function healthOnlyHandler(pid: number): FetchHandler {
  return (request) => {
    if (new URL(request.url).pathname === "/api/health") {
      return Response.json({ app: "lgtm", version: packageJson.version, pid });
    }
    return new Response("lgtm: the HTTP API is not mounted in this build\n", { status: 503 });
  };
}

/** The real bind, for production. Tests pass their own and never open a socket. */
export function bunBind(handler: FetchHandler): Bind {
  return async (port) => {
    try {
      const server = Bun.serve({ port, hostname: HOSTNAME, fetch: handler });
      return {
        // `server.port` is what actually got bound, which matters when the
        // caller passes 0. It is typed optional, so fall back to the request.
        port: server.port ?? port,
        stop: () => {
          server.stop(true);
        },
      };
    } catch (error) {
      if (isAddressInUse(error)) return null;
      throw error;
    }
  };
}

function isAddressInUse(error: unknown): boolean {
  if ((error as NodeJS.ErrnoException | null)?.code === "EADDRINUSE") return true;
  return error instanceof Error && /EADDRINUSE|address already in use/i.test(error.message);
}

/**
 * Ask an occupied port whether it is an LGTM daemon. Never changes which port
 * gets picked; it only labels the skipped one for `/api/status` and the log.
 */
async function probeLgtmHealth(port: number): Promise<boolean> {
  try {
    const response = await fetch(`http://${HOSTNAME}:${port}/api/health`, {
      signal: AbortSignal.timeout(1000),
    });
    if (!response.ok) return false;
    const body = (await response.json()) as { app?: unknown };
    return body?.app === "lgtm";
  } catch {
    return false;
  }
}

// ─── Signals ────────────────────────────────────────────────────────────────

export type DaemonSignal = "SIGINT" | "SIGTERM";

/** Structurally `process`, narrowed to the two signals the daemon handles. */
export interface SignalTarget {
  on(signal: DaemonSignal, handler: () => void): void;
  off(signal: DaemonSignal, handler: () => void): void;
}

const DAEMON_SIGNALS: readonly DaemonSignal[] = ["SIGINT", "SIGTERM"];

// ─── Options ────────────────────────────────────────────────────────────────

export interface DaemonOptions {
  /** Store root. Defaults to `~/.lgtm-farm`. */
  lgtmDir?: string;
  /**
   * Reads `config.md`. The store's own loader resolves the path from HOME, so
   * a test pointing `lgtmDir` at a temp directory has to pass this too.
   */
  loadConfig?: () => Promise<Config>;
  /** Recorded in daemon.json. Defaults to this process. */
  pid?: number;
  /** Liveness check for the lock. Defaults to the signal-0 probe. */
  isPidAlive?: (pid: number) => boolean;
  /** Defaults to a login-shell resolver carrying config.md's pins. */
  binaries?: BinaryResolver;
  /** Defaults to the shared chain in @/forge/github/auth. */
  resolveToken?: (ghPath: string | null) => string | null;
  /** Defaults to the GitHub adapter over the resolved `gh` path. */
  forge?: ForgeAdapter;
  /** Defaults to `claude -p /usage` through the resolved `claude` path. */
  usageProbe?: UsageProbe;
  /** The poll cycle itself. Defaults to `runCycle`. */
  cycle?: (deps: CycleDeps) => Promise<PollCycleResult>;
  /** The Provider run inside a Round. Defaults to the real runner. */
  review?: DispatchDeps["review"];
  /** Defaults to a fresh in-process bus. */
  events?: EventBus;
  /** How the notifier spawns terminal-notifier or osascript. */
  notifySpawn?: SpawnFn;
  /** Defaults to `Bun.serve` on 127.0.0.1. */
  bind?: Bind;
  /** The HTTP handler for the default bind. Defaults to health only. */
  fetch?: FetchHandler;
  /** First port of the scan. Defaults to 4747. */
  port?: number;
  /** How many ports the scan covers. Defaults to 11, so 4747 to 4757. */
  portScanCount?: number;
  /** Classifies an occupied port. Defaults to an `/api/health` probe. */
  probeOccupant?: (port: number) => Promise<boolean>;
  /** Scheduler clock. Also the source of the millisecond and ISO clocks below. */
  clock?: Clock;
  ticker?: Ticker;
  random?: () => number;
  tickMs?: number;
  /** Millisecond clock for the queue and the gate. Defaults to `clock.now()`. */
  now?: () => number;
  /** ISO clock for the cycle, Rounds, and daemon.json. Defaults to `now()`. */
  isoNow?: () => string;
  /** The gate's background-refresh timer. */
  quotaTimers?: QuotaTimers;
  /** The queue's hold-retry timer. */
  setTimer?: (fn: () => void, ms: number) => () => void;
  /** Where SIGINT and SIGTERM come from. Defaults to `process`; null skips the wiring. */
  signals?: SignalTarget | null;
  /** Daemon log sink. Defaults to silence, which is what the tests want. */
  log?: (line: string) => void;
}

// ─── The running daemon ─────────────────────────────────────────────────────

/**
 * `GET /api/status` (design.md, "HTTP API"), and the same contract the v1.1
 * tray reads. Everything here is in memory and synchronous, so a tray polling
 * every few seconds never touches the store or the Forge.
 *
 * The two counts design.md also lists for that route, PRs awaiting the Gate
 * and PRs awaiting triage, are store reads. The API layer joins them onto
 * this snapshot rather than the daemon holding a cache of them.
 */
export interface DaemonStatus {
  app: "lgtm";
  version: string;
  pid: number;
  port: number;
  /** ISO 8601, when this daemon bound its port. */
  startedAt: string;
  uptimeMs: number;
  lgtmDir: string;
  scheduler: SchedulerStatus;
  /** The last completed poll, with its per-repo outcomes. Null until one finishes. */
  lastCycle: PollCycleResult | null;
  queue: QueueSnapshot;
  quota: QuotaState;
  binaries: BinaryStatus[];
  /** Whether the token chain resolved anything at boot. The value never leaves the daemon. */
  githubTokenPresent: boolean;
  /** PRs this boot recovered from a crashed run. */
  recoveredPRs: PRRef[];
  /** Occupied ports skipped on the way to `port`, each labelled lgtm or foreign. */
  portScan: PortScanEntry[];
}

export interface Daemon {
  readonly lgtmDir: string;
  readonly port: number;
  /** The bearer token every `/api/*` route except health requires. */
  readonly token: string;
  readonly pid: number;
  readonly startedAt: string;
  readonly events: EventBus;
  readonly scheduler: Scheduler;
  readonly queue: ReviewQueue;
  readonly quota: QuotaGate;
  readonly binaries: BinaryResolver;
  readonly forge: ForgeAdapter;
  /** PRs reset out of a crashed run's `queued` or `reviewing`. */
  readonly recoveredPRs: PRRef[];
  status(): DaemonStatus;
  /** Clean, idempotent shutdown. Safe to call from a signal handler and again after. */
  stop(): Promise<void>;
}

export type BootResult =
  | { status: "started"; daemon: Daemon }
  | {
      /** A live daemon holds the lock. Nothing was started and nothing was written. */
      status: "refused";
      existing: DaemonInfo;
    };

// ─── Boot ───────────────────────────────────────────────────────────────────

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** In memory, shared by the Forge adapter and the cycle. The cycle backs it with watch.md. */
function createEtagCache(): EtagStore {
  const entries = new Map<string, string>();
  return {
    get: (key) => entries.get(key) ?? null,
    set: (key, etag) => {
      if (etag === null) entries.delete(key);
      else entries.set(key, etag);
    },
  };
}

/**
 * Build and start the daemon, or refuse because another one is already
 * running. See the module comment for why the steps are in this order.
 */
export async function createDaemon(options: DaemonOptions = {}): Promise<BootResult> {
  const lgtmDir = options.lgtmDir ?? getStorePath();
  const log = options.log ?? (() => {});
  const pid = options.pid ?? process.pid;

  const clock = options.clock ?? systemClock;
  const msNow = options.now ?? (() => clock.now());
  const isoNow = options.isoNow ?? (() => new Date(msNow()).toISOString());

  // 1. The lock. Nothing below this point runs next to a live daemon.
  const lock = await acquireLock(lgtmDir, options.isPidAlive ?? systemIsPidAlive);
  if (lock.status === "refused") {
    log(`boot: pid ${lock.existing.pid} is already serving ${lgtmDir} on port ${lock.existing.port}`);
    return { status: "refused", existing: lock.existing };
  }
  if (lock.recoveredFrom !== null) {
    log(`boot: taking over from dead pid ${lock.recoveredFrom.pid}`);
  }
  if (lock.strandedPRs.length > 0) {
    log(`boot: requeued ${lock.strandedPRs.length} PR(s) stranded by the previous run`);
  }

  // 2. The bearer token, minted once and kept across restarts.
  const token = await ensureToken(lgtmDir);

  // 3. Config, then the binary probe it carries pins for.
  const config = await (options.loadConfig ?? loadStoreConfig)();
  const binaries =
    options.binaries ??
    createBinaryResolver({ pins: { claude: config.claude_path, gh: config.gh_path } });
  await binaries.probe();

  // 4. The GitHub token, through the path the probe just resolved.
  const resolveToken = options.resolveToken ?? resolveGitHubToken;
  const ghPath = binaries.resolve("gh");
  const githubTokenPresent = resolveToken(ghPath) !== null;
  if (!githubTokenPresent) {
    log("boot: no GitHub token resolved; every poll will fail until one is available");
  }

  // 5. The Forge, sharing its ETag cache with the cycle that persists it.
  const etags = createEtagCache();
  const forge = options.forge ?? createGitHubAdapter({ ghPath, resolveToken, etags });

  const events = options.events ?? createEventBus();
  const emit = (event: DaemonEvent): void => {
    try {
      events.emit(event);
    } catch (error) {
      // The bus delivers synchronously and catches nothing, so a listener that
      // throws would otherwise take the gate or the queue down with it.
      log(`boot: event listener threw on ${event.type}: ${messageOf(error)}`);
    }
  };

  const stopNotifier = createNotifier({
    binaries,
    bus: events,
    spawn: options.notifySpawn,
    now: msNow,
    logger: { log },
    // pr-changed carries only a ref, and the cycle emits it on every meta
    // write. The notifier reads the state to tell a PR genuinely arriving in
    // triage from one whose metadata merely changed.
    getPRState: async (ref) => (await loadMeta(lgtmDir, ref))?.state ?? null,
  });

  // 6. The quota gate. Its two callbacks are the whole reason this module
  //    exists. The notifier only ever hears about a pause through the bus, and
  //    the queue only learns that the gate reopened if something tells it.
  const queueRef: { queue: ReviewQueue | null } = { queue: null };
  let quotaMode: QuotaMode = "ok";
  let lastQuotaEvent: string | null = null;

  /**
   * One `quota-changed` per distinct reading. `onPause` and `onChange` both
   * fire on the way into `throttled`, in that order, and the SPA treats every
   * event as an invalidation hint, so without this it refetches twice for one
   * transition.
   */
  const emitQuota = (mode: QuotaMode, maxPercent: number | null): void => {
    const signature = `${mode}:${maxPercent ?? "unknown"}`;
    if (signature === lastQuotaEvent) return;
    lastQuotaEvent = signature;
    emit({ type: "quota-changed", mode });
  };

  const quota = createQuotaGate({
    probe:
      options.usageProbe ??
      createClaudeUsageProbe({
        binPath: () => binaries.resolve("claude"),
        onSpawnFailure: () => binaries.reportSpawnFailure("claude"),
      }),
    thresholds: {
      pause_above_pct: config.pause_above_pct,
      resume_below_pct: config.resume_below_pct,
      daily_cap: config.daily_cap,
    },
    now: msNow,
    log: (decision) =>
      log(`quota: ${decision.allowed ? "allow" : "hold"} [${decision.mode}] ${decision.reason}`),
    onPause: (pause) => {
      log(`quota: paused at ${pause.maxPercent}% (${pause.dedupeKey})`);
      emitQuota("throttled", pause.maxPercent);
    },
    onChange: (state) => {
      const reopened = quotaMode === "throttled" && state.mode !== "throttled";
      quotaMode = state.mode;
      emitQuota(state.mode, state.maxPercent);
      if (reopened) {
        log("quota: gate reopened, draining the queue");
        void queueRef.queue?.drain();
      }
    },
    timers: options.quotaTimers,
  });

  // 7. The queue, gated by the quota gate and dispatching whole Rounds.
  const queue = createReviewQueue({
    dispatch: createDispatch({
      lgtmDir,
      forge,
      events,
      binPath: () => binaries.resolve("claude"),
      review: options.review,
      now: isoNow,
      log,
    }),
    canDispatch: async () => (await quota.requestDispatch()).allowed,
    concurrency: config.concurrency,
    now: msNow,
    setTimer: options.setTimer,
    onError: (failure) => {
      const where = failure.entry ? ` for ${formatRef(failure.entry.ref)}` : "";
      log(`queue: ${failure.phase} failed${where}: ${messageOf(failure.error)}`);
      // The cause carries no ref, so one broken CLI notifies once however
      // many PRs hit it (R8.2).
      emit({ type: "error", cause: `queue ${failure.phase}: ${messageOf(failure.error)}` });
    },
  });
  queueRef.queue = queue;

  // 8. The scheduler over the poll cycle.
  const cycleDeps: CycleDeps = { lgtmDir, forge, queue, events, etags, now: isoNow, log };
  const cycle = options.cycle ?? runCycle;
  let lastCycle: PollCycleResult | null = null;

  const scheduler = createScheduler({
    cycle: async () => {
      lastCycle = await cycle(cycleDeps);
    },
    intervalMinutes: config.interval_minutes,
    clock,
    ticker: options.ticker ?? systemTicker,
    random: options.random,
    tickMs: options.tickMs,
    onCycleFinished: (outcome) =>
      log(`cycle: ${outcome.trigger} ${outcome.status} in ${outcome.durationMs}ms`),
    onError: (error, trigger) => {
      log(`cycle: ${trigger} threw: ${messageOf(error)}`);
      emit({ type: "error", cause: `cycle: ${messageOf(error)}` });
    },
  });

  // 9. The port, and daemon.json once the socket is real.
  const bindContext: BindContext = {
    lgtmDir,
    token,
    pid,
    version: packageJson.version,
    events,
    scheduler,
    queue,
    quota,
    binaries,
    forge,
  };
  const bound: { server: BoundServer | null } = { server: null };
  let selection: SelectPortResult;
  try {
    const bind = options.bind ?? bunBind(options.fetch ?? healthOnlyHandler(pid));
    selection = await selectPort(
      {
        tryBind: async (candidate) => {
          const server = await bind(candidate, bindContext);
          if (!server) return false;
          bound.server = server;
          return true;
        },
        probeOccupant: options.probeOccupant ?? probeLgtmHealth,
      },
      options.port ?? DEFAULT_PORT,
      options.portScanCount
    );
  } catch (error) {
    // Nothing is running yet, but the notifier is already on the bus.
    stopNotifier();
    throw error;
  }

  for (const skipped of selection.skipped) {
    log(`boot: port ${skipped.port} is busy (${skipped.occupant})`);
  }

  const startedAtMs = msNow();
  const startedAt = isoNow();
  await writeDaemonInfo(lgtmDir, { port: selection.port, pid, startedAt });
  setUiPort(selection.port);
  log(`boot: listening on http://${HOSTNAME}:${selection.port}`);

  // ── Shutdown ─────────────────────────────────────────────────────────────

  const handlers: Array<[DaemonSignal, () => void]> = [];
  const signals = options.signals === null ? null : (options.signals ?? process);

  function detachSignals(): void {
    if (!signals) return;
    for (const [signal, handler] of handlers) signals.off(signal, handler);
    handlers.length = 0;
  }

  async function shutdown(): Promise<void> {
    log("boot: shutting down");
    try {
      detachSignals();
      // The scheduler first, so no cycle starts while the rest comes apart.
      // Its stop() settles once the running cycle has.
      await scheduler.stop();
      quota.stop();
      // New dispatches stop here. Rounds already running are left alone; see
      // the module comment.
      queue.stop();
      stopNotifier();
      setUiPort(null);
      try {
        await bound.server?.stop();
      } catch (error) {
        log(`boot: closing the server failed: ${messageOf(error)}`);
      }
    } finally {
      await removeDaemonInfo(lgtmDir);
    }
  }

  let stopping: Promise<void> | null = null;
  function stop(): Promise<void> {
    stopping ??= shutdown();
    return stopping;
  }

  if (signals) {
    for (const signal of DAEMON_SIGNALS) {
      const handler = (): void => {
        log(`boot: ${signal} received`);
        void stop();
      };
      signals.on(signal, handler);
      handlers.push([signal, handler]);
    }
  }

  // 10. Run. The scheduler's boot cycle starts immediately and is not awaited.
  scheduler.start();
  quota.start(() => {
    // In-flight Rounds count. A queue whose entries are all running still
    // needs a fresh reading before the next one is let through.
    const snapshot = queue.status();
    return snapshot.queued + snapshot.inFlight;
  });

  const daemon: Daemon = {
    lgtmDir,
    port: selection.port,
    token,
    pid,
    startedAt,
    events,
    scheduler,
    queue,
    quota,
    binaries,
    forge,
    recoveredPRs: lock.strandedPRs,
    status: () => ({
      app: "lgtm",
      version: packageJson.version,
      pid,
      port: selection.port,
      startedAt,
      uptimeMs: Math.max(0, msNow() - startedAtMs),
      lgtmDir,
      scheduler: scheduler.status(),
      lastCycle,
      queue: queue.status(),
      quota: quota.state(),
      binaries: binaries.status(),
      githubTokenPresent,
      recoveredPRs: lock.strandedPRs,
      portScan: selection.skipped,
    }),
    stop,
  };

  return { status: "started", daemon };
}

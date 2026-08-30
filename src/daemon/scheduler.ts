/**
 * The cycle Scheduler, the part that makes the Watcher a watcher (CONTEXT.md,
 * "Watcher"). One poll cycle at daemon start, one every `interval_minutes`
 * after that, and one on wake from sleep (requirements R1.1, R1.2; design.md,
 * "Poll cycle" and "Daemon lifecycle").
 *
 * The failure this module exists to prevent is not a wrong interval. It is
 * silence. A daemon that has stopped polling looks exactly like a daemon with
 * nothing to report, and the user finds out days later. Three rules follow,
 * each with tests that exist only because the failure is otherwise invisible.
 *
 * 1. THE OVERLAP GUARD IS RELEASED IN A `finally`. The old watcher awaited a
 *    bare `cycle()` inside its interval callback with no guard at all, so a
 *    slow cycle overlapped the next one. The obvious repair, a boolean set
 *    before the call and cleared after it, is worse than the bug it fixes. A
 *    cycle that REJECTS leaves the flag stuck true, and every later cycle is
 *    skipped forever without a word. Here a `finally` releases the guard and
 *    re-arms the next due time, whether the cycle returned, threw, or
 *    rejected.
 *
 * 2. DUE TIMES LIVE ON THE MONOTONIC CLOCK, never on the wall clock. An NTP
 *    step or a manual clock change moves `Date.now()` by hours. A due time
 *    computed from it lands that far out, and polling stops until the wall
 *    clock catches up. Wall time only shows up in what the status endpoint
 *    reports and in wake detection.
 *
 * 3. NOTHING THE CALLER SUPPLIES CAN STOP THE TICK. A throwing cycle, a
 *    throwing status listener, a nonsense `interval_minutes` hand-edited into
 *    config.md. Each of them degrades to a logged outcome, and the next tick
 *    still runs.
 *
 * Wake detection. Timers do not fire while a Mac sleeps, so a 15-minute timer
 * armed before an overnight sleep fires eight hours late, and R1.2 wants a
 * catch-up cycle the moment the machine is back. Rather than bind to an IOKit
 * notification, the scheduler ticks on a short heartbeat and looks for a gap
 * no heartbeat can explain. It compares two clock readings rather than one,
 * because the monotonic clock's own behaviour across suspend is not something
 * to bet a daemon on. On some platforms it pauses with the machine, on others
 * it keeps counting. If it paused, wall time ran ahead of monotonic time and
 * the difference is the sleep. If it kept counting, both clocks agree, but the
 * heartbeat arrives far later than its own period, and that lateness is the
 * sleep. Either signal past the threshold counts as a wake, so a large forward
 * clock step costs one extra cycle rather than a missed one.
 *
 * The scheduler takes its clock and its ticker as arguments. Real timers would
 * make every test in scheduler.test.ts either slow or a coin flip, and the
 * behaviours that matter most here, an eight-hour sleep or a rejecting cycle
 * two hundred cycles in, cannot be observed any other way.
 */

// ─── Injected time ──────────────────────────────────────────────────────────

export interface Clock {
  /** Epoch milliseconds. Steps when NTP or the user changes the system clock. */
  now(): number;
  /**
   * Milliseconds from an arbitrary origin, never stepped by clock changes.
   * Whether it advances while the machine is asleep is platform business, and
   * wake detection below works either way.
   */
  monotonic(): number;
}

export const systemClock: Clock = {
  now: () => Date.now(),
  monotonic: () => performance.now(),
};

/** Cancels a running tick. Safe to call more than once. */
export type StopTicking = () => void;

/**
 * Starts a repeating tick. Modelled as one call returning its own canceller
 * so there is no handle type to thread through, and so the fake in the tests
 * is four lines.
 */
export type Ticker = (intervalMs: number, onTick: () => void) => StopTicking;

export const systemTicker: Ticker = (intervalMs, onTick) => {
  // Deliberately not unref'd. A scheduler that lets the process exit is one
  // more way for the daemon to go quiet.
  const handle = setInterval(onTick, intervalMs);
  return () => clearInterval(handle);
};

// ─── Cycles ─────────────────────────────────────────────────────────────────

/** Why a cycle ran. Carried into the cycle function and into the status snapshot. */
export type CycleTrigger = "boot" | "interval" | "wake" | "manual";

/**
 * One poll cycle over every watched repo (design.md, "Poll cycle"). It may
 * throw; the scheduler records that as a failed cycle and keeps going. It must
 * not be relied on to keep its own schedule.
 */
export type CycleFn = (trigger: CycleTrigger) => void | Promise<void>;

/**
 * What one cycle did. `status` mirrors the vocabulary the Provider layer
 * already uses for a Round, so `/api/status` renders one shape, not two.
 */
export interface CycleOutcome {
  status: "ok" | "failed";
  trigger: CycleTrigger;
  /** ISO 8601, from the wall clock, taken when the cycle started. */
  startedAt: string;
  durationMs: number;
  /** Null when the status is "ok". */
  error: string | null;
}

/**
 * The scheduler half of the tray contract (design.md, "HTTP API", `/api/status`;
 * the v1.1 MenuBarExtra greys its icon within 30 seconds of daemon death and
 * needs `nextCycleAt` to say when the next poll is due).
 */
export interface SchedulerStatus {
  running: boolean;
  cycleInFlight: boolean;
  /** ISO 8601, when `start()` was last called. */
  startedAt: string | null;
  /** ISO 8601, when the most recent cycle began. */
  lastCycleAt: string | null;
  lastCycleOutcome: CycleOutcome | null;
  /** ISO 8601 estimate, null while stopped. Reads as "now" during a cycle. */
  nextCycleAt: string | null;
  /** Cycles started since construction, across start/stop. */
  cycles: number;
  /** Cycles the overlap guard refused. A steady climb means cycles outlast the interval. */
  overlapSkips: number;
  wakes: number;
  intervalMinutes: number;
}

export interface Scheduler {
  /** Arms the heartbeat and runs the boot cycle. Does not wait for it. Idempotent. */
  start(): void;
  /**
   * Cancels the heartbeat. The returned promise settles once any in-flight
   * cycle has, so shutdown can wait for a clean stop; callers that must not
   * block (a Ctrl-C handler waiting on a ten-minute review) can ignore it.
   * Idempotent.
   */
  stop(): Promise<void>;
  /**
   * Runs a cycle now, outside the schedule. Resolves to null when the overlap
   * guard refused it. Works while stopped, for a one-shot poll.
   */
  runNow(trigger?: CycleTrigger): Promise<CycleOutcome | null>;
  /** Resolves when no cycle is in flight. */
  whenIdle(): Promise<void>;
  /**
   * Applies a new `interval_minutes` without a restart. A value that is not a
   * positive finite number falls back to the default rather than stopping or
   * hot-looping the daemon.
   */
  setIntervalMinutes(minutes: number): void;
  status(): SchedulerStatus;
}

export interface SchedulerOptions {
  cycle: CycleFn;
  /** Defaults to DEFAULT_INTERVAL_MINUTES, which tracks config.md's own default. */
  intervalMinutes?: number;
  /**
   * Half-width of the jitter applied to every interval, in milliseconds.
   * Defaults to a tenth of the interval, capped at MAX_JITTER_MS.
   */
  jitterMs?: number;
  /** Heartbeat period. Also the resolution at which a due cycle is noticed. */
  tickMs?: number;
  /** Unexplained gap that counts as a wake. */
  wakeGapMs?: number;
  clock?: Clock;
  ticker?: Ticker;
  /** Jitter source, injected so tests get exact due times. Returns [0, 1). */
  random?: () => number;
  /** Fed to the event bus as `cycle-finished`. A throw here never reaches the tick. */
  onCycleFinished?: (outcome: CycleOutcome) => void;
  /** The raw error behind a failed cycle, for the daemon log. Never rethrown. */
  onError?: (error: unknown, trigger: CycleTrigger) => void;
}

// ─── Defaults ───────────────────────────────────────────────────────────────

/**
 * R1.1's fifteen minutes. A test, rather than an import, keeps this in step
 * with `DEFAULTS.interval_minutes` in src/store/config.ts, so the scheduler
 * stays clear of the store's file layer. The two drifted apart in the old
 * codebase, which is why "the interval default matches its documentation" is
 * on the regression checklist (design.md, "Testing").
 */
export const DEFAULT_INTERVAL_MINUTES = 15;

/**
 * A heartbeat is two clock reads and a comparison, not a poll, so thirty
 * seconds of it costs nothing and puts wake detection within half a minute of
 * the lid opening.
 */
export const DEFAULT_TICK_MS = 30_000;

/**
 * Below two minutes, a stalled event loop or a slow tick looks like a wake.
 * Above it, nothing but a real suspend (or a clock step) gets this far.
 */
export const DEFAULT_WAKE_GAP_MS = 120_000;

/** Jitter ceiling, so a long interval does not smear the poll across minutes. */
export const MAX_JITTER_MS = 60_000;

/** Floor on any computed delay, so a pathological config cannot busy-poll GitHub. */
export const MIN_CYCLE_DELAY_MS = 1_000;

/** Floor on the heartbeat, so a tiny configured interval cannot spin the loop. */
const MIN_TICK_MS = 250;

/** Only reachable through an injected clock that returns something unusable. */
const EPOCH_ISO = new Date(0).toISOString();

// ─── Factory ────────────────────────────────────────────────────────────────

export function createScheduler(options: SchedulerOptions): Scheduler {
  const cycle = options.cycle;
  const clock = options.clock ?? systemClock;
  const ticker = options.ticker ?? systemTicker;
  const random = options.random ?? Math.random;
  const wakeGapMs = positiveOr(options.wakeGapMs, DEFAULT_WAKE_GAP_MS);
  const configuredTickMs = positiveOr(options.tickMs, DEFAULT_TICK_MS);

  let intervalMinutes = sanitizeInterval(options.intervalMinutes);
  let running = false;
  let stopTicking: StopTicking | null = null;
  let tickPeriodMs = 0;

  /**
   * The guard. `inFlight` answers "may another cycle start", `inFlightCycle` is
   * what `whenIdle` and `stop` await. One `finally` clears both.
   */
  let inFlight = false;
  let inFlightCycle: Promise<CycleOutcome> | null = null;

  /**
   * A wake or manual trigger the guard refused, kept rather than dropped,
   * because it asked for something the running cycle may have missed. Redeemed at
   * the next tick, carrying its own label so the status snapshot still says
   * why the daemon polled.
   */
  let deferredTrigger: CycleTrigger | null = null;

  /** Monotonic, never wall: see rule 2 in the module comment. */
  let nextDueMono = 0;
  let lastTickWall = 0;
  let lastTickMono = 0;

  let startedAtWall: number | null = null;
  let lastCycleAtWall: number | null = null;
  let lastOutcome: CycleOutcome | null = null;
  let cycles = 0;
  let overlapSkips = 0;
  let wakes = 0;

  // ── Scheduling arithmetic ────────────────────────────────────────────────

  function intervalMs(): number {
    return intervalMinutes * 60_000;
  }

  function jitterSpanMs(): number {
    const explicit = options.jitterMs;
    if (explicit !== undefined && Number.isFinite(explicit) && explicit >= 0) return explicit;
    return Math.min(MAX_JITTER_MS, Math.round(intervalMs() / 10));
  }

  /**
   * Symmetric jitter around the configured interval, so the average cadence is
   * the number in config.md rather than that number plus a drift nobody
   * documented. Its job is to keep restarts from lining every repo's poll up
   * on the same second.
   */
  function nextDelayMs(): number {
    const spread = (clamp01(random()) * 2 - 1) * jitterSpanMs();
    return Math.max(MIN_CYCLE_DELAY_MS, Math.round(intervalMs() + spread));
  }

  function armNextCycle(): void {
    nextDueMono = clock.monotonic() + nextDelayMs();
  }

  /** End-of-cycle arming: a refused wake or manual trigger jumps the queue. */
  function armAfterCycle(): void {
    if (deferredTrigger !== null) {
      nextDueMono = clock.monotonic(); // due now; the next tick carries the label.
      return;
    }
    armNextCycle();
  }

  function tickPeriod(): number {
    return Math.max(MIN_TICK_MS, Math.min(configuredTickMs, intervalMs()));
  }

  /** Monotonic, so a cycle's reported duration survives a clock change mid-cycle. */
  function elapsedSince(startedMono: number): number {
    return Math.max(0, Math.round(clock.monotonic() - startedMono));
  }

  // ── Running one cycle ────────────────────────────────────────────────────

  /**
   * Never rejects and never throws. It contains whatever the caller's cycle
   * and listeners do, because the caller that matters is a tick with nowhere
   * to put an error.
   */
  async function execute(trigger: CycleTrigger): Promise<CycleOutcome> {
    const startedWall = clock.now();
    const startedMono = clock.monotonic();
    const startedAt = toISO(startedWall) ?? EPOCH_ISO;
    lastCycleAtWall = startedWall;
    cycles += 1;

    // Provisional, so ticks during a long cycle are not all counted as
    // overlaps; armAfterCycle() has the last word.
    armNextCycle();

    let outcome: CycleOutcome;
    try {
      await cycle(trigger);
      outcome = {
        status: "ok",
        trigger,
        startedAt,
        durationMs: elapsedSince(startedMono),
        error: null,
      };
    } catch (error) {
      outcome = {
        status: "failed",
        trigger,
        startedAt,
        durationMs: elapsedSince(startedMono),
        error: describeError(error),
      };
      safely(() => options.onError?.(error, trigger));
    } finally {
      // THE LINE THE OLD WATCHER WAS MISSING. Reached after a return, a throw,
      // or a rejection; without it a single failed cycle ends all polling.
      inFlight = false;
      inFlightCycle = null;
      armAfterCycle();
    }

    lastOutcome = outcome;
    safely(() => options.onCycleFinished?.(outcome));
    return outcome;
  }

  function runCycle(trigger: CycleTrigger): Promise<CycleOutcome | null> {
    if (inFlight) {
      overlapSkips += 1;
      // An interval tick that lands mid-cycle is just early; a wake or a
      // manual poll asked for something this cycle may not cover, so it is
      // remembered rather than dropped.
      if (trigger !== "interval") deferredTrigger = trigger;
      return Promise.resolve(null);
    }
    deferredTrigger = null;
    inFlight = true;
    const pending = execute(trigger);
    // A cycle that throws synchronously never reaches an `await`, so all of
    // execute(), catch and finally included, has already run by the time it
    // hands back its settled promise. Publishing that promise as the in-flight
    // one would leave whenIdle() and stop() waiting on a cycle that is over,
    // the same silent stall in a different disguise. `inFlight` is the tell,
    // since only execute()'s finally clears it and nothing else can run in
    // between.
    inFlightCycle = inFlight ? pending : null;
    return pending;
  }

  /** Start a cycle from a context with nowhere to report to. */
  function fireAndForget(trigger: CycleTrigger): void {
    // execute() cannot reject, but an unhandled rejection here would take the
    // whole daemon down, which is the outcome this file exists to avoid.
    void runCycle(trigger).catch(() => undefined);
  }

  // ── The heartbeat ────────────────────────────────────────────────────────

  /**
   * True when more wall time passed than this tick can account for. The module
   * comment explains why it reads two clocks instead of one.
   */
  function detectTimeJump(): boolean {
    const wall = clock.now();
    const mono = clock.monotonic();
    const wallDelta = wall - lastTickWall;
    const monoDelta = mono - lastTickMono;
    lastTickWall = wall;
    lastTickMono = mono;

    // A backwards step re-baselines and reports nothing. It is a clock
    // correction, and due times do not depend on the wall clock anyway.
    if (wallDelta < 0 || monoDelta < 0) return false;

    const unexplainedByMonotonic = wallDelta - monoDelta;
    const tickLateness = wallDelta - tickPeriodMs;
    return unexplainedByMonotonic >= wakeGapMs || tickLateness >= wakeGapMs;
  }

  function onTick(): void {
    if (!running) return; // a tick already queued when stop() ran.
    if (detectTimeJump()) {
      wakes += 1;
      fireAndForget("wake");
      return;
    }
    if (clock.monotonic() >= nextDueMono) fireAndForget(deferredTrigger ?? "interval");
  }

  function armTicker(): void {
    stopTicking?.();
    tickPeriodMs = tickPeriod();
    lastTickWall = clock.now();
    lastTickMono = clock.monotonic();
    stopTicking = ticker(tickPeriodMs, onTick);
  }

  // ── What the daemon calls ────────────────────────────────────────────────

  async function whenIdle(): Promise<void> {
    while (inFlightCycle) {
      const pending = inFlightCycle;
      await pending;
      // Belt and braces: a settled promise still sitting in the slot would
      // spin this loop forever, and `await scheduler.stop()` with it.
      if (inFlightCycle === pending) inFlightCycle = null;
    }
  }

  return {
    start() {
      if (running) return; // a second ticker would double every cycle.
      running = true;
      startedAtWall = clock.now();
      armTicker();
      armNextCycle();
      fireAndForget("boot"); // R1.2: immediately at daemon start.
    },

    async stop() {
      running = false;
      stopTicking?.();
      stopTicking = null;
      await whenIdle();
    },

    runNow(trigger: CycleTrigger = "manual") {
      return runCycle(trigger);
    },

    whenIdle,

    setIntervalMinutes(minutes: number) {
      intervalMinutes = sanitizeInterval(minutes);
      if (!running) return;
      if (tickPeriod() !== tickPeriodMs) armTicker();
      if (!inFlight) armNextCycle();
    },

    status(): SchedulerStatus {
      return {
        running,
        cycleInFlight: inFlight,
        startedAt: toISO(startedAtWall),
        lastCycleAt: toISO(lastCycleAtWall),
        lastCycleOutcome: lastOutcome ? { ...lastOutcome } : null,
        nextCycleAt: running
          ? toISO(clock.now() + Math.max(0, nextDueMono - clock.monotonic()))
          : null,
        cycles,
        overlapSkips,
        wakes,
        intervalMinutes,
      };
    },
  };
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * config.md is a file a human edits, so `interval_minutes: 0`, a negative, or
 * a typo that parses as NaN all reach here. Any of them silently disabling the
 * watcher, or turning it into a poll-per-tick, would be the exact failure this
 * module is built against, so nonsense falls back to the documented default.
 */
function sanitizeInterval(minutes: number | undefined): number {
  if (minutes === undefined) return DEFAULT_INTERVAL_MINUTES;
  if (!Number.isFinite(minutes) || minutes <= 0) return DEFAULT_INTERVAL_MINUTES;
  return minutes;
}

function positiveOr(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value > 0 ? value : fallback;
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

function toISO(ms: number | null): string | null {
  if (ms === null || !Number.isFinite(ms)) return null;
  return new Date(ms).toISOString();
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message || error.name || "Error";
  const text = typeof error === "string" ? error : String(error);
  return text.length > 0 ? text : "unknown error";
}

/** A listener that throws is a bug in the listener, never a stopped watcher. */
function safely(fn: () => void): void {
  try {
    fn();
  } catch {
    // swallowed on purpose.
  }
}

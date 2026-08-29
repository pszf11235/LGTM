/**
 * These tests exist because a daemon that has silently stopped polling is
 * indistinguishable, from the outside, from a daemon with nothing to report.
 * Every behaviour below is one way the old watcher could have gone quiet:
 * a rejecting cycle wedging the overlap guard, an overnight sleep swallowing
 * the timer, a clock step pushing the next poll out of reach, a hand-edited
 * `interval_minutes: 0`.
 *
 * Nothing here waits on a real clock. The scheduler takes its clock and its
 * ticker as arguments, and the fake below drives both, so an eight-hour sleep
 * or two hundred consecutive cycles cost microseconds and always produce the
 * same answer. The only real timer in the file is in the two smoke tests that
 * check the production `systemClock` and `systemTicker`, which the fake by
 * definition cannot cover.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { DEFAULTS } from "@/store/config";
import {
  createScheduler,
  DEFAULT_INTERVAL_MINUTES,
  MIN_CYCLE_DELAY_MS,
  systemClock,
  systemTicker,
  type Clock,
  type CycleTrigger,
  type Scheduler,
  type SchedulerOptions,
  type Ticker,
} from "./scheduler";

// ─── Fake time ──────────────────────────────────────────────────────────────

const SECOND = 1_000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;

const INTERVAL_MS = DEFAULT_INTERVAL_MINUTES * MINUTE;
const TICK_MS = 30 * SECOND;

/** A round number so the ISO strings in status assertions read at a glance. */
const WALL_ORIGIN = Date.UTC(2026, 7, 29, 9, 0, 0);

interface FakeTick {
  period: number;
  fn: () => void;
  nextAt: number;
  alive: boolean;
}

/**
 * A wall clock, a monotonic clock, and a ticker that only moves when a test
 * says so. `advance` moves both clocks together and delivers every tick that
 * falls in the window, which is an awake machine. `sleep` is the interesting
 * one. It moves time forward while delivering nothing, because timers do not
 * fire while a Mac is suspended.
 */
function makeEnv(origin = WALL_ORIGIN) {
  let wall = origin;
  let mono = 10_000;
  const ticks: FakeTick[] = [];

  const clock: Clock = { now: () => wall, monotonic: () => mono };

  const ticker: Ticker = (period, fn) => {
    const entry: FakeTick = { period, fn, nextAt: mono + period, alive: true };
    ticks.push(entry);
    return () => {
      entry.alive = false;
    };
  };

  /** Lets the scheduler's own promise chain settle without moving the clock. */
  async function flush(): Promise<void> {
    for (let i = 0; i < 8; i++) await Promise.resolve();
  }

  function earliestTick(): number | null {
    let due: number | null = null;
    for (const entry of ticks) {
      if (!entry.alive) continue;
      if (due === null || entry.nextAt < due) due = entry.nextAt;
    }
    return due;
  }

  async function advance(ms: number): Promise<void> {
    const target = mono + ms;
    for (let steps = 0; steps < 100_000; steps++) {
      const due = earliestTick();
      if (due === null || due > target) break;
      // An overdue tick (a sleep left it in the past) fires without rewinding.
      const step = Math.max(0, due - mono);
      mono += step;
      wall += step;
      for (const entry of [...ticks]) {
        if (!entry.alive || entry.nextAt > mono) continue;
        entry.nextAt = mono + entry.period;
        entry.fn();
        await flush();
      }
    }
    const rest = target - mono;
    if (rest > 0) {
      mono += rest;
      wall += rest;
    }
    await flush();
  }

  /**
   * The machine suspends. Wall time passes, no timer fires. `"pauses"` models
   * a monotonic clock that stops with the CPU, `"continues"` one that keeps
   * counting through suspend. Which one a given runtime and macOS version hand
   * you is not worth betting a daemon on, so this fake offers both.
   */
  function sleep(ms: number, monotonic: "pauses" | "continues"): void {
    wall += ms;
    if (monotonic === "continues") mono += ms;
  }

  /** An NTP correction or a user changing the clock. Monotonic time is unaffected. */
  function stepWallClock(ms: number): void {
    wall += ms;
  }

  return {
    clock,
    ticker,
    advance,
    sleep,
    stepWallClock,
    flush,
    activeTickers: () => ticks.filter((entry) => entry.alive).length,
    wall: () => wall,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const started: Scheduler[] = [];

afterEach(async () => {
  while (started.length > 0) await started.pop()?.stop();
});

/**
 * `random: () => 0.5` sits at the centre of the symmetric jitter, so the
 * default cadence is exactly `interval_minutes` and due times are exact
 * numbers rather than ranges. Tests that care about jitter override it.
 */
function harness(overrides: Partial<SchedulerOptions> = {}) {
  const env = makeEnv();
  const triggers: CycleTrigger[] = [];
  const inner = overrides.cycle;

  const scheduler = createScheduler({
    random: () => 0.5,
    ...overrides,
    clock: env.clock,
    ticker: env.ticker,
    cycle: (trigger) => {
      triggers.push(trigger);
      return inner?.(trigger);
    },
  });
  started.push(scheduler);

  return { env, scheduler, triggers };
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

// ─── Boot and cadence ───────────────────────────────────────────────────────

describe("start", () => {
  test("runs one cycle immediately, before any tick (R1.2)", async () => {
    const { scheduler, triggers } = harness();
    scheduler.start();
    await scheduler.whenIdle();
    expect(triggers).toEqual(["boot"]);
  });

  test("polls once per interval and not before (R1.1)", async () => {
    const { env, scheduler, triggers } = harness();
    scheduler.start();
    await scheduler.whenIdle();

    await env.advance(INTERVAL_MS - TICK_MS);
    expect(triggers).toEqual(["boot"]);

    await env.advance(TICK_MS);
    expect(triggers).toEqual(["boot", "interval"]);

    await env.advance(INTERVAL_MS);
    await env.advance(INTERVAL_MS);
    expect(triggers).toEqual(["boot", "interval", "interval", "interval"]);
  });

  test("is idempotent: a second start neither doubles the ticker nor the cycle", async () => {
    const { env, scheduler, triggers } = harness();
    scheduler.start();
    scheduler.start();
    await scheduler.whenIdle();

    expect(triggers).toEqual(["boot"]);
    expect(env.activeTickers()).toBe(1);

    await env.advance(INTERVAL_MS);
    expect(triggers).toEqual(["boot", "interval"]);
  });

  test("the default interval is the one config.md documents", () => {
    expect(DEFAULT_INTERVAL_MINUTES).toBe(15);
    expect(DEFAULT_INTERVAL_MINUTES).toBe(DEFAULTS.interval_minutes);
  });
});

describe("jitter", () => {
  test("shifts the next cycle later at the top of the range", async () => {
    const { env, scheduler, triggers } = harness({ random: () => 1, jitterMs: 60 * SECOND });
    scheduler.start();
    await scheduler.whenIdle();

    expect(scheduler.status().nextCycleAt).toBe(iso(WALL_ORIGIN + INTERVAL_MS + 60 * SECOND));

    await env.advance(INTERVAL_MS);
    expect(triggers).toEqual(["boot"]);
    await env.advance(60 * SECOND);
    expect(triggers).toEqual(["boot", "interval"]);
  });

  test("shifts it earlier at the bottom of the range", async () => {
    const { env, scheduler, triggers } = harness({ random: () => 0, jitterMs: 60 * SECOND });
    scheduler.start();
    await scheduler.whenIdle();

    await env.advance(INTERVAL_MS - 60 * SECOND - TICK_MS);
    expect(triggers).toEqual(["boot"]);
    await env.advance(TICK_MS);
    expect(triggers).toEqual(["boot", "interval"]);
  });

  test("never collapses the interval, however large the jitter", async () => {
    const { scheduler } = harness({ random: () => 0, jitterMs: 10 * INTERVAL_MS });
    scheduler.start();
    await scheduler.whenIdle();

    // A negative delay would poll GitHub on every tick.
    expect(scheduler.status().nextCycleAt).toBe(iso(WALL_ORIGIN + MIN_CYCLE_DELAY_MS));
  });
});

// ─── The overlap guard ──────────────────────────────────────────────────────

describe("overlap guard", () => {
  test("holds the next cycle while one is in flight", async () => {
    const gate = deferred<void>();
    const { env, scheduler, triggers } = harness({ cycle: () => gate.promise });

    scheduler.start();
    await env.flush();
    expect(scheduler.status().cycleInFlight).toBe(true);

    await env.advance(3 * INTERVAL_MS);
    expect(triggers).toEqual(["boot"]);
    expect(scheduler.status().overlapSkips).toBeGreaterThan(0);

    gate.resolve();
    await scheduler.whenIdle();
    expect(scheduler.status().cycleInFlight).toBe(false);

    await env.advance(INTERVAL_MS);
    expect(triggers).toEqual(["boot", "interval"]);
  });

  test("refuses an overlapping manual poll rather than running two at once", async () => {
    const gate = deferred<void>();
    const { scheduler, triggers } = harness({ cycle: () => gate.promise });

    scheduler.start();
    await scheduler.runNow().then((outcome) => expect(outcome).toBeNull());
    expect(triggers).toEqual(["boot"]);

    gate.resolve();
    await scheduler.whenIdle();
  });

  test("redeems a wake the guard refused, once the running cycle ends", async () => {
    const gate = deferred<void>();
    const { env, scheduler, triggers } = harness({ cycle: () => gate.promise });

    scheduler.start();
    await env.flush();

    // The machine sleeps mid-cycle; the cycle that resumes with dead sockets
    // is not the catch-up R1.2 asked for, so the wake is kept, not dropped.
    env.sleep(2 * HOUR, "pauses");
    await env.advance(TICK_MS);
    expect(triggers).toEqual(["boot"]);
    expect(scheduler.status().overlapSkips).toBe(1);

    gate.resolve();
    await scheduler.whenIdle();

    await env.advance(TICK_MS);
    expect(triggers).toEqual(["boot", "wake"]);
  });
});

// ─── The bug this module exists not to rewrite ──────────────────────────────

describe("a failing cycle never stops the schedule", () => {
  test("a rejecting cycle releases the guard and the next tick still runs", async () => {
    const { env, scheduler, triggers } = harness({
      cycle: async () => {
        throw new Error("forge unreachable");
      },
    });

    scheduler.start();
    await scheduler.whenIdle();

    const outcome = scheduler.status().lastCycleOutcome;
    expect(outcome?.status).toBe("failed");
    expect(outcome?.error).toBe("forge unreachable");
    expect(outcome?.trigger).toBe("boot");
    // The flag that the naive guard would have left stuck true.
    expect(scheduler.status().cycleInFlight).toBe(false);

    await env.advance(INTERVAL_MS);
    await env.advance(INTERVAL_MS);
    expect(triggers).toEqual(["boot", "interval", "interval"]);
  });

  // A synchronous throw never reaches an `await` inside the scheduler, so the
  // whole cycle completes before its promise is handed back. Getting that
  // wrong wedges whenIdle() and stop() on a cycle that has already finished,
  // and this test hangs rather than fails.
  test("a cycle that throws synchronously is treated the same", async () => {
    const { env, scheduler, triggers } = harness({
      cycle: () => {
        throw new Error("bad config");
      },
    });

    scheduler.start();
    await scheduler.whenIdle();
    await env.advance(INTERVAL_MS);

    expect(triggers).toEqual(["boot", "interval"]);
    expect(scheduler.status().lastCycleOutcome?.error).toBe("bad config");
  });

  test("something thrown that is not an Error still describes itself", async () => {
    const { scheduler } = harness({
      cycle: () => {
        throw "gh exited 128";
      },
    });

    scheduler.start();
    await scheduler.whenIdle();
    expect(scheduler.status().lastCycleOutcome?.error).toBe("gh exited 128");
  });

  test("a throwing status listener does not take the watcher down with it", async () => {
    const { env, scheduler, triggers } = harness({
      onCycleFinished: () => {
        throw new Error("event bus down");
      },
    });

    scheduler.start();
    await scheduler.whenIdle();
    await env.advance(INTERVAL_MS);
    await env.advance(INTERVAL_MS);

    expect(triggers).toEqual(["boot", "interval", "interval"]);
  });

  test("hands the raw error to onError once per failed cycle", async () => {
    const seen: Array<{ message: string; trigger: CycleTrigger }> = [];
    const boom = new Error("token expired");
    const { env, scheduler } = harness({
      cycle: () => {
        throw boom;
      },
      onError: (error, trigger) => {
        seen.push({ message: (error as Error).message, trigger });
        expect(error).toBe(boom);
      },
    });

    scheduler.start();
    await scheduler.whenIdle();
    await env.advance(INTERVAL_MS);

    expect(seen).toEqual([
      { message: "token expired", trigger: "boot" },
      { message: "token expired", trigger: "interval" },
    ]);
  });

  test("two hundred cycles, a third of them failing, and it is still polling", async () => {
    let n = 0;
    const { env, scheduler, triggers } = harness({
      intervalMinutes: 1,
      cycle: () => {
        n += 1;
        if (n % 3 === 0) throw new Error(`cycle ${n} failed`);
      },
    });

    scheduler.start();
    await scheduler.whenIdle();
    for (let i = 0; i < 200; i++) await env.advance(1 * MINUTE);

    expect(triggers).toHaveLength(201);
    expect(scheduler.status().cycles).toBe(201);
    expect(scheduler.status().running).toBe(true);
  });
});

// ─── Wake from sleep ────────────────────────────────────────────────────────

describe("wake detection", () => {
  test("catches up after a sleep the monotonic clock paused through", async () => {
    const { env, scheduler, triggers } = harness();
    scheduler.start();
    await scheduler.whenIdle();

    env.sleep(8 * HOUR, "pauses");
    await env.advance(TICK_MS);

    expect(triggers).toEqual(["boot", "wake"]);
    expect(scheduler.status().wakes).toBe(1);
    expect(scheduler.status().lastCycleOutcome?.trigger).toBe("wake");
  });

  test("catches up after a sleep the monotonic clock counted through", async () => {
    const { env, scheduler, triggers } = harness();
    scheduler.start();
    await scheduler.whenIdle();

    // Both clocks agree, but the heartbeat that should have fired sixteen
    // times during the night arrives once, hours late. That lateness is the
    // only evidence of the sleep, and it is enough.
    env.sleep(8 * HOUR, "continues");
    await env.advance(0);

    expect(triggers).toEqual(["boot", "wake"]);
    expect(scheduler.status().wakes).toBe(1);
  });

  test("resumes the normal cadence from the catch-up cycle", async () => {
    const { env, scheduler, triggers } = harness();
    scheduler.start();
    await scheduler.whenIdle();

    env.sleep(8 * HOUR, "pauses");
    await env.advance(TICK_MS);
    await env.advance(INTERVAL_MS);

    expect(triggers).toEqual(["boot", "wake", "interval"]);
  });

  test("a short gap is not a wake", async () => {
    const { env, scheduler, triggers } = harness();
    scheduler.start();
    await scheduler.whenIdle();

    env.sleep(1 * MINUTE, "pauses");
    await env.advance(TICK_MS);

    expect(triggers).toEqual(["boot"]);
    expect(scheduler.status().wakes).toBe(0);
  });

  test("respects a configured wake threshold", async () => {
    const { env, scheduler, triggers } = harness({ wakeGapMs: 10 * MINUTE });
    scheduler.start();
    await scheduler.whenIdle();

    env.sleep(5 * MINUTE, "pauses");
    await env.advance(TICK_MS);
    expect(triggers).toEqual(["boot"]);

    env.sleep(11 * MINUTE, "pauses");
    await env.advance(TICK_MS);
    expect(triggers).toEqual(["boot", "wake"]);
  });
});

// ─── Clock changes ──────────────────────────────────────────────────────────

describe("wall-clock changes", () => {
  test("a clock set backwards does not stall the next poll", async () => {
    const { env, scheduler, triggers } = harness();
    scheduler.start();
    await scheduler.whenIdle();

    // Due times computed from Date.now() would now sit three hours out.
    env.stepWallClock(-3 * HOUR);
    await env.advance(INTERVAL_MS);

    expect(triggers).toEqual(["boot", "interval"]);
    expect(scheduler.status().wakes).toBe(0);
  });

  test("a clock set forward polls once too often rather than once too little", async () => {
    const { env, scheduler, triggers } = harness();
    scheduler.start();
    await scheduler.whenIdle();

    env.stepWallClock(3 * HOUR);
    await env.advance(TICK_MS);

    expect(triggers).toEqual(["boot", "wake"]);
  });

  test("cycle duration comes from the monotonic clock", async () => {
    const gate = deferred<void>();
    const { env, scheduler } = harness({ cycle: () => gate.promise });

    scheduler.start();
    await env.flush();
    await env.advance(45 * SECOND);
    gate.resolve();
    await scheduler.whenIdle();

    expect(scheduler.status().lastCycleOutcome?.durationMs).toBe(45 * SECOND);
  });
});

// ─── Status snapshot ────────────────────────────────────────────────────────

describe("status", () => {
  test("reports the tray contract after a boot cycle", async () => {
    const { scheduler } = harness();
    scheduler.start();
    await scheduler.whenIdle();

    const status = scheduler.status();
    expect(status.running).toBe(true);
    expect(status.cycleInFlight).toBe(false);
    expect(status.startedAt).toBe(iso(WALL_ORIGIN));
    expect(status.lastCycleAt).toBe(iso(WALL_ORIGIN));
    expect(status.nextCycleAt).toBe(iso(WALL_ORIGIN + INTERVAL_MS));
    expect(status.lastCycleOutcome).toEqual({
      status: "ok",
      trigger: "boot",
      startedAt: iso(WALL_ORIGIN),
      durationMs: 0,
      error: null,
    });
    expect(status.intervalMinutes).toBe(DEFAULT_INTERVAL_MINUTES);
  });

  test("before the first cycle, the timestamps are null rather than invented", () => {
    const { scheduler } = harness();
    const status = scheduler.status();

    expect(status.running).toBe(false);
    expect(status.startedAt).toBeNull();
    expect(status.lastCycleAt).toBeNull();
    expect(status.lastCycleOutcome).toBeNull();
    expect(status.nextCycleAt).toBeNull();
    expect(status.cycles).toBe(0);
  });

  test("hands out a copy, so a caller cannot edit the daemon's own record", async () => {
    const { scheduler } = harness();
    scheduler.start();
    await scheduler.whenIdle();

    const snapshot = scheduler.status();
    if (snapshot.lastCycleOutcome) snapshot.lastCycleOutcome.status = "failed";

    expect(scheduler.status().lastCycleOutcome?.status).toBe("ok");
  });
});

// ─── Manual poll ────────────────────────────────────────────────────────────

describe("runNow", () => {
  test("returns the outcome of the cycle it ran", async () => {
    const { scheduler, triggers } = harness();
    const outcome = await scheduler.runNow();

    expect(outcome?.status).toBe("ok");
    expect(outcome?.trigger).toBe("manual");
    expect(triggers).toEqual(["manual"]);
  });

  test("works while the scheduler is stopped, for a one-shot poll", async () => {
    const { scheduler, triggers } = harness();
    await scheduler.runNow("manual");

    expect(triggers).toEqual(["manual"]);
    expect(scheduler.status().running).toBe(false);
  });

  test("reports a failed cycle instead of rejecting", async () => {
    const { scheduler } = harness({
      cycle: () => {
        throw new Error("nope");
      },
    });
    const outcome = await scheduler.runNow();

    expect(outcome?.status).toBe("failed");
    expect(outcome?.error).toBe("nope");
  });
});

// ─── Stop ───────────────────────────────────────────────────────────────────

describe("stop", () => {
  test("cancels the ticker and reports itself stopped", async () => {
    const { env, scheduler, triggers } = harness();
    scheduler.start();
    await scheduler.whenIdle();

    await scheduler.stop();
    await env.advance(5 * INTERVAL_MS);

    expect(triggers).toEqual(["boot"]);
    expect(env.activeTickers()).toBe(0);
    expect(scheduler.status().running).toBe(false);
    expect(scheduler.status().nextCycleAt).toBeNull();
  });

  test("waits for the cycle already in flight", async () => {
    const gate = deferred<void>();
    const { env, scheduler } = harness({ cycle: () => gate.promise });

    scheduler.start();
    await env.flush();

    let stopped = false;
    const stopping = scheduler.stop().then(() => {
      stopped = true;
    });
    await env.flush();
    expect(stopped).toBe(false);

    gate.resolve();
    await stopping;
    expect(stopped).toBe(true);
    expect(scheduler.status().cycleInFlight).toBe(false);
  });

  test("is safe before a start and safe twice", async () => {
    const { scheduler } = harness();
    await scheduler.stop();
    scheduler.start();
    await scheduler.whenIdle();
    await scheduler.stop();
    await scheduler.stop();

    expect(scheduler.status().running).toBe(false);
  });

  test("start after stop resumes polling", async () => {
    const { env, scheduler, triggers } = harness();
    scheduler.start();
    await scheduler.whenIdle();
    await scheduler.stop();

    scheduler.start();
    await scheduler.whenIdle();
    await env.advance(INTERVAL_MS);

    expect(triggers).toEqual(["boot", "boot", "interval"]);
    expect(env.activeTickers()).toBe(1);
  });
});

// ─── Interval changes ───────────────────────────────────────────────────────

describe("setIntervalMinutes", () => {
  test("applies a new cadence without a restart", async () => {
    const { env, scheduler, triggers } = harness();
    scheduler.start();
    await scheduler.whenIdle();

    scheduler.setIntervalMinutes(1);
    expect(scheduler.status().intervalMinutes).toBe(1);

    await env.advance(1 * MINUTE);
    await env.advance(1 * MINUTE);
    expect(triggers).toEqual(["boot", "interval", "interval"]);
  });

  test("keeps the heartbeat shorter than the interval", async () => {
    // Six seconds. Without clamping the tick to the interval, a 30-second
    // heartbeat would miss four cycles out of five.
    const { env, scheduler, triggers } = harness({ intervalMinutes: 0.1 });
    scheduler.start();
    await scheduler.whenIdle();

    await env.advance(6 * SECOND);
    expect(triggers).toEqual(["boot", "interval"]);
  });

  test("a nonsense interval falls back to the default instead of stopping the daemon", async () => {
    const { env, scheduler, triggers } = harness();
    scheduler.start();
    await scheduler.whenIdle();

    for (const bad of [0, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
      scheduler.setIntervalMinutes(bad);
      expect(scheduler.status().intervalMinutes).toBe(DEFAULT_INTERVAL_MINUTES);
    }

    await env.advance(INTERVAL_MS);
    expect(triggers).toEqual(["boot", "interval"]);
  });

  test("a nonsense interval at construction does the same", async () => {
    const { env, scheduler, triggers } = harness({ intervalMinutes: 0 });
    expect(scheduler.status().intervalMinutes).toBe(DEFAULT_INTERVAL_MINUTES);

    scheduler.start();
    await scheduler.whenIdle();
    await env.advance(INTERVAL_MS);
    expect(triggers).toEqual(["boot", "interval"]);
  });
});

// ─── The real clock and ticker ──────────────────────────────────────────────

describe("system time sources", () => {
  test("systemClock reads wall and monotonic time", () => {
    expect(Math.abs(systemClock.now() - Date.now())).toBeLessThan(SECOND);

    const first = systemClock.monotonic();
    const second = systemClock.monotonic();
    expect(second).toBeGreaterThanOrEqual(first);
  });

  test("systemTicker fires repeatedly and stops when cancelled", async () => {
    let fired = 0;
    const stop = systemTicker(1, () => {
      fired += 1;
    });

    await Bun.sleep(5);
    stop();
    const atStop = fired;

    await Bun.sleep(5);
    expect(atStop).toBeGreaterThan(0);
    expect(fired).toBe(atStop);
  });
});

/**
 * The gate's whole job is refusing to start work, so these tests are mostly
 * about the ways it could be tricked into starting some anyway: an
 * unrecognised report read as 0%, a stale reading trusted for three more
 * minutes after the CLI broke, a fallback counter that never rolls over, a
 * throttle lifted by a reset time that was never really parsed.
 *
 * Nothing here reads the real clock or the real quota. The clock is injected
 * and stepped by hand, the background timer is a fake, and the one test that
 * spawns a process spawns the fake-claude shim.
 */
import { describe, expect, test } from "bun:test";
import path from "path";
import {
  BACKGROUND_REFRESH_MS,
  createClaudeUsageProbe,
  createQuotaGate,
  parseUsage,
  PROBE_MAX_AGE_MS,
  QUOTA_DEFAULTS,
  type QuotaDecision,
  type QuotaPause,
  type QuotaState,
  type QuotaTimers,
  type UsageProbe,
  type UsageProbeResult,
} from "./quota";

// ─── Fixtures and harness ───────────────────────────────────────────────────

/** Verbatim from the M0 spike (docs/spec/spike-provider.md). */
const SPIKE_OUTPUT = [
  "Current session: 61% used · resets Aug 29 at 3:40pm (Europe/Paris)",
  "Current week (all models): 56% used · resets Aug 29 at 8pm (Europe/Paris)",
].join("\n");

/** Aug 29 2026, 10:00 UTC. Noon in Europe/Paris, before either spike reset. */
const T0 = Date.UTC(2026, 7, 29, 10, 0, 0);
const SESSION_RESET = Date.UTC(2026, 7, 29, 13, 40, 0); // 3:40pm Paris (UTC+2)
const WEEK_RESET = Date.UTC(2026, 7, 29, 18, 0, 0); // 8pm Paris

const FAKE_CLAUDE = path.join(import.meta.dir, "..", "..", "test", "fixtures", "fake-claude.ts");

function usageOutput(sessionPct: number, weekPct: number, resets = true): string {
  const sessionTail = resets ? " · resets Aug 29 at 3:40pm (Europe/Paris)" : "";
  const weekTail = resets ? " · resets Aug 29 at 8pm (Europe/Paris)" : "";
  return [
    `Current session: ${sessionPct}% used${sessionTail}`,
    `Current week (all models): ${weekPct}% used${weekTail}`,
  ].join("\n");
}

function fakeClock(start: number) {
  let t = start;
  return {
    now: () => t,
    advance(ms: number) {
      t += ms;
    },
    set(ms: number) {
      t = ms;
    },
  };
}

/** A probe whose next answer the test sets, counting how often it was asked. */
function stubProbe(initial: UsageProbeResult) {
  const state = { result: initial, calls: 0 };
  const probe: UsageProbe = async () => {
    state.calls += 1;
    return state.result;
  };
  return {
    probe,
    get calls() {
      return state.calls;
    },
    answer(output: string) {
      state.result = { output, error: null };
    },
    fail(error: string) {
      state.result = { output: "", error };
    },
  };
}

function okProbe(output: string) {
  return stubProbe({ output, error: null });
}

function fakeTimers() {
  const entries = new Map<number, { fn: () => void; ms: number }>();
  let nextId = 1;

  const timers: QuotaTimers = {
    setInterval(fn, ms) {
      const id = nextId++;
      entries.set(id, { fn, ms });
      return id;
    },
    clearInterval(handle) {
      entries.delete(handle as number);
    },
  };

  return {
    timers,
    get count() {
      return entries.size;
    },
    get periods() {
      return [...entries.values()].map((e) => e.ms);
    },
    tick() {
      for (const entry of [...entries.values()]) entry.fn();
    },
  };
}

/** A gate wired to a stub probe, a fake clock, and captured log/pause output. */
function harness(
  output: string,
  overrides: Partial<Parameters<typeof createQuotaGate>[0]> = {},
  start = T0
) {
  const clock = fakeClock(start);
  const probe = okProbe(output);
  const log: QuotaDecision[] = [];
  const pauses: QuotaPause[] = [];
  const changes: QuotaState[] = [];

  const gate = createQuotaGate({
    probe: probe.probe,
    now: clock.now,
    timeZone: "UTC",
    log: (d) => log.push(d),
    onPause: (p) => pauses.push(p),
    onChange: (s) => changes.push(s),
    ...overrides,
  });

  return { gate, clock, probe, log, pauses, changes };
}

// ─── Parsing ────────────────────────────────────────────────────────────────

describe("parseUsage", () => {
  test("reads every window's percentage out of the spike's own output", () => {
    const reading = parseUsage(SPIKE_OUTPUT, { now: T0 });

    expect(reading).not.toBeNull();
    expect(reading!.windows.map((w) => [w.label, w.percent])).toEqual([
      ["Current session", 61],
      ["Current week (all models)", 56],
    ]);
  });

  test("takes the maximum across windows, not the first or the average", () => {
    // The weekly window is the exhausted one here. Averaging would report 48
    // and dispatch happily while the user's week is nearly gone.
    const reading = parseUsage(usageOutput(4, 92), { now: T0 });

    expect(reading!.maxPercent).toBe(92);
  });

  test("resolves reset times against the named zone", () => {
    const reading = parseUsage(SPIKE_OUTPUT, { now: T0 });

    expect(reading!.windows[0]!.resetAt).toBe(SESSION_RESET);
    expect(reading!.windows[1]!.resetAt).toBe(WEEK_RESET);
    // The reading's own reset belongs to the window driving the maximum.
    expect(reading!.resetAt).toBe(SESSION_RESET);
  });

  test("a reset with no year resolves to the next occurrence across a year boundary", () => {
    const newYearsEve = Date.UTC(2026, 11, 31, 23, 0, 0);
    const reading = parseUsage("Current session: 80% used · resets Jan 1 at 3am (UTC)", {
      now: newYearsEve,
    });

    expect(reading!.resetAt).toBe(Date.UTC(2027, 0, 1, 3, 0, 0));
  });

  test("a reset that has only just passed stays in the past instead of jumping a year", () => {
    // 20 minutes after the printed reset. Reading this as Aug 2027 would pin
    // the gate in `throttled` for eleven months.
    const reading = parseUsage(SPIKE_OUTPUT, { now: SESSION_RESET + 20 * 60 * 1000 });

    expect(reading!.windows[0]!.resetAt).toBe(SESSION_RESET);
  });

  test("a reset well in the past is the next occurrence, a year on", () => {
    const reading = parseUsage("Current session: 80% used · resets Aug 29 at 3:40pm (UTC)", {
      now: Date.UTC(2026, 7, 30, 12, 0, 0),
    });

    expect(reading!.resetAt).toBe(Date.UTC(2027, 7, 29, 15, 40, 0));
  });

  test("an unresolvable timezone loses only the reset, never the percentage", () => {
    const reading = parseUsage("Current session: 77% used · resets Aug 29 at 3:40pm (Middle/Earth)", {
      now: T0,
    });

    expect(reading!.maxPercent).toBe(77);
    expect(reading!.windows[0]!.resetAt).toBeNull();
    expect(reading!.resetAt).toBeNull();
  });

  test("a partial parse keeps the percentages when no reset text is printed at all", () => {
    const reading = parseUsage(usageOutput(88, 40, false), { now: T0 });

    expect(reading!.maxPercent).toBe(88);
    expect(reading!.resetAt).toBeNull();
    expect(reading!.windows.every((w) => w.resetAt === null)).toBe(true);
  });

  test("an unparsed reset on the leading window leaves the reading without one", () => {
    // The weekly window is the maximum and its reset is unreadable, so the
    // gate cannot know when the block lifts even though the other line parsed.
    const reading = parseUsage(
      [
        "Current session: 12% used · resets Aug 29 at 3:40pm (Europe/Paris)",
        "Current week (all models): 91% used · resets when it resets",
      ].join("\n"),
      { now: T0 }
    );

    expect(reading!.maxPercent).toBe(91);
    expect(reading!.resetAt).toBeNull();
  });

  test("garbage is null, not zero", () => {
    expect(parseUsage("This is not valid JSON and should not parse: {broken [", { now: T0 })).toBeNull();
  });

  test("empty output is null", () => {
    expect(parseUsage("", { now: T0 })).toBeNull();
    expect(parseUsage("   \n\n  ", { now: T0 })).toBeNull();
  });

  test("a plausible-looking format change is null rather than a guess", () => {
    // The shape the CLI might drift to after an update: same information,
    // none of it matching the contract this parser was written against.
    const drifted = [
      "Session   ████████░░  61/100",
      "Week      ███████░░░  56/100",
    ].join("\n");

    expect(parseUsage(drifted, { now: T0 })).toBeNull();
  });

  test("a percentage outside 0-100 poisons the whole reading", () => {
    // Skipping the nonsense line and keeping the other one would report 4%
    // from a format that clearly is not the one we know.
    const output = ["Current session: 234% used", "Current week (all models): 4% used"].join("\n");

    expect(parseUsage(output, { now: T0 })).toBeNull();
  });

  test("bare numbers elsewhere in the output are not read as usage", () => {
    expect(parseUsage("Logged in as user@example.com (plan 20)", { now: T0 })).toBeNull();
    expect(parseUsage("Progress: 45% complete", { now: T0 })).toBeNull();
  });
});

// ─── Mode: ok ───────────────────────────────────────────────────────────────

describe("createQuotaGate / ok", () => {
  test("dispatches below the pause threshold and logs the mode that decided it", async () => {
    const { gate, log } = harness(SPIKE_OUTPUT);

    const decision = await gate.requestDispatch();

    expect(decision.allowed).toBe(true);
    expect(decision.mode).toBe("ok");
    expect(decision.maxPercent).toBe(61);
    expect(log).toHaveLength(1);
    expect(log[0]!.mode).toBe("ok");
    expect(log[0]!.reason).toContain("61%");
  });

  test("announces state changes for the SSE event, and only real ones", async () => {
    const { gate, probe, clock, changes } = harness(usageOutput(20, 20));

    await gate.requestDispatch();
    expect(changes.at(-1)!.mode).toBe("ok");

    probe.answer(usageOutput(85, 20));
    clock.advance(PROBE_MAX_AGE_MS);
    await gate.requestDispatch();
    expect(changes.at(-1)!.mode).toBe("throttled");

    // An unchanged reading is not news, and the UI does not need to refetch.
    const announced = changes.length;
    clock.advance(PROBE_MAX_AGE_MS);
    await gate.requestDispatch();
    expect(changes).toHaveLength(announced);
  });

  test("exposes the parsed windows for the status API", async () => {
    const { gate } = harness(SPIKE_OUTPUT);

    await gate.refresh();
    const state = gate.state();

    expect(state.mode).toBe("ok");
    expect(state.maxPercent).toBe(61);
    expect(state.windows).toHaveLength(2);
    expect(state.lastError).toBeNull();
  });
});

// ─── Mode: throttled ────────────────────────────────────────────────────────

describe("createQuotaGate / throttled", () => {
  test("holds every dispatch once the maximum exceeds pause_above_pct", async () => {
    const { gate, log } = harness(usageOutput(78, 40));

    const decision = await gate.requestDispatch();

    expect(decision.allowed).toBe(false);
    expect(decision.mode).toBe("throttled");
    expect(log[0]!.mode).toBe("throttled");
  });

  test("the boundary is exceeding the threshold, not reaching it", async () => {
    const { gate } = harness(usageOutput(70, 10));

    expect((await gate.requestDispatch()).allowed).toBe(true);
  });

  test("hysteresis: a reading between the two thresholds stays throttled", async () => {
    const { gate, probe, clock } = harness(usageOutput(78, 40));

    expect((await gate.requestDispatch()).allowed).toBe(false);

    probe.answer(usageOutput(65, 40)); // below pause, above resume
    clock.advance(PROBE_MAX_AGE_MS);
    expect((await gate.requestDispatch()).allowed).toBe(false);

    probe.answer(usageOutput(59, 40)); // below resume
    clock.advance(PROBE_MAX_AGE_MS);
    const resumed = await gate.requestDispatch();
    expect(resumed.allowed).toBe(true);
    expect(resumed.mode).toBe("ok");
  });

  test("resume_below_pct is a floor to drop under, not one to touch", async () => {
    const { gate, probe, clock } = harness(usageOutput(78, 40));
    await gate.requestDispatch();

    probe.answer(usageOutput(60, 40));
    clock.advance(PROBE_MAX_AGE_MS);

    expect((await gate.requestDispatch()).allowed).toBe(false);
  });

  test("a parsed reset passing lifts the throttle on its own", async () => {
    const { gate, clock } = harness(usageOutput(95, 40));
    await gate.requestDispatch();
    expect(gate.state().mode).toBe("throttled");

    clock.set(SESSION_RESET + 1);

    // No probe involved: the reset instant alone is enough to leave throttled.
    expect(gate.state().mode).toBe("ok");
  });

  test("with no parsed reset, only hysteresis can lift the throttle", async () => {
    const { gate, clock } = harness(usageOutput(95, 40, false));
    await gate.requestDispatch();

    clock.advance(30 * 24 * 60 * 60 * 1000); // a month later

    expect(gate.state().mode).toBe("throttled");
  });

  test("the reading after a passed reset is re-probed rather than trusted", async () => {
    const { gate, probe, clock } = harness(usageOutput(95, 40));
    await gate.requestDispatch();
    const before = probe.calls;

    clock.set(SESSION_RESET + 1000); // well inside the 3-minute staleness window
    probe.answer(usageOutput(3, 41));

    const decision = await gate.requestDispatch();
    expect(probe.calls).toBe(before + 1);
    expect(decision.allowed).toBe(true);
  });
});

// ─── The pause notification ─────────────────────────────────────────────────

describe("createQuotaGate / pause notification", () => {
  test("fires once on entry, deduped on the parsed reset instant", async () => {
    const { gate, probe, clock, pauses } = harness(usageOutput(78, 40));

    await gate.requestDispatch();
    expect(pauses).toHaveLength(1);
    expect(pauses[0]!.maxPercent).toBe(78);
    expect(pauses[0]!.resetAt).toBe(SESSION_RESET);

    // Still throttled a probe later: the same pause, not a second one.
    clock.advance(PROBE_MAX_AGE_MS);
    await gate.requestDispatch();
    expect(pauses).toHaveLength(1);

    // Out and back in on the same window: still the same pause.
    probe.answer(usageOutput(50, 40));
    clock.advance(PROBE_MAX_AGE_MS);
    await gate.requestDispatch();
    probe.answer(usageOutput(78, 40));
    clock.advance(PROBE_MAX_AGE_MS);
    await gate.requestDispatch();

    expect(pauses).toHaveLength(1);
  });

  test("a different reset instant is a different pause", async () => {
    const { gate, probe, clock, pauses } = harness(usageOutput(78, 40));
    await gate.requestDispatch();

    probe.answer(usageOutput(50, 40));
    clock.advance(PROBE_MAX_AGE_MS);
    await gate.requestDispatch();

    probe.answer("Current session: 81% used · resets Aug 29 at 9:15pm (Europe/Paris)");
    clock.advance(PROBE_MAX_AGE_MS);
    await gate.requestDispatch();

    expect(pauses).toHaveLength(2);
    expect(pauses[1]!.resetAt).toBe(Date.UTC(2026, 7, 29, 19, 15, 0));
  });

  test("without a reset instant it dedupes on the entry itself", async () => {
    const { gate, probe, clock, pauses } = harness(usageOutput(78, 40, false));

    await gate.requestDispatch();
    clock.advance(PROBE_MAX_AGE_MS);
    await gate.requestDispatch(); // still throttled, same entry
    expect(pauses).toHaveLength(1);
    expect(pauses[0]!.dedupeKey).toBe("entry:1");

    probe.answer(usageOutput(20, 20, false));
    clock.advance(PROBE_MAX_AGE_MS);
    await gate.requestDispatch();

    probe.answer(usageOutput(78, 40, false));
    clock.advance(PROBE_MAX_AGE_MS);
    await gate.requestDispatch();

    expect(pauses).toHaveLength(2);
  });
});

// ─── Mode: fallback ─────────────────────────────────────────────────────────

describe("createQuotaGate / fallback", () => {
  test("one unparseable probe does not become a zero percentage", async () => {
    const { gate, probe, clock } = harness(usageOutput(95, 40));
    await gate.requestDispatch();

    probe.answer("This is not valid JSON and should not parse: {broken [");
    clock.advance(PROBE_MAX_AGE_MS);
    const decision = await gate.requestDispatch();

    // The dangerous outcome is the gate reading garbage as 0% and dispatching.
    expect(decision.allowed).toBe(false);
    expect(decision.mode).toBe("throttled");
    expect(gate.state().maxPercent).toBe(95);
    expect(gate.state().consecutiveParseFailures).toBe(1);
  });

  test("two unparseable probes in a row degrade to the daily cap", async () => {
    const { gate, probe, clock, log } = harness(usageOutput(20, 20), {
      thresholds: { ...QUOTA_DEFAULTS, daily_cap: 3 },
    });
    await gate.requestDispatch();

    probe.answer("garbage");
    clock.advance(PROBE_MAX_AGE_MS);
    await gate.requestDispatch();
    expect(gate.state().mode).toBe("ok");

    clock.advance(PROBE_MAX_AGE_MS);
    await gate.requestDispatch();
    expect(gate.state().mode).toBe("fallback");
    expect(log.at(-1)!.mode).toBe("fallback");
  });

  test("a successful probe restores percentage gating", async () => {
    const { gate, probe, clock } = harness("garbage");

    await gate.requestDispatch();
    await gate.requestDispatch();
    expect(gate.state().mode).toBe("fallback");

    probe.answer(usageOutput(30, 30));
    clock.advance(PROBE_MAX_AGE_MS);
    await gate.requestDispatch();

    expect(gate.state().mode).toBe("ok");
    expect(gate.state().maxPercent).toBe(30);
    expect(gate.state().consecutiveParseFailures).toBe(0);
  });

  test("a broken probe that parses straight into a throttle still throttles", async () => {
    const { gate, probe, clock } = harness("garbage");
    await gate.requestDispatch();
    await gate.requestDispatch();

    probe.answer(usageOutput(99, 99));
    clock.advance(PROBE_MAX_AGE_MS);

    expect((await gate.requestDispatch()).mode).toBe("throttled");
  });

  test("the counter caps dispatches and every decision names the mode", async () => {
    const { gate, log } = harness("garbage", {
      thresholds: { ...QUOTA_DEFAULTS, daily_cap: 3 },
    });

    const decisions = [
      await gate.requestDispatch(),
      await gate.requestDispatch(),
      await gate.requestDispatch(),
      await gate.requestDispatch(),
    ];

    expect(decisions.map((d) => d.allowed)).toEqual([true, true, true, false]);
    expect(decisions.at(-1)!.mode).toBe("fallback");
    expect(decisions.at(-1)!.reason).toContain("daily cap of 3");
    expect(log).toHaveLength(4);
    expect(log.every((d) => d.mode === "ok" || d.mode === "fallback")).toBe(true);
  });

  test("the counter rolls over at midnight", async () => {
    const lateEvening = Date.UTC(2026, 7, 29, 23, 59, 0);
    const { gate, clock } = harness(
      "garbage",
      { thresholds: { ...QUOTA_DEFAULTS, daily_cap: 2 } },
      lateEvening
    );

    expect((await gate.requestDispatch()).allowed).toBe(true);
    expect((await gate.requestDispatch()).allowed).toBe(true);
    expect((await gate.requestDispatch()).allowed).toBe(false);

    clock.advance(2 * 60 * 1000); // 00:01 the next day, in the gate's zone

    const afterMidnight = await gate.requestDispatch();
    expect(afterMidnight.allowed).toBe(true);
    expect(afterMidnight.runsToday).toBe(1);
  });

  test("the rollover follows the configured zone, not UTC", async () => {
    // 22:30 UTC on Aug 29 is already 00:30 on Aug 30 in Europe/Paris, so the
    // two calendars disagree for the next 90 minutes. A gate counting UTC
    // days would hand out a fresh cap at UTC midnight, in the middle of the
    // user's Paris day.
    const { gate, clock } = harness(
      "garbage",
      { thresholds: { ...QUOTA_DEFAULTS, daily_cap: 1 }, timeZone: "Europe/Paris" },
      Date.UTC(2026, 7, 29, 22, 30, 0)
    );

    expect((await gate.requestDispatch()).allowed).toBe(true);

    clock.advance(60 * 60 * 1000); // 23:30 UTC, 01:30 in Paris
    expect((await gate.requestDispatch()).allowed).toBe(false);

    clock.advance(2 * 60 * 60 * 1000); // past UTC midnight, still Aug 30 in Paris
    expect((await gate.requestDispatch()).allowed).toBe(false);

    clock.set(Date.UTC(2026, 7, 30, 22, 30, 0)); // 00:30 on Aug 31 in Paris
    expect((await gate.requestDispatch()).allowed).toBe(true);
  });

  test("a cap of zero refuses everything, including before the first reading", async () => {
    const { gate } = harness("garbage", { thresholds: { ...QUOTA_DEFAULTS, daily_cap: 0 } });

    expect((await gate.requestDispatch()).allowed).toBe(false);
  });
});

// ─── Probe failures ─────────────────────────────────────────────────────────

describe("createQuotaGate / probe failures", () => {
  test("a failing probe counts as unreadable and reaches fallback", async () => {
    const { gate, probe } = harness("", { thresholds: { ...QUOTA_DEFAULTS, daily_cap: 5 } });
    probe.fail("spawn claude ENOENT");

    // Before any reading has ever succeeded the gate knows nothing, so it
    // gates on the cap rather than assuming a percentage it never read.
    const first = await gate.requestDispatch();
    expect(first.reason).toContain("no usage reading yet");
    expect(first.reason).toContain("ENOENT");

    const second = await gate.requestDispatch();
    expect(second.mode).toBe("fallback");
    expect(gate.state().lastError).toContain("ENOENT");
  });

  test("a failed probe never buys the CLI three minutes of fresh-looking cache", async () => {
    const { gate, probe } = harness("");
    probe.fail("spawn claude ENOENT");

    await gate.requestDispatch();
    await gate.requestDispatch();
    await gate.requestDispatch();

    // Every dispatch re-probed, despite each attempt being seconds apart.
    expect(probe.calls).toBe(3);
  });
});

// ─── Probe cadence ──────────────────────────────────────────────────────────

describe("createQuotaGate / probe cadence", () => {
  test("a reading younger than three minutes is reused", async () => {
    const { gate, probe, clock } = harness(SPIKE_OUTPUT);

    await gate.requestDispatch();
    clock.advance(PROBE_MAX_AGE_MS - 1000);
    await gate.requestDispatch();

    expect(probe.calls).toBe(1);
  });

  test("a reading three minutes old is re-probed before dispatch", async () => {
    const { gate, probe, clock } = harness(SPIKE_OUTPUT);

    await gate.requestDispatch();
    clock.advance(PROBE_MAX_AGE_MS);
    await gate.requestDispatch();

    expect(probe.calls).toBe(2);
  });

  test("concurrent dispatches share one probe", async () => {
    const { gate, probe } = harness(SPIKE_OUTPUT);

    await Promise.all([gate.requestDispatch(), gate.requestDispatch(), gate.requestDispatch()]);

    expect(probe.calls).toBe(1);
  });

  test("the background refresh probes every five minutes while work is queued", async () => {
    const timers = fakeTimers();
    const { gate, probe } = harness(SPIKE_OUTPUT, { timers: timers.timers });

    gate.start(() => 2);
    expect(timers.periods).toEqual([BACKGROUND_REFRESH_MS]);

    timers.tick();
    await Promise.resolve();

    expect(probe.calls).toBe(1);
  });

  test("an empty queue means no background probe at all", async () => {
    const timers = fakeTimers();
    const { gate, probe } = harness(SPIKE_OUTPUT, { timers: timers.timers });

    gate.start(() => 0);
    timers.tick();
    await Promise.resolve();

    expect(probe.calls).toBe(0);
  });

  test("stop clears the timer and start is idempotent", () => {
    const timers = fakeTimers();
    const { gate } = harness(SPIKE_OUTPUT, { timers: timers.timers });

    gate.start(() => 1);
    gate.start(() => 1);
    expect(timers.count).toBe(1);

    gate.stop();
    expect(timers.count).toBe(0);
  });
});

// ─── Thresholds ─────────────────────────────────────────────────────────────

describe("createQuotaGate / thresholds", () => {
  test("config changes take effect on the next decision", async () => {
    const { gate, clock } = harness(usageOutput(65, 20));

    expect((await gate.requestDispatch()).allowed).toBe(true);

    gate.setThresholds({ pause_above_pct: 50, resume_below_pct: 40, daily_cap: 20 });
    clock.advance(PROBE_MAX_AGE_MS);

    expect((await gate.requestDispatch()).allowed).toBe(false);
  });

  test("a resume threshold above the pause threshold is clamped rather than flapping", async () => {
    const { gate, probe, clock } = harness(usageOutput(78, 20), {
      thresholds: { pause_above_pct: 70, resume_below_pct: 90, daily_cap: 20 },
    });

    expect((await gate.requestDispatch()).allowed).toBe(false);

    // With resume clamped to 70, a reading at 69 resumes and one at 71 does not.
    probe.answer(usageOutput(69, 20));
    clock.advance(PROBE_MAX_AGE_MS);
    expect((await gate.requestDispatch()).allowed).toBe(true);
  });
});

// ─── The real probe ─────────────────────────────────────────────────────────

describe("createClaudeUsageProbe", () => {
  test("reads the fake CLI's usage report end to end", async () => {
    const clock = fakeClock(T0);
    const probe = createClaudeUsageProbe({ binPath: () => FAKE_CLAUDE });

    const gate = createQuotaGate({ probe, now: clock.now, timeZone: "Europe/Paris" });
    const decision = await gate.requestDispatch();

    expect(decision.allowed).toBe(true);
    expect(decision.mode).toBe("ok");
    expect(decision.maxPercent).toBe(61);
    expect(gate.state().windows).toHaveLength(2);
    expect(gate.state().windows[0]!.resetAt).toBe(SESSION_RESET);
  });

  test("an unresolved binary is an error, not an empty reading", async () => {
    const probe = createClaudeUsageProbe({ binPath: () => null });

    const result = await probe();

    expect(result.error).toBe("claude binary not resolved");
    expect(parseUsage(result.output, { now: T0 })).toBeNull();
  });

  test("a missing binary reports the spawn failure and asks for a re-probe", async () => {
    const failures: Error[] = [];
    const probe = createClaudeUsageProbe({
      binPath: () => "/nonexistent/lgtm-test/claude",
      onSpawnFailure: (err) => {
        failures.push(err);
      },
    });

    const result = await probe();

    expect(result.error).not.toBeNull();
    expect(result.output).toBe("");
    expect(failures).toHaveLength(1);
  });

  test("a missing binary drives the gate into fallback, not into dispatching", async () => {
    const clock = fakeClock(T0);
    const gate = createQuotaGate({
      probe: createClaudeUsageProbe({ binPath: () => "/nonexistent/lgtm-test/claude" }),
      now: clock.now,
      timeZone: "UTC",
      thresholds: { ...QUOTA_DEFAULTS, daily_cap: 1 },
    });

    expect((await gate.requestDispatch()).allowed).toBe(true); // the one run the cap allows
    const second = await gate.requestDispatch();

    expect(second.mode).toBe("fallback");
    expect(second.allowed).toBe(false);
  });

  test("a non-zero exit is an error even when it printed something", async () => {
    const probe = createClaudeUsageProbe({
      binPath: () => "/usr/bin/true",
      spawn: async () => ({
        stdout: "Current session: 61% used",
        stderr: "not logged in",
        exitCode: 1,
        timedOut: false,
      }),
    });

    expect((await probe()).error).toContain("not logged in");
  });

  test("a timed-out probe is an error, so a truncated report is never trusted", async () => {
    // Half a report can be missing the very window that is exhausted.
    const probe = createClaudeUsageProbe({
      binPath: () => "/usr/bin/true",
      timeoutSeconds: 5,
      spawn: async () => ({
        stdout: "Current session: 3% used",
        stderr: "",
        exitCode: null,
        timedOut: true,
      }),
    });

    const result = await probe();
    expect(result.error).toContain("timed out");

    const clock = fakeClock(T0);
    const gate = createQuotaGate({ probe, now: clock.now, timeZone: "UTC" });
    await gate.refresh();

    expect(gate.state().maxPercent).toBeNull();
    expect(gate.state().consecutiveParseFailures).toBe(1);
  });
});

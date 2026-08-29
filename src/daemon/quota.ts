/**
 * The QuotaGate: what work is allowed to start, given how much of the user's
 * subscription is already spent (CONTEXT.md; requirements R4; design.md,
 * "Quota gate").
 *
 * The point of this module is that LGTM must never compete with the human for
 * the human's own subscription. Every other failure here is an inconvenience.
 * The one that matters is failing OPEN: dispatching reviews while the user is
 * at 95% of their weekly window, so their next real question is refused by a
 * limit a background daemon spent. Every judgement call below is resolved in
 * the direction that stops work rather than the direction that starts it.
 *
 * Source of truth is the CLI itself, spawned in print mode with the usage
 * command. The M0 spike (docs/spec/spike-provider.md) measured that call:
 * non-interactive, no tokens and no turns consumed, roughly four seconds, and
 * it prints lines shaped like
 *
 *   Current session: 61% used · resets Aug 29 at 3:40pm (Europe/Paris)
 *   Current week (all models): 56% used · resets Aug 29 at 8pm (Europe/Paris)
 *
 * That format is not documented anywhere and a CLI update can change it
 * without warning, which is why `parseUsage` returns null rather than a
 * best-guess reading. A number this gate invents is worse than no number: an
 * assumed 0% is precisely the reading that lets a daemon drain a quota it
 * cannot see. Two consecutive unparseable probes drop the gate into
 * `fallback`, where a plain daily run counter takes over.
 *
 * Time is injected, all of it. Staleness, hysteresis, reset expiry and the
 * midnight rollover of the daily counter are the whole behaviour of this
 * file, and none of them can be tested against a clock the test does not own.
 */

import { run, type SpawnOutcome } from "@/provider/claude";

// ─── Constants ──────────────────────────────────────────────────────────────

/** Probe before a dispatch when the cached reading is older than this. */
export const PROBE_MAX_AGE_MS = 3 * 60 * 1000;

/** Background refresh cadence while the review queue is non-empty. */
export const BACKGROUND_REFRESH_MS = 5 * 60 * 1000;

/**
 * Consecutive unparseable probes before the gate degrades to the daily cap.
 * Two, not one: a single blip (a CLI mid-update, a killed probe) should not
 * throw away percentage gating, and two in a row is already ~3 minutes of
 * evidence that the format moved.
 */
export const FALLBACK_AFTER_FAILURES = 2;

/**
 * The usage probe is measured at ~4s. This ceiling exists only so a hung CLI
 * cannot stall a dispatch forever; it is not a duration anyone should hit.
 */
export const USAGE_TIMEOUT_SECONDS = 60;

/** The print-mode prompt that produces the usage report. */
export const USAGE_COMMAND = "/usage";

/**
 * A parsed reset time this far in the past is read as "just passed" rather
 * than rolled forward to next year. The printed string carries no year, so
 * "resets Aug 29 at 3:40pm" read at 4pm on Aug 29 is a window that has
 * already reset, not one eleven months out.
 */
const ROLLOVER_GRACE_MS = 60 * 60 * 1000;

// ─── Types ──────────────────────────────────────────────────────────────────

/**
 * `ok` dispatches freely, `throttled` holds everything, `fallback` gates on a
 * daily run counter because the percentages stopped being readable.
 */
export type QuotaMode = "ok" | "throttled" | "fallback";

/** One usage window as the CLI reported it. */
export interface UsageWindow {
  /** The window's own label, e.g. "Current session", "Current week (all models)". */
  label: string;
  /** Percent of the window consumed, 0-100. */
  percent: number;
  /** Epoch ms of the window's reset, or null when the tail of the line did not parse. */
  resetAt: number | null;
  /** The reset text exactly as printed, kept for the status API. */
  resetText: string | null;
}

/** One successful reading of the CLI's usage report. */
export interface UsageReading {
  windows: UsageWindow[];
  /**
   * The highest percentage across every reported window. Either window
   * exhausting blocks the user as completely as it blocks LGTM, so the gate
   * runs on the maximum and never on an average.
   */
  maxPercent: number;
  /**
   * When the window driving `maxPercent` resets, or null when that window's
   * reset did not parse. Ties take the later reset: while two windows sit at
   * the maximum, the max only drops once the last of them has reset.
   */
  resetAt: number | null;
  readAt: number;
}

/** The subset of config.md this gate reads. Shaped to accept `loadConfig()`'s result. */
export interface QuotaThresholds {
  pause_above_pct: number;
  resume_below_pct: number;
  daily_cap: number;
}

export const QUOTA_DEFAULTS: QuotaThresholds = {
  pause_above_pct: 70,
  resume_below_pct: 60,
  daily_cap: 20,
};

/** One dispatch decision, and the log line for it. */
export interface QuotaDecision {
  allowed: boolean;
  /** Which mode produced this decision (requirements R4.3). */
  mode: QuotaMode;
  /** Human-readable justification, carrying the numbers the decision used. */
  reason: string;
  maxPercent: number | null;
  /** Runs counted today, including this one when `allowed`. */
  runsToday: number;
  dailyCap: number;
  at: number;
}

/** The gate as `/api/status` renders it. */
export interface QuotaState {
  mode: QuotaMode;
  maxPercent: number | null;
  windows: UsageWindow[];
  /** When the current reading was taken, or null before the first success. */
  readAt: number | null;
  /** Reset of the window that caused a throttle, when one parsed. */
  resetAt: number | null;
  consecutiveParseFailures: number;
  runsToday: number;
  dailyCap: number;
  /** Why the last probe failed, or null when it succeeded. */
  lastError: string | null;
}

/** Payload of the one notification a pause fires (requirements R4.4, R8.1). */
export interface QuotaPause {
  at: number;
  maxPercent: number;
  resetAt: number | null;
  /** What the notification was deduped on: the reset instant, or the entry itself. */
  dedupeKey: string;
}

export interface UsageProbeResult {
  output: string;
  /** Non-null means the probe itself failed; `output` is then not trusted. */
  error: string | null;
}

/** Reads the CLI's usage report. Never throws. */
export type UsageProbe = () => Promise<UsageProbeResult>;

// ─── Parsing ────────────────────────────────────────────────────────────────

/**
 * Percentages are the contract. Anchored on the literal `% used` so a stray
 * number elsewhere in the output cannot be read as a usage figure, and the
 * captured value is range-checked below.
 */
const PERCENT_RE = /(\d+(?:\.\d+)?)\s*%\s+used/i;

/**
 * Reset times are best-effort: month and day, a clock time, an am/pm marker,
 * and optionally an IANA zone in parens. A line that says "resets in 2
 * hours", or anything else this does not recognise, leaves `resetAt` null and
 * costs nothing. The percentage on that line still counts.
 *
 * The am/pm marker is required rather than optional, because "at 3" without
 * one is ambiguous and guessing 03:00 for a 3pm reset would unthrottle the
 * gate twelve hours early.
 */
const RESET_RE =
  /resets\s+([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:,?\s*(\d{4}))?\s+at\s+(\d{1,2})(?::(\d{2}))?\s*([ap])\.?m\.?\s*(?:\(([^)]+)\))?/i;

const MONTHS: Record<string, number> = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};

/** The host's zone, used when a reset line carries no zone of its own. */
function hostTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

/**
 * How far `timeZone` is from UTC at `ts`, in ms.
 *
 * Formatting the instant in the zone and reading it back as if it were UTC
 * gives the offset without a table: the difference between the two is exactly
 * what the zone was doing at that moment, DST included.
 */
function zoneOffsetMs(ts: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(ts));

  const field = (type: string): number => {
    const part = parts.find((p) => p.type === type);
    return part ? Number(part.value) : 0;
  };

  // en-US with hour12:false prints midnight as 24 in some ICU versions.
  const hour = field("hour") % 24;

  const asIfUtc = Date.UTC(field("year"), field("month") - 1, field("day"), hour, field("minute"), field("second"));
  return asIfUtc - ts;
}

/**
 * The instant at which a wall-clock time occurs in a named zone.
 *
 * Two passes, because the offset depends on the answer. The first guess uses
 * the offset at the naive instant, and the second corrects it when that guess
 * landed on the other side of a DST boundary.
 */
function wallTimeToInstant(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timeZone: string
): number {
  const naive = Date.UTC(year, month, day, hour, minute, 0);
  const first = zoneOffsetMs(naive, timeZone);
  const candidate = naive - first;
  const second = zoneOffsetMs(candidate, timeZone);
  return second === first ? candidate : naive - second;
}

/** The calendar year `ts` falls in, as seen from `timeZone`. */
function yearInZone(ts: number, timeZone: string): number {
  const value = new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric" }).format(new Date(ts));
  return Number(value.replace(/\D/g, ""));
}

/**
 * Resolve one printed reset string to an instant, or null when any part of it
 * is unresolvable: an unknown month name, a zone ICU does not know, a clock
 * time that makes no sense. Unparsed is a supported outcome here; a wrong
 * instant is not, because a fabricated reset in the past would unthrottle the
 * gate on evidence nobody produced.
 */
function parseResetAt(text: string, now: number, defaultZone: string): number | null {
  const m = RESET_RE.exec(text);
  if (!m) return null;

  const monthName = m[1];
  const dayText = m[2];
  const yearText = m[3];
  const hourText = m[4];
  const minuteText = m[5];
  const meridiem = m[6];
  const zoneName = m[7];
  if (!monthName || !dayText || !hourText || !meridiem) return null;

  const month = MONTHS[monthName.slice(0, 3).toLowerCase()];
  if (month === undefined) return null;

  const day = Number(dayText);
  if (day < 1 || day > 31) return null;

  const rawHour = Number(hourText);
  if (rawHour < 1 || rawHour > 12) return null;
  const minute = minuteText === undefined ? 0 : Number(minuteText);
  if (minute > 59) return null;

  const pm = meridiem.toLowerCase() === "p";
  const hour = pm ? (rawHour === 12 ? 12 : rawHour + 12) : rawHour === 12 ? 0 : rawHour;

  const timeZone = zoneName?.trim() || defaultZone;

  try {
    if (yearText) return wallTimeToInstant(Number(yearText), month, day, hour, minute, timeZone);

    // No year in the string, so take the next matching occurrence. The grace
    // window keeps a reset that has only just passed from being read as one
    // eleven months away, which would pin the gate in `throttled`.
    const thisYear = yearInZone(now, timeZone);
    const candidate = wallTimeToInstant(thisYear, month, day, hour, minute, timeZone);
    if (candidate >= now - ROLLOVER_GRACE_MS) return candidate;
    return wallTimeToInstant(thisYear + 1, month, day, hour, minute, timeZone);
  } catch {
    // RangeError from an unresolvable zone name. Best-effort means the
    // percentage on this line still counts; only its reset is lost.
    return null;
  }
}

/**
 * Parse the CLI's usage report, or return null.
 *
 * Null is the fail-closed answer and the caller must treat it as such. No
 * percentage was readable, so no percentage may be assumed. A line whose
 * `% used` figure is outside 0-100 poisons the whole reading rather than
 * being skipped, because a format that can print 234% is a format this
 * parser no longer understands, and quietly using the other lines would
 * under-report exactly when it matters.
 */
export function parseUsage(
  output: string,
  options: { now: number; timeZone?: string }
): UsageReading | null {
  const defaultZone = options.timeZone ?? hostTimeZone();
  const windows: UsageWindow[] = [];

  for (const line of output.split(/\r?\n/)) {
    const m = PERCENT_RE.exec(line);
    if (!m) continue;

    const captured = m[1];
    if (captured === undefined) continue;

    const percent = Number(captured);
    if (!Number.isFinite(percent) || percent < 0 || percent > 100) return null;

    const label = line.slice(0, m.index).replace(/[\s:·-]+$/, "").trim();
    const resetIndex = line.toLowerCase().indexOf("resets", m.index);
    const resetText = resetIndex === -1 ? null : line.slice(resetIndex).trim();

    windows.push({
      label: label || "window",
      percent,
      resetAt: resetText ? parseResetAt(resetText, options.now, defaultZone) : null,
      resetText,
    });
  }

  if (windows.length === 0) return null;

  const maxPercent = windows.reduce((max, w) => (w.percent > max ? w.percent : max), 0);

  // The reset that matters is the one belonging to the window driving the
  // maximum. If several are tied there, the max only falls once the last of
  // them resets; if any of them has no parsed reset, the gate cannot know
  // when the block lifts and runs on hysteresis alone.
  const leaders = windows.filter((w) => w.percent === maxPercent);
  const resetAt = leaders.some((w) => w.resetAt === null)
    ? null
    : leaders.reduce<number>((latest, w) => Math.max(latest, w.resetAt as number), 0);

  return { windows, maxPercent, resetAt, readAt: options.now };
}

// ─── The probe ──────────────────────────────────────────────────────────────

export type UsageSpawn = (cmd: string[], opts: { timeoutSeconds: number }) => Promise<SpawnOutcome>;

export interface ClaudeUsageProbeOptions {
  /**
   * The resolved absolute path to the CLI, read fresh on every probe so a
   * re-probe by the binary resolver takes effect without rebuilding the gate.
   * Null means unresolved, which is a probe failure, not a zero reading.
   */
  binPath: () => string | null;
  /** Called when the spawn fails outright, so the daemon can re-probe its paths. */
  onSpawnFailure?: (error: Error) => void | Promise<void>;
  timeoutSeconds?: number;
  /** Injectable for tests that do not want a real process. */
  spawn?: UsageSpawn;
}

/**
 * The real probe: spawn the CLI with the usage command and hand back what it
 * printed. Never throws; a missing binary is an error string, and the gate
 * counts that as an unreadable probe like any other.
 */
export function createClaudeUsageProbe(options: ClaudeUsageProbeOptions): UsageProbe {
  const spawn = options.spawn ?? run;
  const timeoutSeconds = options.timeoutSeconds ?? USAGE_TIMEOUT_SECONDS;

  return async () => {
    const bin = options.binPath();
    if (!bin) return { output: "", error: "claude binary not resolved" };

    try {
      const outcome = await spawn([bin, "-p", USAGE_COMMAND], { timeoutSeconds });

      if (outcome.timedOut) {
        // Partial output is deliberately not returned as usable. A truncated
        // report can be missing the very window that is exhausted, and a
        // reading that under-reports is worse than no reading at all.
        return { output: outcome.stdout, error: `claude ${USAGE_COMMAND} timed out after ${timeoutSeconds}s` };
      }

      if (outcome.exitCode !== 0) {
        const detail = outcome.stderr.trim().split("\n").slice(0, 3).join(" ") || `exit ${outcome.exitCode}`;
        return { output: outcome.stdout, error: `claude ${USAGE_COMMAND} failed: ${detail}` };
      }

      return { output: outcome.stdout, error: null };
    } catch (err) {
      const error = err as Error;
      await options.onSpawnFailure?.(error);
      return { output: "", error: error.message };
    }
  };
}

// ─── The gate ───────────────────────────────────────────────────────────────

export interface QuotaTimers {
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

const REAL_TIMERS: QuotaTimers = {
  setInterval(fn, ms) {
    const handle = setInterval(fn, ms);
    (handle as { unref?: () => void }).unref?.();
    return handle;
  },
  clearInterval(handle) {
    clearInterval(handle as ReturnType<typeof setInterval>);
  },
};

export interface CreateQuotaGateOptions {
  probe: UsageProbe;
  thresholds?: QuotaThresholds;
  /** Injected clock. Everything time-shaped in this file reads it and nothing calls Date.now(). */
  now?: () => number;
  /** Zone for the daily counter's midnight and for reset lines that carry no zone. */
  timeZone?: string;
  /** Every dispatch decision goes here, mode included (requirements R4.3). */
  log?: (decision: QuotaDecision) => void;
  /** Fires once per throttled entry (requirements R4.4). */
  onPause?: (pause: QuotaPause) => void;
  /** Fires when the mode or the reading changes, for the SSE `quota-changed` event. */
  onChange?: (state: QuotaState) => void;
  timers?: QuotaTimers;
}

export interface QuotaGate {
  /**
   * Ask permission to dispatch one Round. Probes first when the cached
   * reading is stale. An allowed decision consumes a run from the daily
   * counter, so a caller that gets `allowed` must dispatch or lose the slot;
   * that is what keeps a burst of concurrent callers from stepping over the
   * cap between a check and a dispatch.
   */
  requestDispatch(): Promise<QuotaDecision>;
  /** Probe now, whatever the cache says, and return the resulting state. */
  refresh(): Promise<QuotaState>;
  /** The current state, with expiry and the day rollover settled first. */
  state(): QuotaState;
  /** Config.md changed under us. */
  setThresholds(thresholds: QuotaThresholds): void;
  /** Start the background refresh. It probes only while `queueLength()` is non-zero. */
  start(queueLength: () => number): void;
  stop(): void;
}

function normalise(thresholds: QuotaThresholds): QuotaThresholds {
  const pause = Math.min(100, Math.max(1, thresholds.pause_above_pct));
  return {
    pause_above_pct: pause,
    // A resume threshold above the pause threshold has no hysteresis left in
    // it and would flap the gate on every reading, so it is clamped rather
    // than trusted.
    resume_below_pct: Math.min(thresholds.resume_below_pct, pause),
    daily_cap: Math.max(0, thresholds.daily_cap),
  };
}

/** The local calendar day, for the fallback counter's midnight rollover. */
function dayKey(ts: number, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date(ts));
  } catch {
    return new Date(ts).toISOString().slice(0, 10);
  }
}

export function createQuotaGate(options: CreateQuotaGateOptions): QuotaGate {
  const clock = options.now ?? Date.now;
  const timeZone = options.timeZone ?? hostTimeZone();
  const timers = options.timers ?? REAL_TIMERS;

  let thresholds = normalise(options.thresholds ?? QUOTA_DEFAULTS);
  let mode: QuotaMode = "ok";
  let reading: UsageReading | null = null;
  let throttleResetAt: number | null = null;
  let failures = 0;
  let lastError: string | null = null;
  let lastProbeFailed = false;
  let forceProbe = false;

  // Runs are counted in every mode, not only in fallback. The cap is a cap on
  // the day, so a gate that drops into fallback at noon has to account for the
  // work it already dispatched that morning.
  let runsToday = 0;
  let runsDay: string | null = null;

  /** Distinguishes one throttled entry from the next when no reset parsed. */
  let entryCount = 0;
  let lastPauseKey: string | null = null;

  let inFlight: Promise<void> | null = null;
  let timer: unknown = null;

  function snapshot(): QuotaState {
    return {
      mode,
      maxPercent: reading?.maxPercent ?? null,
      windows: reading?.windows ?? [],
      readAt: reading?.readAt ?? null,
      resetAt: throttleResetAt,
      consecutiveParseFailures: failures,
      runsToday,
      dailyCap: thresholds.daily_cap,
      lastError,
    };
  }

  function emitChange(): void {
    options.onChange?.(snapshot());
  }

  function enterThrottled(at: number, max: number, resetAt: number | null): void {
    mode = "throttled";
    throttleResetAt = resetAt;
    entryCount += 1;

    // Deduped on the reset instant when one parsed, so re-entering the same
    // exhausted window does not notify twice; on the entry itself otherwise,
    // where every entry is genuinely new information.
    const dedupeKey = resetAt === null ? `entry:${entryCount}` : `reset:${resetAt}`;
    if (dedupeKey === lastPauseKey) return;

    lastPauseKey = dedupeKey;
    options.onPause?.({ at, maxPercent: max, resetAt, dedupeKey });
  }

  function applyReading(next: UsageReading): void {
    const previousMode = mode;
    const previousMax = reading?.maxPercent ?? null;
    reading = next;
    failures = 0;
    lastProbeFailed = false;
    lastError = null;

    // A readable report restores percentage gating; fallback is only ever a
    // stand-in for numbers the gate could not get.
    if (mode === "fallback") mode = "ok";

    if (mode === "throttled") {
      if (next.maxPercent < thresholds.resume_below_pct) {
        mode = "ok";
        throttleResetAt = null;
      } else {
        // Still throttled: keep tracking the reset of whatever is blocking now.
        throttleResetAt = next.resetAt;
      }
    } else if (next.maxPercent > thresholds.pause_above_pct) {
      enterThrottled(next.readAt, next.maxPercent, next.resetAt);
    }

    if (mode !== previousMode || next.maxPercent !== previousMax) emitChange();
  }

  function applyFailure(error: string): void {
    failures += 1;
    lastProbeFailed = true;
    lastError = error;

    if (failures >= FALLBACK_AFTER_FAILURES && mode !== "fallback") {
      // Note the tradeoff: a gate that was throttled lands in fallback and
      // starts allowing work again under the daily cap. That is the spec's
      // choice (requirements R4.3) and the alternative is worse. A throttle
      // with no readable percentages and no parsed reset would otherwise never
      // lift, and the daemon would stop reviewing until someone restarted it.
      mode = "fallback";
      throttleResetAt = null;
      emitChange();
    }
  }

  function runProbe(): Promise<void> {
    if (inFlight) return inFlight;

    inFlight = (async () => {
      const result = await options.probe();
      forceProbe = false;

      if (result.error !== null) {
        applyFailure(result.error);
        return;
      }

      const parsed = parseUsage(result.output, { now: clock(), timeZone });
      if (parsed === null) {
        applyFailure("usage output did not parse");
        return;
      }

      applyReading(parsed);
    })().finally(() => {
      inFlight = null;
    });

    return inFlight;
  }

  /** Day rollover and throttle expiry, both driven by the injected clock. */
  function settle(now: number): void {
    const today = dayKey(now, timeZone);
    if (runsDay !== today) {
      runsDay = today;
      runsToday = 0;
    }

    if (mode === "throttled" && throttleResetAt !== null && now >= throttleResetAt) {
      mode = "ok";
      throttleResetAt = null;
      // The cached percentages describe a window that no longer exists, so
      // the next dispatch re-reads rather than trusting them.
      forceProbe = true;
      emitChange();
    }
  }

  function needsProbe(now: number): boolean {
    if (forceProbe) return true;
    if (reading === null) return true;
    // A failed probe never counts as a fresh reading, or a broken CLI would
    // buy itself three minutes of un-gated dispatches per failure.
    if (lastProbeFailed) return true;
    return now - reading.readAt >= PROBE_MAX_AGE_MS;
  }

  function evaluate(now: number): Omit<QuotaDecision, "runsToday" | "dailyCap"> {
    const cap = thresholds.daily_cap;
    const max = reading?.maxPercent ?? null;

    // Fallback, and the not-yet-readable state before any successful probe,
    // both gate on the counter. Gating an unknown state on the cap is the
    // fail-closed reading of "never assume a percentage".
    if (mode === "fallback" || reading === null) {
      const allowed = runsToday < cap;
      const source = mode === "fallback" ? "fallback" : "no usage reading yet";
      const detail = lastError ? ` (${lastError})` : "";
      return {
        allowed,
        mode,
        reason: allowed
          ? `${source}: run ${runsToday + 1} of ${cap} today${detail}`
          : `${source}: daily cap of ${cap} reached${detail}`,
        maxPercent: max,
        at: now,
      };
    }

    if (mode === "throttled") {
      const until = throttleResetAt === null ? "no parsed reset" : new Date(throttleResetAt).toISOString();
      return {
        allowed: false,
        mode,
        reason: `throttled: usage ${max}% above pause_above_pct ${thresholds.pause_above_pct}, resumes below ${thresholds.resume_below_pct} or at ${until}`,
        maxPercent: max,
        at: now,
      };
    }

    return {
      allowed: true,
      mode,
      reason: `usage ${max}% at or below pause_above_pct ${thresholds.pause_above_pct}`,
      maxPercent: max,
      at: now,
    };
  }

  return {
    async requestDispatch() {
      settle(clock());
      if (needsProbe(clock())) await runProbe();

      const now = clock();
      settle(now);

      const verdict = evaluate(now);
      if (verdict.allowed) runsToday += 1;

      const decision: QuotaDecision = {
        ...verdict,
        runsToday,
        dailyCap: thresholds.daily_cap,
      };

      options.log?.(decision);
      return decision;
    },

    async refresh() {
      settle(clock());
      await runProbe();
      settle(clock());
      return snapshot();
    },

    state() {
      settle(clock());
      return snapshot();
    },

    setThresholds(next) {
      thresholds = normalise(next);
    },

    start(queueLength) {
      if (timer !== null) return;
      timer = timers.setInterval(() => {
        // Nothing queued means nothing to gate, and a probe every five
        // minutes on an idle machine is four seconds of CLI for no reason.
        if (queueLength() <= 0) return;
        void runProbe();
      }, BACKGROUND_REFRESH_MS);
    },

    stop() {
      if (timer === null) return;
      timers.clearInterval(timer);
      timer = null;
    },
  };
}

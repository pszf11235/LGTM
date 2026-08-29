/**
 * The review queue: what runs next, how much runs at once, and what happens
 * when a PR collects new commits while a Round is already going.
 *
 * design.md's poll cycle ends by draining this queue "through the quota gate
 * and the concurrency cap", and states the four rules the module exists to
 * enforce:
 *
 *   1. At most one entry per PR, ever.
 *   2. A newer head SHA replaces a queued entry instead of adding a second.
 *   3. An in-flight Round is never cancelled. It runs to completion, records
 *      the SHA it actually reviewed, and the PR re-queues for the newer one.
 *   4. One PR never has two Rounds running at once.
 *
 * The M0 spike measured 5m44s for a two-file PR (spike-provider.md), which is
 * what makes those rules worth code rather than comments. A Round is minutes
 * of wall clock, so a PR under active development can collect three new head
 * SHAs before its first Round finishes, and a queue that just appends would
 * spend half an hour of a 2-wide pipe reviewing three dead commits.
 *
 * What this module deliberately does not know: whether a SHA has already been
 * reviewed, what a PR's state on disk is, or what a Round does. The poll cycle
 * decides what deserves a Round; `dispatch` runs it and writes the result. The
 * queue only orders the work and counts the slots.
 */

import type { PRRef } from "@/core";
import { formatRef } from "@/core/pr-ref";

// ─── Types ──────────────────────────────────────────────────────────────────

/** design.md, "Architecture": two Rounds at once, globally, not per repo. */
export const DEFAULT_CONCURRENCY = 2;

/**
 * How long a held queue waits before re-consulting the dispatch gate on its
 * own. The QuotaGate is expected to call `drain()` when it reopens, so this
 * is the backstop for the case where it doesn't. Without it, one missed kick
 * leaves a daemon that polls forever and reviews nothing.
 */
export const DEFAULT_HOLD_RETRY_MS = 60_000;

/** One PR waiting for a slot, at the head SHA it was last enqueued for. */
export interface QueueEntry {
  readonly ref: PRRef;
  readonly headSha: string;
  /**
   * From the injected clock, at first enqueue. A replacement keeps it, so
   * this is when the PR got in line, not when its SHA last changed.
   */
  readonly queuedAt: number;
}

/** One Round currently running, and the SHA it is reviewing. */
export interface InFlightRound {
  readonly ref: PRRef;
  readonly headSha: string;
  readonly startedAt: number;
}

/**
 * What `enqueue` did with the request. The poll cycle uses this to decide
 * what to write to `meta.md`, and it is the observable half of rules 1 and 2.
 *
 * - `queued`: a new entry. The PR was idle, or it is in flight at an older
 *   SHA and the newer one is now parked behind that Round.
 * - `replaced`: the PR was already waiting, and its entry now carries this
 *   SHA instead. Still one entry.
 * - `already-queued`: the PR is waiting at exactly this SHA. Nothing changed.
 * - `in-flight`: this SHA is being reviewed right now. Nothing changed, and
 *   no second Round starts for it.
 */
export type EnqueueOutcome = "queued" | "replaced" | "already-queued" | "in-flight";

/** The queue's half of `GET /api/status` (design.md, "HTTP API"). */
export interface QueueSnapshot {
  queued: number;
  inFlight: number;
  /** FIFO order, so the first element is the next PR to run. */
  queuedEntries: QueueEntry[];
  inFlightRounds: InFlightRound[];
  /** True when the last drain stopped because the dispatch gate said no. */
  pausedByGate: boolean;
}

/**
 * The hook the QuotaGate plugs into. Consulted before each dispatch, never on
 * an empty queue and never when the concurrency cap is already full, so a
 * quiet daemon does not spawn a usage probe every time it thinks about work.
 *
 * A false answer holds the queue. Nothing is dropped and nothing is
 * reordered; the same entry is the next candidate when the gate reopens
 * (requirements R4.2, "Queued work is kept, not dropped").
 */
export type DispatchGate = () => boolean | Promise<boolean>;

/**
 * Runs one Round. Resolving and rejecting both free the slot; the queue draws
 * no other conclusion from either, because a failed Round is the poll cycle's
 * business (requirements R3.5) and not the queue's.
 */
export type DispatchFn = (entry: QueueEntry) => Promise<void>;

/**
 * Where the failure happened. `drain` is the catch-all for the queue's own
 * bookkeeping and should never appear; it exists so that if it ever does, it
 * lands in the log rather than in an unhandled rejection.
 */
export type QueueErrorPhase = "gate" | "dispatch" | "drain";

export interface QueueError {
  phase: QueueErrorPhase;
  /** The entry being dispatched, or null for a failure not tied to one. */
  entry: QueueEntry | null;
  error: unknown;
}

export interface ReviewQueueOptions {
  dispatch: DispatchFn;
  /** Defaults to always open, which is what the tests that are not about quota want. */
  canDispatch?: DispatchGate;
  /** Defaults to DEFAULT_CONCURRENCY. Values below 1 are clamped up, see below. */
  concurrency?: number;
  /** Injected so timestamps in the snapshot are testable. Defaults to Date.now. */
  now?: () => number;
  /** Logging seam. Never called with a queue in a broken state; the slot is always freed first. */
  onError?: (failure: QueueError) => void;
  /** 0 disables the self-retry. Defaults to DEFAULT_HOLD_RETRY_MS. */
  holdRetryMs?: number;
  /** Returns its own canceller. Injected so tests never wait on a real timer. */
  setTimer?: (fn: () => void, ms: number) => () => void;
}

export interface ReviewQueue {
  /** Add or update this PR's single entry. See EnqueueOutcome. Kicks a drain. */
  enqueue(ref: PRRef, headSha: string): EnqueueOutcome;
  /**
   * Drop a PR's queued entry, for a PR that closed or got skipped before its
   * turn came. Returns whether there was one. An in-flight Round is never
   * cancelled, so this does not touch one.
   */
  remove(ref: PRRef): boolean;
  /**
   * Start every Round the gate and the cap allow. Resolves once the pass is
   * over, meaning the dispatches have started, not that they have finished.
   * Call it after the QuotaGate reopens.
   */
  drain(): Promise<void>;
  status(): QueueSnapshot;
  /** Stop dispatching and cancel the retry timer. In-flight Rounds keep running. */
  stop(): void;
}

// ─── Queue ──────────────────────────────────────────────────────────────────

function defaultSetTimer(fn: () => void, ms: number): () => void {
  const handle = setTimeout(fn, ms);
  // A retry that keeps the process alive would outlive the daemon it serves.
  (handle as unknown as { unref?: () => void }).unref?.();
  return () => clearTimeout(handle);
}

function normaliseConcurrency(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return DEFAULT_CONCURRENCY;
  // A configured 0 or a negative is a daemon that queues forever and reviews
  // nothing, which looks exactly like a hung daemon from the outside. Clamp.
  return Math.max(1, Math.floor(value));
}

export function createReviewQueue(options: ReviewQueueOptions): ReviewQueue {
  const dispatch = options.dispatch;
  const canDispatch = options.canDispatch ?? (() => true);
  const now = options.now ?? Date.now;
  const report = options.onError;
  const setTimer = options.setTimer ?? defaultSetTimer;
  const holdRetryMs = options.holdRetryMs ?? DEFAULT_HOLD_RETRY_MS;
  const concurrency = normaliseConcurrency(options.concurrency);

  /**
   * Keyed by `owner/repo#number`, which is what makes rule 1 structural
   * rather than a check somebody has to remember. Map iteration is insertion
   * ordered, and `set` on an existing key keeps that key's position, so the
   * map is the FIFO order and replacement keeps a PR's place in line for
   * free.
   */
  const queued = new Map<string, QueueEntry>();
  const inFlight = new Map<string, InFlightRound>();

  let draining: Promise<void> | null = null;
  let drainRequested = false;
  let pausedByGate = false;
  let cancelHoldRetry: (() => void) | null = null;
  let stopped = false;

  function key(ref: PRRef): string {
    return formatRef(ref);
  }

  /**
   * The first waiting entry whose PR has no Round running. Skipping the ones
   * that do is rule 4: a PR with a Round in flight and a newer SHA waiting
   * simply is not a candidate until that Round lands.
   */
  function nextReady(): QueueEntry | null {
    for (const [k, entry] of queued) {
      if (!inFlight.has(k)) return entry;
    }
    return null;
  }

  async function gateAllows(entry: QueueEntry): Promise<boolean> {
    try {
      return await canDispatch();
    } catch (error) {
      // A gate that cannot answer fails closed, matching how the quota parser
      // handles output it cannot read (design.md, "Quota gate"). Dispatching
      // on an unknown quota is how LGTM ends up competing with the user for
      // the subscription it is supposed to stay out of the way of.
      report?.({ phase: "gate", entry, error });
      return false;
    }
  }

  function scheduleHoldRetry(): void {
    if (stopped || holdRetryMs <= 0 || cancelHoldRetry) return;
    cancelHoldRetry = setTimer(() => {
      cancelHoldRetry = null;
      void drain();
    }, holdRetryMs);
  }

  function startRound(entry: QueueEntry): void {
    const k = key(entry.ref);
    inFlight.set(k, { ref: entry.ref, headSha: entry.headSha, startedAt: now() });

    const release = (): void => {
      inFlight.delete(k);
      void drain();
    };

    // Promise.resolve().then() rather than calling dispatch directly: a
    // dispatch that throws synchronously has to release its slot too. A leaked
    // slot is a silent halving of throughput, and two of them are a daemon
    // that polls, queues, and never reviews anything again.
    void Promise.resolve()
      .then(() => dispatch(entry))
      .then(undefined, (error: unknown) => {
        try {
          report?.({ phase: "dispatch", entry, error });
        } catch {
          // A logging hook that throws must not take the slot with it.
        }
      })
      .finally(release);
  }

  async function pass(): Promise<void> {
    for (;;) {
      if (stopped) return;
      if (inFlight.size >= concurrency) return;

      const candidate = nextReady();
      if (!candidate) {
        pausedByGate = false; // idle is not the same as held
        return;
      }

      if (!(await gateAllows(candidate))) {
        pausedByGate = true;
        scheduleHoldRetry();
        return;
      }
      pausedByGate = false;

      // Awaiting the gate let other code run, so re-read the entry: a bump
      // that arrived during the await should be reviewed at its newer SHA,
      // and a PR that closed during it should not be reviewed at all.
      const k = key(candidate.ref);
      const entry = queued.get(k);
      if (!entry) continue;
      queued.delete(k);
      startRound(entry);
    }
  }

  function drain(): Promise<void> {
    if (stopped) return Promise.resolve();
    // One pass at a time. Everything a pass reads (the maps, the cap) can
    // change across its awaits, and serialising is what keeps two concurrent
    // drains from handing the same entry to two dispatches. A caller that
    // arrives mid-pass gets that pass plus one more, because its reason for
    // calling (a reopened gate, a freed slot) may postdate what the running
    // pass already decided.
    if (draining) {
      drainRequested = true;
      return draining;
    }
    draining = (async () => {
      try {
        do {
          drainRequested = false;
          await pass();
        } while (drainRequested && !stopped);
      } catch (error) {
        report?.({ phase: "drain", entry: null, error });
      } finally {
        draining = null;
      }
    })();
    return draining;
  }

  return {
    enqueue(ref, headSha) {
      const k = key(ref);
      const waiting = queued.get(k);

      if (waiting) {
        if (waiting.headSha === headSha) return "already-queued";
        // Rule 2. The entry keeps its slot in the map and its queuedAt, so a
        // PR whose author pushes every two minutes cannot shove itself to the
        // back of the line forever while quieter PRs overtake it.
        queued.set(k, { ref: waiting.ref, headSha, queuedAt: waiting.queuedAt });
        void drain();
        return "replaced";
      }

      const running = inFlight.get(k);
      if (running && running.headSha === headSha) return "in-flight";

      // Either the PR is idle, or a Round is running on an older SHA and this
      // one waits behind it (rule 3). Same map either way, so the SHA that
      // arrives while a Round is in flight is the same single entry that a
      // later bump replaces.
      queued.set(k, { ref: { ...ref }, headSha, queuedAt: now() });
      void drain();
      return "queued";
    },

    remove(ref) {
      return queued.delete(key(ref));
    },

    drain,

    status() {
      // Copies, because the status route hands these to a JSON serialiser and
      // to whatever the SPA does next, and neither should be able to reach
      // into the queue's own bookkeeping.
      return {
        queued: queued.size,
        inFlight: inFlight.size,
        queuedEntries: [...queued.values()].map((entry) => ({
          ref: { ...entry.ref },
          headSha: entry.headSha,
          queuedAt: entry.queuedAt,
        })),
        inFlightRounds: [...inFlight.values()].map((round) => ({
          ref: { ...round.ref },
          headSha: round.headSha,
          startedAt: round.startedAt,
        })),
        pausedByGate,
      };
    },

    stop() {
      stopped = true;
      cancelHoldRetry?.();
      cancelHoldRetry = null;
    },
  };
}

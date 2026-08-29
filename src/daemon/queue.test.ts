/**
 * These tests are about races, so nothing here is allowed to depend on real
 * time or on a Round actually finishing. Every dispatch hands back a deferred
 * the test resolves by hand, the clock is a variable, and the hold retry runs
 * on a fake timer, so "a new SHA lands while a Round is in flight" is a
 * two-line setup instead of a six-minute one.
 *
 * `settle()` is the one piece of machinery worth explaining. Resolving a
 * dispatch does not free its slot synchronously; the release runs on a
 * microtask and kicks a drain of its own. One macrotask turn (setTimeout 0)
 * drains every pending microtask, so by the time it runs, that drain has
 * started, and awaiting drain() then joins the pass in progress rather than
 * guessing how many turns it needs.
 */
import { describe, expect, test } from "bun:test";
import type { PRRef } from "@/core";
import {
  createReviewQueue,
  DEFAULT_CONCURRENCY,
  type QueueError,
  type ReviewQueue,
  type ReviewQueueOptions,
} from "./queue";

// ─── Harness ────────────────────────────────────────────────────────────────

interface Deferred {
  promise: Promise<void>;
  resolve: () => void;
  reject: (error: unknown) => void;
}

function deferred(): Deferred {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = () => res();
    reject = rej;
  });
  return { promise, resolve, reject };
}

interface FakeTimer {
  ms: number;
  fn: () => void;
  cancelled: boolean;
  fired: boolean;
}

function createFakeTimers() {
  const scheduled: FakeTimer[] = [];
  return {
    scheduled,
    setTimer(fn: () => void, ms: number): () => void {
      const timer: FakeTimer = { ms, fn, cancelled: false, fired: false };
      scheduled.push(timer);
      return () => {
        timer.cancelled = true;
      };
    },
    pending(): FakeTimer[] {
      return scheduled.filter((timer) => !timer.cancelled && !timer.fired);
    },
    fireAll(): void {
      for (const timer of scheduled.filter((t) => !t.cancelled && !t.fired)) {
        timer.fired = true;
        timer.fn();
      }
    },
  };
}

const pr = (number: number): PRRef => ({ owner: "acme", repo: "api", number });

/** `acme/api#7@sha2`, so an ordering assertion reads as a sentence. */
function label(round: { ref: PRRef; headSha: string }): string {
  return `${round.ref.owner}/${round.ref.repo}#${round.ref.number}@${round.headSha}`;
}

function harness(overrides: Partial<ReviewQueueOptions> = {}) {
  let clock = 1_000;
  const dispatched: Array<{ ref: PRRef; headSha: string }> = [];
  const rounds: Deferred[] = [];
  const failures: QueueError[] = [];
  const timers = createFakeTimers();

  const queue: ReviewQueue = createReviewQueue({
    dispatch: (entry) => {
      dispatched.push({ ref: entry.ref, headSha: entry.headSha });
      const round = deferred();
      rounds.push(round);
      return round.promise;
    },
    now: () => clock,
    onError: (failure) => {
      failures.push(failure);
    },
    setTimer: timers.setTimer,
    ...overrides,
  });

  async function settle(): Promise<void> {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    await queue.drain();
  }

  async function finish(index: number): Promise<void> {
    rounds[index]!.resolve();
    await settle();
  }

  async function failRound(index: number, error: unknown): Promise<void> {
    rounds[index]!.reject(error);
    await settle();
  }

  return {
    queue,
    dispatched,
    failures,
    timers,
    settle,
    finish,
    failRound,
    advanceClock: (ms: number) => {
      clock += ms;
    },
    labels: () => dispatched.map(label),
  };
}

// ─── Concurrency and ordering ───────────────────────────────────────────────

describe("concurrency", () => {
  test("runs two Rounds at once and holds the rest", async () => {
    const h = harness();

    h.queue.enqueue(pr(1), "sha1");
    h.queue.enqueue(pr(2), "sha1");
    h.queue.enqueue(pr(3), "sha1");
    await h.settle();

    expect(h.labels()).toEqual(["acme/api#1@sha1", "acme/api#2@sha1"]);
    expect(h.queue.status()).toMatchObject({ inFlight: 2, queued: 1 });
  });

  test("the cap is global, not per repo", async () => {
    const h = harness();

    h.queue.enqueue({ owner: "acme", repo: "api", number: 1 }, "sha1");
    h.queue.enqueue({ owner: "acme", repo: "web", number: 1 }, "sha1");
    h.queue.enqueue({ owner: "other", repo: "thing", number: 1 }, "sha1");
    await h.settle();

    expect(h.dispatched).toHaveLength(2);
    expect(h.queue.status().queued).toBe(1);
  });

  test("design.md's cap of two is the default", () => {
    expect(DEFAULT_CONCURRENCY).toBe(2);
  });

  test("a freed slot goes to the oldest ready entry", async () => {
    const h = harness();

    h.queue.enqueue(pr(1), "sha1");
    h.queue.enqueue(pr(2), "sha1");
    h.queue.enqueue(pr(3), "sha1");
    h.queue.enqueue(pr(4), "sha1");
    await h.settle();

    await h.finish(0);
    expect(h.labels()[2]).toBe("acme/api#3@sha1");

    await h.finish(1);
    expect(h.labels()[3]).toBe("acme/api#4@sha1");
  });

  test("a concurrency of zero is clamped, because a queue that never dispatches is a hung daemon", async () => {
    const h = harness({ concurrency: 0 });

    h.queue.enqueue(pr(1), "sha1");
    await h.settle();

    expect(h.dispatched).toHaveLength(1);
  });
});

// ─── One entry per PR ───────────────────────────────────────────────────────

describe("one entry per PR", () => {
  test("a newer SHA replaces a queued entry instead of adding a second", async () => {
    const h = harness({ concurrency: 1 });

    h.queue.enqueue(pr(1), "sha1"); // takes the only slot
    h.queue.enqueue(pr(2), "old");
    await h.settle();

    expect(h.queue.enqueue(pr(2), "new")).toBe("replaced");
    expect(h.queue.status().queued).toBe(1);

    await h.finish(0);
    expect(h.labels()).toEqual(["acme/api#1@sha1", "acme/api#2@new"]);
  });

  test("replacement keeps the PR's place in line and its queuedAt", async () => {
    const h = harness({ concurrency: 1 });

    h.queue.enqueue(pr(1), "sha1"); // takes the only slot
    await h.settle();

    h.queue.enqueue(pr(2), "old"); // queued first
    h.advanceClock(60_000);
    h.queue.enqueue(pr(3), "sha1"); // queued second
    h.queue.enqueue(pr(2), "new"); // replacement, not a new arrival

    const [first, second] = h.queue.status().queuedEntries;
    expect(first).toMatchObject({ headSha: "new", queuedAt: 1_000 });
    expect(second?.ref.number).toBe(3);

    await h.finish(0);
    expect(h.labels()[1]).toBe("acme/api#2@new");
  });

  test("enqueueing the same SHA twice changes nothing", async () => {
    const h = harness({ concurrency: 1 });

    h.queue.enqueue(pr(1), "sha1"); // takes the only slot
    await h.settle();

    expect(h.queue.enqueue(pr(2), "sha9")).toBe("queued");
    expect(h.queue.enqueue(pr(2), "sha9")).toBe("already-queued");
    expect(h.queue.status().queued).toBe(1);
  });

  test("the SHA already being reviewed is not queued again", async () => {
    const h = harness();

    h.queue.enqueue(pr(1), "sha1");
    await h.settle();

    expect(h.queue.enqueue(pr(1), "sha1")).toBe("in-flight");
    expect(h.queue.status().queued).toBe(0);

    await h.settle();
    expect(h.dispatched).toHaveLength(1);
  });

  test("one PR never has two Rounds running at once, even with a slot free", async () => {
    const h = harness(); // cap 2, so there is a spare slot throughout

    h.queue.enqueue(pr(1), "sha1");
    await h.settle();
    h.queue.enqueue(pr(1), "sha2");
    await h.settle();

    expect(h.dispatched).toHaveLength(1);
    expect(h.queue.status()).toMatchObject({ inFlight: 1, queued: 1 });
  });
});

// ─── New commits mid-flight ─────────────────────────────────────────────────

describe("a new SHA arriving mid-flight", () => {
  test("the in-flight Round keeps the SHA it started on, and the PR re-queues for the newer one", async () => {
    const h = harness();

    h.queue.enqueue(pr(1), "sha1");
    await h.settle();

    expect(h.queue.enqueue(pr(1), "sha2")).toBe("queued");
    await h.settle();

    // Rule 3: the Round is minutes into real work and is never cancelled.
    expect(h.queue.status().inFlightRounds[0]).toMatchObject({ headSha: "sha1" });
    expect(h.dispatched).toHaveLength(1);

    await h.finish(0);
    expect(h.labels()).toEqual(["acme/api#1@sha1", "acme/api#1@sha2"]);
  });

  test("two rapid bumps collapse into one re-queue at the newest SHA", async () => {
    const h = harness();

    h.queue.enqueue(pr(1), "sha1");
    await h.settle();

    expect(h.queue.enqueue(pr(1), "sha2")).toBe("queued");
    expect(h.queue.enqueue(pr(1), "sha3")).toBe("replaced");
    await h.settle();
    expect(h.queue.status().queued).toBe(1);

    await h.finish(0);
    expect(h.labels()).toEqual(["acme/api#1@sha1", "acme/api#1@sha3"]);

    // sha2 never ran. That is the whole point: it is six minutes of provider
    // time spent on a commit nobody is looking at any more.
    expect(h.dispatched).toHaveLength(2);
  });

  test("a bump that lands while the gate is being consulted is dispatched at the newer SHA", async () => {
    // The gate is async, and enqueue can happen during that await. The pass
    // re-reads the entry afterwards, so the bump wins the slot it was racing.
    const gateOpened = deferred();
    const h = harness({ canDispatch: () => gateOpened.promise.then(() => true) });

    h.queue.enqueue(pr(1), "sha1");
    await Promise.resolve();
    h.queue.enqueue(pr(1), "sha2"); // still queued: the gate has not answered
    gateOpened.resolve();
    await h.settle();

    expect(h.labels()).toEqual(["acme/api#1@sha2"]);
  });

  test("a PR removed while the gate is being consulted is not dispatched", async () => {
    const gateOpened = deferred();
    const h = harness({ canDispatch: () => gateOpened.promise.then(() => true) });

    h.queue.enqueue(pr(1), "sha1");
    await Promise.resolve();
    expect(h.queue.remove(pr(1))).toBe(true);
    gateOpened.resolve();
    await h.settle();

    expect(h.dispatched).toHaveLength(0);
  });
});

// ─── Dispatch gate ──────────────────────────────────────────────────────────

describe("the dispatch gate", () => {
  test("a closed gate holds the queue instead of dropping it, and reopening drains it", async () => {
    let open = false;
    const h = harness({ canDispatch: () => open });

    h.queue.enqueue(pr(1), "sha1");
    h.queue.enqueue(pr(2), "sha1");
    await h.settle();

    expect(h.dispatched).toHaveLength(0);
    expect(h.queue.status()).toMatchObject({ queued: 2, inFlight: 0, pausedByGate: true });

    open = true;
    await h.queue.drain();

    expect(h.labels()).toEqual(["acme/api#1@sha1", "acme/api#2@sha1"]);
    expect(h.queue.status().pausedByGate).toBe(false);
  });

  test("a gate that closes between dispatches holds the entries behind it", async () => {
    let allowances = 1;
    const h = harness({
      canDispatch: () => {
        allowances -= 1;
        return allowances >= 0;
      },
    });

    h.queue.enqueue(pr(1), "sha1");
    h.queue.enqueue(pr(2), "sha1");
    await h.settle();

    expect(h.dispatched).toHaveLength(1);
    expect(h.queue.status()).toMatchObject({ queued: 1, pausedByGate: true });
  });

  test("consulted once per dispatch", async () => {
    let consulted = 0;
    const h = harness({
      canDispatch: async () => {
        consulted += 1;
        return true;
      },
    });

    h.queue.enqueue(pr(1), "sha1");
    h.queue.enqueue(pr(2), "sha1");
    h.queue.enqueue(pr(3), "sha1"); // no slot for this one, so no third consult
    await h.settle();

    expect(consulted).toBe(2);
  });

  test("never consulted with nothing to dispatch, so a quiet daemon runs no usage probes", async () => {
    let consulted = 0;
    const h = harness({
      canDispatch: () => {
        consulted += 1;
        return true;
      },
    });

    await h.queue.drain();
    expect(consulted).toBe(0);

    h.queue.enqueue(pr(1), "sha1");
    h.queue.enqueue(pr(2), "sha1");
    await h.settle();
    expect(consulted).toBe(2);

    // Cap full now. Draining again must not re-ask.
    await h.queue.drain();
    expect(consulted).toBe(2);
  });

  test("a gate that throws fails closed and reports", async () => {
    const h = harness({
      canDispatch: () => {
        throw new Error("usage probe failed");
      },
    });

    h.queue.enqueue(pr(1), "sha1");
    await h.settle();

    expect(h.dispatched).toHaveLength(0);
    expect(h.queue.status()).toMatchObject({ queued: 1, pausedByGate: true });
    expect(h.failures.length).toBeGreaterThanOrEqual(1);
    expect(h.failures[0]?.phase).toBe("gate");
    expect(h.failures[0]?.entry?.ref.number).toBe(1);
  });
});

// ─── Failure paths ──────────────────────────────────────────────────────────

describe("a dispatch that fails", () => {
  test("frees its slot when it rejects", async () => {
    const h = harness({ concurrency: 1 });

    h.queue.enqueue(pr(1), "sha1");
    h.queue.enqueue(pr(2), "sha1");
    await h.settle();
    expect(h.dispatched).toHaveLength(1);

    await h.failRound(0, new Error("provider spawn failed"));

    expect(h.labels()).toEqual(["acme/api#1@sha1", "acme/api#2@sha1"]);
    expect(h.queue.status()).toMatchObject({ inFlight: 1, queued: 0 });
    expect(h.failures[0]?.phase).toBe("dispatch");
    expect(h.failures[0]?.entry?.ref.number).toBe(1);
  });

  test("frees its slot when it throws synchronously", async () => {
    const dispatched: string[] = [];
    const failures: QueueError[] = [];
    const queue = createReviewQueue({
      concurrency: 1,
      dispatch: (entry) => {
        dispatched.push(entry.headSha);
        throw new Error("binary path was stale");
      },
      onError: (failure) => failures.push(failure),
      setTimer: createFakeTimers().setTimer,
    });

    queue.enqueue(pr(1), "sha1");
    queue.enqueue(pr(2), "sha2");
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    await queue.drain();

    // Both ran and both released. A synchronous throw that kept its slot
    // would leave the second entry queued behind a Round that never existed.
    expect(dispatched).toEqual(["sha1", "sha2"]);
    expect(queue.status()).toMatchObject({ inFlight: 0, queued: 0 });
    expect(failures).toHaveLength(2);
  });

  test("frees its slot even when the error hook itself throws", async () => {
    const h = harness({
      concurrency: 1,
      onError: () => {
        throw new Error("logger is down");
      },
    });

    h.queue.enqueue(pr(1), "sha1");
    h.queue.enqueue(pr(2), "sha1");
    await h.settle();

    await h.failRound(0, new Error("provider spawn failed"));

    expect(h.labels()).toEqual(["acme/api#1@sha1", "acme/api#2@sha1"]);
    expect(h.queue.status().inFlight).toBe(1);
  });

  test("a failed Round leaves the PR free to be enqueued again", async () => {
    const h = harness();

    h.queue.enqueue(pr(1), "sha1");
    await h.settle();
    await h.failRound(0, new Error("unparseable output"));

    expect(h.queue.status()).toMatchObject({ inFlight: 0, queued: 0 });
    expect(h.queue.enqueue(pr(1), "sha1")).toBe("queued"); // retry, R3.5
    await h.settle();
    expect(h.dispatched).toHaveLength(2);
  });
});

// ─── Removal ────────────────────────────────────────────────────────────────

describe("remove", () => {
  test("drops a queued entry and reports whether there was one", async () => {
    const h = harness({ concurrency: 1 });

    h.queue.enqueue(pr(1), "sha1"); // takes the only slot
    h.queue.enqueue(pr(2), "sha1");
    await h.settle();

    expect(h.queue.remove(pr(2))).toBe(true);
    expect(h.queue.remove(pr(2))).toBe(false);
    expect(h.queue.status().queued).toBe(0);

    await h.finish(0);
    expect(h.dispatched).toHaveLength(1);
  });

  test("never cancels an in-flight Round", async () => {
    const h = harness();

    h.queue.enqueue(pr(1), "sha1");
    await h.settle();

    expect(h.queue.remove(pr(1))).toBe(false);
    expect(h.queue.status().inFlight).toBe(1);

    await h.finish(0);
    expect(h.queue.status().inFlight).toBe(0);
  });
});

// ─── Status snapshot ────────────────────────────────────────────────────────

describe("status", () => {
  test("reports both counts and the PRs behind them", async () => {
    const h = harness();

    h.queue.enqueue(pr(1), "sha1");
    h.queue.enqueue(pr(2), "sha2");
    h.queue.enqueue(pr(3), "sha3");
    await h.settle();

    const status = h.queue.status();
    expect(status.inFlight).toBe(2);
    expect(status.inFlightRounds.map(label)).toEqual(["acme/api#1@sha1", "acme/api#2@sha2"]);
    expect(status.queued).toBe(1);
    expect(status.queuedEntries.map(label)).toEqual(["acme/api#3@sha3"]);
  });

  test("timestamps come from the injected clock", async () => {
    const h = harness();

    h.queue.enqueue(pr(1), "sha1"); // queuedAt
    h.advanceClock(5_000); // the gate is awaited before the Round starts
    await h.settle(); // startedAt

    expect(h.queue.status().inFlightRounds[0]?.startedAt).toBe(6_000);

    h.queue.enqueue(pr(2), "sha2");
    h.queue.enqueue(pr(3), "sha3");
    await h.settle();
    expect(h.queue.status().queuedEntries[0]?.queuedAt).toBe(6_000);
  });

  test("hands out copies, so the status route cannot reach into the queue", async () => {
    const h = harness({ concurrency: 1 });

    h.queue.enqueue(pr(1), "sha1");
    h.queue.enqueue(pr(2), "sha1");
    await h.settle();

    const snapshot = h.queue.status();
    snapshot.queuedEntries.length = 0;
    snapshot.inFlightRounds.length = 0;

    expect(h.queue.status().queuedEntries).toHaveLength(1);
    expect(h.queue.status().inFlightRounds).toHaveLength(1);
  });
});

// ─── Self-healing while held ────────────────────────────────────────────────

describe("hold retry", () => {
  test("a held queue retries itself instead of waiting for a kick that may never come", async () => {
    let open = false;
    const h = harness({ canDispatch: () => open, holdRetryMs: 60_000 });

    h.queue.enqueue(pr(1), "sha1");
    await h.settle();
    expect(h.dispatched).toHaveLength(0);
    expect(h.timers.pending()).toHaveLength(1);
    expect(h.timers.pending()[0]?.ms).toBe(60_000);

    open = true;
    h.timers.fireAll();
    await h.settle();

    expect(h.labels()).toEqual(["acme/api#1@sha1"]);
  });

  test("repeated holds do not stack timers", async () => {
    const h = harness({ canDispatch: () => false, holdRetryMs: 60_000 });

    h.queue.enqueue(pr(1), "sha1");
    h.queue.enqueue(pr(2), "sha1");
    await h.settle();
    await h.queue.drain();

    expect(h.timers.pending()).toHaveLength(1);
  });

  test("a retry that finds the gate still closed schedules the next one", async () => {
    const h = harness({ canDispatch: () => false, holdRetryMs: 60_000 });

    h.queue.enqueue(pr(1), "sha1");
    await h.settle();

    h.timers.fireAll();
    await h.settle();

    expect(h.timers.pending()).toHaveLength(1);
    expect(h.dispatched).toHaveLength(0);
  });

  test("no timer is scheduled when the retry is disabled", async () => {
    const h = harness({ canDispatch: () => false, holdRetryMs: 0 });

    h.queue.enqueue(pr(1), "sha1");
    await h.settle();

    expect(h.timers.scheduled).toHaveLength(0);
    expect(h.queue.status().queued).toBe(1);
  });
});

// ─── Shutdown ───────────────────────────────────────────────────────────────

describe("stop", () => {
  test("cancels the retry timer and dispatches nothing more", async () => {
    const h = harness({ canDispatch: () => false, holdRetryMs: 60_000 });

    h.queue.enqueue(pr(1), "sha1");
    await h.settle();
    expect(h.timers.pending()).toHaveLength(1);

    h.queue.stop();

    expect(h.timers.pending()).toHaveLength(0);
    await h.queue.drain();
    expect(h.dispatched).toHaveLength(0);
  });

  test("leaves an in-flight Round alone", async () => {
    const h = harness();

    h.queue.enqueue(pr(1), "sha1");
    h.queue.enqueue(pr(2), "sha1");
    await h.settle();

    h.queue.stop();
    expect(h.queue.status().inFlight).toBe(2);

    await h.finish(0);
    await h.finish(1);
    expect(h.queue.status().inFlight).toBe(0);
  });
});

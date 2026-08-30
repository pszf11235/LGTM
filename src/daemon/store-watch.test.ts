/**
 * store-watch.ts turns "a file under the store changed" into "the SPA should
 * refetch this PR", and does it without ever waiting on a real filesystem
 * event or a real timer: every test here drives a fake `WatchFn` by calling
 * its listener directly with the same `(eventType, filename)` shape
 * `fs.watch` hands to a real one, and a fake `setTimer` that only fires when
 * a test tells it to. That is what makes "does the debounce actually
 * coalesce a five-file write into one event" a synchronous assertion instead
 * of a test that sleeps and hopes.
 *
 * `refForChangedPath` gets its own describe block because it is the part
 * carrying the platform risk this module exists to survive: an editor's
 * atomic save renames a temp file over the target, and the reported
 * `filename` is not guaranteed to be the target's own name. Matching on the
 * PR directory rather than the leaf is the fix, and it earns its own tests
 * independent of the debounce machinery around it.
 */
import { describe, expect, test } from "bun:test";
import path from "node:path";
import fs from "node:fs/promises";
import os from "node:os";
import type { PRRef } from "@/core";
import type { DaemonEvent, EventBus } from "./events";
import { createEventBus } from "./events";
import {
  createStoreWatch,
  DEFAULT_DEBOUNCE_MS,
  DEFAULT_MAX_DEFER_MS,
  nodeWatch,
  refForChangedPath,
  type FsEventType,
  type FsListener,
  type WatchFn,
} from "./store-watch";

// ─── refForChangedPath ──────────────────────────────────────────────────────

describe("refForChangedPath", () => {
  test("matches a file inside a PR directory", () => {
    expect(refForChangedPath("reviews/acme/widget/pr-42/meta.md")).toEqual({
      owner: "acme",
      repo: "widget",
      number: 42,
    });
  });

  test("matches the PR directory itself, with no file segment", () => {
    // fs.watch fires for the directory's own creation too (confirmed against
    // Bun's fs.watch: mkdir -p reports one rename event per intermediate
    // segment), and it is exactly as much "this PR changed" as a file under it.
    expect(refForChangedPath("reviews/acme/widget/pr-9")).toEqual({
      owner: "acme",
      repo: "widget",
      number: 9,
    });
  });

  test("matches regardless of the leaf filename, including a dotfile an editor drops", () => {
    // This is the whole reason the match is on the directory and not the
    // filename: an atomic save's temp file lives in the same PR directory.
    expect(refForChangedPath("reviews/acme/widget/pr-42/.meta.md.swp")).toEqual({
      owner: "acme",
      repo: "widget",
      number: 42,
    });
  });

  test("matches a nested path deeper than one file", () => {
    expect(refForChangedPath("reviews/acme/widget/pr-42/nested/whatever.md")).toEqual({
      owner: "acme",
      repo: "widget",
      number: 42,
    });
  });

  test("normalizes backslash separators, for a fake WatchFn on any platform", () => {
    expect(refForChangedPath("reviews\\acme\\widget\\pr-42\\meta.md")).toEqual({
      owner: "acme",
      repo: "widget",
      number: 42,
    });
  });

  for (const outside of ["config.md", "watch.md", "agents/reviewer.md", "templates/review-body.md", "logs/daemon.log", "daemon.json", "token"]) {
    test(`returns null for a store file outside reviews/ (${outside})`, () => {
      expect(refForChangedPath(outside)).toBeNull();
    });
  }

  for (const shallow of ["reviews", "reviews/acme", "reviews/acme/widget"]) {
    test(`returns null above the PR directory (${shallow})`, () => {
      expect(refForChangedPath(shallow)).toBeNull();
    });
  }

  for (const malformed of ["reviews/acme/widget/pr-/meta.md", "reviews/acme/widget/pr-abc/meta.md", "reviews/acme/widget/prs-42/meta.md", "reviews/acme/widget/42/meta.md"]) {
    test(`returns null for a malformed PR segment (${malformed})`, () => {
      expect(refForChangedPath(malformed)).toBeNull();
    });
  }
});

// ─── Fakes ──────────────────────────────────────────────────────────────────

interface FakeTimer {
  ms: number;
  fn: () => void;
  cancelled: boolean;
  fired: boolean;
}

/**
 * Mirrors queue.test.ts's fake timer: `setTimer` records a callback instead
 * of scheduling one, and a test decides when it fires. `fireDue` fires every
 * timer pending at the moment it is called; a callback that re-arms (the
 * `isDaemonWriting` defer path) creates a new, separate pending timer that a
 * later `fireDue()` call picks up, so "the timer kept re-arming itself" is
 * observable by calling `fireDue` more than once.
 */
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
    fireDue(): void {
      for (const timer of scheduled.filter((t) => !t.cancelled && !t.fired)) {
        timer.fired = true;
        timer.fn();
      }
    },
  };
}

/** A `WatchFn` whose "OS" is a test calling `emit` by hand. */
function createFakeWatch() {
  let listener: FsListener | null = null;
  let closeCalls = 0;
  let startCalls = 0;

  const watchFn: WatchFn = (_dir, l) => {
    startCalls += 1;
    listener = l;
    return {
      close: () => {
        closeCalls += 1;
      },
    };
  };

  return {
    watchFn,
    emit(eventType: FsEventType, filename: string | null): void {
      listener?.(eventType, filename);
    },
    get startCalls() {
      return startCalls;
    },
    get closeCalls() {
      return closeCalls;
    },
  };
}

function collectPrChanged(bus: EventBus): PRRef[] {
  const seen: PRRef[] = [];
  bus.on((event: DaemonEvent) => {
    if (event.type === "pr-changed") seen.push(event.ref);
  });
  return seen;
}

const REVIEW_TMP_PREFIX = "lgtm-store-watch-";

// ─── Debouncing ─────────────────────────────────────────────────────────────

describe("createStoreWatch: debouncing", () => {
  test("a single relevant change flushes as one pr-changed once the debounce elapses", () => {
    const bus = createEventBus();
    const seen = collectPrChanged(bus);
    const watch = createFakeWatch();
    const timers = createFakeTimers();

    const sw = createStoreWatch({ dir: "/store", bus, watchFn: watch.watchFn, setTimer: timers.setTimer });
    sw.start();

    watch.emit("change", "reviews/acme/widget/pr-42/meta.md");
    expect(seen).toHaveLength(0); // not yet, the debounce hasn't elapsed

    timers.fireDue();
    expect(seen).toEqual([{ owner: "acme", repo: "widget", number: 42 }]);
  });

  test("schedules the debounce at DEFAULT_DEBOUNCE_MS when unconfigured", () => {
    const bus = createEventBus();
    const watch = createFakeWatch();
    const timers = createFakeTimers();
    const sw = createStoreWatch({ dir: "/store", bus, watchFn: watch.watchFn, setTimer: timers.setTimer });
    sw.start();

    watch.emit("change", "reviews/acme/widget/pr-42/meta.md");

    expect(timers.pending()).toHaveLength(1);
    expect(timers.pending()[0]?.ms).toBe(DEFAULT_DEBOUNCE_MS);
  });

  test("several changes to the same PR inside one window coalesce into a single event", () => {
    const bus = createEventBus();
    const seen = collectPrChanged(bus);
    const watch = createFakeWatch();
    const timers = createFakeTimers();
    const sw = createStoreWatch({ dir: "/store", bus, watchFn: watch.watchFn, setTimer: timers.setTimer });
    sw.start();

    // A round's own write pattern: meta.md, a round file, a diff snapshot.
    watch.emit("change", "reviews/acme/widget/pr-42/meta.md");
    watch.emit("rename", "reviews/acme/widget/pr-42/r1-reviewer.md");
    watch.emit("change", "reviews/acme/widget/pr-42/diff-abc123.patch");

    timers.fireDue();

    expect(seen).toEqual([{ owner: "acme", repo: "widget", number: 42 }]);
  });

  test("changes to different PRs inside one window each get their own event", () => {
    const bus = createEventBus();
    const seen = collectPrChanged(bus);
    const watch = createFakeWatch();
    const timers = createFakeTimers();
    const sw = createStoreWatch({ dir: "/store", bus, watchFn: watch.watchFn, setTimer: timers.setTimer });
    sw.start();

    watch.emit("change", "reviews/acme/widget/pr-1/meta.md");
    watch.emit("change", "reviews/acme/other/pr-2/meta.md");

    timers.fireDue();

    expect(seen).toHaveLength(2);
    expect(seen).toContainEqual({ owner: "acme", repo: "widget", number: 1 });
    expect(seen).toContainEqual({ owner: "acme", repo: "other", number: 2 });
  });

  test("a later change resets the quiet period rather than adding a second timer", () => {
    const bus = createEventBus();
    const seen = collectPrChanged(bus);
    const watch = createFakeWatch();
    const timers = createFakeTimers();
    const sw = createStoreWatch({ dir: "/store", bus, watchFn: watch.watchFn, setTimer: timers.setTimer });
    sw.start();

    watch.emit("change", "reviews/acme/widget/pr-42/meta.md");
    watch.emit("change", "reviews/acme/widget/pr-42/r1-reviewer.md");

    // The first timer was cancelled in favor of a fresh one, not left to fire
    // alongside it.
    expect(timers.scheduled.filter((t) => t.cancelled)).toHaveLength(1);
    expect(timers.pending()).toHaveLength(1);
    expect(seen).toHaveLength(0);

    timers.fireDue();
    expect(seen).toEqual([{ owner: "acme", repo: "widget", number: 42 }]);
  });

  test("a change outside reviews/ arms no timer and reaches no listener", () => {
    const bus = createEventBus();
    const seen = collectPrChanged(bus);
    const watch = createFakeWatch();
    const timers = createFakeTimers();
    const sw = createStoreWatch({ dir: "/store", bus, watchFn: watch.watchFn, setTimer: timers.setTimer });
    sw.start();

    watch.emit("change", "config.md");
    watch.emit("rename", "logs/daemon.log");

    expect(timers.scheduled).toHaveLength(0);
    expect(seen).toHaveLength(0);
  });

  test("a null filename is dropped rather than guessed at", () => {
    const bus = createEventBus();
    const seen = collectPrChanged(bus);
    const watch = createFakeWatch();
    const timers = createFakeTimers();
    const sw = createStoreWatch({ dir: "/store", bus, watchFn: watch.watchFn, setTimer: timers.setTimer });
    sw.start();

    watch.emit("rename", null);

    expect(timers.scheduled).toHaveLength(0);
    expect(seen).toHaveLength(0);
  });

  test("a configured debounceMs is what gets scheduled", () => {
    const bus = createEventBus();
    const watch = createFakeWatch();
    const timers = createFakeTimers();
    const sw = createStoreWatch({
      dir: "/store",
      bus,
      watchFn: watch.watchFn,
      setTimer: timers.setTimer,
      debounceMs: 2_000,
    });
    sw.start();

    watch.emit("change", "reviews/acme/widget/pr-1/meta.md");

    expect(timers.pending()[0]?.ms).toBe(2_000);
  });
});

// ─── isDaemonWriting: telling hand-edits from the daemon's own tail apart ──

describe("createStoreWatch: isDaemonWriting", () => {
  test("defers a flush while the daemon reports it is still writing", () => {
    const bus = createEventBus();
    const seen = collectPrChanged(bus);
    const watch = createFakeWatch();
    const timers = createFakeTimers();
    let writing = true;
    let clock = 0;

    const sw = createStoreWatch({
      dir: "/store",
      bus,
      watchFn: watch.watchFn,
      setTimer: timers.setTimer,
      isDaemonWriting: () => writing,
      now: () => clock,
    });
    sw.start();

    watch.emit("change", "reviews/acme/widget/pr-42/meta.md");
    timers.fireDue(); // debounce elapses, but isDaemonWriting is still true

    expect(seen).toHaveLength(0);
    // Deferred, not dropped: a fresh timer took the first one's place.
    expect(timers.pending()).toHaveLength(1);

    writing = false;
    clock += 100;
    timers.fireDue();

    expect(seen).toEqual([{ owner: "acme", repo: "widget", number: 42 }]);
  });

  test("a change that arrives while deferred joins the same batch, not a second one", () => {
    const bus = createEventBus();
    const seen = collectPrChanged(bus);
    const watch = createFakeWatch();
    const timers = createFakeTimers();
    let writing = true;
    let clock = 0;

    const sw = createStoreWatch({
      dir: "/store",
      bus,
      watchFn: watch.watchFn,
      setTimer: timers.setTimer,
      isDaemonWriting: () => writing,
      now: () => clock,
    });
    sw.start();

    watch.emit("change", "reviews/acme/widget/pr-1/meta.md");
    timers.fireDue(); // deferred: still "writing"

    watch.emit("change", "reviews/acme/widget/pr-2/meta.md");
    writing = false;
    timers.fireDue();

    expect(seen).toHaveLength(2);
    expect(seen).toContainEqual({ owner: "acme", repo: "widget", number: 1 });
    expect(seen).toContainEqual({ owner: "acme", repo: "widget", number: 2 });
  });

  test("defaults to never suppressing, when the caller has no way to tell", () => {
    // No isDaemonWriting supplied: this module cannot distinguish a
    // daemon-caused write from a hand-edit at all, and the module comment is
    // explicit that the default degrades to plain debouncing, not silence.
    const bus = createEventBus();
    const seen = collectPrChanged(bus);
    const watch = createFakeWatch();
    const timers = createFakeTimers();
    const sw = createStoreWatch({ dir: "/store", bus, watchFn: watch.watchFn, setTimer: timers.setTimer });
    sw.start();

    watch.emit("change", "reviews/acme/widget/pr-42/meta.md");
    timers.fireDue();

    expect(seen).toEqual([{ owner: "acme", repo: "widget", number: 42 }]);
  });

  test("maxDeferMs is a safety valve: a stuck-true predicate cannot swallow a change forever", () => {
    const bus = createEventBus();
    const seen = collectPrChanged(bus);
    const watch = createFakeWatch();
    const timers = createFakeTimers();
    const logs: string[] = [];
    let clock = 0;

    const sw = createStoreWatch({
      dir: "/store",
      bus,
      watchFn: watch.watchFn,
      setTimer: timers.setTimer,
      isDaemonWriting: () => true, // never returns false: the bug this valve is for
      now: () => clock,
      maxDeferMs: 5_000,
      debounceMs: 1_000,
      log: (line) => logs.push(line),
    });
    sw.start();

    watch.emit("change", "reviews/acme/widget/pr-42/meta.md");

    // Each debounce window re-defers, advancing the clock the way real time
    // would between one fired timer and the next.
    for (let i = 0; i < 4; i++) {
      timers.fireDue();
      clock += 1_000;
    }
    expect(seen).toHaveLength(0); // 4s deferred, under the 5s valve

    timers.fireDue();
    clock += 1_000; // now 5s: past maxDeferMs

    timers.fireDue();
    expect(seen).toEqual([{ owner: "acme", repo: "widget", number: 42 }]);
    expect(logs.some((line) => line.includes("maxDeferMs"))).toBe(true);
  });

  test("DEFAULT_MAX_DEFER_MS is exported and positive, since production leans on it unconfigured", () => {
    expect(DEFAULT_MAX_DEFER_MS).toBeGreaterThan(0);
  });
});

// ─── Batch isolation ────────────────────────────────────────────────────────

describe("createStoreWatch: one bad listener doesn't cost the rest of the batch", () => {
  test("a bus.emit that throws for one ref does not stop the others in the same flush", () => {
    const emitted: PRRef[] = [];
    const logs: string[] = [];
    const throwingBus: EventBus = {
      on: () => {},
      off: () => {},
      emit: (event) => {
        if (event.type !== "pr-changed") return;
        emitted.push(event.ref);
        if (event.ref.number === 1) throw new Error("listener boom");
      },
    };
    const watch = createFakeWatch();
    const timers = createFakeTimers();
    const sw = createStoreWatch({
      dir: "/store",
      bus: throwingBus,
      watchFn: watch.watchFn,
      setTimer: timers.setTimer,
      log: (line) => logs.push(line),
    });
    sw.start();

    watch.emit("change", "reviews/acme/widget/pr-1/meta.md");
    watch.emit("change", "reviews/acme/widget/pr-2/meta.md");
    timers.fireDue();

    expect(emitted).toHaveLength(2); // both refs were attempted
    expect(logs.some((line) => line.includes("listener threw"))).toBe(true);
  });
});

// ─── Lifecycle ──────────────────────────────────────────────────────────────

describe("createStoreWatch: start/stop", () => {
  test("start() opens the watch once and stop() closes it", () => {
    const bus = createEventBus();
    const watch = createFakeWatch();
    const timers = createFakeTimers();
    const sw = createStoreWatch({ dir: "/store", bus, watchFn: watch.watchFn, setTimer: timers.setTimer });

    expect(sw.watching).toBe(false);
    sw.start();
    expect(sw.watching).toBe(true);
    expect(watch.startCalls).toBe(1);

    sw.start(); // idempotent: no second watch opened
    expect(watch.startCalls).toBe(1);

    sw.stop();
    expect(sw.watching).toBe(false);
    expect(watch.closeCalls).toBe(1);

    sw.stop(); // idempotent
    expect(watch.closeCalls).toBe(1);
  });

  test("stop() cancels a pending timer and drops the unflushed batch", () => {
    const bus = createEventBus();
    const seen = collectPrChanged(bus);
    const watch = createFakeWatch();
    const timers = createFakeTimers();
    const sw = createStoreWatch({ dir: "/store", bus, watchFn: watch.watchFn, setTimer: timers.setTimer });
    sw.start();

    watch.emit("change", "reviews/acme/widget/pr-42/meta.md");
    expect(timers.pending()).toHaveLength(1);

    sw.stop();
    expect(timers.pending()).toHaveLength(0);

    // Nothing to fire, and nothing was emitted for the dropped batch.
    timers.fireDue();
    expect(seen).toHaveLength(0);
  });

  test("a change after restart starts a fresh batch, not a resumed one", () => {
    const bus = createEventBus();
    const seen = collectPrChanged(bus);
    const watch = createFakeWatch();
    const timers = createFakeTimers();
    const sw = createStoreWatch({ dir: "/store", bus, watchFn: watch.watchFn, setTimer: timers.setTimer });
    sw.start();

    watch.emit("change", "reviews/acme/widget/pr-1/meta.md");
    sw.stop();
    sw.start();
    watch.emit("change", "reviews/acme/widget/pr-2/meta.md");
    timers.fireDue();

    expect(seen).toEqual([{ owner: "acme", repo: "widget", number: 2 }]);
  });
});

// ─── nodeWatch: the real thing, against a real directory ──────────────────

describe("nodeWatch", () => {
  test("opens and closes against a real directory without throwing", async () => {
    // No assertion on event delivery: FSEvents' own timing is exactly what
    // the rest of this file avoids depending on. This only confirms the
    // production WatchFn is wireable against a real path.
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), REVIEW_TMP_PREFIX));
    try {
      const handle = nodeWatch(dir, () => {});
      expect(typeof handle.close).toBe("function");
      handle.close();
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  test("createStoreWatch wires to nodeWatch by default", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), REVIEW_TMP_PREFIX));
    try {
      const bus = createEventBus();
      const sw = createStoreWatch({ dir, bus });
      sw.start();
      expect(sw.watching).toBe(true);
      sw.stop();
      expect(sw.watching).toBe(false);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

/**
 * Watches the store directory so hand-edits made in an editor show up in the
 * UI without a restart (requirements R9.4; ADR 0004; design.md's
 * single-writer rule: "The daemon also watches the store directory with
 * `fs.watch` so hand-edits show up in the UI without a restart.").
 *
 * The store's readability is a product feature (ADR 0004), and a feature
 * nobody can see working is not shipped. This module is what makes editing
 * `meta.md` by hand in VS Code, instead of clicking a button in the SPA,
 * actually do something.
 *
 * THE HARD PART. The daemon is the store's only writer (R9.4), and a poll
 * cycle writes constantly: a `meta.md` per PR, a round file per Round, a diff
 * snapshot per completed Round. A watcher that turns every one of those into
 * an SSE invalidation gives the SPA a refetch storm for news it is about to
 * hear about anyway, through `pr-changed` and `findings-ready` events that
 * `cycle.ts` already emits directly. Two defenses, in order:
 *
 * 1. DEBOUNCE. Every relevant change resets a quiet-period timer; the batch
 *    only flushes once nothing has changed for `debounceMs`. A cycle writing
 *    five files for one PR back-to-back collapses into one `pr-changed`, not
 *    five, regardless of whether anything downstream can tell who wrote them.
 *
 * 2. `isDaemonWriting`. An OPTIONAL, INJECTED predicate — "is the daemon
 *    itself mid-write right now" — that the caller wires to whatever it
 *    already tracks (a queue's in-flight count, a scheduler's cycle-in-flight
 *    flag). When the debounce timer fires and this returns true, the flush is
 *    deferred rather than sent, so a cycle whose writes happen to straddle
 *    the debounce window (a gap between two PRs' Rounds longer than
 *    `debounceMs`) still doesn't leak an event mid-cycle. It is capped by
 *    `maxDeferMs`: a predicate stuck on `true` — a bug, not a busy cycle —
 *    must not swallow a real hand-edit forever, so a deferred batch flushes
 *    anyway once it has waited that long, logged as the anomaly it is.
 *
 * HOW THIS MODULE ACTUALLY TELLS THE TWO APART, AND WHAT IT CANNOT. It
 * cannot, from the filesystem alone. No event this module observes says
 * "this write came from `reviews.ts`'s `saveMeta`, not from `vim`" — both are
 * a process opening a path and writing bytes. `isDaemonWriting` is a real
 * signal, not a guess, but it depends entirely on being wired by whoever
 * builds the daemon (`boot.ts`, out of this module's file list) to something
 * that actually reflects write activity; left at its default (`() => false`,
 * "cannot tell"), this module still debounces but suppresses nothing, and
 * every daemon-caused change becomes its own `pr-changed` once the writes to
 * that PR go quiet for `debounceMs`. That is not silently wrong — `pr-changed`
 * carries only a ref (events.ts), the SPA treats it as a hint and refetches
 * real data, and `notify.ts`'s triage notification is keyed off the PR's
 * actual state, not off this event firing, so a spurious one costs a refetch,
 * never a wrong notification or a wrong UI state. The residual risk is noise,
 * not correctness, and it is the reason `isDaemonWriting` exists rather than
 * being load-bearing.
 *
 * PLATFORM REALITY, macOS. `fs.watch`'s `recursive` option is a macOS (and
 * Windows) feature backed by FSEvents, which coalesces bursts and can report
 * the same path twice for one logical write — harmless here, since the
 * pending batch is a Set keyed by PR, not a counter. What is NOT harmless:
 * editors overwhelmingly save by writing a temp file and renaming it over the
 * target (atomic save), not by writing the target in place. A watcher that
 * only reacts to a changed path matching `meta.md` or `r<N>-<agent>.md`
 * exactly can miss the event that matters, because the rename's `filename`
 * is sometimes reported for the temp name rather than the target (confirmed
 * against Bun 1.4's `fs.watch` on this codebase's target platform: a plain
 * `fs.writeFile` + `fs.rename` over an existing file reliably produced a
 * `rename` event naming the FINAL path here, but FSEvents coalescing is not a
 * contract, and other editors, other macOS versions, or a slower disk are not
 * guaranteed to behave the same). So this module does not match filenames at
 * all. It matches the DIRECTORY: any change anywhere under
 * `reviews/<owner>/<repo>/pr-<n>/` counts, whatever the leaf is named,
 * including a swap file or a `.tmp` a naive matcher would ignore and an
 * editor would clean up a moment later. The cost is a stray dotfile
 * triggering one extra, harmless refetch; the alternative is missing the
 * hand-edit this feature exists to catch, which is a worse trade every time.
 *
 * SCOPE. Only `reviews/<owner>/<repo>/pr-<n>/**` maps to anything: the only
 * DaemonEvent shaped for a single-item invalidation is `pr-changed`, which
 * carries a `PRRef` (events.ts). `config.md`, `watch.md`, `agents/*.md`, and
 * `templates/*.md` are store files a human can just as validly hand-edit, but
 * there is no PR to name and no `store-changed` (or similar) event in
 * events.ts to name instead — extending that vocabulary is a change to a file
 * outside this task's list. `logs/daemon.log`, `daemon.json`, and `token`
 * are excluded by the same match failing to apply, which is also what keeps
 * the constantly-appended daemon log from ever entering the pending batch.
 */

import fsMod from "node:fs";
import type { PRRef } from "@/core";
import { formatRef } from "@/core/pr-ref";
import type { EventBus } from "./events";

// ─── The watch primitive, injected ─────────────────────────────────────────

/** A live OS-level watch handle. Structurally what `fs.watch` returns. */
export interface WatchHandle {
  close(): void;
}

/**
 * `rename` covers a path appearing, disappearing, or being renamed over;
 * `change` is a content or metadata change to a path that already existed.
 * This module does not distinguish between them (see the module comment on
 * matching directories, not filenames), but the real value is threaded
 * through so a test asserting on it is asserting on something real.
 */
export type FsEventType = "rename" | "change";

export type FsListener = (eventType: FsEventType, filename: string | null) => void;

/**
 * Starts a recursive watch over `dir` and calls `listener` for every change
 * underneath it, with `filename` relative to `dir`. Defaults to `nodeWatch`.
 * Injected so tests never open a real OS-level watch (this module's tests
 * simulate events instead; see store-watch.test.ts).
 */
export type WatchFn = (dir: string, listener: FsListener) => WatchHandle;

/**
 * The real thing, for production. `recursive: true` is what lets one call
 * cover every `reviews/<owner>/<repo>/pr-<n>/` no matter how deep the watch
 * list grows, at the FSEvents cost the module comment names.
 */
export const nodeWatch: WatchFn = (dir, listener) => {
  const watcher = fsMod.watch(dir, { recursive: true }, (eventType, filename) => {
    listener(eventType === "change" ? "change" : "rename", filename === null ? null : filename.toString());
  });
  return {
    close: () => {
      watcher.close();
    },
  };
};

// ─── Path → PR ──────────────────────────────────────────────────────────────

const REVIEWS_SEGMENT = "reviews";
const PR_DIR_PATTERN = /^pr-(\d+)$/;

/**
 * Maps a changed path, relative to the watched store root, to the PR it
 * belongs to. Null for anything outside `reviews/<owner>/<repo>/pr-<n>/`
 * (see the module comment's SCOPE section) or where the PR segment does not
 * parse to a finite number.
 *
 * Splits on both slash kinds rather than `path.sep`: `fs.watch` reports
 * forward slashes on macOS regardless of `path.sep`, and a fake `WatchFn` in
 * a test is free to hand either.
 */
export function refForChangedPath(relPath: string): PRRef | null {
  const segments = relPath.split(/[\\/]+/).filter((segment) => segment.length > 0);
  const reviewsSegment = segments[0];
  const owner = segments[1];
  const repo = segments[2];
  const prSegment = segments[3];

  if (reviewsSegment !== REVIEWS_SEGMENT || !owner || !repo || !prSegment) return null;

  const match = PR_DIR_PATTERN.exec(prSegment);
  const numberText = match?.[1];
  if (numberText === undefined) return null;

  const number = Number(numberText);
  if (!Number.isFinite(number)) return null;

  return { owner, repo, number };
}

// ─── Options ────────────────────────────────────────────────────────────────

export interface StoreWatchOptions {
  /** The store root to watch (`lgtmDir`). */
  dir: string;
  /** Where `pr-changed` invalidations land. This module never emits any other DaemonEvent type. */
  bus: EventBus;
  /**
   * Quiet period after the last relevant change before a batch flushes.
   * Long enough to fold one PR's meta-plus-round write into a single event,
   * short enough that a hand-edit still feels live. Defaults to 750ms.
   */
  debounceMs?: number;
  /**
   * Safety valve on `isDaemonWriting`: the longest a batch can be deferred
   * before it flushes regardless. Defaults to 10s. See the module comment.
   */
  maxDeferMs?: number;
  /**
   * Best-effort "is the daemon itself writing right now". Defaults to
   * `() => false` ("cannot tell"), under which this module still debounces
   * but never defers a flush. See the module comment for what wiring this
   * buys, and what its absence costs.
   */
  isDaemonWriting?: () => boolean;
  /** Starts the underlying watch. Defaults to `nodeWatch`. Injected for tests. */
  watchFn?: WatchFn;
  /** Returns its own canceller. Injected so tests never wait on a real timer. */
  setTimer?: (fn: () => void, ms: number) => () => void;
  /** Wall clock, used only to time `maxDeferMs`. Defaults to `Date.now`. */
  now?: () => number;
  /** Defaults to silence. */
  log?: (line: string) => void;
}

export interface StoreWatch {
  /** Opens the watch. Idempotent while already running. */
  start(): void;
  /** Closes the watch, cancels any pending timer, and drops an unflushed batch. Idempotent. */
  stop(): void;
  /** True from `start()` until `stop()`. */
  readonly watching: boolean;
}

// ─── Defaults ───────────────────────────────────────────────────────────────

export const DEFAULT_DEBOUNCE_MS = 750;
export const DEFAULT_MAX_DEFER_MS = 10_000;

function defaultSetTimer(fn: () => void, ms: number): () => void {
  const handle = setTimeout(fn, ms);
  // A watcher that keeps the process alive is one more way the daemon fails
  // to exit cleanly; `stop()` cancels this explicitly on shutdown regardless.
  (handle as unknown as { unref?: () => void }).unref?.();
  return () => clearTimeout(handle);
}

function positiveOr(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value > 0 ? value : fallback;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// ─── Factory ────────────────────────────────────────────────────────────────

export function createStoreWatch(options: StoreWatchOptions): StoreWatch {
  const { dir, bus } = options;
  const debounceMs = positiveOr(options.debounceMs, DEFAULT_DEBOUNCE_MS);
  const maxDeferMs = positiveOr(options.maxDeferMs, DEFAULT_MAX_DEFER_MS);
  const isDaemonWriting = options.isDaemonWriting ?? (() => false);
  const watchFn = options.watchFn ?? nodeWatch;
  const setTimer = options.setTimer ?? defaultSetTimer;
  const now = options.now ?? Date.now;
  const log = options.log ?? (() => {});

  let handle: WatchHandle | null = null;
  let cancelTimer: (() => void) | null = null;

  /** Keyed by `formatRef`, so two events for the same PR stay one pending entry. */
  const pending = new Map<string, PRRef>();
  /** When the current, unflushed batch's first change arrived. Null while empty. */
  let batchStartedAt: number | null = null;

  function clearPendingTimer(): void {
    cancelTimer?.();
    cancelTimer = null;
  }

  function armTimer(delayMs: number): void {
    clearPendingTimer();
    cancelTimer = setTimer(onDebounceElapsed, delayMs);
  }

  function flush(): void {
    const refs = [...pending.values()];
    pending.clear();
    batchStartedAt = null;
    for (const ref of refs) {
      try {
        bus.emit({ type: "pr-changed", ref });
      } catch (error) {
        // One listener's bug must not cost the rest of the batch, or wedge
        // this watcher into never processing another change.
        log(`store-watch: a pr-changed listener threw for ${formatRef(ref)}: ${messageOf(error)}`);
      }
    }
  }

  function onDebounceElapsed(): void {
    cancelTimer = null;
    if (pending.size === 0) return;

    const stillWriting = isDaemonWriting();
    const waitedMs = batchStartedAt === null ? 0 : now() - batchStartedAt;

    if (stillWriting && waitedMs < maxDeferMs) {
      // Cannot tell a hand-edit from the daemon's own tail apart yet; wait
      // one more quiet period rather than guess.
      armTimer(debounceMs);
      return;
    }

    if (stillWriting) {
      log(
        `store-watch: flushing ${pending.size} pending change(s) after ${waitedMs}ms of deferring; ` +
          "isDaemonWriting still reports true past maxDeferMs"
      );
    }

    flush();
  }

  function onFsEvent(_eventType: FsEventType, filename: string | null): void {
    // Some platforms and some conditions do not report a filename (Node's
    // own docs call this out). There is nothing to key an invalidation on,
    // so this update is dropped rather than guessed at; a filename does
    // arrive for the change that follows it in the same directory, in every
    // case this module has been able to produce.
    if (filename === null) return;

    const ref = refForChangedPath(filename);
    if (ref === null) return;

    if (batchStartedAt === null) batchStartedAt = now();
    pending.set(formatRef(ref), ref);
    armTimer(debounceMs);
  }

  return {
    start() {
      if (handle) return;
      handle = watchFn(dir, onFsEvent);
    },

    stop() {
      clearPendingTimer();
      pending.clear();
      batchStartedAt = null;
      handle?.close();
      handle = null;
    },

    get watching() {
      return handle !== null;
    },
  };
}

/**
 * Live data for the SPA: a reconnecting SSE subscription plus the small set
 * of React hooks that ride it.
 *
 * The subscription itself (`createEventStream`) is a plain, non-React
 * factory function in the same shape as the daemon's `createScheduler` /
 * `createReviewQueue` — real EventSource by default, a stub in tests, a
 * timer seam instead of a real `setTimeout` so backoff is asserted without
 * a clock. It is tested directly, below the React layer, because
 * `renderToStaticMarkup` (this SPA's only test harness — see ui.test.ts)
 * never runs effects, so a hook wrapping it cannot be exercised that way.
 *
 * design.md, "HTTP API": events carry ids, not payloads, so the API stays
 * the single source of truth. That is the whole design here — every event,
 * named or not, parseable or not, means exactly one thing: "go refetch."
 * There is deliberately no per-event-type reducer trying to patch cached
 * state in place; that path is exactly what drifts from the API over time.
 */

import { useEffect, useState, type DependencyList } from "react";
import type { PRRef } from "@/core";
import type { DaemonEvent } from "@/daemon/events";
import {
  getDefaultApiClient,
  toApiError,
  type ApiClient,
  type ApiError,
  type PRFindingsResponse,
  type PRListFilter,
  type PRListItem,
  type StatusResponse,
} from "./api";

// ─── The reconnecting stream (no React) ────────────────────────────────────

export type ConnectionStatus = "connecting" | "open" | "reconnecting" | "closed";

/** What one SSE message means. Unparseable or unnamed messages still count — see the module doc. */
export type InvalidationHint = DaemonEvent | { type: "unknown" };

export interface BackoffOptions {
  initialMs: number;
  maxMs: number;
  factor: number;
}

/** 1s, 2s, 4s, 8s, ... capped at 30s, each with up to 20% jitter so a daemon restart does not get thundered by every open tab at once. */
export const DEFAULT_BACKOFF: BackoffOptions = { initialMs: 1000, maxMs: 30_000, factor: 2 };

/** The slice of EventSource this module needs, minimal enough to stub in tests without a DOM. */
export interface EventSourceLike {
  onopen: (() => void) | null;
  onerror: (() => void) | null;
  onmessage: ((ev: { data: string }) => void) | null;
  addEventListener(type: string, listener: (ev: { data: string }) => void): void;
  close(): void;
}

export type EventSourceFactory = (url: string) => EventSourceLike;

export interface EventStreamOptions {
  url: string;
  onInvalidate: (hint: InvalidationHint) => void;
  onStatusChange?: (status: ConnectionStatus) => void;
  /** Defaults to the global EventSource. Tests supply a stub instead. */
  createEventSource?: EventSourceFactory;
  backoff?: BackoffOptions;
  /** Defaults to real setTimeout/clearTimeout. Tests inject a fake to assert backoff without waiting. */
  setTimer?: (fn: () => void, ms: number) => () => void;
  /** Defaults to Math.random. Tests inject a fixed value so jitter is deterministic. */
  random?: () => number;
}

export interface EventStreamHandle {
  stop(): void;
  status(): ConnectionStatus;
}

const DAEMON_EVENT_TYPES = ["cycle-finished", "pr-changed", "findings-ready", "quota-changed", "error"] as const;

function isDaemonEvent(value: unknown): value is DaemonEvent {
  if (!value || typeof value !== "object") return false;
  const type = (value as { type?: unknown }).type;
  return typeof type === "string" && (DAEMON_EVENT_TYPES as readonly string[]).includes(type);
}

function realEventSourceFactory(): EventSourceFactory | null {
  if (typeof EventSource === "undefined") return null;
  return (url) => new EventSource(url) as unknown as EventSourceLike;
}

function realSetTimer(fn: () => void, ms: number): () => void {
  const id = setTimeout(fn, ms);
  return () => clearTimeout(id);
}

/**
 * Open (and keep open) an SSE connection to the daemon's event bus.
 *
 * Every message, on any of the five named events or the generic `message`
 * fallback, becomes exactly one `onInvalidate` call — parsed into a
 * `DaemonEvent` when it is one, `{type:"unknown"}` otherwise, but a hint
 * either way. A dropped connection reconnects on its own schedule (the
 * browser's built-in EventSource retry is deliberately not used — its fixed
 * ~3s interval cannot back off, so a dead daemon would get hammered by every
 * open tab forever); backoff resets to the first interval the moment a
 * connection actually opens.
 *
 * Returns a handle rather than nothing so a caller (a React effect's cleanup,
 * a test) can stop it deterministically instead of just dropping references
 * and hoping GC gets to it before the next reconnect fires.
 */
export function createEventStream(options: EventStreamOptions): EventStreamHandle {
  const factory = options.createEventSource ?? realEventSourceFactory();
  const backoff = options.backoff ?? DEFAULT_BACKOFF;
  const setTimer = options.setTimer ?? realSetTimer;
  const random = options.random ?? Math.random;

  let status: ConnectionStatus = "connecting";
  let attempt = 0;
  let stopped = false;
  let source: EventSourceLike | null = null;
  let cancelReconnect: (() => void) | null = null;

  function setStatus(next: ConnectionStatus) {
    if (status === next) return;
    status = next;
    options.onStatusChange?.(next);
  }

  function handleMessage(data: string | undefined) {
    if (!data) {
      options.onInvalidate({ type: "unknown" });
      return;
    }
    try {
      const parsed = JSON.parse(data) as unknown;
      options.onInvalidate(isDaemonEvent(parsed) ? parsed : { type: "unknown" });
    } catch {
      options.onInvalidate({ type: "unknown" });
    }
  }

  function scheduleReconnect() {
    setStatus("reconnecting");
    const backoffMs = Math.min(backoff.maxMs, backoff.initialMs * Math.pow(backoff.factor, attempt));
    const jitterMs = backoffMs * 0.2 * random();
    attempt += 1;
    cancelReconnect = setTimer(() => {
      cancelReconnect = null;
      open();
    }, backoffMs + jitterMs);
  }

  function open() {
    if (stopped || !factory) return;
    setStatus(attempt === 0 ? "connecting" : "reconnecting");

    const es = factory(options.url);
    source = es;

    es.onopen = () => {
      attempt = 0;
      setStatus("open");
    };

    for (const type of DAEMON_EVENT_TYPES) {
      es.addEventListener(type, (evt) => handleMessage(evt.data));
    }
    es.onmessage = (evt) => handleMessage(evt.data);

    es.onerror = () => {
      es.close();
      source = null;
      if (!stopped) scheduleReconnect();
    };
  }

  if (factory) {
    open();
  } else {
    // No EventSource in this environment (a non-browser test, an odd
    // embed). Fail to "closed" rather than throwing, matching the rest of
    // this file's posture: a dead live-update pipe degrades the UI, it does
    // not crash it.
    setStatus("closed");
  }

  return {
    stop() {
      stopped = true;
      cancelReconnect?.();
      cancelReconnect = null;
      source?.close();
      source = null;
      setStatus("closed");
    },
    status: () => status,
  };
}

// ─── One shared connection for the whole tab ───────────────────────────────
//
// Every hook below rides the same EventSource rather than opening one each,
// so mounting both the PR list and the status panel in one view (Reviews
// does exactly that) does not double the daemon's SSE fan-out. Ref-counted
// so the connection closes when the last subscriber unmounts and reopens on
// the next one, rather than leaking or being pinned open forever.

interface SharedStream {
  handle: EventStreamHandle;
  state: { signal: number; status: ConnectionStatus };
  signalListeners: Set<(signal: number) => void>;
  statusListeners: Set<(status: ConnectionStatus) => void>;
  refCount: number;
}

let shared: SharedStream | null = null;

function acquireSharedStream(client: ApiClient): SharedStream {
  if (!shared) {
    const signalListeners = new Set<(signal: number) => void>();
    const statusListeners = new Set<(status: ConnectionStatus) => void>();
    const state = { signal: 0, status: "connecting" as ConnectionStatus };

    const handle = createEventStream({
      url: client.eventsUrl(),
      onInvalidate: () => {
        state.signal += 1;
        for (const listener of signalListeners) listener(state.signal);
      },
      onStatusChange: (status) => {
        state.status = status;
        for (const listener of statusListeners) listener(status);
      },
    });

    shared = { handle, state, signalListeners, statusListeners, refCount: 0 };
  }

  shared.refCount += 1;
  return shared;
}

function releaseSharedStream(s: SharedStream) {
  s.refCount -= 1;
  if (s.refCount <= 0 && shared === s) {
    s.handle.stop();
    shared = null;
  }
}

/** Live connection health, for a "the daemon may be unreachable" indicator (the Reviews view's empty-state health check). */
export function useConnectionStatus(): ConnectionStatus {
  const [status, setStatus] = useState<ConnectionStatus>(() => shared?.state.status ?? "connecting");

  useEffect(() => {
    const s = acquireSharedStream(getDefaultApiClient());
    setStatus(s.state.status);
    const listener = (next: ConnectionStatus) => setStatus(next);
    s.statusListeners.add(listener);
    return () => {
      s.statusListeners.delete(listener);
      releaseSharedStream(s);
    };
  }, []);

  return status;
}

/** Bumps once per SSE event. Not meant to be read for its value — only as an effect dependency that forces a refetch. */
function useInvalidationSignal(): number {
  const [signal, setSignal] = useState<number>(() => shared?.state.signal ?? 0);

  useEffect(() => {
    const s = acquireSharedStream(getDefaultApiClient());
    setSignal(s.state.signal);
    const listener = (next: number) => setSignal(next);
    s.signalListeners.add(listener);
    return () => {
      s.signalListeners.delete(listener);
      releaseSharedStream(s);
    };
  }, []);

  return signal;
}

// ─── Ticking clock (elapsed-time labels, no React) ─────────────────────────
//
// The SSE stream carries invalidation hints, never a notion of time passing
// (see the module doc), so a round's elapsed-time label would otherwise only
// advance when something else happens to trigger a refetch: the daemon's own
// poll, or another PR's status changing. A round that just started and one
// about to time out would print the same stale number between those events.
// This is the same split as `createEventStream`/`useConnectionStatus` above.
// The scheduling itself (`createTicker`) is a plain, non-React function, so
// its firing and its `stop()` cancellation can be asserted directly. The
// hook wrapping it is untested at that layer, for the same reason
// `useConnectionStatus` is. renderToStaticMarkup never runs effects (see
// ui.test.ts's "no DOM globals" note).

export interface TickerHandle {
  stop(): void;
}

/** Same shape as `EventStreamOptions.setTimer`: real timer by default, a fake in tests, always returning its own canceller. */
export type IntervalTimer = (fn: () => void, ms: number) => () => void;

function realInterval(fn: () => void, ms: number): () => void {
  const id = setInterval(fn, ms);
  return () => clearInterval(id);
}

/** Calls `onTick` every `intervalMs` until `stop()`. The one place `setInterval` is named in this module. */
export function createTicker(onTick: () => void, intervalMs: number, setTimer: IntervalTimer = realInterval): TickerHandle {
  const cancel = setTimer(onTick, intervalMs);
  return { stop: cancel };
}

/**
 * The current time, re-read every `intervalMs` while `enabled`. The component
 * that calls this owns the ticker: mounting (with `enabled`) starts it,
 * unmounting or `enabled` going false clears it via the effect's own cleanup,
 * so nothing keeps ticking once the last elapsed-time row using it is gone.
 *
 * `enabled` exists so a view with nothing currently in flight is not woken up
 * once a second for no reason. Pass `false` and this hook holds its last
 * value instead of scheduling anything.
 */
export function useTick(intervalMs: number, enabled = true): number {
  const [now, setNow] = useState<number>(() => Date.now());

  useEffect(() => {
    if (!enabled) return;
    const ticker = createTicker(() => setNow(Date.now()), intervalMs);
    return () => ticker.stop();
  }, [intervalMs, enabled]);

  return now;
}

// ─── Data hooks ─────────────────────────────────────────────────────────────

export interface AsyncState<T> {
  status: "loading" | "ok" | "error";
  data: T | null;
  error: ApiError | null;
}

const LOADING: AsyncState<never> = { status: "loading", data: null, error: null };

/**
 * Fetch once, then again on every SSE-signalled change. All browser-touching
 * work (constructing the default client, issuing the request) happens inside
 * the effect, never during render, so mounting this hook is safe anywhere —
 * including a server-rendered smoke test that never runs effects at all.
 */
function useApiQuery<T>(run: (client: ApiClient) => Promise<T>, deps: DependencyList): AsyncState<T> {
  const [state, setState] = useState<AsyncState<T>>(LOADING);
  const signal = useInvalidationSignal();

  useEffect(() => {
    let cancelled = false;
    setState(LOADING);

    run(getDefaultApiClient()).then(
      (data) => {
        if (!cancelled) setState({ status: "ok", data, error: null });
      },
      (err: unknown) => {
        if (!cancelled) setState({ status: "error", data: null, error: toApiError(err) });
      },
    );

    return () => {
      cancelled = true;
    };
    // `run` is expected to be a fresh closure per render that only closes
    // over `deps`; re-running it whenever `deps` (or the SSE signal) changes
    // is the entire point.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signal, ...deps]);

  return state;
}

/** The filtered PR list behind the Reviews view (R2.5, R5.1). Refetches whenever any part of `filter` changes, not only `state`. */
export function usePRList(filter?: PRListFilter): AsyncState<PRListItem[]> {
  const stateKey = !filter?.state ? "" : Array.isArray(filter.state) ? filter.state.join(",") : filter.state;
  const closedKey = filter?.closed ?? "";
  const withFindingsKey = filter?.withFindings ? "1" : "";
  return useApiQuery((client) => client.listPRs(filter), [stateKey, closedKey, withFindingsKey]);
}

/** Daemon uptime, last cycle, queue and quota — feeds the Reviews view's empty-state health check. */
export function useStatus(): AsyncState<StatusResponse> {
  return useApiQuery((client) => client.status(), []);
}

/** One PR's header metadata and findings, for PR detail. */
export function usePRDetail(ref: PRRef): AsyncState<PRFindingsResponse> {
  return useApiQuery((client) => client.getFindings(ref), [ref.owner, ref.repo, ref.number]);
}

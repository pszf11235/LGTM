/**
 * Typed event bus for the daemon. Events carry IDs, not payloads, because the
 * API stays the single source of truth (design.md, "HTTP API").
 *
 * Event names correspond to SSE events; subscribers (like the notifier) use
 * these to signal changes without reimplementing queries.
 */

import type { PRRef } from "@/core";

/**
 * Event types that fire from the poll cycle, quota gate, and provider. Each
 * carries only an ID or key so the caller does not have to serialize state
 * into the event — they invalidate a cache line and the subscriber fetches
 * fresh data from the API.
 */
export type DaemonEvent =
  | { type: "cycle-finished"; repoKey: string }
  | { type: "pr-changed"; ref: PRRef }
  | { type: "findings-ready"; ref: PRRef }
  | { type: "quota-changed"; mode: "ok" | "throttled" | "fallback" }
  | { type: "error"; cause: string };

/** Callback signature for event subscribers. */
export type EventListener = (event: DaemonEvent) => void;

/**
 * In-process event bus. Not a full EventEmitter — intentionally minimal so
 * subscribers cannot rely on ordering, replay, or any other property that
 * isn't mentioned here.
 */
export interface EventBus {
  /** Subscribe to all events. */
  on(listener: EventListener): void;
  /** Unsubscribe from all events. Idempotent: removing a listener that is not subscribed is a no-op. */
  off(listener: EventListener): void;
  /** Emit an event to all subscribers. */
  emit(event: DaemonEvent): void;
}

/**
 * Create a new in-process event bus. Each call returns a separate instance
 * with its own subscriber list, so tests can inject their own bus.
 */
export function createEventBus(): EventBus {
  const listeners: EventListener[] = [];

  return {
    on(listener: EventListener) {
      listeners.push(listener);
    },

    off(listener: EventListener) {
      const idx = listeners.indexOf(listener);
      if (idx !== -1) {
        listeners.splice(idx, 1);
      }
    },

    emit(event: DaemonEvent) {
      // Copy the list so a listener can unsubscribe without affecting iteration.
      const copy = [...listeners];
      for (const listener of copy) {
        listener(event);
      }
    },
  };
}

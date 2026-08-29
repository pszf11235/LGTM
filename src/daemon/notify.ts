/**
 * Native macOS notifications for the four events in requirements R8.
 *
 * Dedup rules:
 * - Errors: once per distinct cause, not once per cycle
 * - Findings ungated for 4 hours: one reminder
 * - A PR entering triage: once per stay, again only after it leaves and
 *   re-enters (see the note on `getPRState` below)
 * - Quota pause: once per transition into `throttled`
 *
 * Transport probe order: terminal-notifier (resolves through binaries.ts,
 * supports -open deep links) → osascript display notification → silence with
 * a log line. Fire-and-forget: spawn failures never propagate into the pipeline.
 *
 * Inject the clock, spawn function, and PR-state reader for offline testing.
 */

import type { PRRef, PRState } from "@/core";
import type { BinaryResolver } from "./binaries";
import type { EventBus, DaemonEvent } from "./events";

/** Spawn function signature for injection in tests. */
export type SpawnFn = (
  cmd: string[],
  options?: { timeoutMs?: number }
) => Promise<{ exitCode: number | null; error?: string }>;

/** Clock function signature for injection in tests. */
export type ClockFn = () => number; // milliseconds since epoch

/**
 * Reads a PR's current lifecycle state from the store. Null when the PR is
 * unknown (no meta.md, or the read itself failed).
 *
 * `pr-changed` carries only a `ref` (see events.ts): the bus stays a cache
 * invalidation hint, not a payload. cycle.ts emits it on every meta.md write
 * that isn't a no-op, and that includes a brand-new triage arrival, a plain
 * refresh of a PR already sitting in triage, a queue, the
 * reviewing-then-reviewed (or -failed) pair inside a Round, a reconciled
 * draft-review id, and a close.
 * Telling "just arrived in triage" apart from the rest needs to know the
 * state the write actually landed on, and the event alone cannot say that.
 *
 * Production wires this to `@/store/reviews`' `loadMeta` bound to the
 * daemon's `lgtmDir`.
 */
export type PRStateReader = (ref: PRRef) => Promise<PRState | null>;

export interface NotifierOptions {
  /** The binary resolver, from daemon startup. */
  binaries: BinaryResolver;
  /** The event bus to subscribe to. */
  bus: EventBus;
  /** Custom spawn function for testing. Defaults to Bun.spawn. */
  spawn?: SpawnFn;
  /** Custom clock for testing. Defaults to Date.now. */
  now?: ClockFn;
  /** Custom logger for testing. Defaults to console. */
  logger?: { log: (msg: string) => void };
  /**
   * How the notifier tells a genuine arrival in triage apart from the many
   * other writes that also fire `pr-changed`. See `PRStateReader`. Required,
   * rather than defaulted to a guess, because a wrong guess is exactly R8's
   * bug: a notification for every meta.md write instead of one per PR that
   * actually reaches triage.
   */
  getPRState: PRStateReader;
}

/** Deep link into the web UI, filled with the port at runtime. Will be set by the API. */
let uiPort: number | null = null;

export function setUiPort(port: number | null): void {
  uiPort = port;
}

interface NotificationState {
  /** Causes we've already notified about in this session. */
  notifiedErrors: Set<string>;
  /** PRs we've sent findings-ready for, with timestamp. Maps "owner/repo/number" -> ms. */
  findingsNotified: Map<string, number>;
  /**
   * PRs currently believed to be sitting in triage, already notified for
   * this stay. Removed as soon as a `pr-changed` event finds the PR
   * somewhere other than triage, so a later genuine re-entry notifies again.
   */
  triageNotified: Set<string>;
  /** True if we've notified about a quota pause in this session. */
  quotaThrottled: boolean;
}

/**
 * Start the notifier. Subscribe to the event bus, maintain dedup state, and
 * send notifications. Returns a cleanup function.
 *
 * The notifier is fire-and-forget: spawn failures are logged but never
 * propagate. Tests inject a spawn function to avoid actually spawning.
 */
export function createNotifier(options: NotifierOptions): () => void {
  const { binaries, bus, spawn: spawnFn, now = () => Date.now(), logger = console, getPRState } = options;
  const state: NotificationState = {
    notifiedErrors: new Set(),
    findingsNotified: new Map(),
    triageNotified: new Set(),
    quotaThrottled: false,
  };

  const spawn: SpawnFn = spawnFn || defaultSpawn;

  function makeDeepLink(owner: string, repo: string, number: number): string {
    if (!uiPort) return "";
    return `http://127.0.0.1:${uiPort}/#/prs/${owner}/${repo}/${number}`;
  }

  async function sendNotification(title: string, subtitle?: string, clickUrl?: string): Promise<void> {
    // Try terminal-notifier first.
    const terminalNotifierPath = binaries.resolve("terminal-notifier");
    if (terminalNotifierPath) {
      const args = [terminalNotifierPath, "-title", title];
      if (subtitle) {
        args.push("-subtitle", subtitle);
      }
      if (clickUrl) {
        args.push("-open", clickUrl);
      }
      try {
        await spawn(args);
        return;
      } catch {
        // Fall through to osascript.
      }
    }

    // Try osascript display notification.
    const osascriptArgs = [
      "osascript",
      "-e",
      `display notification "${escapeAppleScript(subtitle || "")}" with title "${escapeAppleScript(title)}"`,
    ];
    try {
      await spawn(osascriptArgs);
      return;
    } catch {
      // Fall through to log line.
    }

    // Silent fallback: log only.
    logger.log(`notification: ${title}${subtitle ? " — " + subtitle : ""}`);
  }

  function escapeAppleScript(str: string): string {
    return str.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  }

  function prKey(owner: string, repo: string, number: number): string {
    return `${owner}/${repo}/${number}`;
  }

  async function onEvent(event: DaemonEvent): Promise<void> {
    try {
      if (event.type === "error") {
        // Once per distinct cause.
        if (!state.notifiedErrors.has(event.cause)) {
          state.notifiedErrors.add(event.cause);
          await sendNotification("LGTM error", event.cause);
        }
      } else if (event.type === "findings-ready") {
        const key = prKey(event.ref.owner, event.ref.repo, event.ref.number);
        const lastNotified = state.findingsNotified.get(key);
        const now_ = now();

        // Send if never notified, or if more than 4 hours have passed.
        if (lastNotified === undefined || now_ - lastNotified >= 4 * 60 * 60 * 1000) {
          state.findingsNotified.set(key, now_);
          const clickUrl = makeDeepLink(event.ref.owner, event.ref.repo, event.ref.number);
          await sendNotification(
            "Findings ready for gating",
            `${event.ref.owner}/${event.ref.repo}#${event.ref.number}`,
            clickUrl
          );
        }
      } else if (event.type === "pr-changed") {
        // pr-changed fires on every meta.md write, not only a triage
        // arrival (see PRStateReader's doc comment). Read what the write
        // actually landed on and notify only when that is "triage" and we
        // have not already notified for this stay.
        const key = prKey(event.ref.owner, event.ref.repo, event.ref.number);
        const prState = await getPRState(event.ref);

        if (prState !== "triage") {
          // Left triage, or never was in it. Clearing the dedup here is
          // what lets a PR that genuinely leaves and re-enters triage
          // notify again.
          state.triageNotified.delete(key);
        } else if (!state.triageNotified.has(key)) {
          state.triageNotified.add(key);
          const clickUrl = makeDeepLink(event.ref.owner, event.ref.repo, event.ref.number);
          await sendNotification(
            "New PR in triage",
            `${event.ref.owner}/${event.ref.repo}#${event.ref.number}`,
            clickUrl
          );
        }
      } else if (event.type === "quota-changed") {
        // Once when entering throttled state.
        if (event.mode === "throttled" && !state.quotaThrottled) {
          state.quotaThrottled = true;
          await sendNotification(
            "Claude quota paused",
            "Review will resume when usage drops"
          );
        } else if (event.mode !== "throttled") {
          state.quotaThrottled = false;
        }
      }
    } catch {
      // Fire-and-forget: never let a notification failure propagate.
    }
  }

  bus.on(onEvent);

  return () => {
    bus.off(onEvent);
  };
}

/**
 * Default spawn function using Bun.spawn. Wraps the async spawn in a promise
 * that resolves when the process exits, with a configurable timeout.
 */
async function defaultSpawn(
  cmd: string[],
  options?: { timeoutMs?: number }
): Promise<{ exitCode: number | null; error?: string }> {
  const timeoutMs = options?.timeoutMs ?? 2000;

  return new Promise((resolve) => {
    const proc = Bun.spawn(cmd, {
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
    });

    const timer = setTimeout(() => {
      try {
        proc.kill();
      } catch {
        // already exited.
      }
      resolve({ exitCode: null, error: "timeout" });
    }, timeoutMs);

    proc.exited.then((exitCode) => {
      clearTimeout(timer);
      resolve({ exitCode });
    });
  });
}

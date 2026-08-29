/**
 * Native macOS notifications for the four events in requirements R8.
 *
 * Dedup rules:
 * - Errors: once per distinct cause, not once per cycle
 * - Findings ungated for 4 hours: one reminder
 * - Everything else: once per distinct event (PR, quota transition)
 *
 * Transport probe order: terminal-notifier (resolves through binaries.ts,
 * supports -open deep links) → osascript display notification → silence with
 * a log line. Fire-and-forget: spawn failures never propagate into the pipeline.
 *
 * Inject the clock and spawn function for offline testing.
 */

import type { BinaryResolver } from "./binaries";
import type { EventBus, DaemonEvent } from "./events";

/** Spawn function signature for injection in tests. */
export type SpawnFn = (
  cmd: string[],
  options?: { timeoutMs?: number }
) => Promise<{ exitCode: number | null; error?: string }>;

/** Clock function signature for injection in tests. */
export type ClockFn = () => number; // milliseconds since epoch

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
  const { binaries, bus, spawn: spawnFn, now = () => Date.now(), logger = console } = options;
  const state: NotificationState = {
    notifiedErrors: new Set(),
    findingsNotified: new Map(),
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
        // Once per PR entering triage (no dedup beyond that).
        const clickUrl = makeDeepLink(event.ref.owner, event.ref.repo, event.ref.number);
        await sendNotification(
          "New PR in triage",
          `${event.ref.owner}/${event.ref.repo}#${event.ref.number}`,
          clickUrl
        );
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

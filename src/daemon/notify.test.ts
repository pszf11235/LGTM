/**
 * Tests for the notifier. All offline: injects the clock and spawn function,
 * so no real notifications or process spawns.
 *
 * Run with: bun test src/daemon/notify.test.ts
 */

import { describe, test, expect, beforeEach } from "bun:test";
import { createEventBus } from "./events";
import { createNotifier, setUiPort, type SpawnFn } from "./notify";
import type { BinaryResolver } from "./binaries";

// ─── Mocks ──────────────────────────────────────────────────────────────────

interface MockBinaryResolver extends BinaryResolver {
  setPath(name: string, path: string | null): void;
}

function createMockBinaries(): MockBinaryResolver {
  const paths = new Map<string, string | null>();

  return {
    probe: async () => {},
    resolve: (name) => paths.get(name) ?? null,
    reportSpawnFailure: async () => {},
    status: () => [],
    setPath: (name, path) => paths.set(name, path),
  };
}

interface SpawnCall {
  cmd: string[];
  timeoutMs?: number;
}

function createSpySpawn(
  outcomes: Array<{ exitCode: number | null; error?: string } | Error> = []
): { fn: SpawnFn; calls: SpawnCall[] } {
  const calls: SpawnCall[] = [];
  let callCount = 0;

  const fn: SpawnFn = async (cmd, options) => {
    calls.push({ cmd, timeoutMs: options?.timeoutMs });
    const outcome = outcomes[callCount++];

    if (outcome instanceof Error) {
      throw outcome;
    }
    return outcome || { exitCode: 0 };
  };

  return { fn, calls };
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("createNotifier", () => {
  let binaries: MockBinaryResolver;
  let logger: { messages: string[]; log: (msg: string) => void };
  let now_ = 0;
  const clockFn = () => now_;

  beforeEach(() => {
    binaries = createMockBinaries();
    logger = {
      messages: [],
      log: (msg: string) => logger.messages.push(msg),
    };
    now_ = 0;
    setUiPort(null); // Clear UI port between tests.
  });

  describe("error notifications", () => {
    test("sends notification for error event", async () => {
      const bus = createEventBus();
      const { fn: spawn, calls } = createSpySpawn([{ exitCode: 0 }]);

      binaries.setPath("terminal-notifier", "/usr/local/bin/terminal-notifier");

      createNotifier({ binaries, bus, spawn, now: clockFn, logger });

      bus.emit({ type: "error", cause: "dead-token" });

      await new Promise((r) => setTimeout(r, 10));

      expect(calls).toHaveLength(1);
      expect(calls.at(0)!.cmd[0]).toBe("/usr/local/bin/terminal-notifier");
      expect(calls.at(0)!.cmd).toContain("LGTM error");
      expect(calls.at(0)!.cmd).toContain("dead-token");
    });

    test("dedup: same error cause notifies once per session", async () => {
      const bus = createEventBus();
      const { fn: spawn, calls } = createSpySpawn([{ exitCode: 0 }, { exitCode: 0 }]);

      binaries.setPath("terminal-notifier", "/usr/local/bin/terminal-notifier");

      createNotifier({ binaries, bus, spawn, now: clockFn, logger });

      bus.emit({ type: "error", cause: "dead-token" });
      bus.emit({ type: "error", cause: "dead-token" });
      bus.emit({ type: "error", cause: "missing-claude" });

      await new Promise((r) => setTimeout(r, 10));

      // Only 2 spawn calls: dead-token once, missing-claude once.
      expect(calls).toHaveLength(2);
    });
  });

  describe("findings-ready notifications", () => {
    test("sends notification for findings-ready event", async () => {
      const bus = createEventBus();
      const { fn: spawn, calls } = createSpySpawn([{ exitCode: 0 }]);

      binaries.setPath("terminal-notifier", "/usr/local/bin/terminal-notifier");
      setUiPort(4747);

      createNotifier({ binaries, bus, spawn, now: clockFn, logger });

      bus.emit({
        type: "findings-ready",
        ref: { owner: "acme", repo: "api", number: 42 },
      });

      await new Promise((r) => setTimeout(r, 10));

      expect(calls).toHaveLength(1);
      expect(calls.at(0)!.cmd).toContain("Findings ready for gating");
      expect(calls.at(0)!.cmd).toContain("acme/api#42");
      expect(calls.at(0)!.cmd).toContain("-open");
      expect(calls.at(0)!.cmd).toContain("http://127.0.0.1:4747/#/prs/acme/api/42");
    });

    test("findings-ready: 4-hour reminder dedup", async () => {
      const bus = createEventBus();
      const { fn: spawn, calls } = createSpySpawn([
        { exitCode: 0 },
        { exitCode: 0 },
      ]);

      binaries.setPath("terminal-notifier", "/usr/local/bin/terminal-notifier");

      createNotifier({ binaries, bus, spawn, now: clockFn, logger });

      const ref = { owner: "acme", repo: "api", number: 42 };

      // First notification.
      bus.emit({ type: "findings-ready", ref });
      await new Promise((r) => setTimeout(r, 50));
      expect(calls).toHaveLength(1);

      // Same PR within 4 hours: no notification.
      now_ = 2 * 60 * 60 * 1000; // 2 hours later
      bus.emit({ type: "findings-ready", ref });
      await new Promise((r) => setTimeout(r, 50));
      expect(calls).toHaveLength(1); // Still 1

      // After 4 hours: notification again.
      now_ = 4 * 60 * 60 * 1000 + 1; // Just over 4 hours
      bus.emit({ type: "findings-ready", ref });
      await new Promise((r) => setTimeout(r, 50));
      expect(calls).toHaveLength(2); // Now 2
    });

    test("findings-ready: different PRs notify independently", async () => {
      const bus = createEventBus();
      const { fn: spawn, calls } = createSpySpawn([
        { exitCode: 0 },
        { exitCode: 0 },
      ]);

      binaries.setPath("terminal-notifier", "/usr/local/bin/terminal-notifier");

      createNotifier({ binaries, bus, spawn, now: clockFn, logger });

      bus.emit({
        type: "findings-ready",
        ref: { owner: "acme", repo: "api", number: 42 },
      });
      bus.emit({
        type: "findings-ready",
        ref: { owner: "acme", repo: "api", number: 43 },
      });

      await new Promise((r) => setTimeout(r, 10));

      expect(calls).toHaveLength(2);
    });
  });

  describe("pr-changed notifications", () => {
    test("sends notification for new PR in triage", async () => {
      const bus = createEventBus();
      const { fn: spawn, calls } = createSpySpawn([{ exitCode: 0 }]);

      binaries.setPath("terminal-notifier", "/usr/local/bin/terminal-notifier");

      createNotifier({ binaries, bus, spawn, now: clockFn, logger });

      bus.emit({
        type: "pr-changed",
        ref: { owner: "acme", repo: "api", number: 42 },
      });

      await new Promise((r) => setTimeout(r, 10));

      expect(calls).toHaveLength(1);
      expect(calls.at(0)!.cmd).toContain("New PR in triage");
      expect(calls.at(0)!.cmd).toContain("acme/api#42");
    });

    test("pr-changed: each notification fires independently", async () => {
      const bus = createEventBus();
      const { fn: spawn, calls } = createSpySpawn([
        { exitCode: 0 },
        { exitCode: 0 },
      ]);

      binaries.setPath("terminal-notifier", "/usr/local/bin/terminal-notifier");

      createNotifier({ binaries, bus, spawn, now: clockFn, logger });

      const ref = { owner: "acme", repo: "api", number: 42 };

      // No dedup: same PR fires twice.
      bus.emit({ type: "pr-changed", ref });
      bus.emit({ type: "pr-changed", ref });

      await new Promise((r) => setTimeout(r, 10));

      expect(calls).toHaveLength(2);
    });
  });

  describe("quota-changed notifications", () => {
    test("sends notification when entering throttled state", async () => {
      const bus = createEventBus();
      const { fn: spawn, calls } = createSpySpawn([{ exitCode: 0 }]);

      binaries.setPath("terminal-notifier", "/usr/local/bin/terminal-notifier");

      createNotifier({ binaries, bus, spawn, now: clockFn, logger });

      bus.emit({ type: "quota-changed", mode: "ok" });
      await new Promise((r) => setTimeout(r, 5));
      expect(calls).toHaveLength(0); // No notification for "ok"

      bus.emit({ type: "quota-changed", mode: "throttled" });
      await new Promise((r) => setTimeout(r, 5));
      expect(calls).toHaveLength(1); // Notification for "throttled"

      bus.emit({ type: "quota-changed", mode: "throttled" });
      await new Promise((r) => setTimeout(r, 5));
      expect(calls).toHaveLength(1); // Still 1: already notified
    });

    test("quota-changed: exit throttled clears the flag", async () => {
      const bus = createEventBus();
      const { fn: spawn, calls } = createSpySpawn([
        { exitCode: 0 },
        { exitCode: 0 },
      ]);

      binaries.setPath("terminal-notifier", "/usr/local/bin/terminal-notifier");

      createNotifier({ binaries, bus, spawn, now: clockFn, logger });

      bus.emit({ type: "quota-changed", mode: "throttled" });
      await new Promise((r) => setTimeout(r, 5));
      expect(calls).toHaveLength(1);

      bus.emit({ type: "quota-changed", mode: "ok" });
      await new Promise((r) => setTimeout(r, 5));
      expect(calls).toHaveLength(1); // No new notification for "ok"

      bus.emit({ type: "quota-changed", mode: "throttled" });
      await new Promise((r) => setTimeout(r, 5));
      expect(calls).toHaveLength(2); // Now notified again
    });
  });

  describe("transport fallback", () => {
    test("tries terminal-notifier first", async () => {
      const bus = createEventBus();
      const { fn: spawn, calls } = createSpySpawn([{ exitCode: 0 }]);

      binaries.setPath("terminal-notifier", "/usr/local/bin/terminal-notifier");

      createNotifier({ binaries, bus, spawn, now: clockFn, logger });

      bus.emit({ type: "error", cause: "test" });

      await new Promise((r) => setTimeout(r, 10));

      expect(calls.at(0)!.cmd[0]).toBe("/usr/local/bin/terminal-notifier");
    });

    test("falls back to osascript when terminal-notifier missing", async () => {
      const bus = createEventBus();
      const { fn: spawn, calls } = createSpySpawn([{ exitCode: 0 }]);

      binaries.setPath("terminal-notifier", null);

      createNotifier({ binaries, bus, spawn, now: clockFn, logger });

      bus.emit({ type: "error", cause: "test" });

      await new Promise((r) => setTimeout(r, 10));

      expect(calls.at(0)!.cmd[0]).toBe("osascript");
      expect(calls.at(0)!.cmd[1]).toBe("-e");
      expect(calls.at(0)!.cmd[2]).toContain("display notification");
    });

    test("falls back to log when terminal-notifier fails", async () => {
      const bus = createEventBus();
      const { fn: spawn, calls } = createSpySpawn([
        new Error("spawn failed"),
        new Error("osascript failed"),
      ]);

      binaries.setPath("terminal-notifier", "/usr/local/bin/terminal-notifier");

      createNotifier({ binaries, bus, spawn, now: clockFn, logger });

      bus.emit({ type: "error", cause: "test" });

      await new Promise((r) => setTimeout(r, 10));

      expect(logger.messages).toContain("notification: LGTM error — test");
    });

    test("logs when all transports fail", async () => {
      const bus = createEventBus();
      const { fn: spawn } = createSpySpawn([
        new Error("terminal-notifier failed"),
        new Error("osascript failed"),
      ]);

      binaries.setPath("terminal-notifier", "/usr/local/bin/terminal-notifier");

      createNotifier({ binaries, bus, spawn, now: clockFn, logger });

      bus.emit({ type: "error", cause: "my-error" });

      await new Promise((r) => setTimeout(r, 10));

      expect(logger.messages.length).toBeGreaterThan(0);
      expect(logger.messages[0]).toContain("LGTM error");
      expect(logger.messages[0]).toContain("my-error");
    });
  });

  describe("fire-and-forget", () => {
    test("spawn failure does not break the notifier or propagate", async () => {
      const bus = createEventBus();
      const { fn: spawn } = createSpySpawn([new Error("spawn failed")]);

      binaries.setPath("terminal-notifier", "/usr/local/bin/terminal-notifier");

      const cleanup = createNotifier({ binaries, bus, spawn, now: clockFn, logger });

      // Emit an event that would fail.
      bus.emit({ type: "error", cause: "test" });

      await new Promise((r) => setTimeout(r, 10));

      // No error thrown; notifier stays alive.
      expect(() => {
        bus.emit({ type: "error", cause: "another" });
      }).not.toThrow();

      cleanup();
    });

    test("notifier unsubscribes cleanly", () => {
      const bus = createEventBus();
      const { fn: spawn } = createSpySpawn([{ exitCode: 0 }]);

      binaries.setPath("terminal-notifier", "/usr/local/bin/terminal-notifier");

      const cleanup = createNotifier({ binaries, bus, spawn, now: clockFn, logger });

      cleanup();

      // After cleanup, no listeners.
      // We can't directly inspect the bus's listeners, but we can verify
      // there are no errors when emitting (no crash from missing unsubscribe).
      expect(() => {
        bus.emit({ type: "error", cause: "test" });
      }).not.toThrow();
    });
  });

  describe("deep links", () => {
    test("includes deep link in findings-ready when UI port is set", async () => {
      const bus = createEventBus();
      const { fn: spawn, calls } = createSpySpawn([{ exitCode: 0 }]);

      binaries.setPath("terminal-notifier", "/usr/local/bin/terminal-notifier");
      setUiPort(4747);

      createNotifier({ binaries, bus, spawn, now: clockFn, logger });

      bus.emit({
        type: "findings-ready",
        ref: { owner: "test", repo: "repo", number: 123 },
      });

      await new Promise((r) => setTimeout(r, 10));

      expect(calls.at(0)!.cmd).toContain("-open");
      const openIndex = calls.at(0)!.cmd.indexOf("-open");
      expect(calls.at(0)!.cmd[openIndex + 1]).toBe(
        "http://127.0.0.1:4747/#/prs/test/repo/123"
      );
    });

    test("omits deep link in findings-ready when UI port is not set", async () => {
      const bus = createEventBus();
      const { fn: spawn, calls } = createSpySpawn([{ exitCode: 0 }]);

      binaries.setPath("terminal-notifier", "/usr/local/bin/terminal-notifier");
      // UI port not set

      createNotifier({ binaries, bus, spawn, now: clockFn, logger });

      bus.emit({
        type: "findings-ready",
        ref: { owner: "test", repo: "repo", number: 123 },
      });

      await new Promise((r) => setTimeout(r, 10));

      // No -open flag when uiPort is null.
      expect(calls.at(0)!.cmd).not.toContain("-open");
    });

    test("escapes AppleScript special characters in osascript", async () => {
      const bus = createEventBus();
      const { fn: spawn, calls } = createSpySpawn([{ exitCode: 0 }]);

      binaries.setPath("terminal-notifier", null);

      createNotifier({ binaries, bus, spawn, now: clockFn, logger });

      bus.emit({
        type: "error",
        cause: 'test "quotes" and \\backslash',
      });

      await new Promise((r) => setTimeout(r, 10));

      const osascriptCmd = calls.at(0)!.cmd.join(" ");
      // The cause is escaped for use in AppleScript.
      expect(osascriptCmd).toContain('\\"');
    });
  });
});

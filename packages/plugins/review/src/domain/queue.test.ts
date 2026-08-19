/**
 * Tests for Queue Manager.
 *
 * Run with: bun test packages/plugins/review/src/domain/queue.test.ts
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import fs from "fs";
import path from "path";
import os from "os";
import { createQueueManager } from "./queue.js";
import { createOKFStore } from "@lgtm/core/store/okf.js";

describe("Queue Manager", () => {
  let tmpDir: string;
  let store: ReturnType<typeof createOKFStore>;

  beforeEach(() => {
    tmpDir = path.join(os.tmpdir(), `lgtm-queue-test-${Date.now()}`);
    fs.mkdirSync(tmpDir, { recursive: true });
    store = createOKFStore(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test("addToQueue adds PRs and persists", async () => {
    const queue = createQueueManager(store, "2026-08-15");
    const session = await queue.addToQueue([
      { number: 101, title: "Add OAuth", filesChanged: ["src/auth/oauth.ts"], source: "local" },
      { number: 102, title: "Fix rate limit", filesChanged: ["src/middleware/rate.ts"], source: "local" },
    ]);

    expect(session.prs).toHaveLength(2);
    expect(session.prs[0].number).toBe(101);
    expect(session.prs[0].state).toBe("queued");
    expect(session.prs[1].number).toBe(102);
  });

  test("addToQueue rejects duplicates", async () => {
    const queue = createQueueManager(store, "2026-08-15");
    await queue.addToQueue([
      { number: 101, title: "Add OAuth", filesChanged: ["src/auth/oauth.ts"], source: "local" },
    ]);
    const session = await queue.addToQueue([
      { number: 101, title: "Add OAuth", filesChanged: ["src/auth/oauth.ts"], source: "local" },
      { number: 102, title: "New PR", filesChanged: ["src/new.ts"], source: "local" },
    ]);

    expect(session.prs).toHaveLength(2); // 101 not duplicated
  });

  test("getQueue returns current state", async () => {
    const queue = createQueueManager(store, "2026-08-15");
    await queue.addToQueue([
      { number: 101, title: "Add OAuth", filesChanged: ["src/auth/oauth.ts"], source: "local" },
    ]);

    const session = await queue.getQueue();
    expect(session.prs).toHaveLength(1);
    expect(session.prs[0].title).toBe("Add OAuth");
  });

  test("updateState: queued → reviewing", async () => {
    const queue = createQueueManager(store, "2026-08-15");
    await queue.addToQueue([
      { number: 101, title: "Add OAuth", filesChanged: ["src/auth/oauth.ts"], source: "local" },
    ]);

    const pr = await queue.updateState(101, "reviewing");
    expect(pr).not.toBeNull();
    expect(pr!.state).toBe("reviewing");
  });

  test("updateState: reviewing → approved", async () => {
    const queue = createQueueManager(store, "2026-08-15");
    await queue.addToQueue([
      { number: 101, title: "Add OAuth", filesChanged: ["src/auth/oauth.ts"], source: "local" },
    ]);
    await queue.updateState(101, "reviewing");
    const pr = await queue.updateState(101, "approved");

    expect(pr).not.toBeNull();
    expect(pr!.state).toBe("approved");
    expect(pr!.reviewedAt).toBeTruthy();
  });

  test("updateState: reviewing → flagged with reason", async () => {
    const queue = createQueueManager(store, "2026-08-15");
    await queue.addToQueue([
      { number: 101, title: "Add OAuth", filesChanged: ["src/auth/oauth.ts"], source: "local" },
    ]);
    await queue.updateState(101, "reviewing");
    const pr = await queue.updateState(101, "flagged", "No tests");

    expect(pr).not.toBeNull();
    expect(pr!.state).toBe("flagged");
    expect(pr!.flagReason).toBe("No tests");
  });

  test("updateState: invalid transition returns null", async () => {
    const queue = createQueueManager(store, "2026-08-15");
    await queue.addToQueue([
      { number: 101, title: "Add OAuth", filesChanged: ["src/auth/oauth.ts"], source: "local" },
    ]);

    // Can't go directly from queued → approved
    const pr = await queue.updateState(101, "approved");
    expect(pr).toBeNull();
  });

  test("updateState: non-existent PR returns null", async () => {
    const queue = createQueueManager(store, "2026-08-15");
    const pr = await queue.updateState(999, "reviewing");
    expect(pr).toBeNull();
  });

  test("removeFromQueue removes PR", async () => {
    const queue = createQueueManager(store, "2026-08-15");
    await queue.addToQueue([
      { number: 101, title: "Add OAuth", filesChanged: ["src/auth/oauth.ts"], source: "local" },
      { number: 102, title: "Fix bug", filesChanged: ["src/bug.ts"], source: "local" },
    ]);

    const removed = await queue.removeFromQueue(101);
    expect(removed).toBe(true);

    const session = await queue.getQueue();
    expect(session.prs).toHaveLength(1);
    expect(session.prs[0].number).toBe(102);
  });

  test("removeFromQueue returns false for non-existent PR", async () => {
    const queue = createQueueManager(store, "2026-08-15");
    const removed = await queue.removeFromQueue(999);
    expect(removed).toBe(false);
  });

  test("persists across multiple manager instances", async () => {
    const queue1 = createQueueManager(store, "2026-08-15");
    await queue1.addToQueue([
      { number: 101, title: "Add OAuth", filesChanged: ["src/auth/oauth.ts"], source: "local" },
    ]);

    // New instance, same store + date
    const queue2 = createQueueManager(store, "2026-08-15");
    const session = await queue2.getQueue();
    expect(session.prs).toHaveLength(1);
    expect(session.prs[0].number).toBe(101);
  });
});

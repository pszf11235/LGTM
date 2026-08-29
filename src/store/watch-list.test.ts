/**
 * Tests for watch-list.ts — verifies load, save, add, remove, and updates.
 *
 * Run with: bun test src/store/watch-list.test.ts
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import fs from "fs/promises";
import path from "path";
import os from "os";
import {
  loadWatchList,
  saveWatchList,
  addToWatchList,
  removeFromWatchList,
  updateLastPolledAt,
  updateETag,
  getWatchedRepoKeys,
} from "./watch-list.js";

// Use a temp directory for each test, isolated via HOME
let tmpDir: string;
let originalHome: string;

describe("WatchList", () => {
  beforeEach(async () => {
    tmpDir = path.join(os.tmpdir(), `lgtm-test-${Date.now()}`);
    await fs.mkdir(tmpDir, { recursive: true });
    originalHome = process.env.HOME || "";
    process.env.HOME = tmpDir;
  });

  afterEach(async () => {
    process.env.HOME = originalHome;
    if (tmpDir) {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  test("loadWatchList returns empty array when file does not exist", async () => {
    const entries = await loadWatchList();
    expect(entries).toHaveLength(0);
  });

  test("saveWatchList and loadWatchList round-trip", async () => {
    const entries = [
      {
        owner: "acme",
        repo: "api",
        addedAt: "2026-08-29T10:00:00Z",
        lastPolledAt: "2026-08-29T11:00:00Z",
        etag: "abc123",
      },
      {
        owner: "octocat",
        repo: "Hello-World",
        addedAt: "2026-08-28T10:00:00Z",
      },
    ];

    await saveWatchList(entries);
    const loaded = await loadWatchList();

    expect(loaded).toHaveLength(2);
    expect(loaded[0]).toMatchObject({
      owner: "acme",
      repo: "api",
      lastPolledAt: "2026-08-29T11:00:00Z",
      etag: "abc123",
    });
    expect(loaded[1]).toMatchObject({
      owner: "octocat",
      repo: "Hello-World",
    });
  });

  test("addToWatchList returns true when adding new entry", async () => {
    const added = await addToWatchList("acme", "api");
    expect(added).toBe(true);

    const entries = await loadWatchList();
    expect(entries).toHaveLength(1);
    expect(entries[0].owner).toBe("acme");
    expect(entries[0].repo).toBe("api");
  });

  test("addToWatchList is idempotent", async () => {
    const added1 = await addToWatchList("acme", "api");
    const added2 = await addToWatchList("acme", "api");

    expect(added1).toBe(true);
    expect(added2).toBe(false);

    const entries = await loadWatchList();
    expect(entries).toHaveLength(1);
  });

  test("addToWatchList sets addedAt timestamp", async () => {
    const before = new Date();
    await addToWatchList("acme", "api");
    const after = new Date();

    const entries = await loadWatchList();
    expect(entries).toHaveLength(1);

    const addedAt = new Date(entries[0].addedAt);
    expect(addedAt.getTime()).toBeGreaterThanOrEqual(before.getTime());
    expect(addedAt.getTime()).toBeLessThanOrEqual(after.getTime());
  });

  test("removeFromWatchList returns true when removing existing entry", async () => {
    await addToWatchList("acme", "api");
    const removed = await removeFromWatchList("acme", "api");

    expect(removed).toBe(true);
    const entries = await loadWatchList();
    expect(entries).toHaveLength(0);
  });

  test("removeFromWatchList returns false when entry does not exist", async () => {
    const removed = await removeFromWatchList("acme", "api");
    expect(removed).toBe(false);
  });

  test("removeFromWatchList is idempotent", async () => {
    await addToWatchList("acme", "api");
    await removeFromWatchList("acme", "api");
    const removed = await removeFromWatchList("acme", "api");

    expect(removed).toBe(false);
  });

  test("updateLastPolledAt updates the timestamp", async () => {
    await addToWatchList("acme", "api");
    const before = new Date();
    await updateLastPolledAt("acme", "api");
    const after = new Date();

    const entries = await loadWatchList();
    const lastPolledAt = new Date(entries[0].lastPolledAt || "");

    expect(lastPolledAt.getTime()).toBeGreaterThanOrEqual(before.getTime());
    expect(lastPolledAt.getTime()).toBeLessThanOrEqual(after.getTime());
  });

  test("updateLastPolledAt is no-op for missing repo", async () => {
    await updateLastPolledAt("acme", "api");
    const entries = await loadWatchList();
    expect(entries).toHaveLength(0);
  });

  test("updateETag updates the etag", async () => {
    await addToWatchList("acme", "api");
    await updateETag("acme", "api", "def456");

    const entries = await loadWatchList();
    expect(entries[0].etag).toBe("def456");
  });

  test("updateETag is no-op for missing repo", async () => {
    await updateETag("acme", "api", "def456");
    const entries = await loadWatchList();
    expect(entries).toHaveLength(0);
  });

  test("getWatchedRepoKeys returns set of owner/repo strings", async () => {
    await addToWatchList("acme", "api");
    await addToWatchList("octocat", "Hello-World");

    const keys = await getWatchedRepoKeys();
    expect(keys).toContain("acme/api");
    expect(keys).toContain("octocat/Hello-World");
    expect(keys.size).toBe(2);
  });

  test("filters out entries with missing owner or repo", async () => {
    const store = await import("./okf.js").then((m) =>
      m.createOKFStore(path.join(tmpDir, ".lgtm-farm"))
    );
    await fs.mkdir(path.join(tmpDir, ".lgtm-farm"), { recursive: true });

    // Write watch list with malformed entries
    await store.write("watch.md", {
      repos: [
        { owner: "acme", repo: "api", addedAt: "2026-08-29T10:00:00Z" },
        { owner: "octocat", addedAt: "2026-08-29T10:00:00Z" }, // missing repo
        { repo: "Hello-World", addedAt: "2026-08-29T10:00:00Z" }, // missing owner
        null, // null entry
      ],
    }, "# Watch\n");

    const entries = await loadWatchList();
    expect(entries).toHaveLength(1);
    expect(entries[0].owner).toBe("acme");
    expect(entries[0].repo).toBe("api");
  });

  test("saveWatchList preserves all fields on re-save", async () => {
    const entries = [
      {
        owner: "acme",
        repo: "api",
        addedAt: "2026-08-29T10:00:00Z",
        lastPolledAt: "2026-08-29T11:00:00Z",
        etag: "abc123",
      },
    ];

    await saveWatchList(entries);
    await updateETag("acme", "api", "xyz789");
    const loaded = await loadWatchList();

    expect(loaded[0].addedAt).toBe("2026-08-29T10:00:00Z");
    expect(loaded[0].lastPolledAt).toBe("2026-08-29T11:00:00Z");
    expect(loaded[0].etag).toBe("xyz789");
  });

  test("missing optional fields default gracefully", async () => {
    const store = await import("./okf.js").then((m) =>
      m.createOKFStore(path.join(tmpDir, ".lgtm-farm"))
    );
    await fs.mkdir(path.join(tmpDir, ".lgtm-farm"), { recursive: true });

    // Write watch list with minimal fields
    await store.write("watch.md", {
      repos: [
        { owner: "acme", repo: "api" }, // no addedAt, lastPolledAt, or etag
      ],
    }, "# Watch\n");

    const entries = await loadWatchList();
    expect(entries).toHaveLength(1);
    expect(entries[0].owner).toBe("acme");
    expect(entries[0].repo).toBe("api");
    expect(entries[0].lastPolledAt).toBeUndefined();
    expect(entries[0].etag).toBeUndefined();
    // addedAt should default to now
    expect(entries[0].addedAt).toBeTruthy();
  });
});

/**
 * Tests for config.ts — verifies load, save, and defaults.
 *
 * Run with: bun test src/store/config.test.ts
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import fs from "fs/promises";
import path from "path";
import os from "os";
import { loadConfig, saveConfig, updateConfig, DEFAULTS } from "./config.js";

// Use a temp directory for each test, isolated via HOME
let tmpDir: string;
let originalHome: string;

describe("Config", () => {
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

  test("interval_minutes defaults to 15", async () => {
    const config = await loadConfig();
    expect(config.interval_minutes).toBe(15);
  });

  test("pause_above_pct defaults to 70", async () => {
    const config = await loadConfig();
    expect(config.pause_above_pct).toBe(70);
  });

  test("resume_below_pct defaults to 60", async () => {
    const config = await loadConfig();
    expect(config.resume_below_pct).toBe(60);
  });

  test("daily_cap defaults to 20", async () => {
    const config = await loadConfig();
    expect(config.daily_cap).toBe(20);
  });

  test("concurrency defaults to 2", async () => {
    const config = await loadConfig();
    expect(config.concurrency).toBe(2);
  });

  test("binary paths default to undefined", async () => {
    const config = await loadConfig();
    expect(config.claude_path).toBeUndefined();
    expect(config.gh_path).toBeUndefined();
  });

  test("loadConfig returns defaults when file does not exist", async () => {
    const config = await loadConfig();
    expect(config.interval_minutes).toBe(15);
    expect(config.pause_above_pct).toBe(70);
    expect(config.resume_below_pct).toBe(60);
    expect(config.daily_cap).toBe(20);
    expect(config.concurrency).toBe(2);
  });

  test("saveConfig and loadConfig round-trip", async () => {
    const original = {
      interval_minutes: 30,
      pause_above_pct: 75,
      resume_below_pct: 55,
      daily_cap: 25,
      concurrency: 4,
      claude_path: "/usr/local/bin/claude",
      gh_path: "/usr/local/bin/gh",
    };

    await saveConfig(original);
    const loaded = await loadConfig();

    expect(loaded.interval_minutes).toBe(30);
    expect(loaded.pause_above_pct).toBe(75);
    expect(loaded.resume_below_pct).toBe(55);
    expect(loaded.daily_cap).toBe(25);
    expect(loaded.concurrency).toBe(4);
    expect(loaded.claude_path).toBe("/usr/local/bin/claude");
    expect(loaded.gh_path).toBe("/usr/local/bin/gh");
  });

  test("saveConfig is idempotent", async () => {
    const config = {
      interval_minutes: 20,
      pause_above_pct: 72,
      resume_below_pct: 58,
      daily_cap: 22,
      concurrency: 3,
    };

    await saveConfig(config);
    await saveConfig(config);
    const loaded = await loadConfig();

    expect(loaded.interval_minutes).toBe(20);
    expect(loaded.pause_above_pct).toBe(72);
  });

  test("updateConfig preserves unmodified fields", async () => {
    const original = {
      interval_minutes: 30,
      pause_above_pct: 75,
      resume_below_pct: 55,
      daily_cap: 25,
      concurrency: 4,
    };

    await saveConfig(original);
    await updateConfig({ interval_minutes: 45 });
    const loaded = await loadConfig();

    expect(loaded.interval_minutes).toBe(45);
    expect(loaded.pause_above_pct).toBe(75);
    expect(loaded.resume_below_pct).toBe(55);
    expect(loaded.daily_cap).toBe(25);
    expect(loaded.concurrency).toBe(4);
  });

  test("malformed number fields fall back to defaults", async () => {
    const store = await import("./okf.js").then((m) => m.createOKFStore(path.join(tmpDir, ".lgtm-farm")));
    await fs.mkdir(path.join(tmpDir, ".lgtm-farm"), { recursive: true });

    // Write config with malformed numbers
    await store.write("config.md", {
      interval_minutes: "not a number",
      pause_above_pct: null,
      resume_below_pct: [],
      daily_cap: "abc123",
      concurrency: 2,
    }, "# Config\n");

    const config = await loadConfig();
    expect(config.interval_minutes).toBe(15);
    expect(config.pause_above_pct).toBe(70);
    expect(config.resume_below_pct).toBe(60);
    expect(config.daily_cap).toBe(20);
    expect(config.concurrency).toBe(2);
  });

  test("optional binary paths are included when present", async () => {
    const config = {
      interval_minutes: 15,
      pause_above_pct: 70,
      resume_below_pct: 60,
      daily_cap: 20,
      concurrency: 2,
      claude_path: "/custom/claude",
      gh_path: "/custom/gh",
    };

    await saveConfig(config);
    const loaded = await loadConfig();

    expect(loaded.claude_path).toBe("/custom/claude");
    expect(loaded.gh_path).toBe("/custom/gh");
  });

  test("empty binary paths are treated as undefined", async () => {
    const store = await import("./okf.js").then((m) => m.createOKFStore(path.join(tmpDir, ".lgtm-farm")));
    await fs.mkdir(path.join(tmpDir, ".lgtm-farm"), { recursive: true });

    await store.write("config.md", {
      interval_minutes: 15,
      pause_above_pct: 70,
      resume_below_pct: 60,
      daily_cap: 20,
      concurrency: 2,
      claude_path: "",
      gh_path: "",
    }, "# Config\n");

    const config = await loadConfig();
    expect(config.claude_path).toBeUndefined();
    expect(config.gh_path).toBeUndefined();
  });
});

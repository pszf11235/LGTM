/**
 * Tests for store initialisation.
 *
 * Onboarding asks nothing, so these cover the store being created correctly
 * and initStore() being safe to call repeatedly.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import fs from "fs";
import path from "path";
import os from "os";

let tmpHome: string;
let realHome: string | undefined;

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "lgtm-init-"));
  realHome = process.env.HOME;
  process.env.HOME = tmpHome;
});

afterEach(() => {
  if (realHome !== undefined) process.env.HOME = realHome;
  try {
    fs.rmSync(tmpHome, { recursive: true });
  } catch { /* ignore */ }
});

describe("initStore", () => {
  test("creates the central store with all subdirectories", async () => {
    const { initStore } = await import("./flow.js");
    const result = await initStore();

    expect(result.created).toBe(true);
    expect(result.lgtmDir).toBe(path.join(tmpHome, ".lgtm-farm"));

    for (const sub of ["agents", "reviews", "rules", "cache"]) {
      expect(fs.existsSync(path.join(result.lgtmDir, sub))).toBe(true);
    }
  });

  test("writes a default reviewer agent on first run", async () => {
    const { initStore } = await import("./flow.js");
    const result = await initStore();

    expect(result.agentCreated).toBe(true);

    const agentPath = path.join(result.lgtmDir, "agents", "reviewer.md");
    expect(fs.existsSync(agentPath)).toBe(true);

    const content = fs.readFileSync(agentPath, "utf-8");
    expect(content).toContain("name: reviewer");
    expect(content).toContain("provider: auto");
    expect(content).toContain("prompt: |");
  });

  test("writes a profile", async () => {
    const { initStore } = await import("./flow.js");
    const result = await initStore();

    const profilePath = path.join(result.lgtmDir, "profile.md");
    expect(fs.existsSync(profilePath)).toBe(true);
    expect(fs.readFileSync(profilePath, "utf-8")).toContain("type: lgtm/profile");
  });

  test("is idempotent — second run reports nothing new and preserves edits", async () => {
    const { initStore } = await import("./flow.js");
    const first = await initStore();

    const agentPath = path.join(first.lgtmDir, "agents", "reviewer.md");
    fs.writeFileSync(agentPath, "---\nname: reviewer\nprompt: custom\n---\n", "utf-8");

    const second = await initStore();

    expect(second.created).toBe(false);
    expect(second.agentCreated).toBe(false);
    // A user's edited prompt must survive re-initialisation
    expect(fs.readFileSync(agentPath, "utf-8")).toContain("prompt: custom");
  });
});

describe("storeExists", () => {
  test("false before init, true after", async () => {
    const { storeExists, initStore } = await import("./flow.js");

    expect(storeExists()).toBe(false);
    await initStore();
    expect(storeExists()).toBe(true);
  });
});

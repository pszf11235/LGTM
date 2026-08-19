/**
 * Tests for config loader.
 *
 * Verifies: bootstrap loading/saving, profile loading, config resolution,
 * and edge cases like missing files, partial configs, undefined values.
 *
 * Run with: bun test packages/core/src/config/loader.test.ts
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import fs from "fs";
import path from "path";
import os from "os";
import { loadProfile, resolveYakDir, getDefaultConfig } from "./loader.js";
import type { BootstrapConfig } from "./loader.js";
import { createOKFStore } from "../store/okf.js";

describe("resolveYakDir", () => {
  test("repo mode returns .lgtm in repo root", () => {
    const config: BootstrapConfig = { storageMode: "repo" };
    const result = resolveYakDir(config, "/home/user/myproject");
    expect(result).toBe("/home/user/myproject/.lgtm");
  });

  test("farm mode returns ~/.lgtm-farm/<repo-name>", () => {
    const config: BootstrapConfig = { storageMode: "farm" };
    const result = resolveYakDir(config, "/home/user/myproject");
    expect(result).toBe(path.join(os.homedir(), ".lgtm-farm", "myproject"));
  });

  test("farm mode with custom path uses custom path", () => {
    const config: BootstrapConfig = {
      storageMode: "farm",
      farmPath: "/custom/lgtm-farm",
    };
    const result = resolveYakDir(config, "/home/user/myproject");
    expect(result).toBe("/custom/lgtm-farm/myproject");
  });
});

describe("loadProfile", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = path.join(os.tmpdir(), `lgtm-config-test-${Date.now()}`);
    fs.mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test("returns null when profile.md does not exist", () => {
    expect(loadProfile(tmpDir)).toBeNull();
  });

  test("returns null when profile.md has no frontmatter", () => {
    fs.writeFileSync(path.join(tmpDir, "profile.md"), "# Just markdown\n");
    expect(loadProfile(tmpDir)).toBeNull();
  });

  test("returns null when profile has no project field", () => {
    const content = `---\ngoal: production\n---\n# No project`;
    fs.writeFileSync(path.join(tmpDir, "profile.md"), content);
    expect(loadProfile(tmpDir)).toBeNull();
  });

  test("loads a complete profile correctly", () => {
    const content = `---
project: my-app
goal: production
feedbackStyle: direct
teamSize: solo
qualityReferences:
  - https://github.com/vercel/next.js
techStack:
  - typescript
  - react
ai:
  enabled: true
  provider: anthropic
createdAt: "2026-08-15T10:00:00Z"
---
# Profile`;
    fs.writeFileSync(path.join(tmpDir, "profile.md"), content);

    const profile = loadProfile(tmpDir);
    expect(profile).not.toBeNull();
    expect(profile!.project).toBe("my-app");
    expect(profile!.goal).toBe("production");
    expect(profile!.feedbackStyle).toBe("direct");
    expect(profile!.teamSize).toBe("solo");
    expect(profile!.qualityReferences).toEqual(["https://github.com/vercel/next.js"]);
    expect(profile!.techStack).toEqual(["typescript", "react"]);
    expect(profile!.ai.enabled).toBe(true);
    expect(profile!.ai.provider).toBe("anthropic");
  });

  test("handles partial profile (missing optional fields)", () => {
    const content = `---
project: my-app
goal: vibed
---
# Partial`;
    fs.writeFileSync(path.join(tmpDir, "profile.md"), content);

    const profile = loadProfile(tmpDir);
    expect(profile).not.toBeNull();
    expect(profile!.project).toBe("my-app");
    expect(profile!.goal).toBe("vibed");
    expect(profile!.qualityReferences).toEqual([]);
    expect(profile!.techStack).toEqual([]);
    expect(profile!.ai.enabled).toBe(false);
  });
});

describe("getDefaultConfig", () => {
  test("returns valid defaults", () => {
    const config = getDefaultConfig();
    expect(config.storageMode).toBe("repo");
    expect(config.ai.enabled).toBe(false);
    expect(config.plugins.review.enabled).toBe(true);
    expect(config.plugins.specify.enabled).toBe(false);
    expect(config.plugins.learn.enabled).toBe(false);
  });
});

describe("OKF profile serialization", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = path.join(os.tmpdir(), `lgtm-serial-test-${Date.now()}`);
    fs.mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test("writing profile with no undefined values succeeds", async () => {
    const store = createOKFStore(tmpDir);
    const data = {
      type: "lgtm/profile",
      project: "test",
      goal: "production",
      feedbackStyle: "direct",
      teamSize: "solo",
      techStack: ["typescript"],
      qualityReferences: [],
      ai: { enabled: false },
      createdAt: "2026-08-15T10:00:00Z",
    };

    // Should not throw
    await store.write("profile.md", data, "# Test");
    const result = await store.read("profile.md");
    expect(result).not.toBeNull();
    expect(result!.data.project).toBe("test");
  });

  test("writing profile with undefined values stripped via JSON.parse/stringify", async () => {
    const store = createOKFStore(tmpDir);
    const rawData = {
      type: "lgtm/profile",
      project: "test",
      goal: "",
      feedbackStyle: "",
      teamSize: "",
      ai: { enabled: false, provider: undefined },
    };

    // Strip undefined (this is what the onboarding flow does)
    const cleanData = JSON.parse(JSON.stringify(rawData));

    // Should not throw — undefined is gone
    await store.write("profile.md", cleanData, "# Test");
    const result = await store.read("profile.md");
    expect(result).not.toBeNull();
    expect(result!.data.ai).toEqual({ enabled: false });
    // provider key should not exist at all
    expect("provider" in (result!.data.ai as object)).toBe(false);
  });

  test("empty string fields survive round-trip (not coerced to defaults)", async () => {
    const store = createOKFStore(tmpDir);
    await store.write(
      "profile.md",
      {
        type: "lgtm/profile",
        project: "test",
        goal: "",
        feedbackStyle: "",
        teamSize: "",
      },
      "# Partial"
    );

    const result = await store.read("profile.md");
    expect(result!.data.goal).toBe("");
    expect(result!.data.feedbackStyle).toBe("");
    expect(result!.data.teamSize).toBe("");
  });
});

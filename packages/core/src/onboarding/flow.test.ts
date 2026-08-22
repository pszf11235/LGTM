/**
 * Tests for onboarding flow logic.
 *
 * These test the non-interactive parts: profile completion detection,
 * profile building, resume logic. Interactive prompts are not tested here
 * (would need a PTY mock).
 *
 * Run with: bun test packages/core/src/onboarding/flow.test.ts
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import fs from "fs";
import path from "path";
import os from "os";
import { isOnboardingComplete } from "./flow.js";
import { createOKFStore } from "../store/okf.js";
import { ensureLgtmDirs } from "../store/paths.js";

describe("isOnboardingComplete", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = path.join(os.tmpdir(), `lgtm-test-${Date.now()}`);
    fs.mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test("returns false when no profile exists", () => {
    expect(isOnboardingComplete(tmpDir)).toBe(false);
  });

  test("returns false when profile exists but goal is empty", async () => {
    const store = createOKFStore(tmpDir);
    await store.write(
      "profile.md",
      {
        type: "lgtm/profile",
        project: "test",
        goal: "",
        feedbackStyle: "direct",
        teamSize: "solo",
      },
      "# Test"
    );
    expect(isOnboardingComplete(tmpDir)).toBe(false);
  });

  test("returns false when profile has goal but missing feedbackStyle", async () => {
    const store = createOKFStore(tmpDir);
    await store.write(
      "profile.md",
      {
        type: "lgtm/profile",
        project: "test",
        goal: "production",
        feedbackStyle: "",
        teamSize: "solo",
      },
      "# Test"
    );
    expect(isOnboardingComplete(tmpDir)).toBe(false);
  });

  test("returns false when profile has goal and feedback but missing teamSize", async () => {
    const store = createOKFStore(tmpDir);
    await store.write(
      "profile.md",
      {
        type: "lgtm/profile",
        project: "test",
        goal: "production",
        feedbackStyle: "direct",
        teamSize: "",
      },
      "# Test"
    );
    expect(isOnboardingComplete(tmpDir)).toBe(false);
  });

  test("returns true when all required fields are set", async () => {
    const store = createOKFStore(tmpDir);
    await store.write(
      "profile.md",
      {
        type: "lgtm/profile",
        project: "test",
        goal: "production",
        feedbackStyle: "direct",
        teamSize: "solo",
        techStack: ["typescript"],
        qualityReferences: [],
        ai: { enabled: false },
      },
      "# Test"
    );
    expect(isOnboardingComplete(tmpDir)).toBe(true);
  });

  test("returns true regardless of AI provider being set or not", async () => {
    const store = createOKFStore(tmpDir);
    await store.write(
      "profile.md",
      {
        type: "lgtm/profile",
        project: "test",
        goal: "vibed",
        feedbackStyle: "gentle",
        teamSize: "small",
        ai: { enabled: false },
      },
      "# Test"
    );
    expect(isOnboardingComplete(tmpDir)).toBe(true);
  });
});

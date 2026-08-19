/**
 * Tests for CLI entry point behavior.
 *
 * Verifies that bare `lgtm` routes correctly based on profile state.
 * These test the logic, not the actual CLI parsing (that needs integration tests).
 *
 * Run with: bun test packages/core/src/cli/entry.test.ts
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import fs from "fs";
import path from "path";
import os from "os";
import { isOnboardingComplete } from "../onboarding/flow.js";
import { createOKFStore } from "../store/okf.js";

describe("CLI routing logic: bare 'lgtm' behavior", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = path.join(os.tmpdir(), `lgtm-cli-test-${Date.now()}`);
    fs.mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test("no .lgtm/ directory → should trigger onboarding", () => {
    // No profile at all
    expect(isOnboardingComplete(tmpDir)).toBe(false);
  });

  test("empty .lgtm/ directory → should trigger onboarding", () => {
    fs.mkdirSync(path.join(tmpDir, ".lgtm"), { recursive: true });
    expect(isOnboardingComplete(tmpDir)).toBe(false);
  });

  test("profile.md exists but all fields empty → should resume onboarding", async () => {
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
      "# Incomplete"
    );
    expect(isOnboardingComplete(tmpDir)).toBe(false);
  });

  test("profile.md with only storageMode answered → should resume onboarding", async () => {
    const store = createOKFStore(tmpDir);
    await store.write(
      "profile.md",
      {
        type: "lgtm/profile",
        project: "test",
        goal: "",
        feedbackStyle: "",
        teamSize: "",
        ai: { enabled: false },
      },
      "# Just started"
    );
    expect(isOnboardingComplete(tmpDir)).toBe(false);
  });

  test("profile.md with some fields set → should resume onboarding", async () => {
    const store = createOKFStore(tmpDir);
    await store.write(
      "profile.md",
      {
        type: "lgtm/profile",
        project: "test",
        goal: "production",
        feedbackStyle: "",
        teamSize: "",
      },
      "# Partial"
    );
    expect(isOnboardingComplete(tmpDir)).toBe(false);
  });

  test("complete profile → should NOT trigger onboarding (show TUI)", async () => {
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
        ai: { enabled: false },
      },
      "# Complete"
    );
    expect(isOnboardingComplete(tmpDir)).toBe(true);
  });
});

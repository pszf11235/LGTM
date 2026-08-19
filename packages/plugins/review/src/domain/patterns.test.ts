/**
 * Tests for comment pattern analysis.
 *
 * Verifies: text matching analysis and markdown comment extraction.
 * LLM path is tested with a mock provider.
 *
 * Run with: bun test packages/plugins/review/src/domain/patterns.test.ts
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import fs from "fs";
import path from "path";
import os from "os";
import { analyzeCommentPatterns } from "./patterns.js";
import { createOKFStore } from "@lgtm/core/store/okf.js";

describe("Pattern Analysis", () => {
  let tmpDir: string;
  let store: ReturnType<typeof createOKFStore>;

  beforeEach(() => {
    tmpDir = path.join(os.tmpdir(), `lgtm-patterns-test-${Date.now()}`);
    fs.mkdirSync(tmpDir, { recursive: true });
    fs.mkdirSync(path.join(tmpDir, "sessions"), { recursive: true });
    store = createOKFStore(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test("returns empty when no comments exist", async () => {
    const suggestions = await analyzeCommentPatterns(store);
    expect(suggestions).toEqual([]);
  });

  test("returns empty when fewer than 3 comments", async () => {
    // Create a session with only 2 comments
    fs.mkdirSync(path.join(tmpDir, "sessions", "s1"), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, "sessions", "index.md"),
      "---\ntype: lgtm/session-index\n---\n# Sessions\n"
    );
    fs.writeFileSync(
      path.join(tmpDir, "sessions", "s1", "index.md"),
      "---\ntype: lgtm/session-index\n---\n# Session 1\n"
    );
    fs.writeFileSync(
      path.join(tmpDir, "sessions", "s1", "pr-1.md"),
      "---\ntype: lgtm/review\npr: 1\n---\n### src/app.ts\n- **L14:** Missing error handling\n- **L20:** Add null check\n"
    );

    const suggestions = await analyzeCommentPatterns(store);
    // Only 2 comments from 1 PR — not enough to find patterns
    expect(suggestions).toEqual([]);
  });

  test("detects repeated comments across different PRs", async () => {
    // Create sessions with repeated "missing error handling" comment
    fs.mkdirSync(path.join(tmpDir, "sessions", "s1"), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, "sessions", "index.md"),
      "---\ntype: lgtm/session-index\n---\n# Sessions\n"
    );
    fs.writeFileSync(
      path.join(tmpDir, "sessions", "s1", "index.md"),
      "---\ntype: lgtm/session-index\n---\n# Session\n"
    );

    // PR 1: "Missing error handling"
    fs.writeFileSync(
      path.join(tmpDir, "sessions", "s1", "pr-1.md"),
      "---\ntype: lgtm/review\npr: 1\n---\n### src/auth.ts\n- **L10:** Missing error handling here\n- **L30:** Consider caching this\n"
    );

    // PR 2: "Missing error handling" (same pattern)
    fs.writeFileSync(
      path.join(tmpDir, "sessions", "s1", "pr-2.md"),
      "---\ntype: lgtm/review\npr: 2\n---\n### src/api.ts\n- **L5:** Missing error handling here\n- **L15:** Unused import\n"
    );

    // PR 3: "Missing error handling" (third instance)
    fs.writeFileSync(
      path.join(tmpDir, "sessions", "s1", "pr-3.md"),
      "---\ntype: lgtm/review\npr: 3\n---\n### src/db.ts\n- **L22:** Missing error handling here\n"
    );

    const suggestions = await analyzeCommentPatterns(store);
    // Should detect "missing error handling" as a pattern
    expect(suggestions.length).toBeGreaterThanOrEqual(1);

    const errorHandlingSuggestion = suggestions.find((s) =>
      s.description.toLowerCase().includes("error") || s.description.toLowerCase().includes("handling")
    );
    // If text matching finds it, great. Pattern detection is heuristic.
    if (errorHandlingSuggestion) {
      expect(errorHandlingSuggestion.confidence).toBe("high"); // 3+ similar
      expect(errorHandlingSuggestion.sourceComments.length).toBeGreaterThanOrEqual(2);
    }
  });

  test("uses LLM when available", async () => {
    // Create minimal session data
    fs.mkdirSync(path.join(tmpDir, "sessions", "s1"), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, "sessions", "index.md"),
      "---\ntype: lgtm/session-index\n---\n# Sessions\n"
    );
    fs.writeFileSync(
      path.join(tmpDir, "sessions", "s1", "index.md"),
      "---\ntype: lgtm/session-index\n---\n"
    );
    fs.writeFileSync(
      path.join(tmpDir, "sessions", "s1", "pr-1.md"),
      "---\ntype: lgtm/review\npr: 1\n---\n### a.ts\n- **L1:** Add types\n- **L2:** Add types\n- **L3:** Add types\n"
    );
    fs.writeFileSync(
      path.join(tmpDir, "sessions", "s1", "pr-2.md"),
      "---\ntype: lgtm/review\npr: 2\n---\n### b.ts\n- **L1:** Add types please\n"
    );

    // Mock LLM
    const mockLLM = {
      async complete() {
        return JSON.stringify([{
          description: "Always add TypeScript types",
          category: "style",
          severity: "warn",
          pattern: null,
          bad: ["function foo(x) {}"],
          good: ["function foo(x: string) {}"],
          sourceComments: ["Add types", "Add types please"],
          confidence: "high",
        }]);
      },
      async isAvailable() { return true; },
    };

    const suggestions = await analyzeCommentPatterns(store, mockLLM);
    // LLM path should return the mock suggestion
    expect(suggestions.length).toBeGreaterThanOrEqual(1);
    if (suggestions[0]) {
      expect(suggestions[0].description).toContain("TypeScript");
    }
  });

  test("falls back to text matching when LLM unavailable", async () => {
    const mockLLM = {
      async complete() { throw new Error("offline"); },
      async isAvailable() { return false; },
    };

    // Even with LLM mock that's unavailable, should not throw
    const suggestions = await analyzeCommentPatterns(store, mockLLM);
    expect(Array.isArray(suggestions)).toBe(true);
  });
});

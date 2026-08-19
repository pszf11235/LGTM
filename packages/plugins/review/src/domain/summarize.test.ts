/**
 * Tests for PR summarization.
 *
 * Mocks LLM to test prompt building and response handling.
 *
 * Run with: bun test packages/plugins/review/src/domain/summarize.test.ts
 */

import { describe, test, expect } from "bun:test";
import { generatePRSummary } from "./summarize.js";
import type { ParsedDiff } from "./diff-parser.js";

function makeDiff(files: Array<{ path: string; added: string[] }>): ParsedDiff {
  return {
    files: files.map((f) => ({
      path: f.path,
      status: "modified" as const,
      hunks: [{
        header: "@@ -1,1 +1,1 @@",
        oldStart: 1,
        oldCount: 1,
        newStart: 1,
        newCount: f.added.length,
        lines: f.added.map((content, i) => ({
          type: "added" as const,
          content,
          oldLine: null,
          newLine: i + 1,
        })),
      }],
    })),
  };
}

describe("generatePRSummary", () => {
  test("returns null when LLM is unavailable", async () => {
    const mockLLM = {
      async complete() { return ""; },
      async isAvailable() { return false; },
    };

    const diff = makeDiff([{ path: "src/app.ts", added: ["new line"] }]);
    const result = await generatePRSummary(diff, "feat: add thing", mockLLM);
    expect(result).toBeNull();
  });

  test("returns summary when LLM is available", async () => {
    const mockLLM = {
      async complete() {
        return "This PR adds a new authentication module. It includes JWT token validation and refresh logic. Tests are included.";
      },
      async isAvailable() { return true; },
    };

    const diff = makeDiff([
      { path: "src/auth.ts", added: ["export function validateToken() {", "  // JWT validation"] },
      { path: "src/auth.test.ts", added: ["test('validates token', () => {"] },
    ]);

    const result = await generatePRSummary(diff, "feat: add auth module", mockLLM);
    expect(result).toContain("authentication");
    expect(result).toContain("JWT");
  });

  test("returns null when LLM throws", async () => {
    const mockLLM = {
      async complete() { throw new Error("API rate limit"); },
      async isAvailable() { return true; },
    };

    const diff = makeDiff([{ path: "a.ts", added: ["code"] }]);
    const result = await generatePRSummary(diff, "fix: thing", mockLLM);
    expect(result).toBeNull();
  });

  test("returns null for empty LLM response", async () => {
    const mockLLM = {
      async complete() { return "   "; },
      async isAvailable() { return true; },
    };

    const diff = makeDiff([{ path: "a.ts", added: ["code"] }]);
    const result = await generatePRSummary(diff, "fix: thing", mockLLM);
    expect(result).toBeNull();
  });

  test("passes correct context to LLM", async () => {
    let capturedPrompt = "";
    let capturedOptions: any;

    const mockLLM = {
      async complete(prompt: string, options?: any) {
        capturedPrompt = prompt;
        capturedOptions = options;
        return "A summary.";
      },
      async isAvailable() { return true; },
    };

    const diff = makeDiff([
      { path: "src/feature.ts", added: ["export function doThing() {"] },
    ]);

    await generatePRSummary(diff, "feat: add doThing", mockLLM);

    // Prompt should include PR title, stats, and file list
    expect(capturedPrompt).toContain("feat: add doThing");
    expect(capturedPrompt).toContain("src/feature.ts");
    expect(capturedPrompt).toContain("1 files");

    // Should use low temperature and limited tokens
    expect(capturedOptions.temperature).toBe(0.1);
    expect(capturedOptions.maxTokens).toBe(150);
  });

  test("handles large diffs by truncating", async () => {
    let capturedPrompt = "";

    const mockLLM = {
      async complete(prompt: string) {
        capturedPrompt = prompt;
        return "Summary of large diff.";
      },
      async isAvailable() { return true; },
    };

    // Create a large diff (many files, many lines)
    const files = Array.from({ length: 50 }, (_, i) => ({
      path: `src/file${i}.ts`,
      added: Array.from({ length: 20 }, (_, j) => `const x${j} = ${j}; // some long line of code that takes up space`),
    }));

    const diff = makeDiff(files);
    await generatePRSummary(diff, "refactor: big change", mockLLM);

    // Prompt should be truncated (not include all 1000 lines)
    // The compact diff builder limits to 3000 chars
    expect(capturedPrompt.length).toBeLessThan(10000);
  });

  test("handles binary files gracefully", async () => {
    const mockLLM = {
      async complete() { return "Summary with binary."; },
      async isAvailable() { return true; },
    };

    const diff: ParsedDiff = {
      files: [
        { path: "image.png", status: "binary", hunks: [] },
        {
          path: "src/app.ts",
          status: "modified",
          hunks: [{
            header: "@@ -1,1 +1,2 @@",
            oldStart: 1, oldCount: 1, newStart: 1, newCount: 2,
            lines: [
              { type: "added", content: "new code", oldLine: null, newLine: 1 },
            ],
          }],
        },
      ],
    };

    const result = await generatePRSummary(diff, "add image", mockLLM);
    expect(result).not.toBeNull();
  });
});

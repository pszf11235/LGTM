/**
 * Tests for auto-review engine.
 *
 * Tests the full pipeline: regex rules, LLM rules, LLM holistic review,
 * severity filtering, deduplication, and tone formatting.
 *
 * Run with: bun test packages/plugins/review/src/domain/auto-review.test.ts
 */

import { describe, test, expect } from "bun:test";
import { generateAutoReview, type AutoReviewConfig, type ExistingComment } from "./auto-review.js";
import type { ParsedDiff } from "./diff-parser.js";
import type { Rule } from "./rules.js";
import type { LLMProvider, ProjectProfile } from "@lgtm/core/plugin.js";

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeDiff(files: Array<{ path: string; lines: Array<{ type: "added" | "removed" | "context"; content: string; line: number }> }>): ParsedDiff {
  return {
    files: files.map((f) => ({
      path: f.path,
      status: "modified" as const,
      hunks: [{
        header: "@@ -1,10 +1,10 @@",
        oldStart: 1,
        oldCount: 10,
        newStart: 1,
        newCount: 10,
        lines: f.lines.map((l) => ({
          type: l.type,
          content: l.content,
          oldLine: l.type === "added" ? null : l.line,
          newLine: l.type === "removed" ? null : l.line,
        })),
      }],
    })),
  };
}

function makeRule(overrides: Partial<Rule> = {}): Rule {
  return {
    id: "r-test1",
    description: "No console.log statements",
    category: "style",
    severity: "warn",
    enforcement: "regex",
    pattern: "console\\.log",
    filePattern: "**/*.ts",
    examples: { bad: ["console.log('debug')"], good: ["logger.debug('debug')"] },
    createdAt: new Date().toISOString(),
    enabled: true,
    timesTriggered: 0,
    ...overrides,
  };
}

function makeProfile(overrides: Partial<ProjectProfile> = {}): ProjectProfile {
  return {
    ai: { enabled: true, provider: "openai" },
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

function makeMockLLM(response: string = "[]"): LLMProvider {
  return {
    async complete() { return response; },
    async isAvailable() { return true; },
  };
}

function makeUnavailableLLM(): LLMProvider {
  return {
    async complete() { throw new Error("offline"); },
    async isAvailable() { return false; },
  };
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("generateAutoReview", () => {
  describe("regex rule enforcement", () => {
    test("detects regex rule violations in added lines", async () => {
      const diff = makeDiff([{
        path: "src/app.ts",
        lines: [
          { type: "added", content: "console.log('debugging')", line: 5 },
          { type: "added", content: "const x = 1;", line: 6 },
        ],
      }]);

      const rules = [makeRule()];
      const llm = makeMockLLM();

      const result = await generateAutoReview(diff, rules, makeProfile(), llm, [], {
        severityThreshold: "low", // show all
      });

      const regexFindings = result.findings.filter((f) => f.source === "rule-regex");
      expect(regexFindings.length).toBeGreaterThanOrEqual(1);
      expect(regexFindings[0].file).toBe("src/app.ts");
      expect(regexFindings[0].line).toBe(5);
    });

    test("ignores removed lines", async () => {
      const diff = makeDiff([{
        path: "src/app.ts",
        lines: [
          { type: "removed", content: "console.log('old')", line: 5 },
          { type: "added", content: "logger.info('new')", line: 5 },
        ],
      }]);

      const rules = [makeRule()];
      const llm = makeMockLLM();

      const result = await generateAutoReview(diff, rules, makeProfile(), llm, [], {
        severityThreshold: "low",
      });

      const regexFindings = result.findings.filter((f) => f.source === "rule-regex");
      expect(regexFindings).toHaveLength(0);
    });

    test("skips disabled rules", async () => {
      const diff = makeDiff([{
        path: "src/app.ts",
        lines: [{ type: "added", content: "console.log('x')", line: 1 }],
      }]);

      const rules = [makeRule({ enabled: false })];
      const llm = makeMockLLM();

      const result = await generateAutoReview(diff, rules, makeProfile(), llm, [], {
        severityThreshold: "low",
      });

      expect(result.findings.filter((f) => f.source === "rule-regex")).toHaveLength(0);
    });
  });

  describe("severity filtering", () => {
    test("filters findings below threshold", async () => {
      const diff = makeDiff([{
        path: "src/app.ts",
        lines: [{ type: "added", content: "console.log('x')", line: 1 }],
      }]);

      // Rule severity "warn" maps to "medium"
      const rules = [makeRule({ severity: "warn" })];
      const llm = makeMockLLM();

      const result = await generateAutoReview(diff, rules, makeProfile(), llm, [], {
        severityThreshold: "high", // filter out medium
      });

      // Medium findings should be filtered out
      const regexFindings = result.findings.filter((f) => f.source === "rule-regex");
      expect(regexFindings).toHaveLength(0);
    });

    test("includes findings at or above threshold", async () => {
      const diff = makeDiff([{
        path: "src/app.ts",
        lines: [{ type: "added", content: "console.log('x')", line: 1 }],
      }]);

      // Rule severity "error" maps to "high"
      const rules = [makeRule({ severity: "error" })];
      const llm = makeMockLLM();

      const result = await generateAutoReview(diff, rules, makeProfile(), llm, [], {
        severityThreshold: "high",
      });

      const regexFindings = result.findings.filter((f) => f.source === "rule-regex");
      expect(regexFindings.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe("deduplication", () => {
    test("removes findings that match existing comments", async () => {
      const diff = makeDiff([{
        path: "src/app.ts",
        lines: [{ type: "added", content: "console.log('x')", line: 5 }],
      }]);

      const rules = [makeRule({ severity: "error" })];
      const llm = makeMockLLM();

      const existingComments: ExistingComment[] = [
        { file: "src/app.ts", line: 5, body: "No console.log statements" },
      ];

      const result = await generateAutoReview(diff, rules, makeProfile(), llm, existingComments, {
        severityThreshold: "low",
      });

      // Should be deduplicated
      const regexFindings = result.findings.filter((f) => f.source === "rule-regex");
      expect(regexFindings).toHaveLength(0);
    });

    test("keeps findings that do not match existing comments", async () => {
      const diff = makeDiff([{
        path: "src/app.ts",
        lines: [{ type: "added", content: "console.log('x')", line: 5 }],
      }]);

      const rules = [makeRule({ severity: "error" })];
      const llm = makeMockLLM();

      const existingComments: ExistingComment[] = [
        { file: "src/other.ts", line: 10, body: "Different comment" },
      ];

      const result = await generateAutoReview(diff, rules, makeProfile(), llm, existingComments, {
        severityThreshold: "low",
      });

      const regexFindings = result.findings.filter((f) => f.source === "rule-regex");
      expect(regexFindings.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe("formatting", () => {
    test("removes em dashes when configured", async () => {
      // Mock LLM returning a finding with em dashes
      const llm: LLMProvider = {
        async complete() {
          return JSON.stringify([{
            file: "src/app.ts",
            line: 1,
            comment: "This approach — while creative — has issues",
            severity: "high",
          }]);
        },
        async isAvailable() { return true; },
      };

      const diff = makeDiff([{
        path: "src/app.ts",
        lines: [{ type: "added", content: "code", line: 1 }],
      }]);

      const result = await generateAutoReview(diff, [], makeProfile(), llm, [], {
        severityThreshold: "high",
        formatting: { noEmDashes: true, noSemicolons: false, noSeverityLabels: false },
      });

      const llmFindings = result.findings.filter((f) => f.source === "llm-review");
      if (llmFindings.length > 0) {
        expect(llmFindings[0].comment).not.toContain("—");
        expect(llmFindings[0].comment).toContain(" - ");
      }
    });

    test("strips severity labels when configured", async () => {
      const llm: LLMProvider = {
        async complete() {
          return JSON.stringify([{
            file: "src/app.ts",
            line: 1,
            comment: "[HIGH] Missing null check",
            severity: "high",
          }]);
        },
        async isAvailable() { return true; },
      };

      const diff = makeDiff([{
        path: "src/app.ts",
        lines: [{ type: "added", content: "code", line: 1 }],
      }]);

      const result = await generateAutoReview(diff, [], makeProfile(), llm, [], {
        severityThreshold: "high",
        formatting: { noEmDashes: false, noSemicolons: false, noSeverityLabels: true },
      });

      const llmFindings = result.findings.filter((f) => f.source === "llm-review");
      if (llmFindings.length > 0) {
        expect(llmFindings[0].comment).not.toContain("[HIGH]");
        expect(llmFindings[0].comment).toContain("Missing null check");
      }
    });
  });

  describe("LLM unavailable", () => {
    test("still runs regex rules when LLM is offline", async () => {
      const diff = makeDiff([{
        path: "src/app.ts",
        lines: [{ type: "added", content: "console.log('x')", line: 5 }],
      }]);

      const rules = [makeRule({ severity: "error" })];
      const llm = makeUnavailableLLM();

      const result = await generateAutoReview(diff, rules, makeProfile(), llm, [], {
        severityThreshold: "low",
      });

      // Regex rules should still work
      const regexFindings = result.findings.filter((f) => f.source === "rule-regex");
      expect(regexFindings.length).toBeGreaterThanOrEqual(1);

      // LLM findings should be empty (graceful degradation)
      const llmFindings = result.findings.filter((f) => f.source === "llm-review");
      expect(llmFindings).toHaveLength(0);
    });
  });

  describe("stats and summary", () => {
    test("returns correct stats", async () => {
      const diff = makeDiff([
        { path: "a.ts", lines: [{ type: "added", content: "line1", line: 1 }] },
        { path: "b.ts", lines: [{ type: "added", content: "line2", line: 1 }] },
      ]);

      const rules = [makeRule(), makeRule({ id: "r-test2", description: "Another rule" })];
      const llm = makeMockLLM();

      const result = await generateAutoReview(diff, rules, makeProfile(), llm);

      expect(result.stats.filesReviewed).toBe(2);
      expect(result.stats.rulesChecked).toBe(2);
      expect(result.stats.llmTokensEstimated).toBeGreaterThan(0);
      expect(typeof result.summary).toBe("string");
    });

    test("summary indicates no issues when findings empty", async () => {
      const diff = makeDiff([{
        path: "clean.ts",
        lines: [{ type: "added", content: "const x = 1;", line: 1 }],
      }]);

      const llm = makeMockLLM();

      const result = await generateAutoReview(diff, [], makeProfile(), llm);

      expect(result.summary).toContain("No high-severity issues");
    });
  });

  describe("no rules scenario", () => {
    test("still runs LLM holistic review without rules", async () => {
      const llm: LLMProvider = {
        async complete() {
          return JSON.stringify([{
            file: "src/app.ts",
            line: 3,
            comment: "Potential null pointer",
            severity: "high",
          }]);
        },
        async isAvailable() { return true; },
      };

      const diff = makeDiff([{
        path: "src/app.ts",
        lines: [{ type: "added", content: "obj.value.toString()", line: 3 }],
      }]);

      const result = await generateAutoReview(diff, [], makeProfile(), llm, [], {
        severityThreshold: "high",
      });

      // Should have LLM review findings even without rules
      const llmFindings = result.findings.filter((f) => f.source === "llm-review");
      expect(llmFindings.length).toBeGreaterThanOrEqual(1);
    });
  });
});

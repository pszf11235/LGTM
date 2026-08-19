/**
 * Tests for Rules Engine.
 *
 * Run with: bun test packages/plugins/review/src/domain/rules.test.ts
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import fs from "fs";
import path from "path";
import os from "os";
import { createRulesEngine, type Rule } from "./rules.js";
import { parseDiff } from "./diff-parser.js";
import { createOKFStore } from "@lgtm/core/store/okf.js";

describe("Rules Engine", () => {
  let tmpDir: string;
  let store: ReturnType<typeof createOKFStore>;
  let engine: ReturnType<typeof createRulesEngine>;

  beforeEach(() => {
    tmpDir = path.join(os.tmpdir(), `lgtm-rules-test-${Date.now()}`);
    fs.mkdirSync(tmpDir, { recursive: true });
    store = createOKFStore(tmpDir);
    engine = createRulesEngine(store);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("createRule", () => {
    test("creates a rule and persists it", async () => {
      const rule = await engine.createRule({
        description: "No hardcoded secrets",
        category: "security",
        severity: "error",
        pattern: "(api[_-]?key|secret|token)\\s*[=:]\\s*[\"'][^\"']{8,}",
        filePattern: "**/*.ts",
        examples: {
          bad: ['const apiKey = "sk_live_abc123"'],
          good: ['const apiKey = process.env.API_KEY'],
        },
      });

      expect(rule.id).toMatch(/^r-/);
      expect(rule.description).toBe("No hardcoded secrets");
      expect(rule.category).toBe("security");
      expect(rule.enforcement).toBe("regex");
      expect(rule.enabled).toBe(true);
    });

    test("auto-detects enforcement type from pattern", async () => {
      const withPattern = await engine.createRule({
        description: "Has pattern",
        pattern: "console\\.log",
      });
      expect(withPattern.enforcement).toBe("regex");

      const withoutPattern = await engine.createRule({
        description: "No pattern — needs LLM",
      });
      expect(withoutPattern.enforcement).toBe("llm");
    });
  });

  describe("loadRules", () => {
    test("returns empty array when no rules", async () => {
      const rules = await engine.loadRules();
      expect(rules).toEqual([]);
    });

    test("loads previously created rules", async () => {
      await engine.createRule({ description: "Rule 1", pattern: "foo" });
      await engine.createRule({ description: "Rule 2", pattern: "bar" });

      const rules = await engine.loadRules();
      expect(rules).toHaveLength(2);
      expect(rules.map((r) => r.description).sort()).toEqual(["Rule 1", "Rule 2"]);
    });
  });

  describe("matchRegex", () => {
    const sampleDiff = `diff --git a/src/config.ts b/src/config.ts
index abc..def 100644
--- a/src/config.ts
+++ b/src/config.ts
@@ -1,3 +1,5 @@
 export const config = {
+  apiKey: "sk_live_hardcoded_key_123456",
+  dbPassword: process.env.DB_PASSWORD,
   port: 3000,
 };`;

    test("detects regex violations in added lines", async () => {
      await engine.createRule({
        description: "No hardcoded secrets",
        category: "security",
        severity: "error",
        pattern: "(api[_-]?key|secret|password)\\s*[:=]\\s*\"[^\"]{8,}\"",
        filePattern: "**/*.ts",
      });

      const rules = await engine.loadRules();
      const diff = parseDiff(sampleDiff);
      const violations = engine.matchRegex(rules, diff);

      expect(violations.length).toBe(1);
      expect(violations[0].file).toBe("src/config.ts");
      expect(violations[0].explanation).toBe("No hardcoded secrets");
      expect(violations[0].matchedText).toContain("sk_live_hardcoded_key");
    });

    test("does not match context or removed lines", async () => {
      await engine.createRule({
        description: "No port 3000",
        pattern: "port:\\s*3000",
      });

      const rules = await engine.loadRules();
      const diff = parseDiff(sampleDiff);
      const violations = engine.matchRegex(rules, diff);

      // port: 3000 is a context line (not added), so no violation
      expect(violations.length).toBe(0);
    });

    test("respects filePattern glob", async () => {
      await engine.createRule({
        description: "No hardcoded keys",
        pattern: "sk_live",
        filePattern: "**/*.py", // Only Python files
      });

      const rules = await engine.loadRules();
      const diff = parseDiff(sampleDiff); // diff is .ts file
      const violations = engine.matchRegex(rules, diff);

      // Should not match because file is .ts, not .py
      expect(violations.length).toBe(0);
    });

    test("skips disabled rules", async () => {
      const rule = await engine.createRule({
        description: "Match everything",
        pattern: ".",
      });

      await engine.setEnabled(rule.id, false);
      const rules = await engine.loadRules();
      const diff = parseDiff(sampleDiff);
      const violations = engine.matchRegex(rules, diff);

      expect(violations.length).toBe(0);
    });

    test("handles invalid regex gracefully", async () => {
      await engine.createRule({
        description: "Bad regex",
        pattern: "[invalid(regex",
        enforcement: "regex",
      });

      const rules = await engine.loadRules();
      const diff = parseDiff(sampleDiff);
      // Should not throw
      const violations = engine.matchRegex(rules, diff);
      expect(violations.length).toBe(0);
    });

    test("only LLM rules are not matched by regex engine", async () => {
      await engine.createRule({
        description: "Needs LLM to check",
        enforcement: "llm",
      });

      const rules = await engine.loadRules();
      const diff = parseDiff(sampleDiff);
      const violations = engine.matchRegex(rules, diff);

      expect(violations.length).toBe(0); // LLM rules skipped by regex matcher
    });
  });

  describe("setEnabled", () => {
    test("disables and re-enables a rule", async () => {
      const rule = await engine.createRule({ description: "Test", pattern: "x" });

      await engine.setEnabled(rule.id, false);
      let rules = await engine.loadRules();
      expect(rules.find((r) => r.id === rule.id)!.enabled).toBe(false);

      await engine.setEnabled(rule.id, true);
      rules = await engine.loadRules();
      expect(rules.find((r) => r.id === rule.id)!.enabled).toBe(true);
    });
  });
});

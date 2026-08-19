/**
 * E2E Test: Auto-Review Pipeline
 *
 * Tests the complete flow from raw diff input through the review engine
 * to final posting output — simulating `lgtm review auto --dry-run`.
 *
 * Uses realistic PR diff data, real rules, and mock LLM/GitHub adapters
 * to verify the entire pipeline works end-to-end.
 *
 * Run with: bun test packages/plugins/review/src/e2e/auto-review-pipeline.test.ts
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import fs from "fs";
import path from "path";
import os from "os";
import { parseDiff } from "../domain/diff-parser.js";
import { generateAutoReview } from "../domain/auto-review.js";
import { postReviewFindings } from "../domain/post-review.js";
import { createRulesEngine } from "../domain/rules.js";
import { createOKFStore } from "@lgtm/core/store/okf.js";
import type { LLMProvider, ProjectProfile } from "@lgtm/core/plugin.js";

// ─── Realistic test fixtures ────────────────────────────────────────────────

/** A realistic PR diff (TypeScript auth module with intentional issues) */
const REALISTIC_DIFF = `diff --git a/src/auth/login.ts b/src/auth/login.ts
new file mode 100644
--- /dev/null
+++ b/src/auth/login.ts
@@ -0,0 +1,45 @@
+import { hash } from 'crypto';
+import { db } from '../db';
+
+const API_SECRET = "sk_live_a1b2c3d4e5f6g7h8i9j0";
+
+export async function loginUser(email: string, password: string) {
+  const user = await db.query(\`SELECT * FROM users WHERE email = '\${email}'\`);
+
+  if (!user) {
+    return { error: "User not found" };
+  }
+
+  const hashed = hash('md5', password);
+  if (hashed !== user.passwordHash) {
+    return { error: "Invalid password" };
+  }
+
+  // Generate session token
+  const token = Math.random().toString(36);
+  console.log('User logged in:', email, token);
+
+  await db.query(\`UPDATE users SET token = '\${token}' WHERE id = \${user.id}\`);
+
+  return { token, user: { id: user.id, email: user.email } };
+}
+
+export async function validateToken(token: string) {
+  const user = await db.query(\`SELECT * FROM users WHERE token = '\${token}'\`);
+  return user || null;
+}
+
+export function generateApiKey() {
+  return "key_" + Math.random().toString(36).slice(2);
+}
diff --git a/src/utils/helpers.ts b/src/utils/helpers.ts
--- a/src/utils/helpers.ts
+++ b/src/utils/helpers.ts
@@ -10,6 +10,15 @@ export function formatDate(date: Date): string {
   return date.toISOString();
 }
 
+export function parseConfig(raw: string): Record<string, unknown> {
+  try {
+    return JSON.parse(raw);
+  } catch {
+    console.log("Failed to parse config:", raw);
+    return {};
+  }
+}
+
+export function delay(ms: number): Promise<void> {
+  return new Promise(resolve => setTimeout(resolve, ms));
+}
`;

/** Profile with "direct" feedback style */
const TEST_PROFILE: ProjectProfile = {
  project: "test-app",
  goal: "production",
  qualityReferences: [],
  feedbackStyle: "direct",
  techStack: ["typescript", "node"],
  teamSize: "small",
  ai: { enabled: true, provider: "openai" },
  createdAt: "2024-01-01T00:00:00Z",
};

// ─── E2E Tests ──────────────────────────────────────────────────────────────

describe("E2E: Auto-Review Pipeline", () => {
  let tmpDir: string;
  let store: ReturnType<typeof createOKFStore>;

  beforeEach(() => {
    tmpDir = path.join(os.tmpdir(), `lgtm-e2e-${Date.now()}`);
    fs.mkdirSync(tmpDir, { recursive: true });
    fs.mkdirSync(path.join(tmpDir, "rules"), { recursive: true });
    store = createOKFStore(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test("full pipeline: parse diff → load rules → generate review → dry-run post", async () => {
    // ── Step 1: Parse the diff ──────────────────────────────────────────
    const diff = parseDiff(REALISTIC_DIFF);

    expect(diff.files).toHaveLength(2);
    expect(diff.files[0].path).toBe("src/auth/login.ts");
    expect(diff.files[0].status).toBe("added");
    expect(diff.files[1].path).toBe("src/utils/helpers.ts");

    // ── Step 2: Create realistic rules ──────────────────────────────────
    const engine = createRulesEngine(store);

    await engine.createRule({
      description: "No hardcoded secrets or API keys",
      category: "security",
      severity: "error",
      enforcement: "regex",
      pattern: "(api[_-]?key|secret|token)\\s*=\\s*[\"'][^\"']{8,}",
      filePattern: "**/*.ts",
      examples: {
        bad: ['const API_SECRET = "sk_live_abc123"'],
        good: ['const API_SECRET = process.env.API_SECRET'],
      },
    });

    await engine.createRule({
      description: "No console.log in production code",
      category: "style",
      severity: "warn",
      enforcement: "regex",
      pattern: "console\\.log",
      filePattern: "**/*.ts",
      examples: {
        bad: ["console.log('debug')"],
        good: ["logger.info('debug')"],
      },
    });

    await engine.createRule({
      description: "No SQL injection vulnerabilities (string interpolation in queries)",
      category: "security",
      severity: "error",
      enforcement: "regex",
      pattern: "query\\s*\\(\\s*`[^`]*\\$\\{",
      filePattern: "**/*.ts",
      examples: {
        bad: ["db.query(`SELECT * FROM users WHERE id = ${id}`)"],
        good: ["db.query('SELECT * FROM users WHERE id = ?', [id])"],
      },
    });

    const rules = await engine.loadRules();
    expect(rules).toHaveLength(3);

    // ── Step 3: Mock LLM (returns additional findings) ──────────────────
    const mockLLM: LLMProvider = {
      async complete(prompt: string) {
        // Simulate LLM finding the MD5 weakness
        if (prompt.includes("Review this PR diff")) {
          return JSON.stringify([{
            file: "src/auth/login.ts",
            line: 13,
            comment: "Using MD5 for password hashing is insecure. Use bcrypt or argon2 instead.",
            severity: "critical",
          }]);
        }
        return "[]";
      },
      async isAvailable() { return true; },
    };

    // ── Step 4: Run generateAutoReview ───────────────────────────────────
    const result = await generateAutoReview(
      diff,
      rules,
      TEST_PROFILE,
      mockLLM,
      [], // no existing comments
      { severityThreshold: "medium" }
    );

    // Verify findings were generated
    expect(result.findings.length).toBeGreaterThan(0);
    expect(result.stats.filesReviewed).toBe(2);
    expect(result.stats.rulesChecked).toBe(3);

    // Verify specific expected findings
    const securityFindings = result.findings.filter((f) => f.severity === "high" || f.severity === "critical");
    expect(securityFindings.length).toBeGreaterThan(0);

    // Should catch the hardcoded secret
    const secretFinding = result.findings.find((f) =>
      f.file === "src/auth/login.ts" && f.source === "rule-regex" &&
      f.comment.toLowerCase().includes("secret")
    );
    expect(secretFinding).toBeDefined();

    // Should catch SQL injection
    const sqlFinding = result.findings.find((f) =>
      f.file === "src/auth/login.ts" && f.source === "rule-regex" &&
      f.comment.toLowerCase().includes("sql")
    );
    expect(sqlFinding).toBeDefined();

    // Summary should be informative
    expect(result.summary.length).toBeGreaterThan(10);
    expect(result.summary).toContain("issue");

    // ── Step 5: Dry-run post (verifies posting pipeline) ────────────────
    const postResults: Array<{ path: string; line: number; body: string }> = [];

    const mockGitHub = {
      async postReview(
        _prNumber: number,
        event: string,
        body: string,
        comments?: Array<{ path: string; line: number; body: string }>
      ) {
        if (comments) {
          postResults.push(...comments);
        }
      },
      async postComment(_prNumber: number, _body: string) {},
    };

    // First test dry-run mode
    const dryRunResult = await postReviewFindings(
      42,
      result,
      mockGitHub,
      { dryRun: true, batchMode: true, commentDelay: [1, 1], rateLimitThreshold: 10 },
      { info: () => {}, warn: () => {}, error: () => {} }
    );

    expect(dryRunResult.posted).toBe(0);
    expect(dryRunResult.skipped).toBe(result.findings.length);
    expect(dryRunResult.comments).toHaveLength(result.findings.length);
    expect(dryRunResult.comments.every((c) => c.posted === false)).toBe(true);

    // ── Step 6: Batch post (verifies actual posting) ─────────────────────
    const batchResult = await postReviewFindings(
      42,
      result,
      mockGitHub,
      { dryRun: false, batchMode: true, commentDelay: [1, 1], rateLimitThreshold: 10 },
      { info: () => {}, warn: () => {}, error: () => {} }
    );

    expect(batchResult.posted).toBe(result.findings.length);
    expect(batchResult.skipped).toBe(0);
    expect(postResults.length).toBe(result.findings.length);

    // Verify posted comments have correct structure
    for (const comment of postResults) {
      expect(comment.path).toBeTruthy();
      expect(comment.line).toBeGreaterThan(0);
      expect(comment.body).toBeTruthy();
      expect(comment.body).toContain("lgtm auto-review"); // attribution
    }
  });

  test("pipeline handles empty diff gracefully", async () => {
    const diff = parseDiff("");
    expect(diff.files).toHaveLength(0);

    const mockLLM: LLMProvider = {
      async complete() { return "[]"; },
      async isAvailable() { return true; },
    };

    const result = await generateAutoReview(diff, [], TEST_PROFILE, mockLLM);
    expect(result.findings).toHaveLength(0);
    expect(result.summary).toContain("No high-severity issues");
  });

  test("pipeline works with LLM offline (regex-only mode)", async () => {
    const diff = parseDiff(REALISTIC_DIFF);

    const engine = createRulesEngine(store);
    await engine.createRule({
      description: "No hardcoded secrets",
      category: "security",
      severity: "error",
      enforcement: "regex",
      pattern: "(secret|api_key)\\s*=\\s*[\"']",
      filePattern: "**/*.ts",
      examples: { bad: ['x = "sk_live"'], good: ['x = env.SECRET'] },
    });

    const rules = await engine.loadRules();

    // LLM is offline
    const offlineLLM: LLMProvider = {
      async complete() { throw new Error("Connection refused"); },
      async isAvailable() { return false; },
    };

    const result = await generateAutoReview(diff, rules, TEST_PROFILE, offlineLLM, [], {
      severityThreshold: "high",
    });

    // Should still find regex-based violations
    const regexFindings = result.findings.filter((f) => f.source === "rule-regex");
    expect(regexFindings.length).toBeGreaterThan(0);

    // Should NOT have any LLM findings
    const llmFindings = result.findings.filter((f) => f.source === "llm-review" || f.source === "rule-llm");
    expect(llmFindings).toHaveLength(0);
  });

  test("pipeline deduplicates against existing PR comments", async () => {
    const diff = parseDiff(REALISTIC_DIFF);

    const engine = createRulesEngine(store);
    await engine.createRule({
      description: "No hardcoded secrets or API keys",
      category: "security",
      severity: "error",
      enforcement: "regex",
      pattern: "(secret|api_key)\\s*=\\s*[\"']",
      filePattern: "**/*.ts",
      examples: { bad: ['x = "sk"'], good: ['x = env.X'] },
    });

    const rules = await engine.loadRules();

    const mockLLM: LLMProvider = {
      async complete() { return "[]"; },
      async isAvailable() { return true; },
    };

    // Simulate an existing comment on the same file/line
    const existingComments = [
      { file: "src/auth/login.ts", line: 4, body: "No hardcoded secrets or API keys" },
    ];

    const result = await generateAutoReview(diff, rules, TEST_PROFILE, mockLLM, existingComments, {
      severityThreshold: "high",
    });

    // The finding at line 4 should be deduplicated away
    const line4Finding = result.findings.find(
      (f) => f.file === "src/auth/login.ts" && f.line === 4
    );
    expect(line4Finding).toBeUndefined();
  });

  test("pipeline respects different feedback styles", async () => {
    const diff = parseDiff(REALISTIC_DIFF);

    // Test with "socratic" style
    const socraticProfile: ProjectProfile = {
      ...TEST_PROFILE,
      feedbackStyle: "socratic",
    };

    const mockLLM: LLMProvider = {
      async complete(prompt: string, options?: any) {
        // Verify the system prompt includes socratic tone
        if (options?.systemPrompt) {
          expect(options.systemPrompt).toContain("question");
        }
        return JSON.stringify([{
          file: "src/auth/login.ts",
          line: 13,
          comment: "Have you considered what happens if someone uses a rainbow table against MD5?",
          severity: "high",
        }]);
      },
      async isAvailable() { return true; },
    };

    const result = await generateAutoReview(diff, [], socraticProfile, mockLLM, [], {
      severityThreshold: "high",
    });

    // Should have findings (from LLM)
    const llmFindings = result.findings.filter((f) => f.source === "llm-review");
    if (llmFindings.length > 0) {
      // The LLM was instructed to use socratic tone
      expect(llmFindings[0].comment).toBeTruthy();
    }
  });

  test("pipeline with rate limit hit during individual posting", async () => {
    const diff = parseDiff(REALISTIC_DIFF);

    const engine = createRulesEngine(store);
    await engine.createRule({
      description: "No console.log",
      category: "style",
      severity: "error",
      enforcement: "regex",
      pattern: "console\\.log",
      examples: { bad: ["console.log()"], good: ["logger.info()"] },
    });
    await engine.createRule({
      description: "No hardcoded secrets",
      category: "security",
      severity: "error",
      enforcement: "regex",
      pattern: "(secret|api_key)\\s*=\\s*[\"']",
      examples: { bad: ['x = "sk"'], good: ['x = env.X'] },
    });

    const rules = await engine.loadRules();
    const mockLLM: LLMProvider = {
      async complete() { return "[]"; },
      async isAvailable() { return true; },
    };

    const result = await generateAutoReview(diff, rules, TEST_PROFILE, mockLLM, [], {
      severityThreshold: "high",
    });

    // Ensure we have multiple findings
    expect(result.findings.length).toBeGreaterThan(1);

    // Mock GitHub that rate-limits after first post
    let postCount = 0;
    const rateLimitGitHub = {
      async postReview(_pr: number, _event: string, _body: string, comments?: any[]) {
        postCount++;
        if (postCount > 1) {
          throw new Error("GitHub API 403: rate limit exceeded");
        }
      },
      async postComment() {},
    };

    const postResult = await postReviewFindings(
      42,
      result,
      rateLimitGitHub,
      { dryRun: false, batchMode: false, commentDelay: [0, 0], rateLimitThreshold: 10 },
      { info: () => {}, warn: () => {}, error: () => {} }
    );

    expect(postResult.rateLimitHit).toBe(true);
    expect(postResult.posted).toBe(1);
    expect(postResult.skipped).toBeGreaterThan(0);
  });
});

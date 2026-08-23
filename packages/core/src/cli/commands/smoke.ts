/**
 * `lgtm smoke` — Built-in smoke test / demo walkthrough.
 *
 * Runs through all major features non-interactively, verifying the tool works
 * end-to-end. Designed for:
 *   - CI environments (exit 0 = all pass, exit 1 = failure)
 *   - Agents/automation (structured output, no interactive prompts)
 *   - First-time users (--demo flag walks through features with explanations)
 *
 * Usage:
 *   lgtm smoke              # Run full smoke test (silent unless failure)
 *   lgtm smoke --demo       # Walk through with explanations
 *   lgtm smoke --verbose    # Show all output
 *   lgtm smoke --json       # Machine-readable output
 */

import { Command } from "commander";
import chalk from "chalk";
import fs from "fs";
import path from "path";
import os from "os";
import type { LGTMContext } from "../../plugin.js";

// Resolve the plugin review domain path relative to repo root
function reviewDomainPath(repoRoot: string, module: string): string {
  return path.join(repoRoot, "packages", "plugins", "review", "src", "domain", module);
}

interface SmokeResult {
  name: string;
  passed: boolean;
  duration: number;
  output?: string;
  error?: string;
}

interface SmokeOptions {
  demo?: boolean;
  verbose?: boolean;
  json?: boolean;
}

export function registerSmokeCommand(program: Command, ctx: LGTMContext): void {
  program
    .command("smoke")
    .description("Run smoke tests to verify LGTM works end-to-end (or --demo for guided tour)")
    .option("--demo", "Walk through features with explanations (great for first-time users)")
    .option("--verbose", "Show all output from each test")
    .option("--json", "Machine-readable JSON output")
    .action(async (opts: SmokeOptions) => {
      await runSmokeTests(ctx, opts);
    });
}

async function runSmokeTests(ctx: LGTMContext, opts: SmokeOptions): Promise<void> {
  const results: SmokeResult[] = [];
  const isDemo = opts.demo ?? false;
  const isVerbose = opts.verbose ?? isDemo;
  const isJson = opts.json ?? false;

  if (!isJson) {
    console.log(chalk.bold("\n👍 LGTM Smoke Test\n"));
    if (isDemo) {
      console.log(chalk.gray("  Running in demo mode — explaining each feature as we go.\n"));
      console.log(chalk.gray("  This is a non-interactive walkthrough. No prompts, no TUI.\n"));
    }
  } else {
    process.env.__LGTM_JSON = "1";
  }

  // ─── Test 1: Config Loading ────────────────────────────────────────────
  results.push(await runTest("Config Loading", isVerbose, isDemo, async () => {
    const { loadConfig, resolveLgtmDir, loadBootstrap } = await import("../../config/loader.js");
    const config = loadConfig();
    if (!config.plugins) throw new Error("No plugins in config");
    const dir = resolveLgtmDir(loadBootstrap());
    if (!dir) throw new Error("Could not resolve the store path");
    return `store=${dir}, plugins=${Object.keys(config.plugins).join(",")}`;
  }, "Resolves the central store location and merges config layers. Foundation for everything else."));

  // ─── Test 2: OKF Store ─────────────────────────────────────────────────
  const tempDir = path.join(os.tmpdir(), `lgtm-smoke-${Date.now()}`);
  fs.mkdirSync(tempDir, { recursive: true });

  results.push(await runTest("OKF Store (write/read)", isVerbose, isDemo, async () => {
    const { createOKFStore } = await import("../../store/okf.js");
    const store = createOKFStore(tempDir);
    await store.write("test-smoke.md", { title: "Smoke Test", timestamp: Date.now() }, "Hello from smoke test!");
    const doc = await store.read("test-smoke.md");
    if (!doc) throw new Error("Failed to read back written document");
    if (doc.data.title !== "Smoke Test") throw new Error(`Wrong title: ${doc.data.title}`);
    if (doc.content !== "Hello from smoke test!") throw new Error("Content mismatch");
    return `write → read round-trip OK (${tempDir}/test-smoke.md)`;
  }, "OKF (Open Knowledge Format) is LGTM's storage layer — YAML frontmatter + markdown body. Used for profiles, rules, reviews, etc."));

  // ─── Test 3: Git Utilities ─────────────────────────────────────────────
  results.push(await runTest("Git URL Parsing", isVerbose, isDemo, async () => {
    const { parseGitUrl } = await import("../../utils/git.js");
    const result = parseGitUrl("https://github.com/pszf11235/LGTM.git");
    if (!result) throw new Error("Failed to parse HTTPS git URL");
    if (result.owner !== "pszf11235") throw new Error(`Wrong owner: ${result.owner}`);
    if (result.repo !== "LGTM") throw new Error(`Wrong repo: ${result.repo}`);

    const ssh = parseGitUrl("git@github.com:user/repo.git");
    if (!ssh) throw new Error("Failed to parse SSH URL");
    return `HTTPS → ${result.owner}/${result.repo}, SSH → ${ssh.owner}/${ssh.repo}`;
  }, "Parses GitHub/GitLab URLs (HTTPS and SSH) to extract owner/repo. Used for multi-repo features."));

  // ─── Test 4: Tech Stack Detection ──────────────────────────────────────
  results.push(await runTest("Tech Stack Detection", isVerbose, isDemo, async () => {
    const { detectTechStack } = await import("../../onboarding/detect.js");
    const stack = await detectTechStack(ctx.repoRoot);
    if (stack.length === 0) throw new Error("No tech detected in current repo");
    return `Detected: ${stack.join(", ")}`;
  }, "Auto-detects technologies in a repo (TypeScript, React, Bun, Docker, etc.) from config files. Used during onboarding to pre-configure review rules."));

  // ─── Test 5: LLM Cache ─────────────────────────────────────────────────
  results.push(await runTest("LLM Cache", isVerbose, isDemo, async () => {
    const { createCache } = await import("../../llm/cache.js");
    const cache = createCache();
    cache.set("test-key", "test-value");
    const val = cache.get("test-key");
    if (val !== "test-value") throw new Error(`Cache miss: got ${val}`);
    cache.clear();
    if (cache.size() !== 0) throw new Error("Cache not cleared");
    return `set/get/clear OK, content-hash based`;
  }, "In-memory cache for LLM responses. Prevents redundant API calls when reviewing the same code."));

  // ─── Test 6: Diff Parser ───────────────────────────────────────────────
  results.push(await runTest("Diff Parser", isVerbose, isDemo, async () => {
    const mod = await import(reviewDomainPath(ctx.repoRoot, "diff-parser.ts"));
    const { parseDiff, getDiffStats } = mod;
    const sampleDiff = `diff --git a/src/auth.ts b/src/auth.ts
index abc1234..def5678 100644
--- a/src/auth.ts
+++ b/src/auth.ts
@@ -1,3 +1,5 @@
 import { hash } from "crypto";
 
+const API_KEY = "sk-12345678";
+
 export function login(user: string) {
-  return hash(user);
+  return hash(user + API_KEY);
 }`;
    const result = parseDiff(sampleDiff);
    const files = result.files ?? result;
    const fileList = Array.isArray(files) ? files : [];
    if (fileList.length !== 1) throw new Error(`Expected 1 file, got ${fileList.length}`);
    const stats = getDiffStats(result);
    if (stats.additions === 0) throw new Error("No additions detected");
    return `Parsed 1 file: +${stats.additions} -${stats.deletions}`;
  }, "Parses unified diffs into structured data (files, hunks, lines). Powers the diff viewer and auto-review."));

  // ─── Test 7: Rules Engine ──────────────────────────────────────────────
  results.push(await runTest("Rules Engine", isVerbose, isDemo, async () => {
    const { createRulesEngine } = await import(reviewDomainPath(ctx.repoRoot, "rules.ts"));
    const { createOKFStore } = await import("../../store/okf.js");
    const rulesDir = path.join(tempDir, "rules-test");
    fs.mkdirSync(rulesDir, { recursive: true });
    const store = createOKFStore(rulesDir);
    const engine = createRulesEngine(store);

    const rule = await engine.createRule({
      description: "No hardcoded secrets",
      pattern: '(api_key|secret)\\s*=\\s*"[^"]{8,}"',
      category: "security",
      severity: "error",
    });

    if (!rule.id) throw new Error("Rule not created");

    const rules = await engine.loadRules();
    if (rules.length !== 1) throw new Error(`Expected 1 rule, got ${rules.length}`);
    return `Created rule ${rule.id}: ${rule.description} (enforcement=${rule.enforcement})`;
  }, "Create and manage review rules. Supports regex (zero-cost) and LLM-powered enforcement."));

  // ─── Test 8: Review Queue ──────────────────────────────────────────────
  results.push(await runTest("Review Queue", isVerbose, isDemo, async () => {
    const { createQueueManager } = await import(reviewDomainPath(ctx.repoRoot, "queue.ts"));
    const { createOKFStore } = await import("../../store/okf.js");
    const queueDir = path.join(tempDir, "queue-test");
    fs.mkdirSync(queueDir, { recursive: true });
    const store = createOKFStore(queueDir);
    const queue = createQueueManager(store);

    await queue.addToQueue([
      { number: 42, title: "Smoke Test PR", filesChanged: ["src/auth.ts", "src/login.ts"], source: "local" as const },
      { number: 43, title: "Another PR", filesChanged: ["src/api.ts"], source: "local" as const },
    ]);

    const session = await queue.getQueue();
    if (session.prs.length !== 2) throw new Error(`Expected 2 PRs, got ${session.prs.length}`);

    await queue.updateState(42, "reviewing");
    await queue.updateState(42, "approved");
    await queue.updateState(43, "reviewing");
    await queue.updateState(43, "flagged", "Needs refactor");

    const updated = await queue.getQueue();
    const pr42 = updated.prs.find((p: any) => p.number === 42);
    const pr43 = updated.prs.find((p: any) => p.number === 43);
    if (pr42?.state !== "approved") throw new Error(`PR 42 should be approved, got ${pr42?.state}`);
    if (pr43?.state !== "flagged") throw new Error(`PR 43 should be flagged, got ${pr43?.state}`);
    return `add(2) → approve(42) → flag(43) — state machine OK`;
  }, "Tracks PRs through states: queued → reviewing → approved/flagged. Persists to disk."));

  // ─── Test 9: PR Grouping ───────────────────────────────────────────────
  results.push(await runTest("PR Grouping & Overlap", isVerbose, isDemo, async () => {
    const { analyzeGroups } = await import(reviewDomainPath(ctx.repoRoot, "grouping.ts"));
    const { detectOverlaps } = await import(reviewDomainPath(ctx.repoRoot, "overlap.ts"));

    const prs = [
      { number: 1, title: "Auth login", state: "queued" as const, addedAt: new Date().toISOString(), filesChanged: ["src/auth/login.ts", "src/auth/session.ts"], source: "local" as const },
      { number: 2, title: "Auth logout", state: "queued" as const, addedAt: new Date().toISOString(), filesChanged: ["src/auth/login.ts", "src/auth/logout.ts"], source: "local" as const },
      { number: 3, title: "API routes", state: "queued" as const, addedAt: new Date().toISOString(), filesChanged: ["src/api/routes.ts"], source: "local" as const },
    ];

    const groups = analyzeGroups(prs);
    const overlaps = detectOverlaps(prs);

    if (overlaps.length === 0) throw new Error("Should detect overlap between PR 1 and 2");
    return `Groups: ${groups.length}, Overlaps: ${overlaps.length} (PRs 1&2 share src/auth/login.ts)`;
  }, "Detects when PRs touch the same files and suggests review order. Prevents merge conflicts."));

  // ─── Test 10: Auto-Review Engine ───────────────────────────────────────
  results.push(await runTest("Auto-Review Engine (regex)", isVerbose, isDemo, async () => {
    const { generateAutoReview } = await import(reviewDomainPath(ctx.repoRoot, "auto-review.ts"));
    const { parseDiff } = await import(reviewDomainPath(ctx.repoRoot, "diff-parser.ts"));

    const diff = parseDiff(`diff --git a/src/main.ts b/src/main.ts
--- a/src/main.ts
+++ b/src/main.ts
@@ -1,2 +1,4 @@
+const secret = "sk-abcdefgh12345678";
+console.log("debug output");
 export function main() {}`);

    const rules = [
      { id: "r1", description: "No secrets", pattern: '(secret)\\s*=\\s*"[^"]{8,}"', category: "security", severity: "error", enforcement: "regex", enabled: true, examples: { bad: ['const secret = "sk-12345678"'], good: ['const secret = process.env.SECRET'] } },
      { id: "r2", description: "No console.log", pattern: 'console\\.log', category: "style", severity: "warn", enforcement: "regex", enabled: true, examples: { bad: ['console.log("x")'], good: ['logger.info("x")'] } },
    ];

    // generateAutoReview(diff, rules, profile, llm, existingComments, config)
    // Use a stub LLM that reports unavailable (regex-only mode)
    const stubLlm = { isAvailable: async () => false, generate: async () => "" };
    const result = await generateAutoReview(diff, rules, null, stubLlm as any, []);

    if (!result || result.findings.length === 0) throw new Error("Should find violations");
    return `Found ${result.findings.length} violation(s): ${result.findings.map((f: any) => f.ruleId || f.rule).join(", ")}`;
  }, "The core auto-review engine: applies rules to diffs and generates findings. Works offline with regex rules, or with LLM for complex checks."));

  // ─── Test 11: Review Worker Process Boundary ───────────────────────────
  results.push(await runTest("Review Worker (subprocess)", isVerbose, isDemo, async () => {
    const { selfCommand, childEnv, isCompiledBinary } = await import("../self.js");

    // The orchestrator runs each review agent in its own process by re-invoking
    // this program. That resolution differs between source and the compiled
    // binary, and a mistake there breaks reviews only in the shipped artefact.
    // So this spawns a real worker and requires a real JSON result back.
    const job = {
      mode: "review",
      agent: {
        name: "smoke",
        provider: "auto",
        model: null,
        severity: "high",
        timeout: 10,
        commentDelay: [0, 0],
        enabled: true,
        prompt: "smoke test",
        sourcePath: "<smoke>",
      },
      diff: "--- a/x\n+++ b/x\n",
    };

    const proc = Bun.spawnSync({
      cmd: selfCommand(["review", "internal-worker"]),
      stdin: new TextEncoder().encode(JSON.stringify(job)),
      stdout: "pipe",
      stderr: "pipe",
      env: childEnv(),
    });

    const stdout = proc.stdout.toString().trim();
    if (!stdout) {
      const err = proc.stderr.toString().trim().split("\n").slice(-2).join(" ");
      throw new Error(`worker wrote nothing to stdout${err ? `: ${err}` : ""}`);
    }

    // stdout must be the result and nothing else, or the orchestrator cannot
    // parse it. Any stray banner or log line would fail here.
    let parsed: { findings?: unknown; error?: string | null };
    try {
      parsed = JSON.parse(stdout);
    } catch {
      throw new Error(`worker stdout was not pure JSON: ${stdout.slice(0, 120)}`);
    }

    if (!Array.isArray(parsed.findings)) {
      throw new Error("worker result has no findings array");
    }

    // With no provider installed the worker correctly reports that. Either
    // outcome proves the process boundary works; only a crash is a failure.
    const verdict = parsed.error ? `reported "${parsed.error.slice(0, 40)}..."` : "returned findings";
    return `${isCompiledBinary() ? "compiled binary" : "source"} → worker ${verdict}`;
  }, "Each review agent runs in its own process, so two reviewers run in parallel and a hung CLI can be killed. This checks the process boundary itself."));

  // ─── Test 12: Binary Build (if dist/lgtm exists) ───────────────────────
  const binaryPath = path.join(ctx.repoRoot, "dist", "lgtm");
  if (fs.existsSync(binaryPath)) {
    results.push(await runTest("Binary Executable", isVerbose, isDemo, async () => {
      const proc = Bun.spawnSync([binaryPath, "--version"]);
      const output = proc.stdout.toString().trim();
      if (proc.exitCode !== 0) throw new Error(`Binary exited with code ${proc.exitCode}`);
      if (!output) throw new Error("No version output");
      return `dist/lgtm --version → ${output}`;
    }, "Standalone binary (bun build --compile). Runs without Bun/Node installed. ~50-80MB."));
  }

  // ─── Cleanup ───────────────────────────────────────────────────────────
  try {
    fs.rmSync(tempDir, { recursive: true });
  } catch { /* ignore */ }

  // ─── Results ───────────────────────────────────────────────────────────
  const passed = results.filter((r) => r.passed).length;
  const failed = results.filter((r) => !r.passed).length;
  const totalMs = results.reduce((sum, r) => sum + r.duration, 0);

  if (isJson) {
    console.log(JSON.stringify({ passed, failed, total: results.length, duration: totalMs, results }, null, 2));
  } else {
    console.log(chalk.gray("\n  ─────────────────────────────────────────────────────────"));
    console.log(`  ${chalk.bold("Results:")} ${chalk.green(`${passed} passed`)}${failed > 0 ? `, ${chalk.red(`${failed} failed`)}` : ""} (${totalMs}ms)\n`);

    if (failed > 0) {
      console.log(chalk.red("  Failed tests:"));
      for (const r of results.filter((r) => !r.passed)) {
        console.log(chalk.red(`    ✗ ${r.name}: ${r.error}`));
      }
      console.log();
    }

    if (isDemo && failed === 0) {
      console.log(chalk.bold("  🎉 All smoke tests passed! LGTM is working correctly.\n"));
      console.log(chalk.gray("  Next steps:"));
      console.log(chalk.gray("    • Run `lgtm init` to set up your project"));
      console.log(chalk.gray("    • Run `lgtm review add <PR#> --demo` to try the review queue"));
      console.log(chalk.gray("    • Run `lgtm review rule add \"...\" --pattern '...'` to create rules"));
      console.log(chalk.gray("    • Run `lgtm` to open the TUI"));
      console.log(chalk.gray("    • See TESTING.md for the full feature walkthrough\n"));
    }
  }

  if (failed > 0) {
    process.exit(1);
  }
}

async function runTest(
  name: string,
  verbose: boolean,
  demo: boolean,
  fn: () => Promise<string>,
  explanation?: string
): Promise<SmokeResult> {
  const start = Date.now();

  if (demo && explanation) {
    console.log(chalk.cyan(`  ┌─ ${name}`));
    console.log(chalk.gray(`  │  ${explanation}`));
  }

  try {
    const output = await fn();
    const duration = Date.now() - start;

    if (verbose || demo) {
      console.log(`  ${chalk.green("✓")} ${chalk.bold(name)} ${chalk.gray(`(${duration}ms)`)}`);
      if (output && verbose) {
        console.log(chalk.gray(`    → ${output}`));
      }
    } else if (!process.env.__LGTM_JSON) {
      process.stdout.write(chalk.green("."));
    }

    if (demo) console.log();

    return { name, passed: true, duration, output };
  } catch (err: any) {
    const duration = Date.now() - start;
    const errorMsg = err.message ?? String(err);

    if (verbose || demo) {
      console.log(`  ${chalk.red("✗")} ${chalk.bold(name)} ${chalk.gray(`(${duration}ms)`)}`);
      console.log(chalk.red(`    → ${errorMsg}`));
    } else if (!process.env.__LGTM_JSON) {
      process.stdout.write(chalk.red("✗"));
    }

    if (demo) console.log();

    return { name, passed: false, duration, error: errorMsg };
  }
}

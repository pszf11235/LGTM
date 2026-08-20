/**
 * `lgtm review auto` — AI-powered automated PR review.
 *
 * Fetches a PR diff from GitHub, runs rule enforcement + LLM review,
 * and posts structured findings as inline comments.
 *
 * Usage:
 *   lgtm review auto --pr 42              (review PR #42 in current repo)
 *   lgtm review auto --repo owner/repo --pr 42
 *   lgtm review auto --pr 42 --dry-run    (show findings without posting)
 *   lgtm review auto --pr 42 --severity critical
 *
 * @module commands/auto
 */

import type { Command } from "commander";
import type { LGTMContext } from "@lgtm/core/plugin.js";
import chalk from "chalk";

interface AutoOptions {
  repo?: string;
  pr?: string;
  dryRun?: boolean;
  severity?: string;
  batch?: boolean;
}

/**
 * Register the `lgtm review auto` command.
 */
export function registerAutoCommand(program: Command, ctx: LGTMContext) {
  program
    .command("auto")
    .description("AI-powered PR review — analyze diff and post findings to GitHub")
    .option("--repo <owner/repo>", "Target repository (default: current repo from git remote)")
    .option("--pr <number>", "PR number to review (required)")
    .option("--dry-run", "Show findings without posting to GitHub")
    .option("--severity <level>", "Minimum severity threshold: low, medium, high, critical", "high")
    .option("--no-batch", "Post comments individually with delays instead of batched review")
    .action(async (opts: AutoOptions) => {
      await runAutoReview(ctx, opts);
    });
}

/**
 * Main execution flow for `lgtm review auto`.
 */
async function runAutoReview(ctx: LGTMContext, opts: AutoOptions) {
  // ── Validate inputs ────────────────────────────────────────────────────

  if (!opts.pr) {
    ctx.logger.error("--pr <number> is required. Specify which PR to review.");
    console.log(chalk.gray(`\n  Example: ${chalk.cyan("lgtm review auto --pr 42")}\n`));
    return;
  }

  const prNumber = parseInt(opts.pr, 10);
  if (isNaN(prNumber) || prNumber <= 0) {
    ctx.logger.error(`Invalid PR number: ${opts.pr}`);
    return;
  }

  // ── Resolve repo ───────────────────────────────────────────────────────

  let owner: string;
  let repo: string;

  if (opts.repo) {
    const parts = opts.repo.split("/");
    if (parts.length !== 2) {
      ctx.logger.error(`Invalid repo format: ${opts.repo}. Expected: owner/repo`);
      return;
    }
    [owner, repo] = parts;
  } else {
    // Auto-detect from git remote
    const resolved = await detectRepoFromRemote(ctx.repoRoot);
    if (!resolved) {
      ctx.logger.error("Could not detect repo from git remote. Use --repo owner/repo.");
      return;
    }
    [owner, repo] = resolved;
  }

  // ── Check AI availability ──────────────────────────────────────────────

  if (!ctx.llm) {
    ctx.logger.error("AI is not configured. Run `lgtm ai test` to set up.");
    return;
  }

  const aiAvailable = await ctx.llm.isAvailable();
  if (!aiAvailable) {
    ctx.logger.error("AI provider is not reachable. Check your API key and connection.");
    console.log(chalk.gray(`  Run ${chalk.cyan("lgtm ai test")} to diagnose.`));
    return;
  }

  // ── Resolve LLM provider for review_delegation task ────────────────────

  let llm = ctx.llm;
  try {
    const { getProviderForTask } = await import("@lgtm/core/llm/provider.js");
    llm = getProviderForTask(ctx.config.ai as any, "review_delegation");
  } catch {
    // Fallback to default provider
  }

  // ── Load config overrides for ai_review ────────────────────────────────

  const reviewConfig = await loadAutoReviewConfig(ctx);

  // ── Start review ───────────────────────────────────────────────────────

  console.log(chalk.bold(`\n🤖 LGTM Auto-Review: ${owner}/${repo}#${prNumber}\n`));
  console.log(chalk.gray(`  Severity threshold: ${opts.severity ?? "high"}`));
  console.log(chalk.gray(`  Mode: ${opts.dryRun ? "dry-run (no posting)" : opts.batch === false ? "individual (with delays)" : "batched review"}`));
  console.log("");

  // ── Step 1: Fetch PR diff ──────────────────────────────────────────────

  console.log(chalk.gray("  Fetching PR diff..."));

  const { createGitHubAdapter } = await import("../infra/github.js");
  const github = createGitHubAdapter(owner, repo);

  let rawDiff: string;
  let prTitle: string;
  try {
    const pr = await github.fetchPR(prNumber);
    prTitle = pr.title;
    rawDiff = await github.fetchDiff(prNumber);
    console.log(chalk.green(`  ✓ PR: "${prTitle}" (${pr.additions}+ ${pr.deletions}- across ${pr.changedFiles} files)`));
  } catch (err) {
    ctx.logger.error(`Failed to fetch PR: ${(err as Error).message}`);
    return;
  }

  if (!rawDiff || rawDiff.trim().length === 0) {
    console.log(chalk.yellow("\n  ⚠ PR has no diff (empty or already merged)."));
    return;
  }

  // ── Step 2: Parse diff ─────────────────────────────────────────────────

  const { parseDiff } = await import("../domain/diff-parser.js");
  const diff = parseDiff(rawDiff);

  if (diff.files.length === 0) {
    console.log(chalk.yellow("\n  ⚠ No parseable files in diff."));
    return;
  }

  // ── Step 3: Load rules ─────────────────────────────────────────────────

  console.log(chalk.gray("  Loading rules..."));

  const { createRulesEngine } = await import("../domain/rules.js");
  const engine = createRulesEngine(ctx.store);
  const rules = await engine.loadRules();
  const enabledRules = rules.filter((r) => r.enabled);

  console.log(chalk.gray(`  ${enabledRules.length} rule(s) loaded (${rules.length - enabledRules.length} disabled)`));

  // ── Step 4: Fetch existing comments for dedup ──────────────────────────

  console.log(chalk.gray("  Checking existing comments..."));

  const { fetchExistingComments } = await import("../domain/post-review.js");
  const existingComments = await fetchExistingComments(prNumber, owner, repo);
  if (existingComments.length > 0) {
    console.log(chalk.gray(`  ${existingComments.length} existing comment(s) found (will deduplicate)`));
  }

  // ── Step 5: Run auto-review engine ─────────────────────────────────────

  console.log(chalk.gray("  Running AI review..."));
  console.log("");

  const { generateAutoReview } = await import("../domain/auto-review.js");

  const severityThreshold = validateSeverity(opts.severity ?? "high");

  const result = await generateAutoReview(
    diff,
    enabledRules,
    ctx.profile,
    llm,
    existingComments.map((c) => ({ file: c.file, line: c.line, body: c.body })),
    {
      severityThreshold,
      formatting: reviewConfig.formatting,
    }
  );

  // ── Step 6: Report findings ────────────────────────────────────────────

  console.log(chalk.bold(`  ${result.summary}`));
  console.log(chalk.gray(`  Stats: ${result.stats.filesReviewed} files, ${result.stats.rulesChecked} rules, ~${result.stats.llmTokensEstimated} tokens estimated`));
  console.log("");

  if (result.findings.length === 0) {
    console.log(chalk.green("  ✓ No high-severity issues found. PR looks good!\n"));
    return;
  }

  // ── Step 7: Post findings ──────────────────────────────────────────────

  const { postReviewFindings } = await import("../domain/post-review.js");

  const postResult = await postReviewFindings(
    prNumber,
    result,
    github,
    {
      dryRun: opts.dryRun ?? false,
      batchMode: opts.batch !== false,
      commentDelay: reviewConfig.commentDelay,
      rateLimitThreshold: reviewConfig.rateLimitThreshold,
    },
    {
      info: (msg) => console.log(chalk.gray(`  ${msg}`)),
      warn: (msg) => console.log(chalk.yellow(`  ${msg}`)),
      error: (msg) => console.log(chalk.red(`  ${msg}`)),
    }
  );

  // ── Summary ────────────────────────────────────────────────────────────

  console.log("");
  if (postResult.rateLimitHit) {
    console.log(chalk.yellow(`  ⚠ Rate limit hit. ${postResult.skipped} comment(s) were not posted.`));
    console.log(chalk.gray(`  Re-run later to post remaining comments.`));
  }

  if (opts.dryRun) {
    console.log(chalk.cyan(`  ℹ This was a dry run. Add ${chalk.bold("--no-dry-run")} to post comments.\n`));
  } else if (postResult.posted > 0) {
    console.log(chalk.green(`  ✓ Done. ${postResult.posted} comment(s) posted to PR #${prNumber}.\n`));
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Detect owner/repo from the current git remote.
 */
async function detectRepoFromRemote(repoRoot: string): Promise<[string, string] | null> {
  try {
    const { execSync } = require("child_process");
    const remote = execSync("git remote get-url origin", {
      cwd: repoRoot,
      encoding: "utf-8",
    }).trim();

    // Handle HTTPS: https://github.com/owner/repo.git
    const httpsMatch = remote.match(/github\.com[/:]([^/]+)\/([^/.]+?)(?:\.git)?$/);
    if (httpsMatch) {
      return [httpsMatch[1], httpsMatch[2]];
    }

    // Handle SSH: git@github.com:owner/repo.git
    const sshMatch = remote.match(/git@github\.com:([^/]+)\/([^/.]+?)(?:\.git)?$/);
    if (sshMatch) {
      return [sshMatch[1], sshMatch[2]];
    }

    return null;
  } catch {
    return null;
  }
}

/**
 * Load auto-review config from .lgtmrc.yaml (repo root) or OKF store fallback.
 *
 * Resolution order:
 * 1. .lgtmrc.yaml in repo root (review.ai_review section)
 * 2. .lgtm/config.yaml in OKF store (legacy)
 * 3. Built-in defaults
 */
async function loadAutoReviewConfig(ctx: LGTMContext): Promise<{
  commentDelay: [number, number];
  rateLimitThreshold: number;
  formatting: {
    noEmDashes: boolean;
    noSemicolons: boolean;
    noSeverityLabels: boolean;
  };
}> {
  // Try .lgtmrc.yaml in repo root first (the documented config location)
  try {
    const fs = require("fs");
    const path = require("path");
    const { parse: parseYaml } = require("yaml");

    const candidates = [
      path.join(ctx.repoRoot, ".lgtmrc.yaml"),
      path.join(ctx.repoRoot, ".lgtmrc.yml"),
    ];

    for (const filePath of candidates) {
      try {
        const raw = fs.readFileSync(filePath, "utf-8");
        const parsed = parseYaml(raw);
        const aiReview = parsed?.review?.ai_review;
        if (aiReview) {
          return {
            commentDelay: Array.isArray(aiReview.comment_delay)
              ? [aiReview.comment_delay[0] ?? 20, aiReview.comment_delay[1] ?? 90]
              : [20, 90],
            rateLimitThreshold: aiReview.rate_limit_threshold ?? 10,
            formatting: {
              noEmDashes: aiReview.formatting?.no_em_dashes ?? true,
              noSemicolons: aiReview.formatting?.no_semicolons ?? true,
              noSeverityLabels: aiReview.formatting?.no_severity_labels ?? true,
            },
          };
        }
      } catch { continue; }
    }
  } catch { /* no yaml parser or no file */ }

  // Fallback: try OKF store config.yaml (legacy path)
  try {
    const configDoc = await ctx.store.read("config.yaml");
    if (configDoc?.data?.review) {
      const reviewCfg = configDoc.data.review as any;
      const aiReview = reviewCfg?.ai_review;
      if (aiReview) {
        return {
          commentDelay: Array.isArray(aiReview.comment_delay)
            ? [aiReview.comment_delay[0] ?? 20, aiReview.comment_delay[1] ?? 90]
            : [20, 90],
          rateLimitThreshold: aiReview.rate_limit_threshold ?? 10,
          formatting: {
            noEmDashes: aiReview.formatting?.no_em_dashes ?? true,
            noSemicolons: aiReview.formatting?.no_semicolons ?? true,
            noSeverityLabels: aiReview.formatting?.no_severity_labels ?? true,
          },
        };
      }
    }
  } catch { /* fallback to defaults */ }

  return {
    commentDelay: [20, 90],
    rateLimitThreshold: 10,
    formatting: {
      noEmDashes: true,
      noSemicolons: true,
      noSeverityLabels: true,
    },
  };
}

/**
 * Validate and normalize severity string from CLI input.
 */
function validateSeverity(s: string): "low" | "medium" | "high" | "critical" {
  const lower = s.toLowerCase();
  if (lower === "critical" || lower === "high" || lower === "medium" || lower === "low") {
    return lower;
  }
  return "high";
}

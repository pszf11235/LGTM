/**
 * `yak review add <prs...>` — Add PRs to the review queue.
 *
 * Fetches metadata (title, changed files) from git, computes feature groups,
 * and persists to the session index. No LLM needed.
 *
 * Validates that PRs exist (branch found in git or GitHub).
 * Use --demo to bypass validation for testing.
 */

import type { Command } from "commander";
import type { YakContext } from "@yak/core/plugin.js";
import { createQueueManager } from "../domain/queue.js";
import chalk from "chalk";

export function registerAddCommand(program: Command, ctx: YakContext) {
  program
    .command("add <prs...>")
    .description("Add PR(s) to the review queue")
    .option("-b, --branch", "Treat arguments as branch names instead of PR numbers")
    .option("--demo", "Demo/test mode — skip PR validation, use mock data")
    .action(async (prs: string[], opts: { branch?: boolean; demo?: boolean }) => {
      // Git adapter import (from core package)
      const { createGitAdapter } = await import("@yak/core/utils/git.js");
      const git = createGitAdapter(ctx.repoRoot);

      const isRepo = await git.isGitRepo();

      if (!isRepo && !opts.demo) {
        ctx.logger.error("Not in a git repository. Run from a repo root.");
        ctx.logger.info("Use --demo to add mock PRs for testing.");
        return;
      }

      const queue = createQueueManager(ctx.store);

      // Build PR metadata
      const prEntries: Array<{
        number: number;
        title: string;
        filesChanged: string[];
        source: "github" | "local";
      }> = [];

      for (const pr of prs) {
        const prNumber = parseInt(pr, 10);
        if (isNaN(prNumber) && !opts.branch) {
          ctx.logger.warn(`Skipping '${pr}' — not a valid PR number. Use --branch for branch names.`);
          continue;
        }

        // Demo mode: create mock PR data
        if (opts.demo) {
          prEntries.push({
            number: opts.branch ? prs.indexOf(pr) + 1 : prNumber,
            title: opts.branch ? pr : `Demo PR #${prNumber}`,
            filesChanged: generateDemoFiles(prNumber),
            source: "local",
          });
          continue;
        }

        // Real mode: validate PR exists
        const branchName = opts.branch ? pr : await findPRBranch(git, prNumber);
        let filesChanged: string[] = [];
        let title = opts.branch ? pr : `PR #${prNumber}`;

        if (!branchName) {
          ctx.logger.warn(
            `PR #${prNumber} — branch not found locally. ` +
            `Fetch it with 'git fetch origin pull/${prNumber}/head:pr-${prNumber}' ` +
            `or use --demo for testing.`
          );
          continue;
        }

        try {
          filesChanged = await git.getChangedFiles(branchName);
          if (filesChanged.length === 0) {
            ctx.logger.warn(`PR #${prNumber} (${branchName}) — no changes detected against main.`);
          }
        } catch (err) {
          ctx.logger.warn(`PR #${prNumber} (${branchName}) — could not get diff: ${(err as Error).message}`);
          continue;
        }

        prEntries.push({
          number: opts.branch ? prs.indexOf(pr) + 1 : prNumber,
          title,
          filesChanged,
          source: "local",
        });
      }

      if (prEntries.length === 0) {
        ctx.logger.error("No valid PRs to add. Use --demo to add mock PRs for testing.");
        return;
      }

      // Add to queue (auto-groups)
      const session = await queue.addToQueue(prEntries);

      // Print results
      const modeLabel = opts.demo ? chalk.gray(" [demo mode]") : "";
      console.log(chalk.bold(`\n🦬 Added ${prEntries.length} PR(s) to review queue${modeLabel}\n`));

      for (const pr of prEntries) {
        const queued = session.prs.find((p) => p.number === pr.number);
        const group = queued?.featureGroup
          ? chalk.gray(` [${queued.featureGroup}]`)
          : "";
        console.log(`  ${chalk.green("+")} #${pr.number}: ${pr.title} (${pr.filesChanged.length} files)${group}`);
      }

      // Show groups if any
      if (session.featureGroups.length > 0) {
        console.log(chalk.bold("\n  Feature Groups:"));
        for (const group of session.featureGroups) {
          console.log(
            `  ${chalk.cyan("⚡")} ${group.label} — PRs ${group.prs.map((n) => `#${n}`).join(", ")}`
          );
          console.log(chalk.gray(`     ${group.reason}`));
        }
      }

      console.log(
        chalk.gray(`\n  Run ${chalk.cyan("yak review status")} to see the full queue.\n`)
      );
    });
}

/**
 * Try to find a local branch for a PR number.
 * Checks: pr-<N>, pr/<N>, feature branches with PR number in name.
 */
async function findPRBranch(
  git: { getBranches: () => Promise<{ all: string[] }> },
  prNumber: number
): Promise<string | null> {
  try {
    const { all } = await git.getBranches();

    // Try common PR branch patterns
    const candidates = [
      `pr-${prNumber}`,
      `pr/${prNumber}`,
      `pull/${prNumber}`,
    ];

    for (const candidate of candidates) {
      if (all.includes(candidate)) return candidate;
    }

    // Also check if any branch contains the PR number (e.g., feat/issue-101)
    // This is a weaker heuristic — skip for now to avoid false matches
    return null;
  } catch {
    return null;
  }
}

/**
 * Generate demo file paths for testing.
 * Creates realistic-looking file paths based on PR number.
 */
function generateDemoFiles(prNumber: number): string[] {
  const groups = [
    ["src/auth/login.ts", "src/auth/register.ts", "src/auth/middleware.ts"],
    ["src/api/routes/users.ts", "src/api/routes/auth.ts", "src/api/middleware/rate-limit.ts"],
    ["src/db/migrations/001.ts", "src/db/models/user.ts"],
    ["src/utils/helpers.ts", "src/utils/validation.ts", "tests/utils.test.ts"],
    ["src/config/app.ts", "src/config/database.ts", ".env.example"],
  ];

  // Use PR number to pick a consistent set
  const idx = (prNumber - 1) % groups.length;
  return groups[idx];
}

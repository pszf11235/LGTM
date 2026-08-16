/**
 * `yak review add <prs...>` — Add PRs to the review queue.
 *
 * Fetches metadata (title, changed files) from git, computes feature groups,
 * and persists to the session index. No LLM needed.
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
    .action(async (prs: string[], opts: { branch?: boolean }) => {
      // Git adapter import (from core package)
      const { createGitAdapter } = await import("@yak/core/utils/git.js");
      const git = createGitAdapter(ctx.repoRoot);

      if (!(await git.isGitRepo())) {
        ctx.logger.error("Not in a git repository. Run from a repo root.");
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

        const branchName = opts.branch ? pr : `pr-${prNumber}`;
        let filesChanged: string[] = [];
        let title = opts.branch ? pr : `PR #${prNumber}`;

        try {
          // Try to get changed files from git
          filesChanged = await git.getChangedFiles(branchName);
        } catch {
          // If branch doesn't exist locally, use the PR number as identifier
          // Full GitHub integration (fetching from API) comes in Task 17
          ctx.logger.debug(`Branch '${branchName}' not found locally. Using PR number only.`);
          filesChanged = [];
        }

        prEntries.push({
          number: opts.branch ? prs.indexOf(pr) + 1 : prNumber,
          title,
          filesChanged,
          source: "local",
        });
      }

      if (prEntries.length === 0) {
        ctx.logger.error("No valid PRs to add.");
        return;
      }

      // Add to queue (auto-groups)
      const session = await queue.addToQueue(prEntries);

      // Print results
      console.log(chalk.bold(`\n🦬 Added ${prEntries.length} PR(s) to review queue\n`));

      for (const pr of prEntries) {
        const queued = session.prs.find((p) => p.number === pr.number);
        const group = queued?.featureGroup
          ? chalk.gray(` [${queued.featureGroup}]`)
          : "";
        console.log(`  ${chalk.green("+")} #${pr.number}: ${pr.title}${group}`);
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

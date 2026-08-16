/**
 * @yak/plugin-review
 *
 * PR Review Harness plugin for Yak.
 * Provides structured code review workflow with rules, grouping, and TUI.
 */

import type { Command } from "commander";
import type { YakPlugin, YakContext } from "@yak/core/plugin.js";

/**
 * Review plugin — implements the YakPlugin interface.
 *
 * Commands will be fleshed out in Task 7. For now, they're
 * placeholders that demonstrate the plugin system works.
 */
export const plugin: YakPlugin = {
  name: "review",
  description: "PR review harness — structured code review with rules and grouping",
  version: "0.1.0",

  registerCommands(program: Command, ctx: YakContext): void {
    program
      .command("add <prs...>")
      .description("Add PR(s) to the review queue")
      .action((prs: string[]) => {
        ctx.logger.info(`Would queue PRs: ${prs.join(", ")} (full impl in Task 7)`);
      });

    program
      .command("status")
      .description("Show review queue status with feature groups")
      .action(() => {
        ctx.logger.info("Queue status coming in Task 7!");
      });

    program
      .command("approve <pr>")
      .description("Approve a reviewed PR")
      .action((pr: string) => {
        ctx.logger.info(`Would approve PR #${pr} (full impl in Task 7)`);
      });

    program
      .command("flag <pr>")
      .description("Flag a PR with issues")
      .option("-r, --reason <reason>", "Reason for flagging")
      .action((pr: string, opts: { reason?: string }) => {
        ctx.logger.info(
          `Would flag PR #${pr}: ${opts.reason ?? "(no reason)"} (full impl in Task 7)`
        );
      });

    program
      .command("rule <action>")
      .description("Manage review rules (add/list/export/suggest)")
      .action((action: string) => {
        ctx.logger.info(`Rule '${action}' coming in Task 11!`);
      });

    program
      .command("scan")
      .description("Run all rules against the entire repo")
      .action(() => {
        ctx.logger.info("Repo-wide scan coming in Task 13!");
      });

    program
      .command("history")
      .description("Search past review sessions")
      .option("-s, --search <query>", "Search by keyword")
      .option("-p, --pr <number>", "Filter by PR number")
      .action((opts: { search?: string; pr?: string }) => {
        ctx.logger.info(
          `History search coming in Task 18! (query: ${opts.search ?? opts.pr ?? "all"})`
        );
      });
  },
};

// Also export as default for flexible import patterns
export default plugin;

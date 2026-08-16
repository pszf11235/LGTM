/**
 * @yak/plugin-review
 *
 * PR Review Harness plugin for Yak.
 * Provides structured code review workflow with rules, grouping, and TUI.
 */

import type { Command } from "commander";
import type { YakPlugin, YakContext } from "@yak/core/plugin.js";
import { registerAddCommand } from "./commands/add.js";
import { registerStatusCommand } from "./commands/status.js";
import { registerApproveCommand } from "./commands/approve.js";
import { registerFlagCommand } from "./commands/flag.js";
import { registerRuleCommand } from "./commands/rule.js";
import { registerScanCommand } from "./commands/scan.js";

/**
 * Review plugin — implements the YakPlugin interface.
 */
export const plugin: YakPlugin = {
  name: "review",
  description: "PR review harness — structured code review with rules and grouping",
  version: "0.1.0",

  registerCommands(program: Command, ctx: YakContext): void {
    // Real commands (implemented)
    registerAddCommand(program, ctx);
    registerStatusCommand(program, ctx);
    registerApproveCommand(program, ctx);
    registerFlagCommand(program, ctx);
    registerRuleCommand(program, ctx);
    registerScanCommand(program, ctx);

    // Placeholder commands (future tasks)
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

export default plugin;

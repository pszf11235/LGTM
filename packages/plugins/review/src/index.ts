/**
 * @lgtm/plugin-review
 *
 * PR Review Harness plugin for Yak.
 * Provides structured code review workflow with rules, grouping, and TUI.
 */

import type { Command } from "commander";
import type { LGTMPlugin, LGTMContext } from "@lgtm/core/plugin.js";
import { registerAddCommand } from "./commands/add.js";
import { registerStatusCommand } from "./commands/status.js";
import { registerApproveCommand } from "./commands/approve.js";
import { registerFlagCommand } from "./commands/flag.js";
import { registerRuleCommand } from "./commands/rule.js";
import { registerScanCommand } from "./commands/scan.js";
import { registerWatchCommand } from "./commands/watch.js";
import { registerDashboardCommand } from "./commands/dashboard.js";
import { registerAutoCommand } from "./commands/auto.js";
import { registerReportCommand } from "./commands/report.js";
import { registerStandupCommand } from "./commands/standup.js";
import { ReviewTab } from "./pages/ReviewTab.js";
import { DashboardPage } from "./pages/DashboardPage.js";
import { RulesPage } from "./pages/RulesPage.js";
import { HistoryPage } from "./pages/HistoryPage.js";

/**
 * Review plugin — implements the LGTMPlugin interface.
 */
export const plugin: LGTMPlugin = {
  name: "review",
  description: "PR review harness — structured code review with rules and grouping",
  version: "0.1.0",

  pages: [
    {
      label: "Dashboard",
      shortcut: "d",
      component: DashboardPage,
    },
    {
      label: "Review",
      shortcut: "r",
      component: ReviewTab,
    },
    {
      label: "Rules",
      shortcut: "u",
      component: RulesPage,
    },
    {
      label: "History",
      shortcut: "h",
      component: HistoryPage,
    },
  ],

  registerCommands(program: Command, ctx: LGTMContext): void {
    // Real commands (implemented)
    registerAddCommand(program, ctx);
    registerStatusCommand(program, ctx);
    registerApproveCommand(program, ctx);
    registerFlagCommand(program, ctx);
    registerRuleCommand(program, ctx);
    registerScanCommand(program, ctx);
    registerWatchCommand(program, ctx);
    registerDashboardCommand(program, ctx);
    registerAutoCommand(program, ctx);
    registerReportCommand(program, ctx);
    registerStandupCommand(program, ctx);

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

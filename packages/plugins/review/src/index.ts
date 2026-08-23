/**
 * @lgtm/plugin-review
 *
 * PR Review Harness plugin for LGTM.
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
import {
  registerListCommand,
  registerPostCommand,
  registerSubmitCommand,
  registerDiscardCommand,
} from "./commands/post.js";
import { ReviewTab } from "./pages/ReviewTab.js";
import { DashboardPage } from "./pages/DashboardPage.js";
import { RulesPage } from "./pages/RulesPage.js";
import { HistoryPage } from "./pages/HistoryPage.js";
import { ConfigPage } from "./pages/ConfigPage.js";
import { ScanResultsPage } from "./pages/ScanResultsPage.js";
import { DiscoverPage } from "./pages/DiscoverPage.js";

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
      label: "Repos",
      shortcut: "p",
      component: DiscoverPage,
    },
    {
      label: "History",
      shortcut: "h",
      component: HistoryPage,
    },
    {
      label: "Config",
      shortcut: "c",
      component: ConfigPage,
    },
    {
      label: "Scan",
      shortcut: "s",
      component: ScanResultsPage,
    },
  ],

  /**
   * `lgtm watch` — the main loop, given a top-level name because it is the
   * command people leave running, and `lgtm review watch auto` is a mouthful.
   */
  registerTopLevelCommands(program: Command, ctx: LGTMContext): void {
    program
      .command("watch")
      .description("Poll watched repos and review new PRs locally (posts nothing)")
      .option("--interval <minutes>", "Poll interval in minutes, 0 for a single run", "15")
      .option("--once", "Run a single cycle and exit")
      .action(async (opts: { interval?: string; once?: boolean }) => {
        const { runWatch } = await import("./commands/watch.js");
        await runWatch(ctx, opts);
      });
  },

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

    // The human gate: findings sit locally until one of these runs.
    registerListCommand(program, ctx);
    registerPostCommand(program, ctx);
    registerSubmitCommand(program, ctx);
    registerDiscardCommand(program, ctx);

    // The orchestrator spawns one of these per agent and speaks JSON to it over
    // stdin and stdout. It is hidden because it is a process boundary, not a
    // user-facing command, and it exists as a subcommand because a compiled
    // binary has no source file on disk to spawn instead.
    program
      .command("internal-worker", { hidden: true })
      .description("Internal: run one review in this process (JSON on stdin and stdout)")
      .action(async () => {
        const { runWorker } = await import("./workers/review-agent.js");
        process.exit(await runWorker());
      });

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

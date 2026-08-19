/**
 * `lgtm review status` — Show the current review queue.
 *
 * Displays a table of queued PRs with states, feature groups, and file counts.
 */

import type { Command } from "commander";
import type { LGTMContext } from "@lgtm/core/plugin.js";
import { createQueueManager } from "../domain/queue.js";
import chalk from "chalk";

export function registerStatusCommand(program: Command, ctx: LGTMContext) {
  program
    .command("status")
    .description("Show review queue status with feature groups")
    .action(async () => {
      const queue = createQueueManager(ctx.store);
      const session = await queue.getQueue();

      if (session.prs.length === 0) {
        console.log(
          chalk.gray(
            `\n  No PRs in queue. Add some with ${chalk.cyan("lgtm review add <numbers...>")}\n`
          )
        );
        return;
      }

      console.log(chalk.bold(`\n👍 Review Queue — ${session.date}\n`));

      // Show feature groups first
      if (session.featureGroups.length > 0) {
        console.log(chalk.bold("  Feature Groups:"));
        for (const group of session.featureGroups) {
          console.log(
            `  ${chalk.cyan("⚡")} ${group.label} — PRs ${group.prs.map((n) => `#${n}`).join(", ")}`
          );
        }
        console.log();
      }

      // Table header
      console.log(
        chalk.gray("  #     State       Title                              Files  Group")
      );
      console.log(chalk.gray("  " + "─".repeat(72)));

      // PR rows
      for (const pr of session.prs) {
        const icon = getStateIcon(pr.state);
        const state = getStateLabel(pr.state);
        const title = pr.title.length > 30 ? pr.title.slice(0, 27) + "..." : pr.title.padEnd(30);
        const files = String(pr.filesChanged.length).padStart(3);
        const group = pr.featureGroup ? chalk.gray(pr.featureGroup) : "";
        const reason = pr.flagReason ? chalk.red(` — ${pr.flagReason}`) : "";

        console.log(`  ${icon} ${String(pr.number).padEnd(4)} ${state}  ${title}  ${files}  ${group}${reason}`);
      }

      // Summary
      const approved = session.prs.filter((p) => p.state === "approved").length;
      const flagged = session.prs.filter((p) => p.state === "flagged").length;
      const pending = session.prs.filter((p) => p.state === "queued" || p.state === "reviewing").length;

      console.log(chalk.gray("\n  " + "─".repeat(72)));
      console.log(
        `  ${chalk.green(`${approved} approved`)}  ${chalk.red(`${flagged} flagged`)}  ${chalk.yellow(`${pending} pending`)}\n`
      );
    });
}

function getStateIcon(state: string): string {
  switch (state) {
    case "approved": return chalk.green("✓");
    case "flagged": return chalk.red("✗");
    case "reviewing": return chalk.yellow("◉");
    case "queued": return chalk.gray("○");
    default: return " ";
  }
}

function getStateLabel(state: string): string {
  switch (state) {
    case "approved": return chalk.green("approved ".padEnd(10));
    case "flagged": return chalk.red("flagged  ".padEnd(10));
    case "reviewing": return chalk.yellow("reviewing".padEnd(10));
    case "queued": return chalk.gray("queued   ".padEnd(10));
    default: return state.padEnd(10);
  }
}

/**
 * `yak review approve <pr>` — Mark a PR as approved.
 */

import type { Command } from "commander";
import type { YakContext } from "@yak/core/plugin.js";
import { createQueueManager } from "../domain/queue.js";
import chalk from "chalk";

export function registerApproveCommand(program: Command, ctx: YakContext) {
  program
    .command("approve <pr>")
    .description("Approve a reviewed PR")
    .action(async (pr: string) => {
      const prNumber = parseInt(pr, 10);
      if (isNaN(prNumber)) {
        ctx.logger.error(`Invalid PR number: ${pr}`);
        return;
      }

      const queue = createQueueManager(ctx.store);

      // First check if PR needs to transition through reviewing
      const session = await queue.getQueue();
      const queuedPR = session.prs.find((p) => p.number === prNumber);

      if (!queuedPR) {
        ctx.logger.error(`PR #${prNumber} not found in queue.`);
        return;
      }

      // Auto-transition from queued → reviewing if needed
      if (queuedPR.state === "queued") {
        await queue.updateState(prNumber, "reviewing");
      }

      const result = await queue.updateState(prNumber, "approved");
      if (!result) {
        ctx.logger.error(
          `Cannot approve PR #${prNumber} (current state: ${queuedPR.state}).`
        );
        return;
      }

      console.log(
        `\n  ${chalk.green("✓")} PR #${prNumber} approved: ${result.title}\n`
      );
    });
}

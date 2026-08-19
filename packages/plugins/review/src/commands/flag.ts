/**
 * `lgtm review flag <pr>` — Flag a PR with issues.
 */

import type { Command } from "commander";
import type { LGTMContext } from "@lgtm/core/plugin.js";
import { createQueueManager } from "../domain/queue.js";
import chalk from "chalk";

export function registerFlagCommand(program: Command, ctx: LGTMContext) {
  program
    .command("flag <pr>")
    .description("Flag a PR with issues")
    .requiredOption("-r, --reason <reason>", "Reason for flagging")
    .action(async (pr: string, opts: { reason: string }) => {
      const prNumber = parseInt(pr, 10);
      if (isNaN(prNumber)) {
        ctx.logger.error(`Invalid PR number: ${pr}`);
        return;
      }

      const queue = createQueueManager(ctx.store);

      // Check current state
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

      const result = await queue.updateState(prNumber, "flagged", opts.reason);
      if (!result) {
        ctx.logger.error(
          `Cannot flag PR #${prNumber} (current state: ${queuedPR.state}).`
        );
        return;
      }

      console.log(
        `\n  ${chalk.red("✗")} PR #${prNumber} flagged: ${result.title}`
      );
      console.log(chalk.red(`    Reason: ${opts.reason}\n`));
    });
}

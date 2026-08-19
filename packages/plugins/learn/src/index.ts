/**
 * @lgtm/plugin-learn (stub)
 *
 * Interactive learning paths for new tech stacks.
 * AI-generated project-based curricula.
 *
 * Status: Stub — registered for plugin discovery, not yet implemented.
 */

import type { Command } from "commander";
import type { LGTMPlugin, LGTMContext } from "@lgtm/core/plugin.js";

export const plugin: LGTMPlugin = {
  name: "learn",
  description: "Interactive learning paths — AI-generated curricula for any tech stack",
  version: "0.1.0",

  registerCommands(program: Command, ctx: LGTMContext): void {
    program
      .command("start")
      .description("Start a new learning path")
      .option("-t, --topic <topic>", "What to learn")
      .option("-p, --project <project>", "What to build while learning")
      .action(() => {
        ctx.logger.info("Learn plugin not yet implemented. See IDEA.md for the roadmap.");
      });
  },
};

export default plugin;

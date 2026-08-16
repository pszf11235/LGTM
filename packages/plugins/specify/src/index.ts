/**
 * @yak/plugin-specify (stub)
 *
 * Codebase intelligence & agent handoff tool.
 * Analyze repos, generate diagrams, create agent-ready prompts.
 *
 * Status: Stub — registered for plugin discovery, not yet implemented.
 */

import type { Command } from "commander";
import type { YakPlugin, YakContext } from "@yak/core/plugin.js";

export const plugin: YakPlugin = {
  name: "specify",
  description: "Codebase intelligence — analysis, diagrams, agent-ready prompts",
  version: "0.1.0",

  registerCommands(program: Command, ctx: YakContext): void {
    program
      .command("analyze [path]")
      .description("Analyze a codebase and generate documentation")
      .action((path?: string) => {
        ctx.logger.info("Specify plugin not yet implemented. See IDEA.md for the roadmap.");
      });

    program
      .command("focus <path>")
      .description("Zoom into a specific file/module and show relationships")
      .option("-g, --goal <goal>", "What you want to change")
      .action((path: string) => {
        ctx.logger.info("Specify plugin not yet implemented. See IDEA.md for the roadmap.");
      });
  },
};

export default plugin;

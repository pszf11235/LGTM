#!/usr/bin/env bun
/**
 * 🦬 Yak — Stop shaving, start shipping
 *
 * Main entry point. Bootstraps the CLI, discovers plugins,
 * and either opens the TUI (bare `yak`) or runs a CLI command.
 *
 * Run `bun install` first, then `bun run packages/core/src/index.ts --help`
 */

import { Command } from "commander";
import chalk from "chalk";
import {
  discoverPlugins,
  registerPlugin,
  buildBootstrapContext,
  resolvePluginsDir,
} from "./cli/program.js";

async function main() {
  const program = new Command();

  program
    .name("yak")
    .description(
      `${chalk.bold("🦬 Yak")} — Stop shaving, start shipping\n\n` +
        `A dev productivity platform with plugins.\n` +
        `Run ${chalk.cyan("yak")} to open the TUI, or ${chalk.cyan("yak <plugin> <command>")} for CLI mode.`
    )
    .version("0.1.0");

  // Build bootstrap context (minimal, will be enriched by later tasks)
  const ctx = buildBootstrapContext();

  // Discover and register plugins
  const pluginsDir = resolvePluginsDir();
  const plugins = await discoverPlugins(pluginsDir);

  for (const plugin of plugins) {
    const pluginConfig = ctx.config.plugins[plugin.name];
    if (pluginConfig?.enabled !== false) {
      registerPlugin(program, plugin, ctx);
    }
  }

  // ─── Core Commands ─────────────────────────────────────────────────────

  // `yak` (bare) → opens TUI (placeholder until Task 8)
  program.action(() => {
    if (process.argv.length <= 2) {
      console.log(
        `\n${chalk.bold("🦬 Yak")} — TUI launching soon!\n`
      );
      console.log(
        chalk.gray(
          `  In a future version, bare ${chalk.cyan("yak")} opens the interactive TUI.\n` +
            `  For now, use ${chalk.cyan("yak --help")} to see available commands.\n`
        )
      );
    }
  });

  // `yak tui [plugin]` → opens TUI on specific tab
  program
    .command("tui [plugin]")
    .description("Open the interactive TUI (default when running bare `yak`)")
    .action((plugin?: string) => {
      console.log(
        chalk.yellow(
          `🦬 TUI coming in Task 8! (requested tab: ${plugin ?? "default"})`
        )
      );
    });

  // `yak plugins` → list all plugins with status
  program
    .command("plugins")
    .description("List installed plugins and their status")
    .action(() => {
      console.log(chalk.bold("\n🦬 Yak Plugins\n"));

      for (const plugin of plugins) {
        const enabled = ctx.config.plugins[plugin.name]?.enabled !== false;
        const icon = enabled ? chalk.green("●") : chalk.gray("○");
        const status = enabled ? "" : chalk.gray(" (disabled)");
        console.log(
          `  ${icon} ${chalk.bold(plugin.name.padEnd(10))} — ${plugin.description}${status}`
        );
      }

      if (plugins.length === 0) {
        console.log(chalk.gray("  No plugins found."));
      }

      console.log();
      console.log(
        chalk.gray(
          `  Enable/disable: ${chalk.cyan("yak plugins enable <name>")} / ${chalk.cyan("yak plugins disable <name>")}`
        )
      );
      console.log();
    });

  // `yak plugins enable/disable <name>`
  program
    .command("plugins:enable <name>")
    .description("Enable a plugin")
    .action((name: string) => {
      // Will persist to config in Task 3
      console.log(chalk.green(`✓ Plugin '${name}' enabled`));
    });

  program
    .command("plugins:disable <name>")
    .description("Disable a plugin")
    .action((name: string) => {
      console.log(chalk.yellow(`○ Plugin '${name}' disabled`));
    });

  // `yak init` → onboarding
  program
    .command("init")
    .description("Initialize Yak in this project (runs onboarding)")
    .option("--skip-onboarding", "Skip interactive questions, use defaults")
    .action(async (opts: { skipOnboarding?: boolean }) => {
      if (opts.skipOnboarding) {
        ctx.logger.info("Skipping onboarding — using defaults.");
        ctx.logger.info("Run `yak init` again without --skip-onboarding to configure.");
        return;
      }

      // Dynamic import to avoid loading readline on every CLI invocation
      const { runOnboarding } = await import("../onboarding/flow.js");
      await runOnboarding();
    });

  // `yak config` → view config (placeholder until Task 3)
  program
    .command("config")
    .description("View or edit Yak configuration")
    .action(() => {
      console.log(chalk.bold("\n🦬 Yak Config (defaults)\n"));
      console.log(`  Storage mode: ${chalk.cyan(ctx.config.storageMode)}`);
      console.log(`  AI enabled:   ${chalk.cyan(String(ctx.config.ai.enabled))}`);
      console.log(`  Plugins:`);
      for (const [name, cfg] of Object.entries(ctx.config.plugins)) {
        const icon = cfg.enabled ? chalk.green("●") : chalk.gray("○");
        console.log(`    ${icon} ${name}`);
      }
      console.log();
    });

  // Parse and execute
  await program.parseAsync(process.argv);
}

main().catch((err) => {
  console.error(chalk.red(`\n❌ Fatal error: ${err.message}\n`));
  process.exit(1);
});

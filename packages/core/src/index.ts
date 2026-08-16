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

  // ─── Handle bare `yak` (no args) BEFORE parsing ────────────────────────
  // Commander doesn't reliably call program.action() when subcommands exist.
  // So we intercept bare invocations here.
  if (process.argv.length <= 2) {
    const { isOnboardingComplete } = await import("./onboarding/flow.js");
    if (!isOnboardingComplete(ctx.yakDir)) {
      const hasProfile = await ctx.store.exists("profile.md");
      if (hasProfile) {
        console.log(
          chalk.gray("\n  Yak profile is incomplete — resuming setup...\n")
        );
      } else {
        console.log(
          chalk.gray("\n  No yak profile found — starting first-time setup...\n")
        );
      }
      const { runOnboarding } = await import("./onboarding/flow.js");
      await runOnboarding();
      return;
    }

    // Profile complete — show TUI placeholder (will become real TUI in Task 8)
    console.log(
      `\n${chalk.bold("🦬 Yak")} — TUI launching soon!\n`
    );
    console.log(
      chalk.gray(
        `  In a future version, bare ${chalk.cyan("yak")} opens the interactive TUI.\n` +
          `  For now, use ${chalk.cyan("yak --help")} to see available commands.\n`
      )
    );
    return;
  }

  // ─── Core Commands ─────────────────────────────────────────────────────

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

  // `yak init` → run or resume onboarding
  program
    .command("init")
    .description("Initialize Yak in this project (runs or resumes onboarding)")
    .option("--skip-onboarding", "Skip interactive questions, use defaults")
    .action(async (opts: { skipOnboarding?: boolean }) => {
      if (opts.skipOnboarding) {
        ctx.logger.info("Skipping onboarding — using defaults.");
        ctx.logger.info("Run `yak init` again without --skip-onboarding to configure.");
        return;
      }

      const { runOnboarding } = await import("./onboarding/flow.js");
      await runOnboarding();
    });

  // `yak config` → show current config, offer to re-run onboarding to change
  program
    .command("config")
    .description("View current config or re-run setup to change settings")
    .option("-e, --edit", "Re-run onboarding to change settings")
    .action(async (opts: { edit?: boolean }) => {
      if (opts.edit) {
        const { runOnboarding } = await import("./onboarding/flow.js");
        await runOnboarding();
        return;
      }

      console.log(chalk.bold("\n🦬 Yak Config\n"));
      console.log(`  Storage mode: ${chalk.cyan(ctx.config.storageMode === "farm" ? "yak-farm (~/.yak-farm/)" : "per-repo (.yak/)")}`);
      console.log(`  AI enabled:   ${chalk.cyan(String(ctx.config.ai.enabled))}`);
      if (ctx.config.ai.enabled && ctx.config.ai.provider) {
        console.log(`  AI provider:  ${chalk.cyan(ctx.config.ai.provider)}`);
      }
      console.log(`  Plugins:`);
      for (const [name, cfg] of Object.entries(ctx.config.plugins)) {
        const icon = cfg.enabled ? chalk.green("●") : chalk.gray("○");
        console.log(`    ${icon} ${name}`);
      }

      if (ctx.profile) {
        console.log(`\n  ${chalk.bold("Profile:")}`);
        console.log(`    Project:   ${chalk.cyan(ctx.profile.project)}`);
        console.log(`    Goal:      ${chalk.cyan(ctx.profile.goal)}`);
        console.log(`    Feedback:  ${chalk.cyan(ctx.profile.feedbackStyle)}`);
        console.log(`    Team:      ${chalk.cyan(ctx.profile.teamSize)}`);
        if (ctx.profile.techStack.length > 0) {
          console.log(`    Stack:     ${chalk.cyan(ctx.profile.techStack.join(", "))}`);
        }
      }

      console.log(
        chalk.gray(`\n  Run ${chalk.cyan("yak config --edit")} to change settings.\n`)
      );
    });

  // Parse and execute
  await program.parseAsync(process.argv);
}

main().catch((err) => {
  console.error(chalk.red(`\n❌ Fatal error: ${err.message}\n`));
  process.exit(1);
});

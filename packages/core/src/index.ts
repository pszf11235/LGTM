#!/usr/bin/env bun
/**
 * 👍 LGTM — Looks Good To Me — dev productivity platform
 *
 * Main entry point. Bootstraps the CLI, discovers plugins,
 * and either opens the TUI (bare `lgtm`) or runs a CLI command.
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
    .name("lgtm")
    .description(
      `${chalk.bold("👍 LGTM")} — Looks Good To Me — dev productivity platform\n\n` +
        `A dev productivity platform with plugins.\n` +
        `Run ${chalk.cyan("lgtm")} to open the TUI, or ${chalk.cyan("lgtm <plugin> <command>")} for CLI mode.`
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

  // ─── Handle bare `lgtm` (no args) BEFORE parsing ────────────────────────
  // Commander doesn't reliably call program.action() when subcommands exist.
  // So we intercept bare invocations here.
  if (process.argv.length <= 2) {
    const { isOnboardingComplete } = await import("./onboarding/flow.js");
    if (!isOnboardingComplete(ctx.lgtmDir)) {
      const hasProfile = await ctx.store.exists("profile.md");
      if (hasProfile) {
        console.log(
          chalk.gray("\n  LGTM profile is incomplete — resuming setup...\n")
        );
      } else {
        console.log(
          chalk.gray("\n  No lgtm profile found — starting first-time setup...\n")
        );
      }
      const { runOnboarding } = await import("./onboarding/flow.js");
      await runOnboarding();
      return;
    }

    // Profile complete — launch TUI
    const { launchTUI } = await import("./tui/render.js");
    const path = await import("path");

    const repoName = path.default.basename(ctx.repoRoot);
    const repoPath = ctx.repoRoot;

    // Build tabs dynamically from discovered plugins (not hardcoded)
    const tabs = plugins
      .filter((p) => ctx.config.plugins[p.name]?.enabled !== false)
      .map((p) => {
        // Use plugin's first page as its tab, or a placeholder
        const page = p.pages?.[0];
        return {
          name: p.name,
          label: page?.label ?? p.name.charAt(0).toUpperCase() + p.name.slice(1),
          enabled: true,
          component: page?.component ?? (() => null),
        };
      });

    // Check AI availability and watch count for TUI indicators
    let aiStatus: { available: boolean; provider?: string } | undefined;
    let watchCount = 0;

    if (ctx.config.ai.enabled) {
      try {
        const { createLLMProvider } = await import("./llm/provider.js");
        const llm = createLLMProvider(ctx.config.ai as any);
        const available = await llm.isAvailable();
        aiStatus = { available, provider: ctx.config.ai.provider };
      } catch {
        aiStatus = { available: false, provider: ctx.config.ai.provider };
      }
    }

    try {
      const watchDoc = await ctx.store.read("watch.md");
      if (watchDoc?.data?.repos && Array.isArray(watchDoc.data.repos)) {
        watchCount = (watchDoc.data.repos as any[]).length > 0 ? -1 : 0; // -1 = needs check
        // Quick check: just show count of watched repos as indicator
        // Full PR count would need GitHub API call (deferred to watch status)
      }
    } catch { /* no watch config */ }

    await launchTUI({ tabs, repoName, repoPath, watchCount: watchCount === -1 ? undefined : watchCount, aiStatus });
    return;
  }

  // ─── Auto-register this repo ─────────────────────────────────────────
  try {
    const { registerRepo } = await import("./registry/index.js");
    registerRepo(ctx.repoRoot, { storageMode: ctx.config.storageMode });
  } catch {
    // Non-critical — don't block startup
  }

  // ─── Warn if API key might be in committed files ─────────────────────
  if (ctx.config.storageMode === "repo" && ctx.config.ai.apiKey) {
    console.log(
      chalk.yellow("  ⚠ Warning: AI API key detected in config. In repo-mode, ensure .lgtm/ is in .gitignore.\n")
    );
  }

  // ─── Core Commands ─────────────────────────────────────────────────────

  // `lgtm ai` — AI connection management
  const { registerAICommands } = await import("./cli/commands/ai.js");
  registerAICommands(program, ctx);

  // `lgtm discover` — repo registry
  const { registerDiscoverCommand } = await import("./cli/commands/discover.js");
  registerDiscoverCommand(program);

  // `lgtm tui [plugin]` → opens TUI on specific tab
  program
    .command("tui [plugin]")
    .description("Open the interactive TUI (same as bare `lgtm`)")
    .action(async (plugin?: string) => {
      const { launchTUI } = await import("./tui/render.js");
      const path = await import("path");

      const tabs = plugins
        .filter((p) => ctx.config.plugins[p.name]?.enabled !== false)
        .map((p) => {
          const page = p.pages?.[0];
          return {
            name: p.name,
            label: page?.label ?? p.name.charAt(0).toUpperCase() + p.name.slice(1),
            enabled: true,
            component: page?.component ?? (() => null),
          };
        });

      await launchTUI({
        tabs,
        initialTab: plugin,
        repoName: path.default.basename(ctx.repoRoot),
        repoPath: ctx.repoRoot,
      });
    });

  // `lgtm plugins` → list all plugins with status
  program
    .command("plugins")
    .description("List installed plugins and their status")
    .action(() => {
      console.log(chalk.bold("\n👍 LGTM Plugins\n"));

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
          `  Enable/disable: ${chalk.cyan("lgtm plugins enable <name>")} / ${chalk.cyan("lgtm plugins disable <name>")}`
        )
      );
      console.log();
    });

  // `lgtm plugins enable/disable <name>`
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

  // `lgtm init` → run or resume onboarding
  program
    .command("init")
    .description("Initialize LGTM in this project (runs or resumes onboarding)")
    .option("--skip-onboarding", "Skip interactive questions, use defaults")
    .action(async (opts: { skipOnboarding?: boolean }) => {
      if (opts.skipOnboarding) {
        ctx.logger.info("Skipping onboarding — using defaults.");
        ctx.logger.info("Run `lgtm init` again without --skip-onboarding to configure.");
        return;
      }

      const { runOnboarding } = await import("./onboarding/flow.js");
      await runOnboarding();
    });

  // `lgtm config` → show current config, offer to re-run onboarding to change
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

      console.log(chalk.bold("\n👍 LGTM Config\n"));
      console.log(`  Storage mode: ${chalk.cyan(ctx.config.storageMode === "farm" ? "lgtm-farm (~/.lgtm-farm/)" : "per-repo (.lgtm/)")}`);
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
        chalk.gray(`\n  Run ${chalk.cyan("lgtm config --edit")} to change settings.\n`)
      );
    });

  // Parse and execute
  await program.parseAsync(process.argv);
}

main().catch((err) => {
  console.error(chalk.red(`\n❌ Fatal error: ${err.message}\n`));
  process.exit(1);
});

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
    // No questions to ask — create the store silently if it is missing.
    const { storeExists, initStore } = await import("./onboarding/flow.js");
    if (!storeExists()) {
      await initStore();
    }

    const { buildAndLaunchTUI } = await import("./tui/render.js");
    await buildAndLaunchTUI({ ctx, plugins });
    return;
  }

  // ─── Auto-register this repo ─────────────────────────────────────────
  try {
    const { registerRepo } = await import("./registry/index.js");
    registerRepo(ctx.repoRoot);
  } catch {
    // Non-critical — don't block startup
  }

  // ─── Core Commands ─────────────────────────────────────────────────────

  // `lgtm smoke` — built-in smoke test / demo walkthrough
  const { registerSmokeCommand } = await import("./cli/commands/smoke.js");
  registerSmokeCommand(program, ctx);

  // `lgtm ai` — AI connection management
  const { registerAICommands } = await import("./cli/commands/ai.js");
  registerAICommands(program, ctx);

  // `lgtm auth` — service authentication (OAuth)
  const { registerAuthCommands } = await import("./cli/commands/auth.js");
  registerAuthCommands(program);

  // `lgtm discover` — repo registry
  const { registerDiscoverCommand } = await import("./cli/commands/discover.js");
  registerDiscoverCommand(program);

  // `lgtm tui [plugin]` → opens TUI on specific tab
  program
    .command("tui [plugin]")
    .description("Open the interactive TUI (same as bare `lgtm`)")
    .action(async (plugin?: string) => {
      const { launchTUI } = await import("./tui/render.js");
      const { AITab } = await import("./tui/AITab.js");
      const path = await import("path");

      const tabs = plugins
        .filter((p) => ctx.config.plugins[p.name]?.enabled !== false)
        .flatMap((p) => {
          if (p.pages && p.pages.length > 0) {
            return p.pages.map((page) => ({
              name: `${p.name}-${page.label.toLowerCase()}`,
              label: page.label,
              enabled: true,
              component: page.component,
            }));
          }
          return [{
            name: p.name,
            label: p.name.charAt(0).toUpperCase() + p.name.slice(1),
            enabled: true,
            component: (() => null) as any,
          }];
        });

      // Add the AI management tab
      tabs.push({
        name: "ai",
        label: "AI",
        enabled: true,
        component: AITab,
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
    .action(async (name: string) => {
      await persistPluginState(ctx.repoRoot, name, true);
      console.log(chalk.green(`✓ Plugin '${name}' enabled`));
      console.log(chalk.gray(`  Saved to .lgtmrc.yaml. Restart lgtm to apply.`));
    });

  program
    .command("plugins:disable <name>")
    .description("Disable a plugin")
    .action(async (name: string) => {
      await persistPluginState(ctx.repoRoot, name, false);
      console.log(chalk.yellow(`○ Plugin '${name}' disabled`));
      console.log(chalk.gray(`  Saved to .lgtmrc.yaml. Restart lgtm to apply.`));
    });

  // `lgtm init` → create the central store. No questions.
  program
    .command("init")
    .description("Create the central LGTM store (no questions asked)")
    .action(async () => {
      const { runInit } = await import("./onboarding/flow.js");
      await runInit();
    });

  // `lgtm config` → show resolved config and where things live
  program
    .command("config")
    .description("Show the resolved config and store location")
    .action(async () => {
      console.log(chalk.bold("\n👍 LGTM Config\n"));
      console.log(`  Store:      ${chalk.cyan(ctx.lgtmDir)}`);
      console.log(`  AI enabled: ${chalk.cyan(String(ctx.config.ai.enabled))}`);
      if (ctx.config.ai.enabled && ctx.config.ai.provider) {
        console.log(`  AI provider: ${chalk.cyan(ctx.config.ai.provider)}`);
      }

      console.log(`  Plugins:`);
      for (const [name, cfg] of Object.entries(ctx.config.plugins)) {
        const icon = cfg.enabled ? chalk.green("●") : chalk.gray("○");
        console.log(`    ${icon} ${name}`);
      }

      // Agents are the user-facing config that actually matters, so show the
      // resolved settings rather than just the filenames.
      const { loadAgentConfigs } = await import("./store/agents.js");
      const agents = loadAgentConfigs(ctx.lgtmDir);

      if (agents.length > 0) {
        console.log(`\n  ${chalk.bold("Review agents:")}`);
        for (const agent of agents) {
          const icon = agent.enabled ? chalk.green("●") : chalk.gray("○");
          const model = agent.model ? ` ${chalk.gray(agent.model)}` : "";
          console.log(
            `    ${icon} ${chalk.cyan(agent.name)}` +
            `  ${agent.provider}${model}` +
            chalk.gray(`  min severity ${agent.severity}, timeout ${agent.timeout}s`)
          );
        }
        console.log(chalk.gray(`\n  Edit ${chalk.cyan("agents/<name>.md")} to change how reviews are written.`));
        console.log(chalk.gray(`  Copy it to a second file to run two reviewers per PR.`));
      }

      console.log(
        chalk.gray(`\n  Providers: ${chalk.cyan("lgtm ai discover")}\n`)
      );
    });

  // Parse and execute
  await program.parseAsync(process.argv);
}

main().catch((err) => {
  console.error(chalk.red(`\n❌ Fatal error: ${err.message}\n`));
  process.exit(1);
});

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Persist plugin enable/disable state to .lgtmrc.yaml in repo root.
 * Creates the file if it doesn't exist.
 */
async function persistPluginState(repoRoot: string, pluginName: string, enabled: boolean): Promise<void> {
  const fs = await import("fs");
  const path = await import("path");
  const { parse: parseYaml, stringify: stringifyYaml } = await import("yaml");

  const configPath = path.default.join(repoRoot, ".lgtmrc.yaml");

  let config: Record<string, any> = {};
  try {
    const raw = fs.default.readFileSync(configPath, "utf-8");
    config = parseYaml(raw) ?? {};
  } catch {
    // File doesn't exist — create fresh
  }

  // Ensure plugins section exists
  if (!config.plugins || typeof config.plugins !== "object") {
    config.plugins = {};
  }

  config.plugins[pluginName] = { enabled };

  fs.default.writeFileSync(configPath, stringifyYaml(config), "utf-8");
}

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

const program = new Command();

program
  .name("yak")
  .description(
    `${chalk.bold("🦬 Yak")} — Stop shaving, start shipping\n\n` +
      `A dev productivity platform with plugins.\n` +
      `Run ${chalk.cyan("yak")} to open the TUI, or ${chalk.cyan("yak <plugin> <command>")} for CLI mode.`
  )
  .version("0.1.0");

// Placeholder: `yak` (bare) will open TUI in a future task
program
  .command("tui [plugin]")
  .description("Open the interactive TUI (default when running bare `yak`)")
  .action((plugin?: string) => {
    console.log(
      chalk.yellow(
        `🦬 TUI coming soon! (requested tab: ${plugin ?? "default"})`
      )
    );
  });

// Plugin management
program
  .command("plugins")
  .description("List installed plugins and their status")
  .action(() => {
    console.log(chalk.bold("\n🦬 Yak Plugins\n"));
    console.log(
      `  ${chalk.green("●")} ${chalk.bold("review")}    — PR review harness (enabled)`
    );
    console.log(
      `  ${chalk.gray("○")} ${chalk.bold("specify")}   — Codebase intelligence (stub)`
    );
    console.log(
      `  ${chalk.gray("○")} ${chalk.bold("learn")}     — Interactive learning paths (stub)`
    );
    console.log();
  });

// Init command placeholder
program
  .command("init")
  .description("Initialize Yak in this project (runs onboarding)")
  .action(() => {
    console.log(chalk.yellow("🦬 Onboarding flow coming in Task 4!"));
  });

// Config command placeholder
program
  .command("config")
  .description("View or edit Yak configuration")
  .action(() => {
    console.log(chalk.yellow("🦬 Config system coming in Task 3!"));
  });

// Review plugin placeholder commands
const review = program
  .command("review")
  .description("PR review harness — structured code review workflow");

review
  .command("add <prs...>")
  .description("Add PR(s) to the review queue")
  .action((prs: string[]) => {
    console.log(
      chalk.yellow(`🦬 Would queue PRs: ${prs.join(", ")} (coming in Task 7)`)
    );
  });

review
  .command("status")
  .description("Show review queue status")
  .action(() => {
    console.log(chalk.yellow("🦬 Queue status coming in Task 7!"));
  });

review
  .command("approve <pr>")
  .description("Approve a reviewed PR")
  .action((pr: string) => {
    console.log(chalk.yellow(`🦬 Would approve PR #${pr} (coming in Task 7)`));
  });

review
  .command("flag <pr>")
  .description("Flag a PR with issues")
  .option("-r, --reason <reason>", "Reason for flagging")
  .action((pr: string, opts: { reason?: string }) => {
    console.log(
      chalk.yellow(
        `🦬 Would flag PR #${pr}: ${opts.reason ?? "(no reason)"} (coming in Task 7)`
      )
    );
  });

review
  .command("rule <action>")
  .description("Manage review rules (add/list/export)")
  .action((action: string) => {
    console.log(
      chalk.yellow(`🦬 Rule ${action} coming in Task 11!`)
    );
  });

// If no command given, show help (will become TUI in Task 8)
program.action(() => {
  console.log(
    chalk.bold("\n🦬 Yak") + " — run " + chalk.cyan("yak --help") + " for commands\n"
  );
  console.log(
    chalk.gray(
      "  Tip: In a future version, bare `yak` will open the interactive TUI.\n"
    )
  );
});

program.parse(process.argv);

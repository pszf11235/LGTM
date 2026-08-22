/**
 * `lgtm discover` — manage the repo registry.
 *
 * Commands:
 *   lgtm discover             — show all registered repos
 *   lgtm discover --ingest    — scan machine for git repos, interactive picker
 *   lgtm discover --ingest <dir> — scan specific directory
 *   lgtm discover --scan <dir> — scan for lgtm-enabled repos (legacy)
 *   lgtm discover --prune     — remove stale entries
 */

import type { Command } from "commander";
import chalk from "chalk";
import {
  getRegisteredRepos,
  discoverRepos,
  registerRepo,
  pruneRegistry,
} from "../../registry/index.js";

export function registerDiscoverCommand(program: Command) {
  program
    .command("discover")
    .description("Manage the repo registry (list/scan/prune)")
    .option("-i, --ingest [dir]", "Scan for git repos and interactively add to watch list")
    .option("-s, --scan <dir>", "Scan a directory for lgtm-enabled repos")
    .option("-p, --prune", "Remove repos that no longer exist on disk")
    .option("--new-only", "Only show repos that need a decision")
    .option("--all", "Show all repos including previously denied")
    .option("--recommended", "Auto-accept repos with recent activity")
    .action(async (opts: {
      ingest?: boolean | string;
      scan?: string;
      prune?: boolean;
      newOnly?: boolean;
      all?: boolean;
      recommended?: boolean;
    }) => {
      // ── Ingest mode (new) ─────────────────────────────────────────────
      if (opts.ingest !== undefined) {
        const { runIngest } = await import("../../registry/ingest.js");
        await runIngest({
          scanDir: typeof opts.ingest === "string" ? opts.ingest : undefined,
          newOnly: opts.newOnly,
          all: opts.all,
          recommended: opts.recommended,
          pruneOnly: opts.prune,
        });
        return;
      }

      // ── Prune mode ────────────────────────────────────────────────────
      if (opts.prune) {
        const { removed, kept } = pruneRegistry();
        if (removed.length === 0) {
          console.log(chalk.green("\n  ✓ Registry is clean — no stale entries.\n"));
        } else {
          console.log(chalk.bold(`\n👍 Pruned ${removed.length} stale repo(s):\n`));
          for (const r of removed) {
            console.log(chalk.gray(`  ✗ ${r}`));
          }
          console.log(chalk.gray(`\n  ${kept} repo(s) remaining.\n`));
        }
        return;
      }

      // ── Scan mode (legacy — scans for .lgtm/ directories) ─────────────
      if (opts.scan) {
        console.log(chalk.gray(`\n  Scanning ${opts.scan} for .lgtm/ directories...\n`));
        const found = discoverRepos(opts.scan);

        if (found.length === 0) {
          console.log(chalk.gray("  No lgtm-enabled repos found.\n"));
          return;
        }

        console.log(chalk.bold(`  Found ${found.length} repo(s):\n`));
        for (const repoPath of found) {
          registerRepo(repoPath);
          const name = repoPath.split("/").pop();
          console.log(`  ${chalk.green("+")} ${name} — ${chalk.gray(repoPath)}`);
        }
        console.log(chalk.gray(`\n  All registered in ~/.lgtm-registry.md\n`));
        return;
      }

      // ── Default: list registered repos ────────────────────────────────
      const repos = getRegisteredRepos();
      if (repos.length === 0) {
        console.log(chalk.gray("\n  No repos registered yet.\n"));
        console.log(chalk.gray(`  Run ${chalk.cyan("lgtm discover --ingest")} to scan your machine for repos.\n`));
        return;
      }

      console.log(chalk.bold(`\n👍 Registered Repos (${repos.length})\n`));
      for (const r of repos) {
        const lastSeen = r.lastSeen?.split("T")[0] ?? "unknown";
        console.log(`  ${chalk.green("●")} ${chalk.bold(r.name.padEnd(20))} ${chalk.gray(r.path)}`);
        console.log(chalk.gray(`    Last seen: ${lastSeen} | Plugins: ${r.plugins?.join(", ") ?? "review"}`));
      }
      console.log();
    });
}

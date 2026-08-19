/**
 * `lgtm discover` — manage the repo registry.
 *
 * Commands:
 *   lgtm discover             — show all registered repos
 *   lgtm discover --scan <dir> — scan for lgtm-enabled repos
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
    .option("-s, --scan <dir>", "Scan a directory for lgtm-enabled repos")
    .option("-p, --prune", "Remove repos that no longer exist on disk")
    .action(async (opts: { scan?: string; prune?: boolean }) => {
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

      // Default: list registered repos
      const repos = getRegisteredRepos();
      if (repos.length === 0) {
        console.log(chalk.gray("\n  No repos registered yet. LGTM auto-registers on first use.\n"));
        console.log(chalk.gray(`  Or scan: ${chalk.cyan("lgtm discover --scan ~/projects")}\n`));
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

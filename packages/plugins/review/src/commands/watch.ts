/**
 * `yak review watch` — Monitor repos for new PRs needing review.
 *
 * Commands:
 *   yak review watch add <owner/repo>   — add a repo to watch list
 *   yak review watch list               — show watched repos + pending PRs
 *   yak review watch remove <owner/repo> — stop watching
 *   yak review watch status             — show PRs needing attention
 *   yak review watch --once             — single check (good for cron)
 */

import type { Command } from "commander";
import type { YakContext } from "@yak/core/plugin.js";
import chalk from "chalk";
import type { OKFStore } from "@yak/core/plugin.js";

interface WatchedRepo {
  owner: string;
  repo: string;
  filter: "all" | "assigned" | "review_requested";
  lastChecked?: string;
}

interface PendingPR {
  repo: string;
  number: number;
  title: string;
  author: string;
  createdAt: string;
  url: string;
}

export function registerWatchCommand(program: Command, ctx: YakContext) {
  const watch = program
    .command("watch")
    .description("Monitor repos for new PRs needing review");

  watch
    .command("add <repo>")
    .description("Add a repo to watch (format: owner/repo)")
    .option("-f, --filter <type>", "Filter: all, assigned, review_requested", "all")
    .action(async (repo: string, opts: { filter: string }) => {
      const [owner, repoName] = repo.split("/");
      if (!owner || !repoName) {
        ctx.logger.error("Format: owner/repo (e.g., pszf11235/yak)");
        return;
      }

      const config = await loadWatchConfig(ctx.store);
      const existing = config.find((r) => r.owner === owner && r.repo === repoName);
      if (existing) {
        ctx.logger.info(`Already watching ${repo}`);
        return;
      }

      config.push({
        owner,
        repo: repoName,
        filter: opts.filter as WatchedRepo["filter"],
      });

      await saveWatchConfig(ctx.store, config);
      console.log(chalk.green(`\n  ✓ Now watching ${chalk.bold(repo)} (filter: ${opts.filter})\n`));
    });

  watch
    .command("remove <repo>")
    .description("Stop watching a repo")
    .action(async (repo: string) => {
      const [owner, repoName] = repo.split("/");
      let config = await loadWatchConfig(ctx.store);
      const before = config.length;
      config = config.filter((r) => !(r.owner === owner && r.repo === repoName));

      if (config.length === before) {
        ctx.logger.info(`Not watching ${repo}`);
        return;
      }

      await saveWatchConfig(ctx.store, config);
      console.log(chalk.gray(`\n  ○ Stopped watching ${repo}\n`));
    });

  watch
    .command("list")
    .description("Show watched repos")
    .action(async () => {
      const config = await loadWatchConfig(ctx.store);
      if (config.length === 0) {
        console.log(chalk.gray(`\n  No repos being watched. Add one: ${chalk.cyan("yak review watch add owner/repo")}\n`));
        return;
      }

      console.log(chalk.bold(`\n🦬 Watched Repos (${config.length})\n`));
      for (const r of config) {
        const lastChecked = r.lastChecked ? chalk.gray(` (last: ${r.lastChecked.split("T")[0]})`) : "";
        console.log(`  ${chalk.green("●")} ${r.owner}/${r.repo} — filter: ${r.filter}${lastChecked}`);
      }
      console.log();
    });

  watch
    .command("status")
    .alias("check")
    .description("Check for PRs needing attention")
    .option("--once", "Single check (don't poll)")
    .action(async () => {
      const config = await loadWatchConfig(ctx.store);
      if (config.length === 0) {
        console.log(chalk.gray(`\n  No repos being watched.\n`));
        return;
      }

      console.log(chalk.bold("\n🦬 Checking for PRs needing review...\n"));

      const allPending: PendingPR[] = [];

      for (const watched of config) {
        try {
          const prs = await fetchOpenPRs(watched);
          watched.lastChecked = new Date().toISOString();

          for (const pr of prs) {
            allPending.push({
              repo: `${watched.owner}/${watched.repo}`,
              number: pr.number,
              title: pr.title,
              author: pr.user?.login ?? "unknown",
              createdAt: pr.created_at,
              url: pr.html_url,
            });
          }
        } catch (err) {
          console.log(chalk.yellow(`  ⚠ ${watched.owner}/${watched.repo}: ${(err as Error).message}`));
        }
      }

      await saveWatchConfig(ctx.store, config);

      if (allPending.length === 0) {
        console.log(chalk.green("  ✓ No PRs needing review right now.\n"));
        return;
      }

      // Notify
      process.stdout.write("\x07"); // terminal bell

      console.log(chalk.bold(`  📬 ${allPending.length} PR(s) need attention:\n`));
      for (const pr of allPending) {
        console.log(`  ${chalk.cyan(`#${pr.number}`)} ${pr.title}`);
        console.log(chalk.gray(`    ${pr.repo} by @${pr.author} — ${pr.createdAt.split("T")[0]}`));
      }
      console.log(chalk.gray(`\n  Add to queue: ${chalk.cyan("yak review add <numbers...>")}\n`));
    });
}

async function loadWatchConfig(store: OKFStore): Promise<WatchedRepo[]> {
  const doc = await store.read("watch.md");
  if (!doc) return [];
  return (doc.data.repos as WatchedRepo[]) ?? [];
}

async function saveWatchConfig(store: OKFStore, repos: WatchedRepo[]): Promise<void> {
  const cleanData = JSON.parse(JSON.stringify({
    type: "yak/watch",
    repos,
    lastUpdated: new Date().toISOString(),
  }));

  const body = [
    "# Watch Configuration",
    "",
    `Monitoring ${repos.length} repo(s) for new PRs.`,
    "",
    ...repos.map((r) => `- ${r.owner}/${r.repo} (filter: ${r.filter})`),
    "",
  ].join("\n");

  await store.write("watch.md", cleanData, body);
}

async function fetchOpenPRs(watched: WatchedRepo): Promise<Array<{ number: number; title: string; user?: { login: string }; created_at: string; html_url: string }>> {
  const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
  if (!token) throw new Error("No GitHub token (set GITHUB_TOKEN)");

  let url = `https://api.github.com/repos/${watched.owner}/${watched.repo}/pulls?state=open&per_page=10`;

  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github.v3+json",
      "User-Agent": "yak-cli",
    },
    signal: AbortSignal.timeout(15000),
  });

  if (!res.ok) throw new Error(`API ${res.status}`);
  return await res.json() as any[];
}

/**
 * `lgtm review watch` — poll watched repos and review their open PRs.
 *
 *   lgtm review watch add <owner/repo>     start watching
 *   lgtm review watch remove <owner/repo>  stop watching
 *   lgtm review watch list                 show watched repos
 *   lgtm review watch status               show open PRs, without reviewing
 *   lgtm review watch auto                 poll and review (also `lgtm watch`)
 *
 * The review cycle posts nothing. It leaves findings in the store for a human
 * to look at, and `lgtm review post` is what reaches GitHub.
 */

import type { Command } from "commander";
import type { LGTMContext } from "@lgtm/core/plugin.js";
import chalk from "chalk";
import {
  loadWatchList,
  saveWatchList,
  addToWatchList,
  removeFromWatchList,
  type WatchedRepo,
} from "@lgtm/core/registry/watch-list.js";

interface PendingPR {
  repo: string;
  number: number;
  title: string;
  author: string;
  createdAt: string;
  url: string;
}

export function registerWatchCommand(program: Command, ctx: LGTMContext) {
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
        ctx.logger.error("Format: owner/repo (e.g., pszf11235/lgtm)");
        return;
      }

      const result = addToWatchList(ctx.lgtmDir, {
        owner,
        repo: repoName,
        filter: opts.filter as WatchedRepo["filter"],
      });

      if (!result.changed) {
        ctx.logger.info(`${repo}: ${result.reason}`);
        return;
      }

      console.log(chalk.green(`\n  ✓ Now watching ${chalk.bold(repo)} (filter: ${opts.filter})\n`));
    });

  watch
    .command("remove <repo>")
    .description("Stop watching a repo")
    .action(async (repo: string) => {
      const [owner, repoName] = repo.split("/");
      const result = removeFromWatchList(ctx.lgtmDir, owner, repoName);

      if (!result.changed) {
        ctx.logger.info(`${repo}: ${result.reason}`);
        return;
      }

      console.log(chalk.gray(`\n  ○ Stopped watching ${repo}\n`));
    });

  watch
    .command("list")
    .description("Show watched repos")
    .action(async () => {
      const config = loadWatchList(ctx.lgtmDir);
      if (config.length === 0) {
        console.log(chalk.gray(`\n  No repos being watched. Add one: ${chalk.cyan("lgtm review watch add owner/repo")}\n`));
        return;
      }

      console.log(chalk.bold(`\n👍 Watched Repos (${config.length})\n`));
      for (const r of config) {
        const lastChecked = r.lastChecked ? chalk.gray(` (last: ${r.lastChecked.split("T")[0]})`) : "";
        console.log(`  ${chalk.green("●")} ${r.owner}/${r.repo} — filter: ${r.filter}${lastChecked}`);
      }
      console.log();
    });

  watch
    .command("status")
    .alias("check")
    .description("Check for PRs needing attention (new since last check)")
    .option("--all", "Show all open PRs, not just new ones since last check")
    .action(async (opts: { all?: boolean }) => {
      const config = loadWatchList(ctx.lgtmDir);
      if (config.length === 0) {
        console.log(chalk.gray(`\n  No repos being watched.\n`));
        return;
      }

      console.log(chalk.bold("\n👍 Checking for PRs needing review...\n"));

      const allPending: PendingPR[] = [];

      for (const watched of config) {
        try {
          const prs = await fetchOpenPRs(watched);
          const previousCheck = watched.lastChecked;
          watched.lastChecked = new Date().toISOString();

          for (const pr of prs) {
            // Filter: only show PRs created or updated since last check
            // On first run (no lastChecked), show all. --all bypasses filter.
            if (previousCheck && !opts.all) {
              const prDate = new Date(pr.created_at);
              const lastCheck = new Date(previousCheck);
              if (prDate < lastCheck) continue; // skip PRs from before last check
            }

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

      saveWatchList(ctx.lgtmDir, config);

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
      console.log(chalk.gray(`\n  Add to queue: ${chalk.cyan("lgtm review add <numbers...>")}\n`));
    });

  // ── watch auto — poll and review, posting nothing ──────────────────────
  registerAutoWatch(watch, ctx);
}

/**
 * `lgtm review watch auto`, also reachable as the top-level `lgtm watch`.
 *
 * Runs a cycle immediately and then every `--interval` minutes. It used to
 * default to a single run despite the help text promising 15 minutes, so
 * `lgtm watch` did one pass and exited.
 *
 * Nothing is posted. The cycle leaves findings on disk for a human to look at,
 * which is the point of the tool.
 */
export function registerAutoWatch(parent: Command, ctx: LGTMContext) {
  parent
    .command("auto", { isDefault: false })
    .description("Poll watched repos and review new PRs locally (posts nothing)")
    .option("--interval <minutes>", "Poll interval in minutes, 0 for a single run", "15")
    .option("--once", "Run a single cycle and exit")
    .action(async (opts: { interval?: string; once?: boolean }) => {
      await runWatch(ctx, opts);
    });
}

/**
 * The watch loop, shared by `lgtm review watch auto` and `lgtm watch`.
 */
export async function runWatch(
  ctx: LGTMContext,
  opts: { interval?: string; once?: boolean }
): Promise<void> {
  const { loadEnabledAgents } = await import("@lgtm/core/store/agents.js");
  const { detectProviders } = await import("@lgtm/core/ai/providers.js");
  const { runCycle } = await import("../domain/watch-cycle.js");
  const { createRulesEngine, rulesAsPromptContext } = await import("../domain/rules.js");

  const repos = loadWatchList(ctx.lgtmDir);
  if (repos.length === 0) {
    console.log(chalk.gray(`\n  No repos watched yet.`));
    console.log(chalk.gray(`  Find local ones: ${chalk.cyan("lgtm discover --ingest")}`));
    console.log(chalk.gray(`  Or add one: ${chalk.cyan("lgtm review watch add owner/repo")}\n`));
    return;
  }

  const agents = loadEnabledAgents(ctx.lgtmDir);
  if (agents.length === 0) {
    console.log(chalk.yellow(`\n  Every agent in ${chalk.cyan("agents/")} is disabled, so there is nothing to run.\n`));
    return;
  }

  // Fail before polling rather than per PR. Without a provider every PR would
  // produce an identical error, which reads like many problems instead of one.
  const statuses = await detectProviders();
  if (!statuses.some((s) => s.available)) {
    console.log(chalk.yellow(`\n  No review provider is available, so reviews cannot run.\n`));
    for (const s of statuses) {
      console.log(chalk.gray(`    ${s.id.padEnd(12)} ${s.detail}`));
    }
    console.log(chalk.gray(`\n  Details: ${chalk.cyan("lgtm ai discover")}\n`));
    return;
  }

  // Interval 0 and --once both mean a single pass.
  const requested = parseInt(opts.interval ?? "15", 10);
  const interval = opts.once ? 0 : Number.isFinite(requested) && requested > 0 ? requested : 0;

  const rules = await createRulesEngine(ctx.store).loadRules();
  const ruleContext = rulesAsPromptContext(rules);

  console.log(chalk.bold(`\n👍 LGTM Watch\n`));
  console.log(chalk.gray(`  Repos:     ${repos.map((r) => `${r.owner}/${r.repo}`).join(", ")}`));
  console.log(chalk.gray(`  Agents:    ${agents.map((a) => `${a.name} (${a.provider})`).join(", ")}`));
  console.log(chalk.gray(`  Providers: ${statuses.filter((s) => s.available).map((s) => s.id).join(", ")}`));
  console.log(
    chalk.gray(interval > 0 ? `  Interval:  every ${interval} min` : `  Interval:  single run`)
  );
  console.log(chalk.gray(`  Posting:   nothing, findings stay local\n`));

  const deps = await buildCycleDeps();

  const cycle = async () => {
    const result = await runCycle(ctx.lgtmDir, loadWatchList(ctx.lgtmDir), agents, deps, ruleContext, {
      info: (m) => console.log(chalk.gray(`    ${m}`)),
      warn: (m) => console.log(chalk.yellow(`    ${m}`)),
      error: (m) => console.log(chalk.red(`    ${m}`)),
    });

    printCycle(result);
  };

  await cycle();

  if (interval === 0) return;

  console.log(chalk.gray(`  Next check in ${interval} min. Ctrl+C to stop.\n`));

  const timer = setInterval(async () => {
    console.log(chalk.gray(`─── ${new Date().toLocaleTimeString()} ───\n`));
    await cycle();
    console.log(chalk.gray(`  Next check in ${interval} min.\n`));
  }, interval * 60 * 1000);

  process.on("SIGINT", () => {
    clearInterval(timer);
    console.log(chalk.gray("\n  Stopped watching.\n"));
    process.exit(0);
  });

  await new Promise(() => {});
}

/** Wire the cycle to the real GitHub API. */
async function buildCycleDeps() {
  const { createGitHubAdapter } = await import("../infra/github.js");

  return {
    fetchDiff: async (owner: string, repo: string, pr: number) =>
      createGitHubAdapter(owner, repo).fetchDiff(pr),
    fetchOpenPRs: async (watched: WatchedRepo) => {
      const prs = await fetchOpenPRs(watched);
      return prs.map((pr) => ({
        number: pr.number,
        title: pr.title,
        author: pr.user?.login ?? "unknown",
        createdAt: pr.created_at,
        url: pr.html_url,
        headSha: pr.head?.sha ?? "",
      }));
    },
  };
}

/** Report a cycle, naming the repo on every line. */
function printCycle(result: Awaited<ReturnType<typeof import("../domain/watch-cycle.js").runCycle>>) {
  for (const repo of result.repos) {
    if (repo.error) {
      console.log(chalk.yellow(`  ⚠ ${repo.repo}: ${repo.error}`));
      continue;
    }

    if (repo.prs.length === 0) {
      console.log(chalk.gray(`  ${repo.repo}: no open PRs`));
      continue;
    }

    console.log(chalk.bold(`  ${repo.repo}`));

    for (const { pr, result: outcome } of repo.prs) {
      const label = `#${pr.number} ${pr.title}`;

      switch (outcome.action) {
        case "reviewed":
          console.log(`    ${chalk.green("✓")} ${label} — round ${outcome.round}, ${outcome.findings} finding(s)`);
          break;
        case "re-reviewed":
          console.log(
            `    ${chalk.green("✓")} ${label} — round ${outcome.round}, ${outcome.findings} finding(s), ` +
            `${outcome.resolved} earlier resolved, ${outcome.unresolved} still open`
          );
          break;
        case "skipped":
          console.log(chalk.gray(`    · ${label} — ${outcome.reason}`));
          break;
        case "failed":
          console.log(chalk.red(`    ✗ ${label} — ${outcome.reason}`));
          break;
      }
    }
  }

  const parts: string[] = [];
  if (result.reviewed > 0) parts.push(`${result.reviewed} reviewed`);
  if (result.reReviewed > 0) parts.push(`${result.reReviewed} re-reviewed`);
  if (result.failed > 0) parts.push(`${result.failed} failed`);

  console.log("");
  if (parts.length === 0) {
    console.log(chalk.gray(`  Nothing to review.\n`));
    return;
  }

  console.log(chalk.bold(`  ${parts.join(", ")}, ${result.findings} finding(s) total\n`));
  if (result.findings > 0) {
    console.log(chalk.gray(`  Review them: ${chalk.cyan("lgtm review list")}`));
    console.log(chalk.gray(`  Then post:   ${chalk.cyan("lgtm review post <owner/repo#pr>")}\n`));
  }
}

interface GitHubPR {
  number: number;
  title: string;
  user?: { login: string };
  created_at: string;
  html_url: string;
  head?: { sha: string };
  requested_reviewers?: Array<{ login: string }>;
  assignees?: Array<{ login: string }>;
}

/**
 * Every open PR for a watched repo.
 *
 * Paginates. It used to request a single page of 10 and stop, so a repo with
 * more than 10 open PRs silently never had the rest reviewed.
 *
 * The stored `filter` is applied too. It was accepted by `watch add` and then
 * ignored, so `--filter review_requested` did nothing.
 */
async function fetchOpenPRs(watched: WatchedRepo): Promise<GitHubPR[]> {
  const { resolveGitHubToken } = await import("@lgtm/core/auth/github-oauth.js");
  const token = resolveGitHubToken();
  if (!token) throw new Error("No GitHub token — run `gh auth login` or set GITHUB_TOKEN");

  const perPage = 100;
  const maxPages = 10; // 1000 open PRs is far past anything worth polling.
  const all: GitHubPR[] = [];

  for (let page = 1; page <= maxPages; page++) {
    const url =
      `https://api.github.com/repos/${watched.owner}/${watched.repo}/pulls` +
      `?state=open&per_page=${perPage}&page=${page}&sort=created&direction=asc`;

    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "User-Agent": "lgtm-cli",
      },
      signal: AbortSignal.timeout(15000),
    });

    if (!res.ok) throw new Error(`GitHub API ${res.status} listing PRs`);

    const batch = (await res.json()) as GitHubPR[];
    all.push(...batch);

    if (batch.length < perPage) break;
  }

  return filterPRs(all, watched.filter, await currentLogin(token));
}

/** The authenticated user, for the assigned and review_requested filters. */
async function currentLogin(token: string): Promise<string | null> {
  try {
    const res = await fetch("https://api.github.com/user", {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "User-Agent": "lgtm-cli",
      },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return null;
    const user = (await res.json()) as { login?: string };
    return user.login ?? null;
  } catch {
    return null;
  }
}

/**
 * Apply a watch filter.
 *
 * Exported for testing. When the login cannot be resolved the filter is not
 * applied, because reviewing every PR is a better failure than silently
 * reviewing none.
 */
export function filterPRs(
  prs: GitHubPR[],
  filter: WatchedRepo["filter"],
  login: string | null
): GitHubPR[] {
  if (filter === "all" || !login) return prs;

  if (filter === "assigned") {
    return prs.filter((pr) => pr.assignees?.some((a) => a.login === login));
  }

  if (filter === "review_requested") {
    return prs.filter((pr) => pr.requested_reviewers?.some((r) => r.login === login));
  }

  return prs;
}

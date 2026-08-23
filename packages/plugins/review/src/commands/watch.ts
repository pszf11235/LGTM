/**
 * `lgtm review watch` — Monitor repos for new PRs needing review.
 *
 * Commands:
 *   lgtm review watch add <owner/repo>   — add a repo to watch list
 *   lgtm review watch list               — show watched repos + pending PRs
 *   lgtm review watch remove <owner/repo> — stop watching
 *   lgtm review watch status             — show PRs needing attention
 *   lgtm review watch auto               — auto-review new PRs with AI
 *   lgtm review watch --once             — single check (good for cron)
 */

import type { Command } from "commander";
import type { LGTMContext } from "@lgtm/core/plugin.js";
import chalk from "chalk";
import type { OKFStore } from "@lgtm/core/plugin.js";

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
      const config = await loadWatchConfig(ctx.store);
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
      console.log(chalk.gray(`\n  Add to queue: ${chalk.cyan("lgtm review add <numbers...>")}\n`));
    });

  // ── watch auto — poll and auto-review new PRs ──────────────────────────
  watch
    .command("auto")
    .description("Auto-review new PRs from watched repos using AI")
    .option("--severity <level>", "Minimum severity: low, medium, high, critical", "high")
    .option("--dry-run", "Show findings without posting to GitHub")
    .option("--interval <minutes>", "Poll interval in minutes (default: 15, 0 = single run)", "0")
    .option("--no-batch", "Post comments individually with delays")
    .action(async (opts: { severity?: string; dryRun?: boolean; interval?: string; batch?: boolean }) => {
      const { resolveGitHubToken, describeMissingGitHubToken } = await import(
        "@lgtm/core/auth/github-oauth.js"
      );
      const token = resolveGitHubToken();
      if (!token) {
        for (const line of describeMissingGitHubToken()) console.log(`  ${line}`);
        return;
      }

      if (!ctx.llm) {
        ctx.logger.error("AI is not configured. Run `lgtm ai test` to set up.");
        return;
      }

      const aiAvailable = await ctx.llm.isAvailable();
      if (!aiAvailable) {
        ctx.logger.error("AI provider is not reachable. Check your API key.");
        return;
      }

      const config = await loadWatchConfig(ctx.store);
      if (config.length === 0) {
        console.log(chalk.gray(`\n  No repos being watched. Add one: ${chalk.cyan("lgtm review watch add owner/repo")}\n`));
        return;
      }

      const interval = parseInt(opts.interval ?? "0", 10);

      console.log(chalk.bold(`\n🤖 LGTM Watch Auto-Review\n`));
      console.log(chalk.gray(`  Watching ${config.length} repo(s)`));
      console.log(chalk.gray(`  Severity: ${opts.severity ?? "high"}`));
      console.log(chalk.gray(`  Mode: ${opts.dryRun ? "dry-run" : opts.batch === false ? "individual" : "batched"}`));
      if (interval > 0) {
        console.log(chalk.gray(`  Polling every ${interval} minute(s)`));
      } else {
        console.log(chalk.gray(`  Single run (use --interval to poll)`));
      }
      console.log("");

      // Run the auto-review cycle
      await runAutoReviewCycle(ctx, config, token, opts);

      // If interval > 0, poll
      if (interval > 0) {
        console.log(chalk.gray(`\n  Next check in ${interval} minute(s)... (Ctrl+C to stop)\n`));
        const timer = setInterval(async () => {
          console.log(chalk.gray(`\n─── ${new Date().toLocaleTimeString()} ───\n`));
          const freshConfig = await loadWatchConfig(ctx.store);
          await runAutoReviewCycle(ctx, freshConfig, token, opts);
          console.log(chalk.gray(`\n  Next check in ${interval} minute(s)...\n`));
        }, interval * 60 * 1000);

        // Clean exit on Ctrl+C
        process.on("SIGINT", () => {
          clearInterval(timer);
          console.log(chalk.gray("\n  Stopped watching.\n"));
          process.exit(0);
        });

        // Keep process alive
        await new Promise(() => {});
      }
    });
}

/**
 * Run one auto-review cycle across all watched repos.
 * Finds PRs not yet reviewed, runs AI review, and posts findings.
 */
async function runAutoReviewCycle(
  ctx: LGTMContext,
  watchedRepos: WatchedRepo[],
  token: string,
  opts: { severity?: string; dryRun?: boolean; batch?: boolean }
) {
  const { createGitHubAdapter } = await import("../infra/github.js");
  const { parseDiff } = await import("../domain/diff-parser.js");
  const { generateAutoReview } = await import("../domain/auto-review.js");
  const { postReviewFindings } = await import("../domain/post-review.js");
  const { fetchExistingComments } = await import("../domain/post-review.js");
  const { createRulesEngine } = await import("../domain/rules.js");
  const { getProviderForTask } = await import("@lgtm/core/llm/provider.js");

  // Load rules once for the whole cycle
  const engine = createRulesEngine(ctx.store);
  const rules = await engine.loadRules();
  const enabledRules = rules.filter((r) => r.enabled);

  // Resolve LLM provider for review_delegation task
  let llm = ctx.llm!;
  try {
    llm = getProviderForTask(ctx.config.ai as any, "review_delegation");
  } catch { /* fallback to default */ }

  // Track which PRs we've already reviewed (from store)
  const reviewedPRs = await loadReviewedPRs(ctx.store);

  let totalReviewed = 0;
  let totalFindings = 0;

  for (const watched of watchedRepos) {
    const repoStr = `${watched.owner}/${watched.repo}`;

    try {
      const openPRs = await fetchOpenPRs(watched);
      const newPRs = openPRs.filter((pr) => !reviewedPRs.has(`${repoStr}#${pr.number}`));

      if (newPRs.length === 0) {
        console.log(chalk.gray(`  ${repoStr}: no new PRs`));
        continue;
      }

      console.log(chalk.bold(`  ${repoStr}: ${newPRs.length} new PR(s) to review`));

      const github = createGitHubAdapter(watched.owner, watched.repo);

      for (const pr of newPRs) {
        console.log(chalk.gray(`\n    → PR #${pr.number}: ${pr.title}`));

        try {
          // Fetch diff
          const rawDiff = await github.fetchDiff(pr.number);
          if (!rawDiff || rawDiff.trim().length === 0) {
            console.log(chalk.gray(`      (empty diff — skipping)`));
            await markReviewed(ctx.store, repoStr, pr.number);
            continue;
          }

          const diff = parseDiff(rawDiff);
          if (diff.files.length === 0) {
            console.log(chalk.gray(`      (no parseable files — skipping)`));
            await markReviewed(ctx.store, repoStr, pr.number);
            continue;
          }

          // Fetch existing comments for dedup
          const existingComments = await fetchExistingComments(pr.number, watched.owner, watched.repo);

          // Run AI review
          const severity = (opts.severity ?? "high") as any;
          const result = await generateAutoReview(
            diff,
            enabledRules,
            ctx.profile,
            llm,
            existingComments.map((c) => ({ file: c.file, line: c.line, body: c.body })),
            { severityThreshold: severity }
          );

          if (result.findings.length === 0) {
            console.log(chalk.green(`      ✓ No issues found`));
          } else {
            console.log(chalk.yellow(`      ${result.findings.length} finding(s)`));
            totalFindings += result.findings.length;

            // Post findings
            const postResult = await postReviewFindings(
              pr.number,
              result,
              github,
              {
                dryRun: opts.dryRun ?? false,
                batchMode: opts.batch !== false,
                commentDelay: [20, 90],
                rateLimitThreshold: 10,
              },
              {
                info: (msg) => console.log(chalk.gray(`      ${msg}`)),
                warn: (msg) => console.log(chalk.yellow(`      ${msg}`)),
                error: (msg) => console.log(chalk.red(`      ${msg}`)),
              }
            );

            if (opts.dryRun) {
              console.log(chalk.cyan(`      (dry-run — not posted)`));
            } else if (postResult.posted > 0) {
              console.log(chalk.green(`      ✓ Posted ${postResult.posted} comment(s)`));
            }
          }

          // Mark as reviewed
          await markReviewed(ctx.store, repoStr, pr.number);
          totalReviewed++;
        } catch (err) {
          console.log(chalk.red(`      ✗ Error: ${(err as Error).message}`));
        }
      }
    } catch (err) {
      console.log(chalk.yellow(`  ⚠ ${repoStr}: ${(err as Error).message}`));
    }
  }

  // Summary
  if (totalReviewed > 0) {
    console.log(chalk.bold(`\n  ─── Summary: ${totalReviewed} PR(s) reviewed, ${totalFindings} finding(s) ───`));
  } else {
    console.log(chalk.gray(`\n  No new PRs to review.`));
  }
}

/**
 * Load the set of PRs already auto-reviewed (to avoid re-reviewing).
 */
async function loadReviewedPRs(store: OKFStore): Promise<Set<string>> {
  try {
    const doc = await store.read("auto-reviewed.md");
    if (!doc?.data?.reviewed || !Array.isArray(doc.data.reviewed)) return new Set();
    return new Set(doc.data.reviewed as string[]);
  } catch {
    return new Set();
  }
}

/**
 * Mark a PR as auto-reviewed so we don't review it again.
 */
async function markReviewed(store: OKFStore, repo: string, prNumber: number): Promise<void> {
  const existing = await loadReviewedPRs(store);
  existing.add(`${repo}#${prNumber}`);

  const cleanData = JSON.parse(JSON.stringify({
    type: "lgtm/auto-reviewed",
    lastUpdated: new Date().toISOString(),
    reviewed: Array.from(existing),
  }));

  await store.write("auto-reviewed.md", cleanData, "# Auto-Reviewed PRs\n\nPRs that have been auto-reviewed (won't be reviewed again).");
}

async function loadWatchConfig(store: OKFStore): Promise<WatchedRepo[]> {
  const doc = await store.read("watch.md");
  if (!doc) return [];
  return (doc.data.repos as WatchedRepo[]) ?? [];
}

async function saveWatchConfig(store: OKFStore, repos: WatchedRepo[]): Promise<void> {
  const cleanData = JSON.parse(JSON.stringify({
    type: "lgtm/watch",
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
  const { resolveGitHubToken } = await import("@lgtm/core/auth/github-oauth.js");
  const token = resolveGitHubToken();
  if (!token) throw new Error("No GitHub token — run `gh auth login` or set GITHUB_TOKEN");

  let url = `https://api.github.com/repos/${watched.owner}/${watched.repo}/pulls?state=open&per_page=10`;

  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github.v3+json",
      "User-Agent": "lgtm-cli",
    },
    signal: AbortSignal.timeout(15000),
  });

  if (!res.ok) throw new Error(`API ${res.status}`);
  return await res.json() as any[];
}

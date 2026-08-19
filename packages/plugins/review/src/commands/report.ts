/**
 * `lgtm review report` — PR status report across watched repos.
 *
 * Shows all open PRs with:
 * - Age (highlights overdue >3 days)
 * - CI status (passing/failing/pending)
 * - Review status (approved/changes requested/pending)
 * - Merge conflicts
 * - Recommendation (ready to merge, needs attention, blocked)
 *
 * Usage:
 *   lgtm review report              (all watched repos)
 *   lgtm review report --repo owner/repo
 *   lgtm review report --json       (machine-readable output)
 *
 * @module commands/report
 */

import type { Command } from "commander";
import type { LGTMContext, OKFStore } from "@lgtm/core/plugin.js";
import chalk from "chalk";

// ─── Types ──────────────────────────────────────────────────────────────────

interface WatchedRepo {
  owner: string;
  repo: string;
  filter: string;
}

interface PRStatus {
  number: number;
  title: string;
  author: string;
  repo: string;
  url: string;
  createdAt: string;
  updatedAt: string;
  ageHours: number;
  draft: boolean;
  mergeable: boolean | null;
  ci: "passing" | "failing" | "pending" | "unknown";
  review: "approved" | "changes_requested" | "pending" | "dismissed";
  reviewers: string[];
  additions: number;
  deletions: number;
  changedFiles: number;
  recommendation: "ready" | "needs_attention" | "blocked" | "stale";
}

interface ReportOptions {
  repo?: string;
  json?: boolean;
}

// ─── Command Registration ───────────────────────────────────────────────────

export function registerReportCommand(program: Command, ctx: LGTMContext) {
  program
    .command("report")
    .description("PR status report across watched repos")
    .option("--repo <owner/repo>", "Report on a specific repo only")
    .option("--json", "Output as JSON (machine-readable)")
    .action(async (opts: ReportOptions) => {
      await runReport(ctx, opts);
    });
}

// ─── Main Execution ─────────────────────────────────────────────────────────

async function runReport(ctx: LGTMContext, opts: ReportOptions) {
  const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
  if (!token) {
    ctx.logger.error("Set GITHUB_TOKEN to use the report command.");
    return;
  }

  // ── Resolve repos to check ─────────────────────────────────────────────

  let repos: WatchedRepo[];

  if (opts.repo) {
    const [owner, repo] = opts.repo.split("/");
    if (!owner || !repo) {
      ctx.logger.error("Format: owner/repo");
      return;
    }
    repos = [{ owner, repo, filter: "all" }];
  } else {
    repos = await loadWatchConfig(ctx.store);
    if (repos.length === 0) {
      console.log(chalk.gray(`\n  No repos being watched. Add one: ${chalk.cyan("lgtm review watch add owner/repo")}\n`));
      return;
    }
  }

  if (!opts.json) {
    console.log(chalk.bold(`\n📊 PR Status Report\n`));
    console.log(chalk.gray(`  Checking ${repos.length} repo(s)...\n`));
  }

  // ── Fetch PR statuses ──────────────────────────────────────────────────

  const allStatuses: PRStatus[] = [];

  for (const watched of repos) {
    try {
      const statuses = await fetchPRStatuses(watched.owner, watched.repo, token);
      allStatuses.push(...statuses);
    } catch (err) {
      if (!opts.json) {
        console.log(chalk.yellow(`  ⚠ ${watched.owner}/${watched.repo}: ${(err as Error).message}`));
      }
    }
  }

  if (allStatuses.length === 0) {
    if (opts.json) {
      console.log(JSON.stringify({ prs: [], summary: { total: 0 } }));
    } else {
      console.log(chalk.green("  ✓ No open PRs across watched repos.\n"));
    }
    return;
  }

  // ── Sort: blocked first, then by age (oldest first) ────────────────────

  const sortOrder = { blocked: 0, needs_attention: 1, stale: 2, ready: 3 };
  allStatuses.sort((a, b) => {
    if (sortOrder[a.recommendation] !== sortOrder[b.recommendation]) {
      return sortOrder[a.recommendation] - sortOrder[b.recommendation];
    }
    return b.ageHours - a.ageHours;
  });

  // ── Output ─────────────────────────────────────────────────────────────

  if (opts.json) {
    outputJSON(allStatuses);
  } else {
    outputTable(allStatuses);
  }
}

// ─── Output Formatters ──────────────────────────────────────────────────────

function outputJSON(statuses: PRStatus[]) {
  const summary = buildSummary(statuses);
  console.log(JSON.stringify({ prs: statuses, summary }, null, 2));
}

function outputTable(statuses: PRStatus[]) {
  const summary = buildSummary(statuses);

  // Group by recommendation
  const ready = statuses.filter((s) => s.recommendation === "ready");
  const needsAttention = statuses.filter((s) => s.recommendation === "needs_attention");
  const blocked = statuses.filter((s) => s.recommendation === "blocked");
  const stale = statuses.filter((s) => s.recommendation === "stale");

  // Ready to merge
  if (ready.length > 0) {
    console.log(chalk.green.bold(`  ✓ Ready to Merge (${ready.length})`));
    console.log("");
    for (const pr of ready) {
      printPRLine(pr);
    }
    console.log("");
  }

  // Needs attention
  if (needsAttention.length > 0) {
    console.log(chalk.yellow.bold(`  ⚠ Needs Attention (${needsAttention.length})`));
    console.log("");
    for (const pr of needsAttention) {
      printPRLine(pr);
    }
    console.log("");
  }

  // Blocked
  if (blocked.length > 0) {
    console.log(chalk.red.bold(`  ✗ Blocked (${blocked.length})`));
    console.log("");
    for (const pr of blocked) {
      printPRLine(pr);
    }
    console.log("");
  }

  // Stale
  if (stale.length > 0) {
    console.log(chalk.gray.bold(`  ○ Stale / >3 days (${stale.length})`));
    console.log("");
    for (const pr of stale) {
      printPRLine(pr);
    }
    console.log("");
  }

  // Summary line
  console.log(chalk.bold("  ─────────────────────────────────────────"));
  console.log(`  ${chalk.bold(String(summary.total))} open PR(s): ${chalk.green(`${summary.ready} ready`)} · ${chalk.yellow(`${summary.needsAttention} needs attention`)} · ${chalk.red(`${summary.blocked} blocked`)} · ${chalk.gray(`${summary.stale} stale`)}`);

  if (summary.failingCI > 0) {
    console.log(chalk.red(`  ${summary.failingCI} with failing CI`));
  }
  if (summary.conflicts > 0) {
    console.log(chalk.red(`  ${summary.conflicts} with merge conflicts`));
  }
  console.log("");
}

function printPRLine(pr: PRStatus) {
  const ageStr = formatAge(pr.ageHours);
  const ageColor = pr.ageHours > 72 ? "red" : pr.ageHours > 24 ? "yellow" : "green";
  const ciIcon = pr.ci === "passing" ? chalk.green("✓") : pr.ci === "failing" ? chalk.red("✗") : chalk.yellow("◌");
  const reviewIcon = pr.review === "approved" ? chalk.green("✓") : pr.review === "changes_requested" ? chalk.red("△") : chalk.gray("○");
  const conflictIcon = pr.mergeable === false ? chalk.red(" ⚡conflict") : "";
  const draftLabel = pr.draft ? chalk.gray(" [draft]") : "";

  console.log(`    ${ciIcon} ${reviewIcon} ${chalk.cyan(`#${pr.number}`)} ${pr.title.slice(0, 50)}${draftLabel}${conflictIcon}`);
  console.log(chalk.gray(`       ${pr.repo} · @${pr.author} · ${chalk[ageColor as any](ageStr)} · +${pr.additions} -${pr.deletions} (${pr.changedFiles} files)`));
}

// ─── Data Fetching ──────────────────────────────────────────────────────────

async function fetchPRStatuses(owner: string, repo: string, token: string): Promise<PRStatus[]> {
  // Fetch open PRs
  const prsRes = await ghFetch(
    `https://api.github.com/repos/${owner}/${repo}/pulls?state=open&per_page=30&sort=updated&direction=desc`,
    token
  );
  const prs = await prsRes.json() as any[];

  const statuses: PRStatus[] = [];

  for (const pr of prs) {
    const ageHours = Math.floor((Date.now() - new Date(pr.created_at).getTime()) / (1000 * 60 * 60));

    // Fetch CI status (combined status for head SHA)
    let ci: PRStatus["ci"] = "unknown";
    try {
      const statusRes = await ghFetch(
        `https://api.github.com/repos/${owner}/${repo}/commits/${pr.head.sha}/status`,
        token
      );
      const statusData = await statusRes.json() as any;
      ci = statusData.state === "success" ? "passing" :
           statusData.state === "failure" || statusData.state === "error" ? "failing" :
           statusData.state === "pending" ? "pending" : "unknown";

      // Also check check runs (GitHub Actions uses check runs, not statuses)
      if (ci === "unknown" || ci === "pending") {
        const checksRes = await ghFetch(
          `https://api.github.com/repos/${owner}/${repo}/commits/${pr.head.sha}/check-runs?per_page=10`,
          token
        );
        const checksData = await checksRes.json() as any;
        if (checksData.check_runs && checksData.check_runs.length > 0) {
          const allComplete = checksData.check_runs.every((c: any) => c.status === "completed");
          const anyFailed = checksData.check_runs.some((c: any) => c.conclusion === "failure" || c.conclusion === "cancelled");
          const allPassed = checksData.check_runs.every((c: any) => c.conclusion === "success" || c.conclusion === "skipped");

          if (allComplete && allPassed) ci = "passing";
          else if (anyFailed) ci = "failing";
          else if (!allComplete) ci = "pending";
        }
      }
    } catch {
      // CI status unavailable
    }

    // Fetch review status
    let review: PRStatus["review"] = "pending";
    let reviewers: string[] = [];
    try {
      const reviewsRes = await ghFetch(
        `https://api.github.com/repos/${owner}/${repo}/pulls/${pr.number}/reviews?per_page=20`,
        token
      );
      const reviews = await reviewsRes.json() as any[];
      const latestByUser = new Map<string, string>();
      for (const r of reviews) {
        if (r.state === "APPROVED" || r.state === "CHANGES_REQUESTED" || r.state === "DISMISSED") {
          latestByUser.set(r.user.login, r.state);
        }
      }
      reviewers = Array.from(latestByUser.keys());
      const states = Array.from(latestByUser.values());

      if (states.includes("CHANGES_REQUESTED")) review = "changes_requested";
      else if (states.includes("APPROVED")) review = "approved";
      else if (states.includes("DISMISSED")) review = "dismissed";
    } catch {
      // Review status unavailable
    }

    // Determine recommendation
    const recommendation = getRecommendation(ci, review, pr.mergeable, ageHours, pr.draft);

    statuses.push({
      number: pr.number,
      title: pr.title,
      author: pr.user?.login ?? "unknown",
      repo: `${owner}/${repo}`,
      url: pr.html_url,
      createdAt: pr.created_at,
      updatedAt: pr.updated_at,
      ageHours,
      draft: pr.draft ?? false,
      mergeable: pr.mergeable,
      ci,
      review,
      reviewers,
      additions: pr.additions ?? 0,
      deletions: pr.deletions ?? 0,
      changedFiles: pr.changed_files ?? 0,
      recommendation,
    });
  }

  return statuses;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function getRecommendation(
  ci: PRStatus["ci"],
  review: PRStatus["review"],
  mergeable: boolean | null,
  ageHours: number,
  draft: boolean
): PRStatus["recommendation"] {
  // Blocked: failing CI or merge conflict
  if (ci === "failing" || mergeable === false) return "blocked";

  // Ready: CI passing + approved + mergeable
  if (ci === "passing" && review === "approved" && mergeable !== false && !draft) return "ready";

  // Stale: open > 3 days with no recent activity
  if (ageHours > 72) return "stale";

  // Everything else needs attention
  return "needs_attention";
}

function buildSummary(statuses: PRStatus[]) {
  return {
    total: statuses.length,
    ready: statuses.filter((s) => s.recommendation === "ready").length,
    needsAttention: statuses.filter((s) => s.recommendation === "needs_attention").length,
    blocked: statuses.filter((s) => s.recommendation === "blocked").length,
    stale: statuses.filter((s) => s.recommendation === "stale").length,
    failingCI: statuses.filter((s) => s.ci === "failing").length,
    conflicts: statuses.filter((s) => s.mergeable === false).length,
  };
}

function formatAge(hours: number): string {
  if (hours < 1) return "just now";
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days === 1) return "1 day";
  return `${days} days`;
}

async function ghFetch(url: string, token: string): Promise<Response> {
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github.v3+json",
      "User-Agent": "lgtm-cli",
    },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`GitHub API ${res.status}`);
  return res;
}

async function loadWatchConfig(store: OKFStore): Promise<WatchedRepo[]> {
  const doc = await store.read("watch.md");
  if (!doc) return [];
  return (doc.data.repos as WatchedRepo[]) ?? [];
}

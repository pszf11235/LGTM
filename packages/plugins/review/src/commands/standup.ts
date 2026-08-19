/**
 * `lgtm review standup` — Daily standup summary.
 *
 * Summarizes yesterday's activity across watched repos:
 * - PRs merged
 * - PRs reviewed (comments posted)
 * - PRs opened
 * - Comments received on your PRs
 *
 * Suggests today's priorities based on open PR state.
 * Outputs markdown (paste into Slack/standup tool).
 *
 * Usage:
 *   lgtm review standup              (yesterday's activity + today's priorities)
 *   lgtm review standup --days 3     (last 3 days)
 *   lgtm review standup --markdown   (output as markdown, default)
 *   lgtm review standup --plain      (plain text, no markdown)
 *
 * @module commands/standup
 */

import type { Command } from "commander";
import type { LGTMContext, OKFStore } from "@lgtm/core/plugin.js";
import chalk from "chalk";

// ─── Types ──────────────────────────────────────────────────────────────────

interface WatchedRepo {
  owner: string;
  repo: string;
}

interface StandupActivity {
  type: "merged" | "reviewed" | "opened" | "commented";
  repo: string;
  prNumber: number;
  prTitle: string;
  url: string;
  timestamp: string;
  detail?: string;
}

interface StandupPriority {
  type: "review_needed" | "ci_failing" | "stale" | "conflict" | "changes_requested";
  repo: string;
  prNumber: number;
  prTitle: string;
  url: string;
  reason: string;
}

interface StandupOptions {
  days?: string;
  plain?: boolean;
}

// ─── Command Registration ───────────────────────────────────────────────────

export function registerStandupCommand(program: Command, ctx: LGTMContext) {
  program
    .command("standup")
    .description("Daily standup summary — what happened + today's priorities")
    .option("--days <n>", "Number of days to look back (default: 1)", "1")
    .option("--plain", "Plain text output (no markdown formatting)")
    .action(async (opts: StandupOptions) => {
      await runStandup(ctx, opts);
    });
}

// ─── Main Execution ─────────────────────────────────────────────────────────

async function runStandup(ctx: LGTMContext, opts: StandupOptions) {
  const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
  if (!token) {
    ctx.logger.error("Set GITHUB_TOKEN to use the standup command.");
    return;
  }

  const repos = await loadWatchConfig(ctx.store);
  if (repos.length === 0) {
    console.log(chalk.gray(`\n  No repos being watched. Add one: ${chalk.cyan("lgtm review watch add owner/repo")}\n`));
    return;
  }

  const days = parseInt(opts.days ?? "1", 10);
  const since = new Date();
  since.setDate(since.getDate() - days);
  const sinceISO = since.toISOString();

  const useMarkdown = !opts.plain;

  // ── Detect current user ────────────────────────────────────────────────

  const username = await detectUsername(token);

  // ── Gather activity ────────────────────────────────────────────────────

  const activities: StandupActivity[] = [];
  const priorities: StandupPriority[] = [];

  for (const watched of repos) {
    const repoStr = `${watched.owner}/${watched.repo}`;

    try {
      // Recently closed/merged PRs
      const merged = await fetchRecentlyMerged(watched.owner, watched.repo, sinceISO, token);
      for (const pr of merged) {
        const isMyPR = username && pr.user?.login === username;
        activities.push({
          type: "merged",
          repo: repoStr,
          prNumber: pr.number,
          prTitle: pr.title,
          url: pr.html_url,
          timestamp: pr.merged_at ?? pr.closed_at ?? pr.updated_at,
          detail: isMyPR ? "(your PR)" : `by @${pr.user?.login ?? "unknown"}`,
        });
      }

      // Open PRs (for priorities + recently opened)
      const open = await fetchOpenPRs(watched.owner, watched.repo, token);
      for (const pr of open) {
        const createdAt = new Date(pr.created_at);
        const isMyPR = username && pr.user?.login === username;
        const ageHours = Math.floor((Date.now() - createdAt.getTime()) / (1000 * 60 * 60));

        // Track recently opened
        if (createdAt >= since) {
          activities.push({
            type: "opened",
            repo: repoStr,
            prNumber: pr.number,
            prTitle: pr.title,
            url: pr.html_url,
            timestamp: pr.created_at,
            detail: isMyPR ? "(your PR)" : `by @${pr.user?.login ?? "unknown"}`,
          });
        }

        // Determine priorities for today
        if (!pr.draft) {
          if (ageHours > 72 && !isMyPR) {
            priorities.push({
              type: "stale",
              repo: repoStr,
              prNumber: pr.number,
              prTitle: pr.title,
              url: pr.html_url,
              reason: `Open ${formatAge(ageHours)} — needs review`,
            });
          } else if (!isMyPR && ageHours > 4) {
            priorities.push({
              type: "review_needed",
              repo: repoStr,
              prNumber: pr.number,
              prTitle: pr.title,
              url: pr.html_url,
              reason: `Awaiting review (${formatAge(ageHours)})`,
            });
          }

          // Check for merge conflicts on user's own PRs
          if (isMyPR && pr.mergeable === false) {
            priorities.push({
              type: "conflict",
              repo: repoStr,
              prNumber: pr.number,
              prTitle: pr.title,
              url: pr.html_url,
              reason: "Has merge conflicts — needs rebase",
            });
          }
        }
      }

      // Recent issue/PR comments by the user (reviews given)
      if (username) {
        const comments = await fetchRecentComments(watched.owner, watched.repo, sinceISO, username, token);
        for (const comment of comments) {
          activities.push({
            type: "reviewed",
            repo: repoStr,
            prNumber: comment.prNumber,
            prTitle: `PR #${comment.prNumber}`,
            url: comment.url,
            timestamp: comment.createdAt,
            detail: comment.snippet,
          });
        }
      }
    } catch {
      // Skip repos that fail
    }
  }

  // ── Deduplicate activities ─────────────────────────────────────────────

  const seen = new Set<string>();
  const dedupedActivities = activities.filter((a) => {
    const key = `${a.type}-${a.repo}-${a.prNumber}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  // Sort activities by timestamp (newest first)
  dedupedActivities.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

  // Deduplicate and sort priorities (stale first)
  const priorityOrder = { conflict: 0, stale: 1, ci_failing: 2, changes_requested: 3, review_needed: 4 };
  const seenPriorities = new Set<string>();
  const dedupedPriorities = priorities
    .filter((p) => {
      const key = `${p.repo}-${p.prNumber}`;
      if (seenPriorities.has(key)) return false;
      seenPriorities.add(key);
      return true;
    })
    .sort((a, b) => priorityOrder[a.type] - priorityOrder[b.type]);

  // ── Render output ──────────────────────────────────────────────────────

  if (useMarkdown) {
    outputMarkdown(dedupedActivities, dedupedPriorities, days, username);
  } else {
    outputPlain(dedupedActivities, dedupedPriorities, days);
  }
}

// ─── Output Formatters ──────────────────────────────────────────────────────

function outputMarkdown(activities: StandupActivity[], priorities: StandupPriority[], days: number, username?: string) {
  const lines: string[] = [];
  const dateStr = new Date().toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric" });

  lines.push(`## 📋 Standup — ${dateStr}`);
  lines.push("");

  // Yesterday section
  const periodLabel = days === 1 ? "Yesterday" : `Last ${days} days`;
  lines.push(`### ${periodLabel}`);
  lines.push("");

  if (activities.length === 0) {
    lines.push("_No tracked activity._");
  } else {
    const merged = activities.filter((a) => a.type === "merged");
    const reviewed = activities.filter((a) => a.type === "reviewed");
    const opened = activities.filter((a) => a.type === "opened");

    if (merged.length > 0) {
      lines.push("**Merged:**");
      for (const a of merged) {
        lines.push(`- [#${a.prNumber}](${a.url}) ${a.prTitle} ${a.detail ?? ""}`);
      }
      lines.push("");
    }

    if (reviewed.length > 0) {
      lines.push("**Reviewed:**");
      for (const a of reviewed) {
        lines.push(`- [#${a.prNumber}](${a.url}) ${a.prTitle}`);
      }
      lines.push("");
    }

    if (opened.length > 0) {
      lines.push("**Opened:**");
      for (const a of opened) {
        lines.push(`- [#${a.prNumber}](${a.url}) ${a.prTitle} ${a.detail ?? ""}`);
      }
      lines.push("");
    }
  }

  // Today section
  lines.push("### Today");
  lines.push("");

  if (priorities.length === 0) {
    lines.push("_No pending items. All clear!_ ✓");
  } else {
    for (const p of priorities) {
      const icon = p.type === "conflict" ? "⚡" :
                   p.type === "stale" ? "⏰" :
                   p.type === "ci_failing" ? "🔴" :
                   p.type === "changes_requested" ? "△" : "👀";
      lines.push(`- ${icon} [#${p.prNumber}](${p.url}) ${p.prTitle} — ${p.reason}`);
    }
  }

  lines.push("");
  lines.push("---");
  lines.push(`_Generated by lgtm at ${new Date().toISOString().split("T")[0]}${username ? ` for @${username}` : ""}_`);

  const output = lines.join("\n");
  console.log("\n" + output + "\n");
}

function outputPlain(activities: StandupActivity[], priorities: StandupPriority[], days: number) {
  const dateStr = new Date().toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric" });

  console.log(chalk.bold(`\n📋 Standup — ${dateStr}\n`));

  const periodLabel = days === 1 ? "Yesterday" : `Last ${days} days`;
  console.log(chalk.bold(`  ${periodLabel}:`));

  if (activities.length === 0) {
    console.log(chalk.gray("    No tracked activity."));
  } else {
    const merged = activities.filter((a) => a.type === "merged");
    const reviewed = activities.filter((a) => a.type === "reviewed");
    const opened = activities.filter((a) => a.type === "opened");

    if (merged.length > 0) {
      console.log(chalk.green(`    Merged (${merged.length}):`));
      for (const a of merged) {
        console.log(`      ${chalk.cyan(`#${a.prNumber}`)} ${a.prTitle} ${chalk.gray(a.detail ?? "")}`);
      }
    }
    if (reviewed.length > 0) {
      console.log(chalk.yellow(`    Reviewed (${reviewed.length}):`));
      for (const a of reviewed) {
        console.log(`      ${chalk.cyan(`#${a.prNumber}`)} ${a.prTitle}`);
      }
    }
    if (opened.length > 0) {
      console.log(chalk.blue(`    Opened (${opened.length}):`));
      for (const a of opened) {
        console.log(`      ${chalk.cyan(`#${a.prNumber}`)} ${a.prTitle} ${chalk.gray(a.detail ?? "")}`);
      }
    }
  }

  console.log("");
  console.log(chalk.bold("  Today's Priorities:"));

  if (priorities.length === 0) {
    console.log(chalk.green("    ✓ All clear! No pending items."));
  } else {
    for (const p of priorities) {
      const icon = p.type === "conflict" ? chalk.red("⚡") :
                   p.type === "stale" ? chalk.yellow("⏰") :
                   p.type === "ci_failing" ? chalk.red("●") :
                   p.type === "changes_requested" ? chalk.yellow("△") : chalk.cyan("👀");
      console.log(`    ${icon} ${chalk.cyan(`#${p.prNumber}`)} ${p.prTitle.slice(0, 45)}`);
      console.log(chalk.gray(`       ${p.reason}`));
    }
  }

  console.log("");
}

// ─── Data Fetching ──────────────────────────────────────────────────────────

async function detectUsername(token: string): Promise<string | undefined> {
  try {
    const res = await ghFetch("https://api.github.com/user", token);
    const data = await res.json() as any;
    return data.login;
  } catch {
    return undefined;
  }
}

async function fetchRecentlyMerged(
  owner: string,
  repo: string,
  since: string,
  token: string
): Promise<any[]> {
  const res = await ghFetch(
    `https://api.github.com/repos/${owner}/${repo}/pulls?state=closed&sort=updated&direction=desc&per_page=20`,
    token
  );
  const prs = await res.json() as any[];

  // Filter to merged PRs since the target date
  return prs.filter((pr) => {
    if (!pr.merged_at) return false;
    return new Date(pr.merged_at) >= new Date(since);
  });
}

async function fetchOpenPRs(owner: string, repo: string, token: string): Promise<any[]> {
  const res = await ghFetch(
    `https://api.github.com/repos/${owner}/${repo}/pulls?state=open&per_page=20&sort=updated`,
    token
  );
  return await res.json() as any[];
}

async function fetchRecentComments(
  owner: string,
  repo: string,
  since: string,
  username: string,
  token: string
): Promise<Array<{ prNumber: number; url: string; createdAt: string; snippet: string }>> {
  try {
    const res = await ghFetch(
      `https://api.github.com/repos/${owner}/${repo}/pulls/comments?sort=created&direction=desc&since=${since}&per_page=30`,
      token
    );
    const comments = await res.json() as any[];

    return comments
      .filter((c: any) => c.user?.login === username)
      .map((c: any) => {
        // Extract PR number from pull_request_url
        const prMatch = c.pull_request_url?.match(/\/pulls\/(\d+)$/);
        const prNumber = prMatch ? parseInt(prMatch[1], 10) : 0;
        return {
          prNumber,
          url: c.html_url,
          createdAt: c.created_at,
          snippet: (c.body ?? "").slice(0, 60),
        };
      })
      .filter((c) => c.prNumber > 0);
  } catch {
    return [];
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────────

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

/**
 * `lgtm review add <prs...>` — Add PRs to the review queue.
 *
 * Resolution order:
 * 1. Check for local branch (pr-<N>, pr/<N>, etc.)
 * 2. If not found locally, fetch from GitHub API (metadata + diff)
 * 3. Cache the diff for TUI review
 *
 * Use --demo to bypass validation for testing.
 */

import type { Command } from "commander";
import type { LGTMContext } from "@lgtm/core/plugin.js";
import { createQueueManager } from "../domain/queue.js";
import chalk from "chalk";

export function registerAddCommand(program: Command, ctx: LGTMContext) {
  program
    .command("add <prs...>")
    .description("Add PR(s) to the review queue")
    .option("-b, --branch", "Treat arguments as branch names instead of PR numbers")
    .option("-r, --repo <owner/repo>", "GitHub repo (default: detected from git remote)")
    .option("--demo", "Demo/test mode — skip PR validation, use mock data")
    .action(async (prs: string[], opts: { branch?: boolean; repo?: string; demo?: boolean }) => {
      const { createGitAdapter } = await import("@lgtm/core/utils/git.js");
      const git = createGitAdapter(ctx.repoRoot);

      const isRepo = await git.isGitRepo();

      if (!isRepo && !opts.demo) {
        ctx.logger.error("Not in a git repository. Run from a repo root.");
        ctx.logger.info("Use --demo to add mock PRs for testing.");
        return;
      }

      const queue = createQueueManager(ctx.store);

      // Resolve GitHub repo for API fetch
      let ghOwner: string | null = null;
      let ghRepo: string | null = null;

      if (opts.repo) {
        const parts = opts.repo.split("/");
        if (parts.length === 2) {
          [ghOwner, ghRepo] = parts;
        }
      } else if (!opts.demo) {
        const detected = await detectRepoFromRemote(ctx.repoRoot);
        if (detected) {
          [ghOwner, ghRepo] = detected;
        }
      }

      // Build PR metadata
      const prEntries: Array<{
        number: number;
        title: string;
        filesChanged: string[];
        source: "github" | "local";
      }> = [];

      for (const pr of prs) {
        const prNumber = parseInt(pr, 10);
        if (isNaN(prNumber) && !opts.branch) {
          ctx.logger.warn(`Skipping '${pr}' — not a valid PR number. Use --branch for branch names.`);
          continue;
        }

        // ── Demo mode ────────────────────────────────────────────────────
        if (opts.demo) {
          prEntries.push({
            number: opts.branch ? prs.indexOf(pr) + 1 : prNumber,
            title: opts.branch ? pr : `Demo PR #${prNumber}`,
            filesChanged: generateDemoFiles(prNumber),
            source: "local",
          });
          continue;
        }

        // ── Real mode: try local first, then GitHub ──────────────────────
        const branchName = opts.branch ? pr : await findPRBranch(git, prNumber);

        if (branchName) {
          // Found locally — use git diff
          let filesChanged: string[] = [];
          let title = opts.branch ? pr : `PR #${prNumber}`;

          try {
            filesChanged = await git.getChangedFiles(branchName);
          } catch (err) {
            ctx.logger.warn(`PR #${prNumber} (${branchName}) — could not get diff: ${(err as Error).message}`);
            continue;
          }

          prEntries.push({
            number: opts.branch ? prs.indexOf(pr) + 1 : prNumber,
            title,
            filesChanged,
            source: "local",
          });
        } else if (ghOwner && ghRepo) {
          // Not found locally — fetch from GitHub API
          console.log(chalk.gray(`  Fetching PR #${prNumber} from GitHub...`));

          try {
            const { createGitHubAdapter } = await import("../infra/github.js");
            const github = createGitHubAdapter(ghOwner, ghRepo);

            const prData = await github.fetchPR(prNumber);
            const rawDiff = await github.fetchDiff(prNumber);
            const changedFiles = await github.fetchChangedFiles(prNumber);

            // Cache the diff for TUI review later
            await cachePRDiff(ctx, prNumber, rawDiff, prData);

            console.log(chalk.green(
              `  ✓ PR #${prNumber}: "${prData.title}" (+${prData.additions} -${prData.deletions}, ${prData.changedFiles} files)`
            ));

            prEntries.push({
              number: prNumber,
              title: prData.title,
              filesChanged: changedFiles,
              source: "github",
            });
          } catch (err) {
            const msg = (err as Error).message;
            if (msg.includes("404")) {
              ctx.logger.error(`PR #${prNumber} not found in ${ghOwner}/${ghRepo}.`);
            } else if (msg.includes("token")) {
              ctx.logger.error(`GitHub auth required. Set GITHUB_TOKEN or run: lgtm auth login github`);
              break; // No point trying more PRs
            } else {
              ctx.logger.error(`Failed to fetch PR #${prNumber}: ${msg}`);
            }
            continue;
          }
        } else {
          // No local branch AND no GitHub access
          ctx.logger.warn(
            `PR #${prNumber} — not found locally and no GitHub access.\n` +
            `    Set GITHUB_TOKEN or use --repo owner/repo to fetch from GitHub.`
          );
          continue;
        }
      }

      if (prEntries.length === 0) {
        ctx.logger.error("No valid PRs to add.");
        if (!ghOwner) {
          console.log(chalk.gray(`  Tip: Set GITHUB_TOKEN to auto-fetch PRs from GitHub.\n`));
        }
        return;
      }

      // Add to queue (auto-groups)
      const session = await queue.addToQueue(prEntries);

      // Print results
      const modeLabel = opts.demo ? chalk.gray(" [demo mode]") : "";
      console.log(chalk.bold(`\n👍 Added ${prEntries.length} PR(s) to review queue${modeLabel}\n`));

      for (const pr of prEntries) {
        const queued = session.prs.find((p) => p.number === pr.number);
        const group = queued?.featureGroup
          ? chalk.gray(` [${queued.featureGroup}]`)
          : "";
        const sourceIcon = pr.source === "github" ? chalk.cyan("⬇") : chalk.green("●");
        console.log(`  ${sourceIcon} #${pr.number}: ${pr.title} (${pr.filesChanged.length} files)${group}`);
      }

      // Show groups if any
      if (session.featureGroups.length > 0) {
        console.log(chalk.bold("\n  Feature Groups:"));
        for (const group of session.featureGroups) {
          console.log(
            `  ${chalk.cyan("⚡")} ${group.label} — PRs ${group.prs.map((n) => `#${n}`).join(", ")}`
          );
          console.log(chalk.gray(`     ${group.reason}`));
        }
      }

      console.log(
        chalk.gray(`\n  Run ${chalk.cyan("lgtm")} to open the TUI and review.\n`)
      );
    });
}

// ─── GitHub Diff Caching ────────────────────────────────────────────────────

/**
 * Cache a PR's raw diff and metadata in the OKF store.
 * This allows the TUI to load the real diff without re-fetching.
 */
async function cachePRDiff(
  ctx: LGTMContext,
  prNumber: number,
  rawDiff: string,
  prData: { title: string; head: { ref: string; sha: string }; base: { ref: string }; additions: number; deletions: number; changedFiles: number }
) {
  const cacheData = {
    type: "lgtm/pr-cache",
    pr: prNumber,
    title: prData.title,
    head_ref: prData.head.ref,
    head_sha: prData.head.sha,
    base_ref: prData.base.ref,
    additions: prData.additions,
    deletions: prData.deletions,
    changed_files: prData.changedFiles,
    fetched_at: new Date().toISOString(),
  };

  // Store raw diff in a markdown file (frontmatter = metadata, body = diff)
  await ctx.store.write(
    `cache/pr-${prNumber}.md`,
    cacheData,
    `# PR #${prNumber} — ${prData.title}\n\nCached diff (${prData.additions}+ ${prData.deletions}-):\n\n\`\`\`diff\n${rawDiff}\n\`\`\``
  );
}

/**
 * Load a cached PR diff from the store.
 * Returns null if not cached.
 */
export async function loadCachedDiff(
  store: { read: (path: string) => Promise<{ data: Record<string, unknown>; content: string } | null> },
  prNumber: number
): Promise<{ rawDiff: string; title: string; sha: string } | null> {
  try {
    const doc = await store.read(`cache/pr-${prNumber}.md`);
    if (!doc || doc.data.type !== "lgtm/pr-cache") return null;

    // Extract diff from the markdown code block
    const diffMatch = doc.content.match(/```diff\n([\s\S]*?)\n```/);
    if (!diffMatch) return null;

    return {
      rawDiff: diffMatch[1],
      title: doc.data.title as string ?? `PR #${prNumber}`,
      sha: doc.data.head_sha as string ?? "",
    };
  } catch {
    return null;
  }
}

// ─── Repo Detection ─────────────────────────────────────────────────────────

/**
 * Detect owner/repo from the current git remote.
 */
async function detectRepoFromRemote(repoRoot: string): Promise<[string, string] | null> {
  try {
    const { execSync } = require("child_process");
    const remote = execSync("git remote get-url origin", {
      cwd: repoRoot,
      encoding: "utf-8",
    }).trim();

    // HTTPS: https://github.com/owner/repo.git
    const httpsMatch = remote.match(/github\.com[/:]([^/]+)\/([^/.]+?)(?:\.git)?$/);
    if (httpsMatch) return [httpsMatch[1], httpsMatch[2]];

    // SSH: git@github.com:owner/repo.git
    const sshMatch = remote.match(/git@github\.com:([^/]+)\/([^/.]+?)(?:\.git)?$/);
    if (sshMatch) return [sshMatch[1], sshMatch[2]];

    return null;
  } catch {
    return null;
  }
}

// ─── Local Branch Detection ─────────────────────────────────────────────────

/**
 * Try to find a local branch for a PR number.
 */
async function findPRBranch(
  git: { getBranches: () => Promise<{ all: string[] }> },
  prNumber: number
): Promise<string | null> {
  try {
    const { all } = await git.getBranches();
    const candidates = [`pr-${prNumber}`, `pr/${prNumber}`, `pull/${prNumber}`];
    for (const candidate of candidates) {
      if (all.includes(candidate)) return candidate;
    }
    return null;
  } catch {
    return null;
  }
}

// ─── Demo Data ──────────────────────────────────────────────────────────────

function generateDemoFiles(prNumber: number): string[] {
  const groups = [
    ["src/auth/login.ts", "src/auth/register.ts", "src/auth/middleware.ts"],
    ["src/api/routes/users.ts", "src/api/routes/auth.ts", "src/api/middleware/rate-limit.ts"],
    ["src/db/migrations/001.ts", "src/db/models/user.ts"],
    ["src/utils/helpers.ts", "src/utils/validation.ts", "tests/utils.test.ts"],
    ["src/config/app.ts", "src/config/database.ts", ".env.example"],
  ];
  return groups[(prNumber - 1) % groups.length];
}

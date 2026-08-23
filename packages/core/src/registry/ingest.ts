/**
 * Ingest Command — interactive repo discovery and picker.
 *
 * Scans the filesystem for git repos, reconciles against registry,
 * and presents an interactive accept/deny picker with status indicators.
 *
 * Used by `lgtm discover --ingest`.
 */

import chalk from "chalk";
import path from "path";
import readline from "readline";
import { scanAllRepos, type ScannedRepo, type ScanOptions } from "./scanner.js";
import {
  reconcile,
  acceptRepo,
  denyRepo,
  pruneIngestRegistry,
  type RepoStatus,
  type ReconcileResult,
} from "./reconcile.js";

// ─── Accept Feedback ────────────────────────────────────────────────────────

/**
 * Accept a repo and describe what actually happened to the watch list.
 *
 * Accepting used to print a bare green tick regardless of outcome, which was
 * misleading for a repo with no git remote: there are no pull requests to poll,
 * so it never reaches the watcher. Say so rather than implying success.
 */
function acceptAndDescribe(repo: ScannedRepo): { watched: boolean; label: string } {
  const result = acceptRepo(repo);

  if (result.changed) {
    return { watched: true, label: chalk.green("✓ added to watcher") };
  }
  if (result.reason === "already watching") {
    return { watched: true, label: chalk.gray("• already watching") };
  }
  return { watched: false, label: chalk.yellow(`⚠ not watched (${result.reason})`) };
}

// ─── Types ──────────────────────────────────────────────────────────────────

export interface IngestOptions {
  /** Specific directory to scan */
  scanDir?: string;

  /** Only show repos that need a decision (hide watched/denied) */
  newOnly?: boolean;

  /** Show everything including denied (for re-review) */
  all?: boolean;

  /** Auto-accept all repos with activity in last N days */
  recommended?: boolean;

  /** Only prune — don't scan or prompt */
  pruneOnly?: boolean;

  /** Recommended threshold in days (default: 7) */
  recommendedDays?: number;

  /** Stale threshold in days (default: 90) */
  staleDays?: number;

  /** LGTM storage dir (for watch list lookup) */
  lgtmDir?: string;
}

// ─── Main Ingest Flow ───────────────────────────────────────────────────────

/**
 * Run the full ingest flow: scan → reconcile → display → pick.
 */
export async function runIngest(opts: IngestOptions = {}): Promise<void> {
  const recommendedDays = opts.recommendedDays ?? 7;
  const staleDays = opts.staleDays ?? 90;

  // ── Prune-only mode ─────────────────────────────────────────────────
  if (opts.pruneOnly) {
    const removed = pruneIngestRegistry();
    if (removed.length === 0) {
      console.log(chalk.green("\n  ✓ All repos still exist on disk. Nothing to prune.\n"));
    } else {
      console.log(chalk.bold(`\n  ⚠ Pruned ${removed.length} repo(s) no longer on disk:\n`));
      for (const r of removed) {
        console.log(chalk.gray(`    ✗ ${r.name} — was at ${r.path}`));
      }
      console.log();
    }
    return;
  }

  // ── Scan ────────────────────────────────────────────────────────────
  const scanOpts: ScanOptions = {};
  if (opts.scanDir) {
    scanOpts.roots = [opts.scanDir];
  }

  let scanCount = 0;
  scanOpts.onProgress = (found) => {
    scanCount = found;
    process.stdout.write(`\r  Scanning... found ${found} repos`);
  };

  console.log(chalk.bold("\n👍 LGTM Repo Discovery\n"));
  const scanned = await scanAllRepos(scanOpts);
  if (scanCount > 0) {
    process.stdout.write(`\r  Scanning... found ${scanned.length} repos\n\n`);
  } else {
    console.log(chalk.gray(`  Scanned — found ${scanned.length} repos\n`));
  }

  if (scanned.length === 0) {
    console.log(chalk.gray("  No git repos found. Try: lgtm discover --ingest ~/projects\n"));
    return;
  }

  // ── Reconcile ───────────────────────────────────────────────────────
  const result = reconcile(scanned, { lgtmDir: opts.lgtmDir });

  // ── Show removed repos ──────────────────────────────────────────────
  if (result.removed.length > 0) {
    console.log(chalk.yellow(`  ⚠ ${result.removed.length} repo(s) no longer on disk:`));
    for (const r of result.removed) {
      console.log(chalk.gray(`    ✗ ${r.name} — was at ${r.path}`));
    }
    pruneIngestRegistry();
    console.log(chalk.gray("    (auto-removed from registry)\n"));
  }

  // ── Display summary ─────────────────────────────────────────────────
  const { counts } = result;
  console.log(
    `  Discovered ${chalk.bold(String(counts.total))} repos` +
    ` (${chalk.green(`${counts.watching} watching`)}, ` +
    `${chalk.cyan(`${counts.new} new`)}, ` +
    `${chalk.gray(`${counts.denied} skipped`)})\n`
  );

  // ── Display repos grouped by directory ──────────────────────────────
  const reposToShow = getReposToShow(result, opts);

  if (reposToShow.length === 0) {
    if (opts.newOnly) {
      console.log(chalk.green("  ✓ No new repos found. All repos are already managed.\n"));
    } else {
      console.log(chalk.green("  ✓ All repos accounted for.\n"));
    }
    return;
  }

  displayRepoList(reposToShow, recommendedDays, staleDays);

  // ── Auto-accept recommended ─────────────────────────────────────────
  if (opts.recommended) {
    const now = Date.now();
    const threshold = recommendedDays * 24 * 60 * 60 * 1000;
    const recommended = result.newRepos.filter((r) => {
      if (!r.lastCommitDate) return false;
      return now - new Date(r.lastCommitDate).getTime() < threshold;
    });

    if (recommended.length > 0) {
      console.log(chalk.green(`  Auto-accepting ${recommended.length} recommended repo(s):\n`));
      for (const repo of recommended) {
        const { label } = acceptAndDescribe(repo);
        console.log(`    ${chalk.cyan(repo.name)} ${label}`);
      }
      console.log();
    } else {
      console.log(chalk.gray("  No recommended repos to auto-accept.\n"));
    }
    return;
  }

  // ── Interactive picker (only for repos needing decision) ────────────
  const newRepos = result.newRepos;
  if (newRepos.length === 0) {
    console.log(chalk.gray("  No new repos need a decision. Use --all to re-review.\n"));
    return;
  }

  console.log(chalk.bold(`  ${newRepos.length} new repo(s) need a decision:\n`));
  console.log(chalk.gray("  [a] accept (watch)  [s] skip  [A] accept all  [q] done\n"));

  await runPicker(newRepos);
}

// ─── Display ────────────────────────────────────────────────────────────────

function getReposToShow(
  result: ReconcileResult,
  opts: IngestOptions
): Array<ScannedRepo & { status: RepoStatus }> {
  if (opts.newOnly) {
    return result.newRepos;
  }
  if (opts.all) {
    return result.repos;
  }
  // Default: show all (watching + new + denied)
  return result.repos;
}

function displayRepoList(
  repos: Array<ScannedRepo & { status: RepoStatus }>,
  recommendedDays: number,
  staleDays: number
): void {
  // Group by parent directory
  const groups = new Map<string, typeof repos>();
  for (const repo of repos) {
    const parent = path.dirname(repo.path);
    const displayParent = parent.replace(process.env.HOME ?? "", "~");
    if (!groups.has(displayParent)) {
      groups.set(displayParent, []);
    }
    groups.get(displayParent)!.push(repo);
  }

  const now = Date.now();
  const recommendedThreshold = recommendedDays * 24 * 60 * 60 * 1000;
  const staleThreshold = staleDays * 24 * 60 * 60 * 1000;

  for (const [dir, dirRepos] of groups) {
    console.log(chalk.gray(`  ${dir}/`));
    for (const repo of dirRepos) {
      const icon = statusIcon(repo.status);
      const name = chalk.bold(repo.name.padEnd(20));
      const remote = repo.owner && repo.repoName
        ? chalk.gray(`${repo.platform ?? ""}:${repo.owner}/${repo.repoName}`)
        : chalk.gray("(local)");
      const lang = repo.language ? chalk.gray(repo.language) : "";

      // Activity badge
      let badge = "";
      if (repo.lastCommitDate) {
        const age = now - new Date(repo.lastCommitDate).getTime();
        if (age < recommendedThreshold) {
          badge = chalk.green(" ✦");
        } else if (age > staleThreshold) {
          badge = chalk.gray(" (stale)");
        } else {
          const daysAgo = Math.floor(age / (24 * 60 * 60 * 1000));
          badge = chalk.gray(` ${daysAgo}d ago`);
        }
      }

      console.log(`    ${icon} ${name} ${remote}  ${lang}${badge}`);
    }
    console.log();
  }
}

function statusIcon(status: RepoStatus): string {
  switch (status) {
    case "watching": return chalk.green("👁");
    case "new": return chalk.cyan("✦");
    case "denied": return chalk.gray("○");
    case "removed": return chalk.yellow("⚠");
  }
}

// ─── Interactive Picker ─────────────────────────────────────────────────────

async function runPicker(repos: ScannedRepo[]): Promise<void> {
  // Only needed when stdin cannot go into raw mode, which means piped input.
  // Built lazily because an open readline interface on stdin keeps Bun's event
  // loop alive, so creating one on a TTY run left the command hanging after the
  // summary had already printed.
  let rl: readline.Interface | null = null;
  function fallbackReadline(): readline.Interface {
    rl ??= readline.createInterface({ input: process.stdin, output: process.stdout });
    return rl;
  }

  let accepted = 0;
  let skipped = 0;
  let unwatchable = 0;

  try {
    for (let i = 0; i < repos.length; i++) {
      const repo = repos[i];
      const progress = chalk.gray(`[${i + 1}/${repos.length}]`);
      const remote = repo.owner ? chalk.gray(`${repo.owner}/${repo.repoName}`) : chalk.gray("(local)");

      process.stdout.write(`  ${progress} ${chalk.cyan(repo.name)} ${remote}  `);

      const answer = await new Promise<string>((resolve) => {
        // Raw mode for single keypress
        const stdin = process.stdin;
        const wasRaw = stdin.isRaw;
        try {
          stdin.setRawMode(true);
        } catch {
          // Piped stdin — can't do raw mode, use readline fallback
          fallbackReadline().question("[a/s/A/q] ", resolve);
          return;
        }
        stdin.resume();
        stdin.setEncoding("utf-8");

        const onData = (key: string) => {
          stdin.setRawMode(wasRaw ?? false);
          stdin.removeListener("data", onData);
          stdin.resume();
          resolve(key);
        };
        stdin.on("data", onData);
      });

      const raw = answer.trim();
      const key = raw.toLowerCase();

      // Uppercase A must be tested before the lowercase comparison. It used to
      // be a later branch, so `key === "a"` swallowed it and "accept all" was
      // unreachable despite being advertised in the help line.
      if (raw === "A") {
        // Accept ALL remaining
        const first = acceptAndDescribe(repo);
        accepted++;
        if (!first.watched) unwatchable++;
        console.log(first.label);

        for (let j = i + 1; j < repos.length; j++) {
          const { watched, label } = acceptAndDescribe(repos[j]);
          accepted++;
          if (!watched) unwatchable++;
          console.log(`  ${chalk.gray(`[${j + 1}/${repos.length}]`)} ${chalk.cyan(repos[j].name)} ${label}`);
        }
        break;
      } else if (key === "a" || key === "\r" || key === "\n") {
        const { watched, label } = acceptAndDescribe(repo);
        accepted++;
        if (!watched) unwatchable++;
        console.log(label);
      } else if (key === "s" || key === " ") {
        denyRepo(repo);
        skipped++;
        console.log(chalk.gray("○ skipped"));
      } else if (key === "q" || key === "\x03") {
        // Quit — skip remaining
        console.log(chalk.gray("done"));
        skipped += repos.length - i - 1;
        for (let j = i + 1; j < repos.length; j++) {
          denyRepo(repos[j]);
        }
        break;
      } else {
        // Unknown key — treat as skip
        denyRepo(repo);
        skipped++;
        console.log(chalk.gray("○ skipped"));
      }
    }
  } finally {
    // Aliased because the only assignment is inside fallbackReadline(), which
    // control flow analysis cannot see, so `rl` narrows to null here.
    const opened = rl as readline.Interface | null;
    opened?.close();
    // The keypress path calls stdin.resume() on every prompt. Leaving stdin
    // flowing and in raw mode holds the process open once the picker is done.
    try {
      process.stdin.setRawMode(false);
    } catch {
      // Not a TTY, nothing to restore.
    }
    process.stdin.pause();
  }

  // Summary
  const watching = accepted - unwatchable;

  console.log();
  console.log(
    `  ${chalk.bold("Done!")} ` +
    `${chalk.green(`${watching} watching`)}` +
    (skipped > 0 ? `, ${chalk.gray(`${skipped} skipped`)}` : "") +
    (unwatchable > 0 ? `, ${chalk.yellow(`${unwatchable} without a remote`)}` : "") +
    "\n"
  );

  if (watching > 0) {
    console.log(chalk.gray(`  Watched repos: ${chalk.cyan("lgtm review watch list")}`));
    console.log(chalk.gray(`  Start polling: ${chalk.cyan("lgtm watch")}\n`));
  }
}

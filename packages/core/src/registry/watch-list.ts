/**
 * The watch list — the single source of truth for which repos the watcher polls.
 *
 * Lives at `<store>/watch.md` as an OKF document. Two places used to write this
 * file in slightly different shapes (the review plugin's watch commands, and
 * nothing at all from repo ingest, which was the bug). Everything now goes
 * through here so the frontmatter shape cannot drift.
 *
 * A repo is only watchable if we know its `owner/repo` on a hosting platform.
 * Local-only repos with no remote are silently unwatchable, and callers are
 * told why rather than being left to wonder where their repo went.
 */

import fs from "fs";
import path from "path";
import matter from "gray-matter";

// ─── Types ──────────────────────────────────────────────────────────────────

export type WatchFilter = "all" | "assigned" | "review_requested";

export interface WatchedRepo {
  owner: string;
  repo: string;
  filter: WatchFilter;
  /** Absolute path on disk, when the repo was added by local discovery. */
  path?: string;
  /** ISO timestamp of the last successful poll. */
  lastChecked?: string;
}

export interface WatchListChange {
  /** True when the list was modified and written to disk. */
  changed: boolean;
  /** Why nothing changed, for the caller to surface. */
  reason?: string;
}

// ─── Paths ──────────────────────────────────────────────────────────────────

export function getWatchListPath(lgtmDir: string): string {
  return path.join(lgtmDir, "watch.md");
}

// ─── Read / Write ───────────────────────────────────────────────────────────

/**
 * Load the watch list. Returns an empty array when the file does not exist,
 * which is the normal state of a fresh store.
 */
export function loadWatchList(lgtmDir: string): WatchedRepo[] {
  try {
    const raw = fs.readFileSync(getWatchListPath(lgtmDir), "utf-8");
    const { data } = matter(raw);
    const repos = (data.repos as WatchedRepo[]) ?? [];
    // Guard against hand-edits that drop required fields.
    return repos.filter((r) => r && r.owner && r.repo).map((r) => ({
      ...r,
      filter: r.filter ?? "all",
    }));
  } catch {
    return [];
  }
}

/**
 * Write the watch list. The body is generated, not preserved, so the rendered
 * list always matches the frontmatter.
 */
export function saveWatchList(lgtmDir: string, repos: WatchedRepo[]): void {
  const data = JSON.parse(
    JSON.stringify({
      type: "lgtm/watch",
      lastUpdated: new Date().toISOString(),
      repos,
    })
  );

  const body = [
    "# Watch Configuration",
    "",
    repos.length === 0
      ? "No repos are being watched."
      : `Polling ${repos.length} repo(s) for open pull requests.`,
    "",
    ...repos.map((r) => {
      const url = `https://github.com/${r.owner}/${r.repo}`;
      const last = r.lastChecked ? ` — last checked ${r.lastChecked.split("T")[0]}` : "";
      return `- [${r.owner}/${r.repo}](${url}) (filter: ${r.filter})${last}`;
    }),
    "",
  ].join("\n");

  fs.mkdirSync(lgtmDir, { recursive: true });
  fs.writeFileSync(getWatchListPath(lgtmDir), matter.stringify(body, data), "utf-8");
}

// ─── Mutations ──────────────────────────────────────────────────────────────

/**
 * Add a repo to the watch list. Idempotent.
 */
export function addToWatchList(
  lgtmDir: string,
  entry: { owner?: string; repo?: string; filter?: WatchFilter; path?: string }
): WatchListChange {
  if (!entry.owner || !entry.repo) {
    return { changed: false, reason: "no git remote, so there are no pull requests to poll" };
  }

  const repos = loadWatchList(lgtmDir);
  const existing = repos.find((r) => r.owner === entry.owner && r.repo === entry.repo);

  if (existing) {
    // Backfill the local path if we learned it from a later discovery pass.
    if (entry.path && !existing.path) {
      existing.path = entry.path;
      saveWatchList(lgtmDir, repos);
    }
    return { changed: false, reason: "already watching" };
  }

  repos.push({
    owner: entry.owner,
    repo: entry.repo,
    filter: entry.filter ?? "all",
    path: entry.path,
  });

  saveWatchList(lgtmDir, repos);
  return { changed: true };
}

/**
 * Remove a repo from the watch list.
 */
export function removeFromWatchList(
  lgtmDir: string,
  owner?: string,
  repo?: string
): WatchListChange {
  if (!owner || !repo) return { changed: false, reason: "no git remote" };

  const repos = loadWatchList(lgtmDir);
  const remaining = repos.filter((r) => !(r.owner === owner && r.repo === repo));

  if (remaining.length === repos.length) {
    return { changed: false, reason: "not watching" };
  }

  saveWatchList(lgtmDir, remaining);
  return { changed: true };
}

/**
 * Record a successful poll against a repo.
 */
export function touchWatchedRepo(lgtmDir: string, owner: string, repo: string): void {
  const repos = loadWatchList(lgtmDir);
  const entry = repos.find((r) => r.owner === owner && r.repo === repo);
  if (!entry) return;
  entry.lastChecked = new Date().toISOString();
  saveWatchList(lgtmDir, repos);
}

/**
 * The watch list as an `owner/repo` set, for reconciliation lookups.
 */
export function watchedRepoKeys(lgtmDir: string): Set<string> {
  return new Set(loadWatchList(lgtmDir).map((r) => `${r.owner}/${r.repo}`));
}

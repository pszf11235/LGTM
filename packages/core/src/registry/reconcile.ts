/**
 * Registry Reconciliation — compare scanned repos against registry and watch list.
 *
 * Determines the status of each repo:
 *   - watching: in the watch list (actively monitored)
 *   - new: found on disk but not in registry (needs decision)
 *   - denied: user previously skipped this repo
 *   - removed: was in registry but path no longer exists on disk
 *
 * Used by `lgtm discover --ingest` to present the full picture.
 */

import fs from "fs";
import path from "path";
import matter from "gray-matter";
import type { ScannedRepo } from "./scanner.js";
import {
  addToWatchList,
  removeFromWatchList,
  watchedRepoKeys,
  type WatchListChange,
} from "./watch-list.js";
import { loadBootstrap, resolveLgtmDir } from "../config/loader.js";

// ─── Types ──────────────────────────────────────────────────────────────────

export type RepoStatus = "watching" | "new" | "denied" | "removed";

export interface IngestRegistryEntry {
  /** Absolute path to repo root */
  path: string;

  /** Directory name */
  name: string;

  /** Remote origin URL */
  remote?: string;

  /** Owner (from remote) */
  owner?: string;

  /** Repo name (from remote) */
  repoName?: string;

  /** Platform */
  platform?: "github" | "gitlab" | "bitbucket" | "other";

  /** Current status */
  status: RepoStatus;

  /** When first discovered */
  addedAt: string;

  /** Last commit date (from scan) */
  lastCommitDate?: string;

  /** Primary language */
  language?: string;

  /** When removed (if status=removed) */
  removedAt?: string;
}

export interface ReconcileResult {
  /** All repos with their current status */
  repos: Array<ScannedRepo & { status: RepoStatus }>;

  /** Repos that were in registry but no longer on disk */
  removed: IngestRegistryEntry[];

  /** Repos that are new (not in registry) */
  newRepos: Array<ScannedRepo & { status: "new" }>;

  /** Repos currently being watched */
  watching: Array<ScannedRepo & { status: "watching" }>;

  /** Repos previously denied */
  denied: Array<ScannedRepo & { status: "denied" }>;

  /** Summary counts */
  counts: {
    total: number;
    watching: number;
    new: number;
    denied: number;
    removed: number;
  };
}

// ─── Store Location ─────────────────────────────────────────────────────────

/**
 * The store directory to operate on. Callers may override, which is how tests
 * stay off the real store.
 */
function storeDir(lgtmDir?: string): string {
  return lgtmDir ?? resolveLgtmDir(loadBootstrap());
}

// ─── Registry Path ──────────────────────────────────────────────────────────

/**
 * The ingest registry lives inside the store, next to the watch list it feeds.
 * It used to sit at `~/.lgtm-ingest-registry.md`, outside any store, which made
 * it impossible to isolate in tests and left a stray dotfile in $HOME.
 */
export function getIngestRegistryPath(lgtmDir?: string): string {
  return path.join(storeDir(lgtmDir), "ingest-registry.md");
}

// ─── Load/Save Ingest Registry ──────────────────────────────────────────────

/**
 * Load the ingest registry (tracks status of all discovered repos).
 */
export function loadIngestRegistry(lgtmDir?: string): IngestRegistryEntry[] {
  try {
    const raw = fs.readFileSync(getIngestRegistryPath(lgtmDir), "utf-8");
    const { data } = matter(raw);
    return (data.repos as IngestRegistryEntry[]) ?? [];
  } catch {
    return [];
  }
}

/**
 * Save the ingest registry.
 */
export function saveIngestRegistry(repos: IngestRegistryEntry[], lgtmDir?: string): void {
  const activeCount = repos.filter((r) => r.status === "watching").length;
  const deniedCount = repos.filter((r) => r.status === "denied").length;

  const data = {
    type: "lgtm/ingest-registry",
    lastUpdated: new Date().toISOString(),
    lastScan: new Date().toISOString(),
    repos,
  };

  const statusIcon = (s: RepoStatus) =>
    s === "watching" ? "👁" : s === "new" ? "✦" : s === "denied" ? "○" : "⚠";

  const body = [
    "# LGTM Ingest Registry",
    "",
    `Tracks ${repos.length} discovered repo(s). ${activeCount} watching, ${deniedCount} skipped.`,
    "",
    ...repos
      .filter((r) => r.status !== "removed")
      .map((r) => `- ${statusIcon(r.status)} **${r.name}** — \`${r.path}\` (${r.status})`),
    "",
  ].join("\n");

  const cleanData = JSON.parse(JSON.stringify(data));
  const output = matter.stringify(body, cleanData);
  const registryPath = getIngestRegistryPath(lgtmDir);
  fs.mkdirSync(path.dirname(registryPath), { recursive: true });
  fs.writeFileSync(registryPath, output, "utf-8");
}

// ─── Watch List Helpers ─────────────────────────────────────────────────────

/**
 * Load watched repos as a set of "owner/repo" strings.
 *
 * Only the central store is consulted. The previous version also probed
 * `./.lgtm/watch.md`, which meant a stale per-repo directory could silently
 * mark repos as watched that the watcher would never poll.
 */
export function loadWatchedRepos(lgtmDir?: string): Set<string> {
  return watchedRepoKeys(storeDir(lgtmDir));
}

// ─── Reconciliation ─────────────────────────────────────────────────────────

/**
 * Reconcile scanned repos against the ingest registry and watch list.
 *
 * Determines status for each repo and prunes removed ones.
 */
export function reconcile(
  scanned: ScannedRepo[],
  opts?: { lgtmDir?: string }
): ReconcileResult {
  const registry = loadIngestRegistry(opts?.lgtmDir);
  const watched = loadWatchedRepos(opts?.lgtmDir);

  // Build lookup of registry entries by path
  const registryByPath = new Map(registry.map((r) => [r.path, r]));

  // Build lookup of scanned repos by path (deduplicate)
  const scannedByPath = new Map(scanned.map((r) => [r.path, r]));

  // ── Determine status for each scanned repo ────────────────────────────
  const result: Array<ScannedRepo & { status: RepoStatus }> = [];

  for (const repo of scannedByPath.values()) {
    const registryEntry = registryByPath.get(repo.path);
    const watchKey = repo.owner && repo.repoName ? `${repo.owner}/${repo.repoName}` : null;
    const isWatched = watchKey ? watched.has(watchKey) : false;

    let status: RepoStatus;
    if (isWatched || registryEntry?.status === "watching") {
      status = "watching";
    } else if (registryEntry?.status === "denied") {
      status = "denied";
    } else if (registryEntry) {
      // Known but not watching/denied — treat as new (needs re-decision)
      status = "new";
    } else {
      status = "new";
    }

    result.push({ ...repo, status });
  }

  // ── Detect removed repos (in registry but not on disk) ────────────────
  const removed: IngestRegistryEntry[] = [];
  for (const entry of registry) {
    if (entry.status === "removed") continue; // Already marked removed
    if (!scannedByPath.has(entry.path) && !fs.existsSync(entry.path)) {
      removed.push({ ...entry, status: "removed", removedAt: new Date().toISOString() });
    }
  }

  // ── Build categorized lists ────────────────────────────────────────────
  const newRepos = result.filter((r) => r.status === "new") as Array<ScannedRepo & { status: "new" }>;
  const watching = result.filter((r) => r.status === "watching") as Array<ScannedRepo & { status: "watching" }>;
  const denied = result.filter((r) => r.status === "denied") as Array<ScannedRepo & { status: "denied" }>;

  return {
    repos: result,
    removed,
    newRepos,
    watching,
    denied,
    counts: {
      total: result.length,
      watching: watching.length,
      new: newRepos.length,
      denied: denied.length,
      removed: removed.length,
    },
  };
}

// ─── Status Updates ─────────────────────────────────────────────────────────

/**
 * Accept a repo: mark it watching in the registry *and* add it to the watch list.
 *
 * The registry alone was updated before, so accepting a repo during ingest
 * showed a green tick and then the watcher never polled it. The watch list is
 * what the watcher reads, so both have to be written.
 *
 * Returns whether the watch list actually changed, plus a reason when it did
 * not, so the caller can explain "no git remote" instead of implying success.
 */
export function acceptRepo(repo: ScannedRepo, opts?: { lgtmDir?: string }): WatchListChange {
  const registry = loadIngestRegistry(opts?.lgtmDir);
  const existing = registry.find((r) => r.path === repo.path);
  const now = new Date().toISOString();

  if (existing) {
    existing.status = "watching";
    existing.lastCommitDate = repo.lastCommitDate;
    existing.language = repo.language;
  } else {
    registry.push({
      path: repo.path,
      name: repo.name,
      remote: repo.remote,
      owner: repo.owner,
      repoName: repo.repoName,
      platform: repo.platform,
      status: "watching",
      addedAt: now,
      lastCommitDate: repo.lastCommitDate,
      language: repo.language,
    });
  }

  saveIngestRegistry(registry, opts?.lgtmDir);

  return addToWatchList(storeDir(opts?.lgtmDir), {
    owner: repo.owner,
    repo: repo.repoName,
    filter: "all",
    path: repo.path,
  });
}

/**
 * Deny a repo: mark it skipped in the registry and ensure it is not watched.
 *
 * Denying a repo that was previously accepted has to remove it from the watch
 * list, otherwise the watcher keeps polling something the user just skipped.
 */
export function denyRepo(repo: ScannedRepo, opts?: { lgtmDir?: string }): WatchListChange {
  const registry = loadIngestRegistry(opts?.lgtmDir);
  const existing = registry.find((r) => r.path === repo.path);
  const now = new Date().toISOString();

  if (existing) {
    existing.status = "denied";
  } else {
    registry.push({
      path: repo.path,
      name: repo.name,
      remote: repo.remote,
      owner: repo.owner,
      repoName: repo.repoName,
      platform: repo.platform,
      status: "denied",
      addedAt: now,
      lastCommitDate: repo.lastCommitDate,
      language: repo.language,
    });
  }

  saveIngestRegistry(registry, opts?.lgtmDir);

  return removeFromWatchList(storeDir(opts?.lgtmDir), repo.owner, repo.repoName);
}

/**
 * Unwatch a repo. Same effect as denying it, named for the calling context.
 */
export function unwatchRepo(repo: ScannedRepo, opts?: { lgtmDir?: string }): WatchListChange {
  return denyRepo(repo, opts);
}

/**
 * Prune repos whose path no longer exists on disk, and stop watching them.
 * Returns the repos that were pruned.
 */
export function pruneIngestRegistry(opts?: { lgtmDir?: string }): IngestRegistryEntry[] {
  const registry = loadIngestRegistry(opts?.lgtmDir);
  const removed: IngestRegistryEntry[] = [];
  const kept: IngestRegistryEntry[] = [];

  for (const entry of registry) {
    if (!fs.existsSync(entry.path)) {
      removed.push({ ...entry, status: "removed", removedAt: new Date().toISOString() });
    } else {
      kept.push(entry);
    }
  }

  saveIngestRegistry(kept, opts?.lgtmDir);

  // A deleted checkout cannot be reviewed, so it must leave the watch list too.
  for (const entry of removed) {
    removeFromWatchList(storeDir(opts?.lgtmDir), entry.owner, entry.repoName);
  }

  return removed;
}


// ─── Sorting ────────────────────────────────────────────────────────────────

/**
 * Sort repos by relevance:
 * 1. Status: new first (needs decision), then watching, then denied
 * 2. Activity: most recent commit first
 * 3. Platform: github > gitlab > bitbucket > local
 * 4. Name: alphabetical tiebreaker
 */
export function sortRepos<T extends { status: RepoStatus; lastCommitDate?: string; platform?: string; name: string }>(
  repos: T[]
): T[] {
  const statusOrder: Record<RepoStatus, number> = { new: 0, watching: 1, denied: 2, removed: 3 };
  const platformOrder: Record<string, number> = { github: 0, gitlab: 1, bitbucket: 2, other: 3 };

  return [...repos].sort((a, b) => {
    // 1. Status priority
    const statusDiff = statusOrder[a.status] - statusOrder[b.status];
    if (statusDiff !== 0) return statusDiff;

    // 2. Activity (most recent first)
    const aDate = a.lastCommitDate ? new Date(a.lastCommitDate).getTime() : 0;
    const bDate = b.lastCommitDate ? new Date(b.lastCommitDate).getTime() : 0;
    if (aDate !== bDate) return bDate - aDate; // descending

    // 3. Platform priority
    const aPlatform = platformOrder[a.platform ?? "other"] ?? 3;
    const bPlatform = platformOrder[b.platform ?? "other"] ?? 3;
    if (aPlatform !== bPlatform) return aPlatform - bPlatform;

    // 4. Name alphabetical
    return a.name.localeCompare(b.name);
  });
}

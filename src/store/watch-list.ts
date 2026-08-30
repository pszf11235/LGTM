/**
 * Watch list management.
 *
 * Stores the set of repositories to poll in watch.md as a frontmatter array.
 * Each entry has owner, repo, addedAt, lastPolledAt, and etag.
 *
 * Reads and writes through the okf layer. Idempotent. Handles missing or
 * malformed fields gracefully.
 */

import { createOKFStore } from "./okf.js";
import { getStorePath, getWatchListPath } from "./paths.js";

export interface WatchEntry {
  owner: string;
  repo: string;
  addedAt: string; // ISO timestamp
  lastPolledAt?: string; // ISO timestamp
  etag?: string;
}

/**
 * Load the watch list from watch.md.
 * Returns an empty array if the file doesn't exist.
 * Filters out entries with missing owner or repo.
 */
export async function loadWatchList(lgtmDir?: string): Promise<WatchEntry[]> {
  const store = createOKFStore(lgtmDir ?? getStorePath());
  const doc = await store.read("watch.md");

  if (!doc) {
    return [];
  }

  const entries = (doc.data.repos as unknown[]) ?? [];
  return entries
    .filter((entry): entry is Record<string, unknown> => typeof entry === "object" && entry !== null)
    .filter((entry) => typeof entry.owner === "string" && typeof entry.repo === "string")
    .map((entry) => ({
      owner: entry.owner as string,
      repo: entry.repo as string,
      addedAt: parseOptionalString(entry.addedAt) || new Date().toISOString(),
      lastPolledAt: parseOptionalString(entry.lastPolledAt),
      etag: parseOptionalString(entry.etag),
    }));
}

/**
 * Write the watch list to watch.md.
 * Idempotent; safe to call repeatedly.
 * The body is generated from frontmatter so hand-edits won't persist.
 */
export async function saveWatchList(entries: WatchEntry[], lgtmDir?: string): Promise<void> {
  const store = createOKFStore(lgtmDir ?? getStorePath());

  const data = {
    repos: entries.map((e) => ({
      owner: e.owner,
      repo: e.repo,
      addedAt: e.addedAt,
      ...(e.lastPolledAt && { lastPolledAt: e.lastPolledAt }),
      ...(e.etag && { etag: e.etag }),
    })),
  };

  const body = [
    "# Watched Repositories",
    "",
    entries.length === 0
      ? "No repositories are being watched."
      : `Polling ${entries.length} repository/repositories.`,
    "",
    ...entries.map((e) => {
      const url = `https://github.com/${e.owner}/${e.repo}`;
      const lastPolled = e.lastPolledAt ? ` — last polled ${e.lastPolledAt.split("T")[0]}` : "";
      return `- [${e.owner}/${e.repo}](${url})${lastPolled}`;
    }),
    "",
  ].join("\n");

  await store.write("watch.md", data, body);
}

/**
 * Add a repository to the watch list.
 * Idempotent; returns true if added, false if already present.
 */
export async function addToWatchList(owner: string, repo: string, lgtmDir?: string): Promise<boolean> {
  const entries = await loadWatchList(lgtmDir);
  const existing = entries.find((e) => e.owner === owner && e.repo === repo);

  if (existing) {
    return false;
  }

  entries.push({
    owner,
    repo,
    addedAt: new Date().toISOString(),
  });

  await saveWatchList(entries, lgtmDir);
  return true;
}

/**
 * Remove a repository from the watch list.
 * Idempotent; returns true if removed, false if not present.
 */
export async function removeFromWatchList(owner: string, repo: string, lgtmDir?: string): Promise<boolean> {
  const entries = await loadWatchList(lgtmDir);
  const filtered = entries.filter((e) => !(e.owner === owner && e.repo === repo));

  if (filtered.length === entries.length) {
    return false;
  }

  await saveWatchList(filtered, lgtmDir);
  return true;
}

/**
 * Update the lastPolledAt timestamp for a repository.
 * No-op if the repository is not in the watch list.
 */
export async function updateLastPolledAt(owner: string, repo: string, lgtmDir?: string): Promise<void> {
  const entries = await loadWatchList(lgtmDir);
  const entry = entries.find((e) => e.owner === owner && e.repo === repo);

  if (entry) {
    entry.lastPolledAt = new Date().toISOString();
    await saveWatchList(entries, lgtmDir);
  }
}

/**
 * Update the ETag for a repository.
 * No-op if the repository is not in the watch list.
 */
export async function updateETag(owner: string, repo: string, etag: string, lgtmDir?: string): Promise<void> {
  const entries = await loadWatchList(lgtmDir);
  const entry = entries.find((e) => e.owner === owner && e.repo === repo);

  if (entry) {
    entry.etag = etag;
    await saveWatchList(entries, lgtmDir);
  }
}

/**
 * Get the watched repositories as a Set of "owner/repo" strings.
 * Useful for reconciliation checks.
 */
export async function getWatchedRepoKeys(lgtmDir?: string): Promise<Set<string>> {
  const entries = await loadWatchList(lgtmDir);
  return new Set(entries.map((e) => `${e.owner}/${e.repo}`));
}

/**
 * Parse a value as an optional string.
 */
function parseOptionalString(value: unknown): string | undefined {
  if (typeof value === "string" && value.length > 0) {
    return value;
  }
  return undefined;
}

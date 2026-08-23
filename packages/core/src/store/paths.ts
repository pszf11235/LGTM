/**
 * Path helpers for the central LGTM store.
 *
 * The store lives at ~/.lgtm-farm/ and is shared across every repo.
 * Repo identity is encoded in review directory and cache file names, so a
 * single store can hold findings for any number of repositories.
 *
 * resolveLgtmDir() lives in config/loader.ts. This file provides sub-paths.
 */

import path from "path";
import fs from "fs";

/**
 * Ensure the store directory structure exists.
 */
export function ensureLgtmDirs(lgtmDir: string): void {
  const dirs = [
    lgtmDir,
    path.join(lgtmDir, "agents"),
    path.join(lgtmDir, "reviews"),
    path.join(lgtmDir, "rules"),
    path.join(lgtmDir, "sessions"),
    path.join(lgtmDir, "cache"),
  ];

  for (const dir of dirs) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

/**
 * A repo-qualified slug used for review directories and cache files.
 * `pszf11235/LGTM` + 42 → `pszf11235-LGTM-42`
 */
export function repoSlug(owner: string, repo: string, pr?: number): string {
  const base = `${owner}-${repo}`;
  return pr === undefined ? base : `${base}-${pr}`;
}

/**
 * Directory holding every review round for one PR.
 */
export function getReviewDir(
  lgtmDir: string,
  owner: string,
  repo: string,
  pr: number
): string {
  return path.join(lgtmDir, "reviews", repoSlug(owner, repo, pr));
}

/**
 * Agents directory — review prompts live here, global to the store.
 */
export function getAgentsDir(lgtmDir: string): string {
  return path.join(lgtmDir, "agents");
}

/**
 * Repo-qualified cache path for a fetched diff.
 * Must be repo-qualified because the store is shared.
 */
export function getCachePath(
  lgtmDir: string,
  owner: string,
  repo: string,
  pr: number
): string {
  return path.join(lgtmDir, "cache", `${repoSlug(owner, repo, pr)}.md`);
}

/**
 * Get the session directory for a given date.
 * Sessions are organized by date: <lgtmDir>/sessions/YYYY-MM-DD/
 */
export function getSessionDir(lgtmDir: string, date?: string): string {
  const dateStr = date ?? new Date().toISOString().split("T")[0];
  return path.join(lgtmDir, "sessions", dateStr);
}

/**
 * Get the rules directory.
 */
export function getRulesDir(lgtmDir: string): string {
  return path.join(lgtmDir, "rules");
}

/**
 * Get a plugin's config directory.
 */
export function getPluginDir(lgtmDir: string, pluginName: string): string {
  return path.join(lgtmDir, "plugins", pluginName);
}

/**
 * Get the profile file path.
 */
export function getProfilePath(lgtmDir: string): string {
  return path.join(lgtmDir, "profile.md");
}

/**
 * Find the git root of the current working directory.
 * Walks up the directory tree looking for .git/
 * Returns cwd if no .git found.
 */
export function findGitRoot(startDir?: string): string {
  let dir = startDir ?? process.cwd();

  while (dir !== path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, ".git"))) {
      return dir;
    }
    dir = path.dirname(dir);
  }

  // No .git found — use cwd
  return process.cwd();
}

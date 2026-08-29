/**
 * Path resolution for the LGTM store.
 *
 * The store lives at ~/.lgtm-farm/ and is shared across all repositories.
 * Repository identity is encoded in review directory names under reviews/,
 * and in filenames like watch.md.
 *
 * Honors the HOME environment variable so tests can relocate the store.
 */

import path from "path";
import os from "os";

/**
 * Resolve the user's home directory.
 *
 * HOME is honored ahead of os.homedir() so the store can be relocated by
 * the environment. Tests use this to isolate to a temp directory.
 */
function homeDir(): string {
  return process.env.HOME || os.homedir();
}

/**
 * The root LGTM store directory: ~/.lgtm-farm/
 */
export function getStorePath(): string {
  return path.join(homeDir(), ".lgtm-farm");
}

/**
 * Path to config.md in the store.
 */
export function getConfigPath(): string {
  return path.join(getStorePath(), "config.md");
}

/**
 * Path to watch.md in the store.
 */
export function getWatchListPath(): string {
  return path.join(getStorePath(), "watch.md");
}

/**
 * Directory holding every review round for one PR.
 * Format: ~/.lgtm-farm/reviews/<owner>/<repo>/pr-<number>/
 */
export function getReviewDir(owner: string, repo: string, number: number): string {
  return path.join(getStorePath(), "reviews", owner, repo, `pr-${number}`);
}

/**
 * Path to meta.md for a PR.
 * Format: ~/.lgtm-farm/reviews/<owner>/<repo>/pr-<number>/meta.md
 */
export function getPRMetaPath(owner: string, repo: string, number: number): string {
  return path.join(getReviewDir(owner, repo, number), "meta.md");
}

/**
 * Path to a round file for a PR.
 * Format: ~/.lgtm-farm/reviews/<owner>/<repo>/pr-<number>/r<N>-<agent>.md
 *
 * @param owner Repository owner
 * @param repo Repository name
 * @param number PR number
 * @param round Round number (1-indexed)
 * @param agent Agent name (e.g., "reviewer")
 */
export function getRoundPath(
  owner: string,
  repo: string,
  number: number,
  round: number,
  agent: string
): string {
  return path.join(getReviewDir(owner, repo, number), `r${round}-${agent}.md`);
}

/**
 * Path to a diff snapshot for a PR.
 * Format: ~/.lgtm-farm/reviews/<owner>/<repo>/pr-<number>/diff-<sha>.patch
 */
export function getDiffPath(owner: string, repo: string, number: number, sha: string): string {
  return path.join(getReviewDir(owner, repo, number), `diff-${sha}.patch`);
}

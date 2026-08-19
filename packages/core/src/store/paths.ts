/**
 * Path resolution for lgtm data directories.
 *
 * Storage modes:
 * - "farm": central lgtm-farm (default: ~/.lgtm-farm/<repo-name>/)
 * - "repo": .lgtm/ in each repo root (committed to git, team-shareable)
 *
 * The resolveYakDir() function that handles mode logic lives in config/loader.ts
 * (since it depends on BootstrapConfig). This file provides the sub-path helpers.
 */

import path from "path";
import fs from "fs";

/**
 * Ensure the lgtm directory structure exists.
 * Creates all subdirectories needed for operation.
 */
export function ensureYakDirs(lgtmDir: string): void {
  const dirs = [
    lgtmDir,
    path.join(lgtmDir, "rules"),
    path.join(lgtmDir, "sessions"),
    path.join(lgtmDir, "plugins"),
    path.join(lgtmDir, "learnings"),
    path.join(lgtmDir, "scans"),
  ];

  for (const dir of dirs) {
    fs.mkdirSync(dir, { recursive: true });
  }
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

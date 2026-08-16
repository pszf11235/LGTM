/**
 * Path resolution for yak data directories.
 *
 * Storage modes:
 * - "farm": central yak-farm (default: ~/.yak-farm/<repo-name>/)
 * - "repo": .yak/ in each repo root (committed to git, team-shareable)
 *
 * The resolveYakDir() function that handles mode logic lives in config/loader.ts
 * (since it depends on BootstrapConfig). This file provides the sub-path helpers.
 */

import path from "path";
import fs from "fs";

/**
 * Ensure the yak directory structure exists.
 * Creates all subdirectories needed for operation.
 */
export function ensureYakDirs(yakDir: string): void {
  const dirs = [
    yakDir,
    path.join(yakDir, "rules"),
    path.join(yakDir, "sessions"),
    path.join(yakDir, "plugins"),
    path.join(yakDir, "learnings"),
    path.join(yakDir, "scans"),
  ];

  for (const dir of dirs) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

/**
 * Get the session directory for a given date.
 * Sessions are organized by date: <yakDir>/sessions/YYYY-MM-DD/
 */
export function getSessionDir(yakDir: string, date?: string): string {
  const dateStr = date ?? new Date().toISOString().split("T")[0];
  return path.join(yakDir, "sessions", dateStr);
}

/**
 * Get the rules directory.
 */
export function getRulesDir(yakDir: string): string {
  return path.join(yakDir, "rules");
}

/**
 * Get a plugin's config directory.
 */
export function getPluginDir(yakDir: string, pluginName: string): string {
  return path.join(yakDir, "plugins", pluginName);
}

/**
 * Get the profile file path.
 */
export function getProfilePath(yakDir: string): string {
  return path.join(yakDir, "profile.md");
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

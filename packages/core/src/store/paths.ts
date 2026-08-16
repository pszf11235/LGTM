/**
 * Path resolution for the .yak/ data directory.
 *
 * Handles both storage modes:
 * - "repo": .yak/ in the git repo root (committed, team-shareable)
 * - "central": ~/.yak/ in the user's home dir (global, personal)
 *
 * Per-project overrides always live in the repo root as .yakrc.yaml.
 */

import path from "path";
import os from "os";
import fs from "fs";

/**
 * Resolve the .yak/ directory based on storage mode.
 *
 * @param mode - "central" (~/. yak/) or "repo" (.yak/ in repo root)
 * @param repoRoot - Git repo root (used for "repo" mode)
 */
export function resolveYakDir(
  mode: "central" | "repo",
  repoRoot: string
): string {
  if (mode === "central") {
    return path.join(os.homedir(), ".yak");
  }
  return path.join(repoRoot, ".yak");
}

/**
 * Ensure the .yak/ directory structure exists.
 * Creates the base directories needed for operation.
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
 * Sessions are organized by date: .yak/sessions/YYYY-MM-DD/
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

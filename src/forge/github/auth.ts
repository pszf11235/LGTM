/**
 * GitHub token resolution for API authentication.
 *
 * Order: GITHUB_TOKEN, GH_TOKEN, `gh auth token` (by absolute path), then
 * ~/.lgtm-farm/credentials.json (mode 0600).
 *
 * Re-resolves on demand; the old adapter's lifetime cache meant a token
 * rotated mid-run was never picked up.
 */

import { readFileSync, chmodSync, mkdirSync } from "fs";
import { homedir } from "os";
import { join } from "path";

/**
 * Resolves a GitHub token for API authentication.
 *
 * @param ghBinPath - Absolute path to the `gh` binary (e.g., from PATH probe).
 *   If null, skips the `gh auth token` step.
 * @returns The resolved token, or null if none found.
 */
export function resolveGitHubToken(ghBinPath: string | null = null): string | null {
  // 1. Environment: GITHUB_TOKEN takes precedence, then GH_TOKEN.
  const envToken = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
  if (envToken) return envToken;

  // 2. gh CLI (only if path provided).
  if (ghBinPath) {
    const token = getTokenFromGh(ghBinPath);
    if (token) return token;
  }

  // 3. Saved credentials file.
  return loadCredentialsToken();
}

/**
 * Spawns `gh auth token` and returns its output.
 *
 * Stderr is discarded to avoid noise if gh is broken or missing. The old code
 * had a real bug here: stderr inherited from the parent process meant missing
 * or broken `gh` would print into the middle of LGTM output.
 *
 * @param ghBinPath - Absolute path to the `gh` binary.
 * @returns Token string, or null if spawn failed or output was empty.
 */
function getTokenFromGh(ghBinPath: string): string | null {
  try {
    const proc = Bun.spawnSync([ghBinPath, "auth", "token"], {
      stdio: ["ignore", "pipe", "ignore"], // stderr discarded
    });

    if (proc.exitCode === 0) {
      const token = proc.stdout?.toString().trim();
      if (token) return token;
    }
  } catch {
    // Spawn failed (binary not found, permissions, etc.). Return null without
    // printing anything. This is tested explicitly.
  }

  return null;
}

/**
 * Loads a GitHub token from the credentials file.
 *
 * File: ~/.lgtm-farm/credentials.json, mode 0600.
 * Format: { "github": "ghp_..." }
 *
 * @returns Token string, or null if file doesn't exist or doesn't contain github key.
 */
function loadCredentialsToken(): string | null {
  const credPath = join(homedir(), ".lgtm-farm", "credentials.json");

  try {
    const content = readFileSync(credPath, "utf-8");
    const creds = JSON.parse(content) as Record<string, unknown>;
    const token = creds.github;

    if (typeof token === "string" && token) {
      return token;
    }
  } catch {
    // File doesn't exist, parse failed, or read failed. No token available.
  }

  return null;
}

/**
 * Saves a GitHub token to the credentials file with secure permissions.
 *
 * Creates ~/.lgtm-farm/credentials.json with mode 0600 if it doesn't exist.
 * Merges with existing credentials.
 *
 * @param token - The token to save.
 */
export function saveCredentialsToken(token: string): void {
  const credDir = join(homedir(), ".lgtm-farm");
  const credPath = join(credDir, "credentials.json");

  let creds: Record<string, unknown> = {};

  // Load existing
  try {
    const content = readFileSync(credPath, "utf-8");
    creds = JSON.parse(content) as Record<string, unknown>;
  } catch {
    // File doesn't exist or can't be read. Start with empty object.
  }

  creds.github = token;

  // Ensure directory exists
  try {
    mkdirSync(credDir, { recursive: true });
  } catch {
    throw new Error(`Failed to create credentials directory: ${credDir}`);
  }

  // Write with mode 0600 (read/write for owner only).
  // Use Bun.write to write the JSON, then chmod to secure it.
  const content = JSON.stringify(creds, null, 2);
  Bun.write(credPath, content);
  chmodSync(credPath, 0o600);
}

/**
 * Human-readable guidance for when no token could be resolved.
 */
export function describeMissingGitHubToken(): string[] {
  return [
    "No GitHub token found. Set one of these:",
    "",
    "  export GITHUB_TOKEN=ghp_...        takes precedence over everything else",
    "  gh auth login                      easiest if you have the gh CLI",
    "  lgtm auth login                    saves to ~/.lgtm-farm/credentials.json",
  ];
}

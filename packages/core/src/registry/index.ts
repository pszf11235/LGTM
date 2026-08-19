/**
 * Yak Registry — tracks all yak-enabled repos on this machine.
 *
 * Lives at ~/.yak-registry.md (always central, regardless of storage mode).
 * Auto-registers current repo on every yak invocation.
 * Supports discovery (scan for .yak/ directories) and pruning stale entries.
 */

import fs from "fs";
import path from "path";
import os from "os";
import matter from "gray-matter";

export interface RegistryEntry {
  path: string;
  name: string;
  lastSeen: string;
  plugins: string[];
  storageMode: "farm" | "repo";
}

interface RegistryData {
  type: string;
  lastUpdated: string;
  repos: RegistryEntry[];
}

const REGISTRY_PATH = path.join(os.homedir(), ".yak-registry.md");

/**
 * Load the registry (or create empty).
 */
export function loadRegistry(): RegistryEntry[] {
  try {
    const raw = fs.readFileSync(REGISTRY_PATH, "utf-8");
    const { data } = matter(raw);
    return (data.repos as RegistryEntry[]) ?? [];
  } catch {
    return [];
  }
}

/**
 * Save the registry.
 */
function saveRegistry(repos: RegistryEntry[]): void {
  const data: RegistryData = {
    type: "yak/registry",
    lastUpdated: new Date().toISOString(),
    repos,
  };

  const body = [
    "# Yak Registry",
    "",
    `Tracks ${repos.length} yak-enabled repo(s) on this machine.`,
    "",
    ...repos.map((r) => `- **${r.name}** — \`${r.path}\` (last seen: ${r.lastSeen.split("T")[0]})`),
    "",
  ].join("\n");

  // Strip undefined values
  const cleanData = JSON.parse(JSON.stringify(data));
  const output = matter.stringify(body, cleanData);
  fs.mkdirSync(path.dirname(REGISTRY_PATH), { recursive: true });
  fs.writeFileSync(REGISTRY_PATH, output, "utf-8");
}

/**
 * Register a repo (upsert). Called on every yak invocation.
 */
export function registerRepo(
  repoRoot: string,
  opts?: { plugins?: string[]; storageMode?: "farm" | "repo" }
): void {
  const repos = loadRegistry();
  const name = path.basename(repoRoot);
  const now = new Date().toISOString();

  const existing = repos.find((r) => r.path === repoRoot);
  if (existing) {
    existing.lastSeen = now;
    if (opts?.plugins) existing.plugins = opts.plugins;
    if (opts?.storageMode) existing.storageMode = opts.storageMode;
  } else {
    repos.push({
      path: repoRoot,
      name,
      lastSeen: now,
      plugins: opts?.plugins ?? ["review"],
      storageMode: opts?.storageMode ?? "repo",
    });
  }

  saveRegistry(repos);
}

/**
 * Discover yak-enabled repos by scanning directories.
 */
export function discoverRepos(scanDir: string, maxDepth = 3): string[] {
  const found: string[] = [];
  const ignore = new Set(["node_modules", ".git", "dist", "build", "vendor"]);

  function walk(dir: string, depth: number) {
    if (depth > maxDepth) return;

    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        if (ignore.has(entry.name)) continue;

        const full = path.join(dir, entry.name);

        if (entry.name === ".yak") {
          // Found a yak-enabled repo (parent of .yak/)
          found.push(dir);
          return; // don't recurse into .yak/
        }

        walk(full, depth + 1);
      }
    } catch {
      // Permission errors — skip
    }
  }

  walk(scanDir, 0);
  return found;
}

/**
 * Prune stale entries (repos that no longer exist on disk).
 */
export function pruneRegistry(): { removed: string[]; kept: number } {
  const repos = loadRegistry();
  const valid = repos.filter((r) => fs.existsSync(r.path));
  const removed = repos.filter((r) => !fs.existsSync(r.path)).map((r) => r.path);

  saveRegistry(valid);
  return { removed, kept: valid.length };
}

/**
 * Get all registered repos.
 */
export function getRegisteredRepos(): RegistryEntry[] {
  return loadRegistry();
}

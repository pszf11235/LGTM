/**
 * Repo Scanner — finds git repositories on the local filesystem.
 *
 * Walks common project directories looking for .git/ folders.
 * Returns an async generator of ScannedRepo objects enriched with metadata.
 *
 * Used by `lgtm discover --ingest` to auto-populate the watch list.
 */

import fs from "fs";
import path from "path";
import os from "os";
import { parseGitUrl } from "../utils/git.js";

// ─── Types ──────────────────────────────────────────────────────────────────

export interface ScannedRepo {
  /** Absolute path to repo root */
  path: string;

  /** Directory name (e.g., "frontend-app") */
  name: string;

  /** Remote origin URL (e.g., "https://github.com/org/repo.git") */
  remote?: string;

  /** Owner extracted from remote (e.g., "org") */
  owner?: string;

  /** Repo name extracted from remote (e.g., "repo") */
  repoName?: string;

  /** Platform detected from remote URL */
  platform?: "github" | "gitlab" | "bitbucket" | "other";

  /** ISO date of most recent commit */
  lastCommitDate?: string;

  /** Default branch name (main, master, etc.) */
  defaultBranch?: string;

  /** Primary language detected from file extensions */
  language?: string;

  /** Whether this appears to be a monorepo (workspaces, packages/, etc.) */
  isMonorepo?: boolean;
}

export interface ScanOptions {
  /** Directories to scan (defaults to common project locations) */
  roots?: string[];

  /** Maximum directory depth to recurse (default: 4) */
  maxDepth?: number;

  /** Directory names to skip */
  excludePatterns?: string[];

  /** Progress callback */
  onProgress?: (found: number, currentDir: string) => void;
}

// ─── Default Configuration ──────────────────────────────────────────────────

const DEFAULT_SCAN_ROOTS = [
  "projects",
  "dev",
  "code",
  "repos",
  "src",
  "work",
  "Desktop",
  "Documents",
].map((dir) => path.join(os.homedir(), dir));

const DEFAULT_EXCLUDES = new Set([
  "node_modules",
  ".cache",
  "vendor",
  "dist",
  "build",
  "Library",
  ".Trash",
  ".local",
  ".npm",
  ".bun",
  ".cargo",
  "go",
  ".rustup",
  "__pycache__",
  ".venv",
  "venv",
  ".tox",
  "target",
]);

const DEFAULT_MAX_DEPTH = 4;

// ─── Scanner ────────────────────────────────────────────────────────────────

/**
 * Scan the filesystem for git repositories.
 * Returns an async generator that yields ScannedRepo objects as they're found.
 */
export async function* scanForRepos(opts: ScanOptions = {}): AsyncGenerator<ScannedRepo> {
  const roots = opts.roots ?? getExistingRoots();
  const maxDepth = opts.maxDepth ?? DEFAULT_MAX_DEPTH;
  const excludes = new Set(opts.excludePatterns ?? [...DEFAULT_EXCLUDES]);
  let found = 0;

  // Also scan cwd if it's not already in roots
  const cwd = process.cwd();
  const allRoots = [...new Set([...roots, cwd])];

  for (const root of allRoots) {
    if (!fs.existsSync(root)) continue;

    for (const repoPath of walkForGitRepos(root, maxDepth, excludes)) {
      found++;
      opts.onProgress?.(found, repoPath);

      const enriched = await enrichRepo(repoPath);
      yield enriched;
    }
  }
}

/**
 * Synchronous scan that returns all repos at once (simpler API for non-streaming use).
 */
export async function scanAllRepos(opts: ScanOptions = {}): Promise<ScannedRepo[]> {
  const repos: ScannedRepo[] = [];
  for await (const repo of scanForRepos(opts)) {
    repos.push(repo);
  }
  return repos;
}

// ─── Filesystem Walker ──────────────────────────────────────────────────────

/**
 * Walk directories finding .git/ folders. Yields repo root paths.
 */
function* walkForGitRepos(
  root: string,
  maxDepth: number,
  excludes: Set<string>
): Generator<string> {
  const stack: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }];

  while (stack.length > 0) {
    const { dir, depth } = stack.pop()!;
    if (depth > maxDepth) continue;

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      // Permission denied, broken symlink, etc. — skip
      continue;
    }

    // Check if THIS directory is a git repo
    const hasGit = entries.some((e) => e.isDirectory() && e.name === ".git");
    if (hasGit) {
      yield dir;
      // Don't recurse into git repos (they might have submodules but we treat each .git as one repo)
      continue;
    }

    // Recurse into subdirectories
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name.startsWith(".")) continue; // Skip hidden dirs (except .git which we already checked)
      if (excludes.has(entry.name)) continue;

      stack.push({ dir: path.join(dir, entry.name), depth: depth + 1 });
    }
  }
}

// ─── Enrichment ─────────────────────────────────────────────────────────────

/**
 * Enrich a repo path with metadata (remote, last commit, language, etc.)
 */
async function enrichRepo(repoPath: string): Promise<ScannedRepo> {
  const name = path.basename(repoPath);
  const repo: ScannedRepo = { path: repoPath, name };

  // 1. Extract remote origin from .git/config
  try {
    const gitConfig = fs.readFileSync(path.join(repoPath, ".git", "config"), "utf-8");
    const remoteMatch = gitConfig.match(/\[remote "origin"\][^[]*url\s*=\s*(.+)/m);
    if (remoteMatch) {
      repo.remote = remoteMatch[1].trim();
      const parsed = parseGitUrl(repo.remote);
      if (parsed) {
        repo.owner = parsed.owner;
        repo.repoName = parsed.repo;
        // Detect platform from URL
        if (repo.remote.includes("github.com")) repo.platform = "github";
        else if (repo.remote.includes("gitlab.com") || repo.remote.includes("gitlab")) repo.platform = "gitlab";
        else if (repo.remote.includes("bitbucket")) repo.platform = "bitbucket";
        else repo.platform = "other";
      }
    }
  } catch { /* no .git/config or parse error */ }

  // 2. Get last commit date (fast: read from packed-refs or run git log)
  try {
    const proc = Bun.spawnSync(["git", "log", "-1", "--format=%aI"], { cwd: repoPath });
    if (proc.exitCode === 0) {
      const date = proc.stdout.toString().trim();
      if (date) repo.lastCommitDate = date;
    }
  } catch { /* git not available or not a valid repo */ }

  // 3. Get default branch
  try {
    const headRef = fs.readFileSync(path.join(repoPath, ".git", "HEAD"), "utf-8").trim();
    const branchMatch = headRef.match(/^ref: refs\/heads\/(.+)$/);
    if (branchMatch) {
      repo.defaultBranch = branchMatch[1];
    }
  } catch { /* no HEAD file */ }

  // 4. Detect primary language from file extensions
  repo.language = detectLanguage(repoPath);

  // 5. Detect monorepo
  repo.isMonorepo = detectMonorepo(repoPath);

  return repo;
}

// ─── Language Detection ─────────────────────────────────────────────────────

const LANGUAGE_MAP: Record<string, string> = {
  ".ts": "typescript",
  ".tsx": "typescript",
  ".js": "javascript",
  ".jsx": "javascript",
  ".py": "python",
  ".go": "go",
  ".rs": "rust",
  ".rb": "ruby",
  ".java": "java",
  ".kt": "kotlin",
  ".swift": "swift",
  ".cs": "csharp",
  ".cpp": "cpp",
  ".c": "c",
  ".php": "php",
  ".dart": "dart",
  ".vue": "vue",
  ".svelte": "svelte",
  ".zig": "zig",
  ".ex": "elixir",
  ".exs": "elixir",
};

/**
 * Quick language detection by counting file extensions in the top 2 levels.
 */
function detectLanguage(repoPath: string): string | undefined {
  const counts: Record<string, number> = {};

  function scanDir(dir: string, depth: number) {
    if (depth > 2) return;
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.name.startsWith(".")) continue;
        if (entry.isDirectory() && depth < 2) {
          if (!DEFAULT_EXCLUDES.has(entry.name)) {
            scanDir(path.join(dir, entry.name), depth + 1);
          }
        } else if (entry.isFile()) {
          const ext = path.extname(entry.name).toLowerCase();
          const lang = LANGUAGE_MAP[ext];
          if (lang) {
            counts[lang] = (counts[lang] ?? 0) + 1;
          }
        }
      }
    } catch { /* permission error */ }
  }

  scanDir(repoPath, 0);

  // Return the most common language
  const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  return sorted[0]?.[0];
}

// ─── Monorepo Detection ─────────────────────────────────────────────────────

/**
 * Check if a repo appears to be a monorepo.
 */
function detectMonorepo(repoPath: string): boolean {
  // Check package.json for workspaces
  try {
    const pkgPath = path.join(repoPath, "package.json");
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
    if (pkg.workspaces) return true;
  } catch { /* no package.json */ }

  // Check for go.work
  if (fs.existsSync(path.join(repoPath, "go.work"))) return true;

  // Check for Cargo workspace
  try {
    const cargoPath = path.join(repoPath, "Cargo.toml");
    const cargo = fs.readFileSync(cargoPath, "utf-8");
    if (cargo.includes("[workspace]")) return true;
  } catch { /* no Cargo.toml */ }

  // Check for packages/ or apps/ directories (common monorepo structure)
  if (fs.existsSync(path.join(repoPath, "packages")) && fs.existsSync(path.join(repoPath, "package.json"))) return true;

  return false;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Get scan roots that actually exist on this machine.
 */
function getExistingRoots(): string[] {
  return DEFAULT_SCAN_ROOTS.filter((root) => {
    try {
      return fs.existsSync(root) && fs.statSync(root).isDirectory();
    } catch {
      return false;
    }
  });
}

/**
 * Git Adapter — native git operations (no LLM needed).
 *
 * Provides structured access to git data:
 * - Diffs (between branches, for PRs)
 * - Branch listing
 * - Repo metadata (remote URL → owner/repo)
 *
 * Uses simple-git for the heavy lifting. All operations are
 * local (no network calls unless explicitly fetching).
 */

import simpleGit, { type SimpleGit } from "simple-git";
import path from "path";

/**
 * Create a git adapter for a given repository root.
 */
export function createGitAdapter(repoRoot: string) {
  const git: SimpleGit = simpleGit(repoRoot);

  /**
   * Check if the given path is inside a git repository.
   */
  async function isGitRepo(): Promise<boolean> {
    try {
      await git.revparse(["--git-dir"]);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Get the raw unified diff between a branch and its merge base with the target.
   *
   * @param branch - The source branch (e.g., "feat/add-oauth")
   * @param target - The target branch to diff against (default: "main")
   * @returns Raw unified diff string
   */
  async function getDiff(branch: string, target = "main"): Promise<string> {
    try {
      // Find the merge base to get only the branch's changes
      const mergeBase = await git.raw(["merge-base", target, branch]);
      const base = mergeBase.trim();

      // Get unified diff from merge base to branch head
      const diff = await git.diff([`${base}..${branch}`]);
      return diff;
    } catch {
      // Fallback: simple diff if merge-base fails (e.g., unrelated histories)
      try {
        const diff = await git.diff([`${target}...${branch}`]);
        return diff;
      } catch {
        // Last resort: diff against target directly
        const diff = await git.diff([target, branch]);
        return diff;
      }
    }
  }

  /**
   * Get diff for staged changes (useful for local review before commit).
   */
  async function getStagedDiff(): Promise<string> {
    return await git.diff(["--cached"]);
  }

  /**
   * Get the list of files changed between a branch and its target.
   * Returns relative file paths only (no diff content).
   */
  async function getChangedFiles(
    branch: string,
    target = "main"
  ): Promise<string[]> {
    try {
      const mergeBase = await git.raw(["merge-base", target, branch]);
      const base = mergeBase.trim();
      const result = await git.diff(["--name-only", `${base}..${branch}`]);
      return result
        .trim()
        .split("\n")
        .filter((f) => f.length > 0);
    } catch {
      // Fallback
      const result = await git.diff(["--name-only", `${target}...${branch}`]);
      return result
        .trim()
        .split("\n")
        .filter((f) => f.length > 0);
    }
  }

  /**
   * List all local branches.
   */
  async function getBranches(): Promise<{
    current: string;
    all: string[];
  }> {
    const summary = await git.branchLocal();
    return {
      current: summary.current,
      all: summary.all,
    };
  }

  /**
   * Get the current branch name.
   */
  async function getCurrentBranch(): Promise<string> {
    const result = await git.revparse(["--abbrev-ref", "HEAD"]);
    return result.trim();
  }

  /**
   * Parse the remote URL to extract owner and repo name.
   * Handles both HTTPS and SSH formats:
   *   https://github.com/owner/repo.git
   *   git@github.com:owner/repo.git
   */
  async function getRepoInfo(): Promise<{
    owner: string;
    repo: string;
    remote: string;
  } | null> {
    try {
      const remotes = await git.getRemotes(true);
      const origin = remotes.find((r) => r.name === "origin");
      if (!origin?.refs?.fetch) return null;

      const url = origin.refs.fetch;
      return parseGitUrl(url);
    } catch {
      return null;
    }
  }

  /**
   * Fetch from remote (useful before diffing against remote branches).
   */
  async function fetch(remote = "origin"): Promise<void> {
    await git.fetch(remote);
  }

  /**
   * Get the HEAD commit SHA for a branch.
   */
  async function getHeadSha(branch?: string): Promise<string> {
    const ref = branch ?? "HEAD";
    const result = await git.revparse([ref]);
    return result.trim();
  }

  return {
    isGitRepo,
    getDiff,
    getStagedDiff,
    getChangedFiles,
    getBranches,
    getCurrentBranch,
    getRepoInfo,
    fetch,
    getHeadSha,
  };
}

/**
 * Parse a git remote URL into owner/repo.
 */
export function parseGitUrl(
  url: string
): { owner: string; repo: string; remote: string } | null {
  // HTTPS: https://github.com/owner/repo.git
  const httpsMatch = url.match(
    /https?:\/\/[^/]+\/([^/]+)\/([^/]+?)(?:\.git)?$/
  );
  if (httpsMatch) {
    return { owner: httpsMatch[1], repo: httpsMatch[2], remote: url };
  }

  // SSH: git@github.com:owner/repo.git
  const sshMatch = url.match(/git@[^:]+:([^/]+)\/([^/]+?)(?:\.git)?$/);
  if (sshMatch) {
    return { owner: sshMatch[1], repo: sshMatch[2], remote: url };
  }

  return null;
}

export type GitAdapter = ReturnType<typeof createGitAdapter>;

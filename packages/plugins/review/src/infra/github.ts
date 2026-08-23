/**
 * GitHub Adapter — native GitHub API integration (no LLM needed).
 *
 * Provides:
 * - Fetch PR metadata (title, body, files, diff)
 * - Post a standalone comment on a PR
 *
 * It deliberately cannot create a published review. Draft reviews are built in
 * domain/pending-review.ts, which is the only file that ever sends an `event`.
 *
 * Auth goes through resolveGitHubToken(): GITHUB_TOKEN, then `gh auth token`,
 * then ~/.lgtm-credentials. Uses raw fetch() to the GitHub REST API.
 */

import { resolveGitHubToken } from "@lgtm/core/auth/github-oauth.js";

/**
 * GitHub PR metadata.
 */
export interface GitHubPR {
  number: number;
  title: string;
  body: string;
  state: string;
  /** The PR author's login, or "unknown". */
  author: string;
  head: { ref: string; sha: string };
  base: { ref: string };
  changedFiles: number;
  additions: number;
  deletions: number;
}

/**
 * Create a GitHub adapter for a specific repo.
 */
export function createGitHubAdapter(owner: string, repo: string) {
  const baseUrl = "https://api.github.com";

  // Cache token on first resolution (avoid execSync per request)
  let cachedToken: string | null = null;
  let tokenResolved = false;

  /**
   * Resolved once per adapter, via the one shared resolver.
   *
   * This used to have its own copy of the resolution order, which drifted from
   * the shared one, and it shelled out to `gh auth token` with stderr inherited,
   * so on a machine where `gh` is broken the shim's error text landed in the
   * middle of our output.
   */
  function getToken(): string | null {
    if (tokenResolved) return cachedToken;
    tokenResolved = true;

    cachedToken = resolveGitHubToken();
    return cachedToken;
  }

  async function request(
    endpoint: string,
    options?: { method?: string; body?: unknown; accept?: string }
  ): Promise<Response> {
    const token = getToken();
    if (!token) throw new Error("GitHub token not found. Set GITHUB_TOKEN or run `gh auth login`.");

    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      Accept: options?.accept ?? "application/vnd.github.v3+json",
      "User-Agent": "lgtm-cli",
    };

    if (options?.body) {
      headers["Content-Type"] = "application/json";
    }

    const res = await fetch(`${baseUrl}${endpoint}`, {
      method: options?.method ?? "GET",
      headers,
      body: options?.body ? JSON.stringify(options.body) : undefined,
      signal: AbortSignal.timeout(30000),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`GitHub API ${res.status}: ${text.slice(0, 200)}`);
    }

    return res;
  }

  /**
   * Fetch PR metadata.
   */
  async function fetchPR(prNumber: number): Promise<GitHubPR> {
    const res = await request(`/repos/${owner}/${repo}/pulls/${prNumber}`);
    const data = await res.json() as any;

    return {
      number: data.number,
      title: data.title,
      body: data.body ?? "",
      state: data.state,
      // Recorded on every review so findings say who wrote the PR.
      author: data.user?.login ?? "unknown",
      head: { ref: data.head.ref, sha: data.head.sha },
      base: { ref: data.base.ref },
      changedFiles: data.changed_files,
      additions: data.additions,
      deletions: data.deletions,
    };
  }

  /**
   * Fetch the raw unified diff for a PR.
   */
  async function fetchDiff(prNumber: number): Promise<string> {
    const res = await request(
      `/repos/${owner}/${repo}/pulls/${prNumber}`,
      { accept: "application/vnd.github.v3.diff" }
    );
    return await res.text();
  }

  /**
   * Get list of changed files in a PR.
   */
  async function fetchChangedFiles(prNumber: number): Promise<string[]> {
    const res = await request(`/repos/${owner}/${repo}/pulls/${prNumber}/files`);
    const files = await res.json() as Array<{ filename: string }>;
    return files.map((f) => f.filename);
  }

  /**
   * There is deliberately no function here that posts a review with an `event`.
   *
   * A review created without one is PENDING: a draft only its author can see,
   * which is the whole point of this tool. The single place an event is ever
   * sent is submitPendingReview() in domain/pending-review.ts, and that runs
   * only when someone types `lgtm review submit`.
   */

  /**
   * Post a single comment on a PR (not as part of a review).
   */
  async function postComment(
    prNumber: number,
    body: string
  ): Promise<void> {
    await request(`/repos/${owner}/${repo}/issues/${prNumber}/comments`, {
      method: "POST",
      body: { body },
    });
  }

  /**
   * Check if we have valid auth for this repo.
   */
  async function checkAuth(): Promise<boolean> {
    try {
      await request(`/repos/${owner}/${repo}`);
      return true;
    } catch {
      return false;
    }
  }

  return {
    fetchPR,
    fetchDiff,
    fetchChangedFiles,
    postComment,
    checkAuth,
    getToken,
  };
}

export type GitHubAdapter = ReturnType<typeof createGitHubAdapter>;

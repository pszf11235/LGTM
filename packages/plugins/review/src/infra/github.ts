/**
 * GitHub Adapter — native GitHub API integration (no LLM needed).
 *
 * Provides:
 * - Fetch PR metadata (title, body, files, diff)
 * - Post reviews (APPROVE / REQUEST_CHANGES)
 * - Post inline comments at specific file/line positions
 *
 * Auth: GITHUB_TOKEN env var or `gh auth token` output.
 * Uses raw fetch() to GitHub REST API.
 */

/**
 * GitHub PR metadata.
 */
export interface GitHubPR {
  number: number;
  title: string;
  body: string;
  state: string;
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

  function getToken(): string | null {
    if (tokenResolved) return cachedToken;
    tokenResolved = true;

    // Check env var first
    if (process.env.GITHUB_TOKEN) { cachedToken = process.env.GITHUB_TOKEN; return cachedToken; }
    if (process.env.GH_TOKEN) { cachedToken = process.env.GH_TOKEN; return cachedToken; }

    // Try `gh auth token` (only once)
    try {
      const { execSync } = require("child_process");
      const token = execSync("gh auth token", { encoding: "utf-8" }).trim();
      if (token) { cachedToken = token; return cachedToken; }
    } catch {
      // gh not available or not logged in
    }

    cachedToken = null;
    return null;
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
   * Post a review on a PR.
   *
   * @param prNumber - PR number
   * @param event - APPROVE, REQUEST_CHANGES, or COMMENT
   * @param body - Review body text
   * @param comments - Optional inline comments
   */
  async function postReview(
    prNumber: number,
    event: "APPROVE" | "REQUEST_CHANGES" | "COMMENT",
    body: string,
    comments?: Array<{ path: string; line: number; body: string }>
  ): Promise<void> {
    await request(`/repos/${owner}/${repo}/pulls/${prNumber}/reviews`, {
      method: "POST",
      body: {
        event,
        body,
        comments: comments?.map((c) => ({
          path: c.path,
          line: c.line,
          body: c.body,
        })),
      },
    });
  }

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
    postReview,
    postComment,
    checkAuth,
    getToken,
  };
}

export type GitHubAdapter = ReturnType<typeof createGitHubAdapter>;

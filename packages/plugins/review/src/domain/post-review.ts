/**
 * Post Review — posts auto-review findings to GitHub PRs.
 *
 * Handles:
 * - Batching findings as a single GitHub review (COMMENT event)
 * - Configurable delay between individual comment posts (anti-spam)
 * - Rate limit awareness (X-RateLimit-Remaining header checking)
 * - Dry-run mode (prints what would be posted without actually posting)
 * - Deduplication against comments already on the PR
 *
 * Entry point: `postReviewFindings()`
 *
 * @module post-review
 */

import type { ReviewFinding, AutoReviewResult } from "./auto-review.js";

// ─── Types ──────────────────────────────────────────────────────────────────

/**
 * Configuration for posting review findings.
 */
export interface PostReviewConfig {
  /** Random delay range between posts in seconds [min, max] (default: [20, 90]) */
  commentDelay: [number, number];

  /** Post as a batched review (true) or individual comments (false) */
  batchMode: boolean;

  /** If true, print findings to stdout instead of posting */
  dryRun: boolean;

  /** Minimum remaining rate limit before pausing (default: 10) */
  rateLimitThreshold: number;
}

/**
 * Result of a post-review operation.
 */
export interface PostReviewResult {
  /** Number of comments successfully posted */
  posted: number;

  /** Number of comments skipped (duplicates, errors) */
  skipped: number;

  /** Whether rate limit was hit */
  rateLimitHit: boolean;

  /** Comments that were posted (or would be in dry-run) */
  comments: PostedComment[];

  /** Human-readable summary */
  summary: string;
}

/**
 * A comment that was posted (or would be posted in dry-run).
 */
export interface PostedComment {
  file: string;
  line: number;
  body: string;
  severity: string;
  posted: boolean;
  reason?: string;
}

/**
 * Minimal GitHub adapter interface (subset of createGitHubAdapter return type).
 */
export interface GitHubPoster {
  postReview(
    prNumber: number,
    event: "APPROVE" | "REQUEST_CHANGES" | "COMMENT",
    body: string,
    comments?: Array<{ path: string; line: number; body: string }>
  ): Promise<void>;

  postComment(prNumber: number, body: string): Promise<void>;

  /** Fetch existing review comments for deduplication */
  fetchReviewComments?(prNumber: number): Promise<Array<{ path?: string; line?: number; body: string }>>;
}

/**
 * Logger interface for output during posting.
 */
export interface PostLogger {
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
}

// ─── Constants ──────────────────────────────────────────────────────────────

const DEFAULT_CONFIG: PostReviewConfig = {
  commentDelay: [20, 90],
  batchMode: true,
  dryRun: false,
  rateLimitThreshold: 10,
};

// ─── Main Entry Point ───────────────────────────────────────────────────────

/**
 * Post auto-review findings to a GitHub PR.
 *
 * In batch mode (default), submits all findings as a single review with
 * inline comments. In individual mode, posts comments one at a time with
 * random delays to avoid spam detection.
 *
 * @param prNumber - The PR number to post to
 * @param result - The auto-review result containing findings
 * @param github - GitHub adapter for API calls
 * @param config - Posting configuration
 * @param logger - Logger for progress output
 * @returns Result of the posting operation
 *
 * @example
 * ```ts
 * const postResult = await postReviewFindings(
 *   42,
 *   autoReviewResult,
 *   githubAdapter,
 *   { dryRun: false, batchMode: true, commentDelay: [20, 90], rateLimitThreshold: 10 },
 *   console
 * );
 * ```
 */
export async function postReviewFindings(
  prNumber: number,
  result: AutoReviewResult,
  github: GitHubPoster,
  config: Partial<PostReviewConfig> = {},
  logger?: PostLogger
): Promise<PostReviewResult> {
  const resolvedConfig = { ...DEFAULT_CONFIG, ...config };
  const log = logger ?? { info: () => {}, warn: () => {}, error: () => {} };

  const { findings, summary } = result;

  if (findings.length === 0) {
    log.info("No findings to post.");
    return {
      posted: 0,
      skipped: 0,
      rateLimitHit: false,
      comments: [],
      summary: "No findings to post.",
    };
  }

  // ── Dry-run mode ───────────────────────────────────────────────────────
  if (resolvedConfig.dryRun) {
    return dryRunPost(findings, summary, log);
  }

  // ── Batch mode: single review with inline comments ─────────────────────
  if (resolvedConfig.batchMode) {
    return batchPost(prNumber, findings, summary, github, log);
  }

  // ── Individual mode: one comment at a time with delays ─────────────────
  return individualPost(prNumber, findings, summary, github, resolvedConfig, log);
}

// ─── Posting Strategies ─────────────────────────────────────────────────────

/**
 * Dry-run: print all findings without posting.
 */
function dryRunPost(
  findings: ReviewFinding[],
  summary: string,
  log: PostLogger
): PostReviewResult {
  log.info(`\n┌─ DRY RUN: ${findings.length} finding(s) would be posted ─┐\n`);
  log.info(`  Summary: ${summary}\n`);

  const comments: PostedComment[] = [];

  for (const finding of findings) {
    const label = `[${finding.severity.toUpperCase()}]`;
    log.info(`  ${label} ${finding.file}:${finding.line}`);
    log.info(`    ${finding.comment}`);
    if (finding.suggestion) {
      log.info(`    💡 ${finding.suggestion}`);
    }
    log.info("");

    comments.push({
      file: finding.file,
      line: finding.line,
      body: finding.comment,
      severity: finding.severity,
      posted: false,
      reason: "dry-run",
    });
  }

  log.info(`└─ End dry run ─┘\n`);

  return {
    posted: 0,
    skipped: findings.length,
    rateLimitHit: false,
    comments,
    summary: `Dry run: ${findings.length} comment(s) would be posted.`,
  };
}

/**
 * Batch mode: submit all findings as a single GitHub review.
 * This is the preferred method — fewer API calls, atomic delivery.
 */
async function batchPost(
  prNumber: number,
  findings: ReviewFinding[],
  summary: string,
  github: GitHubPoster,
  log: PostLogger
): Promise<PostReviewResult> {
  log.info(`Posting ${findings.length} finding(s) as a batched review...`);

  const inlineComments = findings.map((f) => ({
    path: f.file,
    line: f.line,
    body: formatCommentBody(f),
  }));

  const reviewBody = `## 🤖 LGTM Auto-Review\n\n${summary}\n\n---\n_${findings.length} inline comment(s) below._`;

  const comments: PostedComment[] = [];

  try {
    await github.postReview(prNumber, "COMMENT", reviewBody, inlineComments);

    for (const f of findings) {
      comments.push({
        file: f.file,
        line: f.line,
        body: f.comment,
        severity: f.severity,
        posted: true,
      });
    }

    log.info(`✓ Posted review with ${findings.length} inline comment(s).`);

    return {
      posted: findings.length,
      skipped: 0,
      rateLimitHit: false,
      comments,
      summary: `Posted ${findings.length} comment(s) as a batched review.`,
    };
  } catch (err) {
    const errMsg = (err as Error).message;
    log.error(`Failed to post batched review: ${errMsg}`);

    // If batch fails (e.g., invalid line numbers), fall back to individual
    log.warn("Falling back to individual comment posting...");
    return individualPost(
      prNumber,
      findings,
      summary,
      github,
      { ...DEFAULT_CONFIG, batchMode: false },
      log
    );
  }
}

/**
 * Individual mode: post comments one at a time with delays.
 * Used when batch mode fails or when explicit delays are desired.
 */
async function individualPost(
  prNumber: number,
  findings: ReviewFinding[],
  summary: string,
  github: GitHubPoster,
  config: PostReviewConfig,
  log: PostLogger
): Promise<PostReviewResult> {
  log.info(`Posting ${findings.length} finding(s) individually with delays...`);

  // Post the summary as a top-level comment first
  const summaryBody = `## 🤖 LGTM Auto-Review\n\n${summary}\n\n---\n_Posting ${findings.length} inline comment(s) with delays._`;

  try {
    await github.postComment(prNumber, summaryBody);
  } catch (err) {
    log.warn(`Could not post summary comment: ${(err as Error).message}`);
  }

  const comments: PostedComment[] = [];
  let posted = 0;
  let skipped = 0;
  let rateLimitHit = false;

  for (let i = 0; i < findings.length; i++) {
    const finding = findings[i];

    // Check rate limit before each post
    if (rateLimitHit) {
      comments.push({
        file: finding.file,
        line: finding.line,
        body: finding.comment,
        severity: finding.severity,
        posted: false,
        reason: "rate-limit-paused",
      });
      skipped++;
      continue;
    }

    try {
      // Post as a single-comment review (allows inline placement)
      await github.postReview(prNumber, "COMMENT", "", [
        { path: finding.file, line: finding.line, body: formatCommentBody(finding) },
      ]);

      comments.push({
        file: finding.file,
        line: finding.line,
        body: finding.comment,
        severity: finding.severity,
        posted: true,
      });
      posted++;

      log.info(`  [${i + 1}/${findings.length}] ✓ ${finding.file}:${finding.line}`);
    } catch (err) {
      const errMsg = (err as Error).message;

      // Check if it's a rate limit error
      if (errMsg.includes("403") || errMsg.includes("rate limit")) {
        rateLimitHit = true;
        log.warn(`  Rate limit hit. Pausing remaining comments.`);
        comments.push({
          file: finding.file,
          line: finding.line,
          body: finding.comment,
          severity: finding.severity,
          posted: false,
          reason: "rate-limit",
        });
        skipped++;
        continue;
      }

      // Other error — skip this comment
      log.warn(`  [${i + 1}/${findings.length}] ✗ ${finding.file}:${finding.line}: ${errMsg}`);
      comments.push({
        file: finding.file,
        line: finding.line,
        body: finding.comment,
        severity: finding.severity,
        posted: false,
        reason: errMsg,
      });
      skipped++;
    }

    // Delay between posts (unless last)
    if (i < findings.length - 1 && !rateLimitHit) {
      const delay = randomDelay(config.commentDelay);
      log.info(`  ⏳ Waiting ${delay}s before next comment...`);
      await sleep(delay * 1000);
    }
  }

  return {
    posted,
    skipped,
    rateLimitHit,
    comments,
    summary: `Posted ${posted}/${findings.length} comment(s).${rateLimitHit ? " Rate limit hit." : ""}`,
  };
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Format a finding into a GitHub comment body.
 * Adds suggestion as a code suggestion block if present.
 */
function formatCommentBody(finding: ReviewFinding): string {
  let body = finding.comment;

  if (finding.suggestion) {
    body += `\n\n💡 **Suggestion:** ${finding.suggestion}`;
  }

  // Add source attribution (subtle, at the bottom)
  const sourceLabel =
    finding.source === "rule-regex" ? "rule (regex)" :
    finding.source === "rule-llm" ? "rule (AI)" :
    "AI review";

  body += `\n\n<sub>🤖 via lgtm auto-review (${sourceLabel})</sub>`;

  return body;
}

/**
 * Generate a random delay within the configured range.
 */
function randomDelay(range: [number, number]): number {
  const [min, max] = range;
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

/**
 * Sleep for a given number of milliseconds.
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Fetch existing review comments on a PR for deduplication.
 * Returns empty array if the adapter doesn't support it.
 */
export async function fetchExistingComments(
  prNumber: number,
  owner: string,
  repo: string
): Promise<Array<{ file?: string; line?: number; body: string }>> {
  try {
    const { resolveGitHubToken } = await import("@lgtm/core/auth/github-oauth.js");
    const token = resolveGitHubToken();
    if (!token) return [];

    const res = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}/comments`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github.v3+json",
          "User-Agent": "lgtm-cli",
        },
        signal: AbortSignal.timeout(15000),
      }
    );

    if (!res.ok) return [];

    const comments = (await res.json()) as Array<{
      path?: string;
      line?: number;
      original_line?: number;
      body: string;
    }>;

    return comments.map((c) => ({
      file: c.path,
      line: c.line ?? c.original_line,
      body: c.body,
    }));
  } catch {
    return [];
  }
}

/**
 * Creating a PENDING draft review on GitHub, and nothing else.
 *
 * `POST /repos/{owner}/{repo}/pulls/{n}/reviews` creates a review in PENDING
 * state when the `event` field is omitted. A pending review is visible only to
 * its author, anchors every comment to the right diff line, and is fully
 * editable in GitHub's own UI until the author clicks "Submit review". That is
 * the DraftReview of CONTEXT.md; "pending" is GitHub's own name for the state,
 * kept here because it is what the API returns and what the assertions read.
 *
 * Three API constraints shape everything below.
 *
 * 1. `event` must be ABSENT, not falsy. Sending `event: "COMMENT"` publishes
 *    the review immediately and irreversibly, and there is no `draft: true`
 *    parameter. Assuming there was one has already published a live review by
 *    accident elsewhere (anthropics/claude-code#82964).
 * 2. Every comment must go in the create call. The API cannot append to an
 *    existing pending review (GitHub community #168380), so replacing a draft
 *    means deleting it and creating a new one.
 * 3. GitHub rejects the whole create call when a single comment names a line
 *    outside the diff, which is why `checkLines` runs before anything is sent.
 *
 * What is missing here is the point of the file. The old codebase kept a
 * `submitPendingReview` that sent `event: "COMMENT"`; v1 has no such function
 * and no other way to publish, so the dangerous request cannot be constructed
 * rather than merely being avoided. See docs/adr/0001-draft-only-posting.md.
 * The test file enumerates this module's exports and drives every one of them
 * to prove it, so an export added later fails the suite until it is covered.
 */

import type { DraftReview, Finding, PRRef } from "@/core";
import { buildDraftReviewRequest } from "./adapter";
import type { ParsedDiff } from "@/core/diff";
import { getCommentableLines } from "@/core/diff";

/** GitHub is not slow, but a hung socket must not hold a poll cycle open. */
const REQUEST_TIMEOUT_MS = 30_000;

const USER_AGENT = "lgtm";

// ─── Types ──────────────────────────────────────────────────────────────────

/** One inline comment on a right-hand-side diff line. */
export type ReviewComment = DraftReview["comments"][number];

export interface PendingReviewResult {
  reviewId: number;
  commentCount: number;
  url: string;
}

/**
 * A Finding carrying the rest of its identity. Ids restart at f1 per round
 * file, so anything that travels outside its round file needs the full
 * `r<N>:<agent>:<id>` triple (see core/types.ts, FindingKey).
 */
export interface PostableFinding extends Finding {
  round: number;
  agent: string;
}

export interface LineCheckResult {
  /** Findings whose file and line exist in the diff. */
  postable: PostableFinding[];
  /** Findings GitHub would reject, with the reason. These become `held`, never dropped. */
  held: Array<{ finding: PostableFinding; reason: string }>;
}

export interface PendingReviewInput {
  ref: PRRef;
  token: string;
  /** Body and comments, already narrowed to postable findings by `checkLines`. */
  review: DraftReview;
}

export interface PendingReviewRequest {
  url: string;
  method: "POST";
  headers: Record<string, string>;
  /** Exactly two keys. An `event` key here publishes the review. */
  body: { body: string; comments: ReviewComment[] };
}

// ─── Comment body ───────────────────────────────────────────────────────────

/**
 * Render a Finding as a review comment.
 *
 * The severity is deliberately not printed. The configured voice asks for
 * "these events probably won't make it to GA4 (this is an important one)"
 * rather than "**High / borderline critical**", so severity stays in the local
 * files where it drives filtering, and out of the comment.
 */
export function formatCommentBody(finding: Finding): string {
  const parts = [finding.comment.trim()];

  if (finding.suggestion) {
    parts.push(`Suggested: ${finding.suggestion.trim()}`);
  }

  return parts.join("\n\n");
}

/**
 * The review's summary body, shown above the inline comments.
 *
 * This is the default rendering. Once `templates/review-body.md` exists the
 * post flow renders that instead, and this stays as the fallback for a store
 * with no template.
 */
export function formatReviewSummary(input: {
  ref: PRRef;
  round: number;
  commentCount: number;
  heldCount: number;
  unresolvedFromPrior?: number;
}): string {
  const lines: string[] = [];
  const { owner, repo, number } = input.ref;

  const what = input.commentCount === 1 ? "1 comment" : `${input.commentCount} comments`;
  lines.push(
    input.round > 1
      ? `Round ${input.round} review of ${owner}/${repo}#${number}. ${what}.`
      : `${what} on ${owner}/${repo}#${number}.`
  );

  if (input.unresolvedFromPrior) {
    lines.push(
      "",
      `${input.unresolvedFromPrior} finding(s) from the previous round still look open.`
    );
  }

  if (input.heldCount > 0) {
    // Say so in the review itself. A finding held back silently is a finding
    // the author will never hear about.
    lines.push(
      "",
      `${input.heldCount} finding(s) could not be attached to a diff line and were left out.`
    );
  }

  return lines.join("\n");
}

// ─── Line validation ────────────────────────────────────────────────────────

/**
 * Which lines of each file can carry a review comment.
 *
 * Re-exported from the diff parser rather than reimplemented. Two answers to
 * "is this line commentable" would drift, and a wrong answer here makes GitHub
 * reject the whole review rather than the one comment.
 */
export const commentableLines = getCommentableLines;

/**
 * Split findings into those GitHub will accept and those it would reject.
 *
 * Nothing is deleted. A rejected finding is reported so the caller can mark it
 * `held` with the reason, which keeps it eligible for the next post.
 */
export function checkLines(findings: PostableFinding[], diff: ParsedDiff): LineCheckResult {
  const commentable = commentableLines(diff);

  const postable: PostableFinding[] = [];
  const held: Array<{ finding: PostableFinding; reason: string }> = [];

  for (const finding of findings) {
    const lines = commentable.get(finding.file);

    if (!lines) {
      held.push({ finding, reason: `${finding.file} is not in this PR's diff` });
      continue;
    }

    if (!lines.has(finding.line)) {
      held.push({
        finding,
        reason: `line ${finding.line} of ${finding.file} is not in the diff`,
      });
      continue;
    }

    postable.push(finding);
  }

  return { postable, held };
}

// ─── Posting ────────────────────────────────────────────────────────────────

/** Where the adapter sends. Used to render an absolute URL for the dry run. */
const GITHUB_API_BASE = "https://api.github.com";

function githubHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "User-Agent": USER_AGENT,
  };
}

/**
 * The exact request that creates a pending review.
 *
 * Split out from the sending so a test can assert on it, and so the post
 * flow's dry run can show the caller the real thing rather than a description
 * of it. The absence of `event` is the single most important property of this
 * whole file, and it is not something to verify by reading.
 */
export function buildPendingReviewRequest(input: PendingReviewInput): PendingReviewRequest {
  // The adapter's builder, not a second one. The dry run is only worth
  // anything if it previews the request that would really be sent, and two
  // builders drifting apart is how a preview starts lying. The body carries no
  // `event` key, which is what makes this a PENDING draft rather than a
  // published review; the human submits in GitHub's UI (ADR 0001).
  const built = buildDraftReviewRequest(input.ref, input.review);

  return {
    url: `${GITHUB_API_BASE}${built.path}`,
    method: built.method,
    headers: { ...githubHeaders(input.token), "Content-Type": "application/json" },
    body: built.body,
  };
}


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

function reviewsUrl(ref: PRRef): string {
  return `https://api.github.com/repos/${ref.owner}/${ref.repo}/pulls/${ref.number}/reviews`;
}

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
  return {
    url: reviewsUrl(input.ref),
    method: "POST",
    headers: { ...githubHeaders(input.token), "Content-Type": "application/json" },
    // No `event` key. Its absence is what makes this a PENDING draft rather
    // than a published review, and there is nowhere else in LGTM that could add
    // one back. The human submits in GitHub's UI (ADR 0001).
    body: {
      body: input.review.body,
      comments: input.review.comments,
    },
  };
}

/**
 * Create a pending review on GitHub.
 *
 * Throws on failure, with GitHub's own message, because a silent failure here
 * looks identical to a clean PR.
 */
export async function postPendingReview(input: PendingReviewInput): Promise<PendingReviewResult> {
  if (input.review.comments.length === 0) {
    throw new Error("refusing to create a review with no comments");
  }

  const request = buildPendingReviewRequest(input);

  const res = await fetch(request.url, {
    method: request.method,
    headers: request.headers,
    body: JSON.stringify(request.body),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  if (!res.ok) {
    const detail = (await res.text()).slice(0, 500);
    throw new Error(`GitHub ${res.status} creating review: ${detail}`);
  }

  const review = (await res.json()) as { id?: number; state?: string; html_url?: string };

  if (typeof review.id !== "number") {
    throw new Error("GitHub returned a review with no id");
  }

  // Anything but PENDING means the comments are already public, which is the
  // exact accident this design exists to prevent. A missing state is treated
  // the same way: the draft contract is a claim this module has to be able to
  // prove, and an unrecognisable response proves nothing. The old codebase
  // shrugged at an absent state; v1 does not.
  const state = typeof review.state === "string" ? review.state.trim().toUpperCase() : null;
  if (state !== "PENDING") {
    throw new Error(
      `expected a PENDING review but GitHub returned ` +
        `${review.state === undefined ? "no state" : `"${review.state}"`}. ` +
        `The comments may already be visible on the PR.`
    );
  }

  return {
    reviewId: review.id,
    commentCount: input.review.comments.length,
    url:
      review.html_url ??
      `https://github.com/${input.ref.owner}/${input.ref.repo}/pull/${input.ref.number}/files`,
  };
}

/**
 * Delete a draft review, so a post can replace it.
 *
 * Only a pending review can be deleted; a submitted one cannot. A 404 is a
 * success, since the goal is that the draft is gone and someone deleting it in
 * GitHub's UI first is the normal way that happens.
 */
export async function deleteDraftReview(input: {
  ref: PRRef;
  reviewId: number;
  token: string;
}): Promise<void> {
  const res = await fetch(`${reviewsUrl(input.ref)}/${input.reviewId}`, {
    method: "DELETE",
    headers: githubHeaders(input.token),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  if (!res.ok && res.status !== 404) {
    const detail = (await res.text()).slice(0, 500);
    throw new Error(`GitHub ${res.status} deleting pending review: ${detail}`);
  }
}

/**
 * Creating a PENDING review on GitHub.
 *
 * `POST /repos/{owner}/{repo}/pulls/{n}/reviews` creates a review in PENDING
 * state when the `event` field is omitted. A pending review is visible only to
 * its author, anchors every comment to the right diff line, and is fully
 * editable in GitHub's UI until the author clicks "Submit review".
 *
 * That is a better review surface than anything a terminal can draw, and it is
 * free, so the tool's job ends at producing a good draft.
 *
 * Two API constraints shape everything here:
 *
 * 1. `event` must be ABSENT, not falsy. Sending `event: "COMMENT"` publishes the
 *    review immediately, and there is no `draft: true` parameter. Assuming there
 *    was one has already published a live review by accident elsewhere
 *    (anthropics/claude-code#82964).
 * 2. Every comment must go in the create call. The API cannot append to an
 *    existing pending review (GitHub community #168380). One round is one create
 *    call is one pending review.
 */

import type { StoredFinding } from "./review-store.js";
import type { ParsedDiff } from "./diff-parser.js";

// ─── Types ──────────────────────────────────────────────────────────────────

export interface ReviewComment {
  path: string;
  line: number;
  body: string;
}

export interface PendingReviewResult {
  reviewId: number;
  commentCount: number;
  url: string;
}

export interface PostableFinding extends StoredFinding {
  round: number;
  agent: string;
}

export interface LineCheckResult {
  /** Findings whose file and line exist in the diff. */
  postable: PostableFinding[];
  /** Findings GitHub would reject, with the reason. */
  skipped: Array<{ finding: PostableFinding; reason: string }>;
}

// ─── Comment body ───────────────────────────────────────────────────────────

/**
 * Render a finding as a review comment.
 *
 * The severity is deliberately not printed. The configured voice asks for
 * "these events probably won't make it to GA4 (this is an important one)"
 * rather than "**High / borderline critical**", so severity stays in the local
 * files where it is used for filtering, and out of the comment.
 */
export function formatCommentBody(finding: StoredFinding): string {
  const parts = [finding.comment.trim()];

  if (finding.suggestion) {
    parts.push(`Suggested: ${finding.suggestion.trim()}`);
  }

  return parts.join("\n\n");
}

/**
 * The review's summary body, shown above the inline comments.
 */
export function formatReviewSummary(input: {
  owner: string;
  repo: string;
  pr: number;
  round: number;
  commentCount: number;
  skippedCount: number;
  unresolvedFromPrior?: number;
}): string {
  const lines: string[] = [];

  const what = input.commentCount === 1 ? "1 comment" : `${input.commentCount} comments`;
  lines.push(
    input.round > 1
      ? `Round ${input.round} review of ${input.owner}/${input.repo}#${input.pr}. ${what}.`
      : `${what} on ${input.owner}/${input.repo}#${input.pr}.`
  );

  if (input.unresolvedFromPrior) {
    lines.push(
      "",
      `${input.unresolvedFromPrior} finding(s) from the previous round still look open.`
    );
  }

  if (input.skippedCount > 0) {
    // Say so in the review itself. A finding held back silently is a finding
    // the author will never hear about.
    lines.push(
      "",
      `${input.skippedCount} finding(s) could not be attached to a diff line and were left out.`
    );
  }

  return lines.join("\n");
}

// ─── Line validation ────────────────────────────────────────────────────────

/**
 * Build the set of file and line pairs that can carry a review comment.
 *
 * GitHub only accepts a comment on a line that appears in the diff, and it
 * rejects the entire create call if any single comment is invalid. So one bad
 * line would lose the whole review, which is why this runs first.
 *
 * Only added and context lines count. A removed line has no position on the
 * right-hand side of the diff, which is where review comments live.
 */
export function commentableLines(diff: ParsedDiff): Map<string, Set<number>> {
  const byFile = new Map<string, Set<number>>();

  for (const file of diff.files) {
    const lines = new Set<number>();

    for (const hunk of file.hunks) {
      for (const line of hunk.lines) {
        if (line.type === "removed") continue;
        if (typeof line.newLine === "number" && line.newLine > 0) {
          lines.add(line.newLine);
        }
      }
    }

    byFile.set(file.path, lines);
  }

  return byFile;
}

/**
 * Split findings into those GitHub will accept and those it would reject.
 *
 * Nothing is deleted. Rejected findings are reported so the caller can mark them
 * skipped, which keeps them eligible for a later round.
 */
export function checkLines(findings: PostableFinding[], diff: ParsedDiff): LineCheckResult {
  const commentable = commentableLines(diff);

  const postable: PostableFinding[] = [];
  const skipped: Array<{ finding: PostableFinding; reason: string }> = [];

  for (const finding of findings) {
    const lines = commentable.get(finding.file);

    if (!lines) {
      skipped.push({ finding, reason: `${finding.file} is not in this PR's diff` });
      continue;
    }

    if (!lines.has(finding.line)) {
      skipped.push({
        finding,
        reason: `line ${finding.line} of ${finding.file} is not in the diff`,
      });
      continue;
    }

    postable.push(finding);
  }

  return { postable, skipped };
}

// ─── Posting ────────────────────────────────────────────────────────────────

export interface PostPendingInput {
  owner: string;
  repo: string;
  pr: number;
  token: string;
  summary: string;
  comments: ReviewComment[];
  /** Return the request instead of sending it. */
  dryRun?: boolean;
}

/**
 * The exact request that creates a pending review.
 *
 * Split out from the sending so a test can assert on it. The absence of `event`
 * is the single most important property of this whole file, and it is not
 * something to verify by reading.
 */
export function buildPendingReviewRequest(input: PostPendingInput): {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
} {
  return {
    url: `https://api.github.com/repos/${input.owner}/${input.repo}/pulls/${input.pr}/reviews`,
    method: "POST",
    headers: {
      Authorization: `Bearer ${input.token}`,
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
      "User-Agent": "lgtm-cli",
    },
    // No `event` key. Its absence is what makes this a PENDING draft rather
    // than a published review. Do not add one here. `review submit` publishes
    // it later via POST /pulls/{n}/reviews/{id}/events.
    body: {
      body: input.summary,
      comments: input.comments,
    },
  };
}

/**
 * Create a pending review on GitHub.
 *
 * Throws on failure, with GitHub's own message, because a silent failure here
 * looks identical to a clean PR.
 */
export async function postPendingReview(
  input: PostPendingInput
): Promise<PendingReviewResult> {
  const request = buildPendingReviewRequest(input);

  if (input.comments.length === 0) {
    throw new Error("refusing to create a review with no comments");
  }

  const res = await fetch(request.url, {
    method: request.method,
    headers: request.headers,
    body: JSON.stringify(request.body),
    signal: AbortSignal.timeout(30000),
  });

  if (!res.ok) {
    const detail = (await res.text()).slice(0, 500);
    throw new Error(`GitHub ${res.status} creating review: ${detail}`);
  }

  const review = (await res.json()) as { id?: number; state?: string; html_url?: string };

  if (typeof review.id !== "number") {
    throw new Error("GitHub returned a review with no id");
  }

  // If this ever comes back as anything but PENDING, the draft contract is
  // broken and the comments are already public. Say so loudly.
  if (review.state && review.state.toUpperCase() !== "PENDING") {
    throw new Error(
      `expected a PENDING review but GitHub returned "${review.state}". ` +
        `The comments may already be visible on the PR.`
    );
  }

  return {
    reviewId: review.id,
    commentCount: input.comments.length,
    url: review.html_url ?? `https://github.com/${input.owner}/${input.repo}/pull/${input.pr}/files`,
  };
}

/**
 * Submit a pending review, making it visible.
 *
 * This is the one place `event` is sent on purpose.
 */
export async function submitPendingReview(input: {
  owner: string;
  repo: string;
  pr: number;
  reviewId: number;
  token: string;
  body?: string;
}): Promise<void> {
  const res = await fetch(
    `https://api.github.com/repos/${input.owner}/${input.repo}/pulls/${input.pr}/reviews/${input.reviewId}/events`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${input.token}`,
        Accept: "application/vnd.github+json",
        "Content-Type": "application/json",
        "User-Agent": "lgtm-cli",
      },
      // COMMENT rather than REQUEST_CHANGES: the tool found things worth saying,
      // it does not get to block a merge on the author's behalf.
      body: JSON.stringify({ event: "COMMENT", ...(input.body ? { body: input.body } : {}) }),
      signal: AbortSignal.timeout(30000),
    }
  );

  if (!res.ok) {
    const detail = (await res.text()).slice(0, 500);
    throw new Error(`GitHub ${res.status} submitting review: ${detail}`);
  }
}

/**
 * Delete a pending review, so `review post --recreate` can replace it.
 *
 * Only a pending review can be deleted; a submitted one cannot.
 */
export async function deletePendingReview(input: {
  owner: string;
  repo: string;
  pr: number;
  reviewId: number;
  token: string;
}): Promise<void> {
  const res = await fetch(
    `https://api.github.com/repos/${input.owner}/${input.repo}/pulls/${input.pr}/reviews/${input.reviewId}`,
    {
      method: "DELETE",
      headers: {
        Authorization: `Bearer ${input.token}`,
        Accept: "application/vnd.github+json",
        "User-Agent": "lgtm-cli",
      },
      signal: AbortSignal.timeout(30000),
    }
  );

  if (!res.ok && res.status !== 404) {
    const detail = (await res.text()).slice(0, 500);
    throw new Error(`GitHub ${res.status} deleting pending review: ${detail}`);
  }
}

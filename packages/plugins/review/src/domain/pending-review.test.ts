/**
 * The absence of `event` in the create request is what makes a review a draft
 * instead of a published one. Getting it wrong posts comments to a real PR that
 * nobody approved, so it is asserted rather than trusted.
 */

import { describe, test, expect } from "bun:test";
import {
  buildPendingReviewRequest,
  postPendingReview,
  submitPendingReview,
  deletePendingReview,
  formatCommentBody,
  formatReviewSummary,
  commentableLines,
  checkLines,
  type PostableFinding,
} from "./pending-review.js";
import { parseDiff } from "./diff-parser.js";
import type { StoredFinding } from "./review-store.js";

function stored(over: Partial<StoredFinding> = {}): StoredFinding {
  return {
    id: "f1",
    file: "src/a.ts",
    line: 2,
    severity: "high",
    comment: "boom",
    posted: false,
    discarded: false,
    ...over,
  };
}

function postable(over: Partial<PostableFinding> = {}): PostableFinding {
  return { ...stored(), round: 1, agent: "reviewer", ...over };
}

// ─── The draft contract ─────────────────────────────────────────────────────

describe("buildPendingReviewRequest", () => {
  const input = {
    owner: "acme",
    repo: "app",
    pr: 42,
    token: "t",
    summary: "2 comments",
    comments: [{ path: "src/a.ts", line: 2, body: "boom" }],
  };

  test("omits event entirely, which is what creates a PENDING draft", () => {
    const request = buildPendingReviewRequest(input);

    // Absent, not undefined, not empty string. GitHub treats any present event
    // as an instruction to publish.
    expect("event" in request.body).toBe(false);
    expect(Object.keys(request.body).sort()).toEqual(["body", "comments"]);
  });

  test("serialises without an event key, so nothing reintroduces it downstream", () => {
    const json = JSON.stringify(buildPendingReviewRequest(input).body);

    expect(json).not.toContain("event");
    expect(json).not.toContain("COMMENT");
    expect(json).not.toContain("REQUEST_CHANGES");
    expect(json).not.toContain("APPROVE");
  });

  test("does not send a draft flag, because no such parameter exists", () => {
    // Assuming `draft: true` worked has already published a live review
    // elsewhere. Omission is the only mechanism.
    expect("draft" in buildPendingReviewRequest(input).body).toBe(false);
  });

  test("targets the reviews endpoint for the right PR", () => {
    expect(buildPendingReviewRequest(input).url).toBe(
      "https://api.github.com/repos/acme/app/pulls/42/reviews"
    );
    expect(buildPendingReviewRequest(input).method).toBe("POST");
  });

  test("carries the token and the GitHub media type", () => {
    const { headers } = buildPendingReviewRequest(input);

    expect(headers.Authorization).toBe("Bearer t");
    expect(headers.Accept).toBe("application/vnd.github+json");
  });

  test("puts every comment in the create call", () => {
    // The API cannot append comments to an existing pending review, so a comment
    // left out of this call can never be added to it.
    const comments = [
      { path: "a.ts", line: 1, body: "one" },
      { path: "b.ts", line: 2, body: "two" },
      { path: "c.ts", line: 3, body: "three" },
    ];

    expect(buildPendingReviewRequest({ ...input, comments }).body.comments).toEqual(comments);
  });
});

// ─── Comment bodies ─────────────────────────────────────────────────────────

describe("formatCommentBody", () => {
  test("is the comment text, with no severity label", () => {
    // The configured voice asks for "(this is an important one)" rather than
    // "**High / borderline critical**", so severity stays out of the comment.
    const body = formatCommentBody(stored({ severity: "critical", comment: "This will break GA4." }));

    expect(body).toBe("This will break GA4.");
    expect(body.toLowerCase()).not.toContain("critical");
    expect(body.toLowerCase()).not.toContain("severity");
  });

  test("appends a suggestion when there is one", () => {
    const body = formatCommentBody(stored({ comment: "Hardcoded key.", suggestion: "Read it from env." }));

    expect(body).toBe("Hardcoded key.\n\nSuggested: Read it from env.");
  });

  test("carries no bot attribution footer", () => {
    // These get edited and submitted under the user's own name.
    const body = formatCommentBody(stored());

    expect(body).not.toContain("lgtm");
    expect(body).not.toContain("🤖");
    expect(body).not.toContain("<sub>");
  });
});

describe("formatReviewSummary", () => {
  test("names the repo and PR, since one store serves many repos", () => {
    const summary = formatReviewSummary({
      owner: "acme", repo: "app", pr: 42, round: 1, commentCount: 2, skippedCount: 0,
    });

    expect(summary).toContain("acme/app#42");
    expect(summary).toContain("2 comments");
  });

  test("says which round it is once there is more than one", () => {
    const summary = formatReviewSummary({
      owner: "acme", repo: "app", pr: 42, round: 3, commentCount: 1, skippedCount: 0,
    });

    expect(summary).toContain("Round 3");
    expect(summary).toContain("1 comment");
  });

  test("mentions findings still open from the previous round", () => {
    const summary = formatReviewSummary({
      owner: "acme", repo: "app", pr: 42, round: 2, commentCount: 1, skippedCount: 0,
      unresolvedFromPrior: 2,
    });

    expect(summary).toContain("2 finding(s) from the previous round still look open");
  });

  test("declares findings that could not be attached to a line", () => {
    // A finding held back silently is one the author never hears about.
    const summary = formatReviewSummary({
      owner: "acme", repo: "app", pr: 42, round: 1, commentCount: 1, skippedCount: 3,
    });

    expect(summary).toContain("3 finding(s) could not be attached");
  });
});

// ─── Line validation ────────────────────────────────────────────────────────

const DIFF = `diff --git a/src/a.ts b/src/a.ts
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,3 +1,4 @@
 const x = 1;
+const key = "sk-123";
 const y = 2;
-const gone = 3;
 const z = 4;
`;

describe("commentableLines", () => {
  test("includes added and context lines", () => {
    const lines = commentableLines(parseDiff(DIFF));

    // Context lines are commentable on GitHub, not just additions.
    expect(lines.get("src/a.ts")!.has(2)).toBe(true);
    expect(lines.get("src/a.ts")!.size).toBeGreaterThan(1);
  });

  test("excludes removed lines, which have no line on the right side of the diff", () => {
    const parsed = parseDiff(DIFF);
    const removed = parsed.files[0].hunks
      .flatMap((h) => h.lines)
      .filter((l) => l.type === "removed");

    expect(removed.length).toBeGreaterThan(0);
    // A removed line carries no newLine, so it can never enter the set.
    expect(removed.every((l) => l.newLine === undefined || l.newLine === null)).toBe(true);
  });
});

describe("checkLines", () => {
  const diff = parseDiff(DIFF);

  test("passes a finding on a line that is in the diff", () => {
    const result = checkLines([postable({ file: "src/a.ts", line: 2 })], diff);

    expect(result.postable.length).toBe(1);
    expect(result.skipped).toEqual([]);
  });

  test("holds back a finding on a line outside the diff", () => {
    // GitHub rejects the entire create call if one comment is invalid, so one
    // bad line would otherwise lose every comment in the review.
    const result = checkLines([postable({ file: "src/a.ts", line: 900 })], diff);

    expect(result.postable).toEqual([]);
    expect(result.skipped.length).toBe(1);
    expect(result.skipped[0].reason).toContain("line 900");
  });

  test("holds back a finding in a file that is not in the diff", () => {
    const result = checkLines([postable({ file: "src/nowhere.ts", line: 1 })], diff);

    expect(result.postable).toEqual([]);
    expect(result.skipped[0].reason).toContain("not in this PR's diff");
  });

  test("one bad finding does not take the good ones with it", () => {
    const result = checkLines(
      [
        postable({ id: "f1", file: "src/a.ts", line: 2 }),
        postable({ id: "f2", file: "src/a.ts", line: 900 }),
        postable({ id: "f3", file: "src/a.ts", line: 1 }),
      ],
      diff
    );

    expect(result.postable.map((f) => f.id)).toEqual(["f1", "f3"]);
    expect(result.skipped.map((s) => s.finding.id)).toEqual(["f2"]);
  });

  test("an empty diff holds everything back rather than posting blind", () => {
    const result = checkLines([postable()], parseDiff(""));

    expect(result.postable).toEqual([]);
    expect(result.skipped.length).toBe(1);
  });
});


// ─── Sending ────────────────────────────────────────────────────────────────
//
// global fetch is stubbed so the request can be inspected and the response
// handling exercised without touching GitHub.

describe("postPendingReview", () => {
  const base = {
    owner: "acme",
    repo: "app",
    pr: 42,
    token: "t",
    summary: "1 comment",
    comments: [{ path: "src/a.ts", line: 2, body: "boom" }],
  };

  async function withFetch<T>(
    handler: (url: string, init: RequestInit) => Response,
    run: () => Promise<T>
  ): Promise<{ result?: T; error?: Error; calls: Array<{ url: string; init: RequestInit }> }> {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const original = globalThis.fetch;

    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      calls.push({ url, init: init ?? {} });
      return handler(url, init ?? {});
    }) as typeof fetch;

    try {
      return { result: await run(), calls };
    } catch (err) {
      return { error: err as Error, calls };
    } finally {
      globalThis.fetch = original;
    }
  }

  const ok = (body: unknown) =>
    new Response(JSON.stringify(body), { status: 201, headers: { "content-type": "application/json" } });

  test("sends no event field on the wire", async () => {
    // The single most important assertion in this file. Everything else about a
    // draft review follows from this.
    const { calls } = await withFetch(
      () => ok({ id: 999, state: "PENDING" }),
      () => postPendingReview(base)
    );

    const sent = JSON.parse(String(calls[0].init.body));
    expect("event" in sent).toBe(false);
    expect(Object.keys(sent).sort()).toEqual(["body", "comments"]);
  });

  test("returns the review id, which is what links findings to the draft", async () => {
    const { result } = await withFetch(
      () => ok({ id: 2847362, state: "PENDING", html_url: "https://github.com/acme/app/pull/42#pullrequestreview-2847362" }),
      () => postPendingReview(base)
    );

    expect(result!.reviewId).toBe(2847362);
    expect(result!.commentCount).toBe(1);
    expect(result!.url).toContain("pullrequestreview-2847362");
  });

  test("throws when GitHub returns a state other than PENDING", async () => {
    // If this ever happens the comments are already public, which is the exact
    // accident this whole design exists to avoid. It must not pass silently.
    const { error } = await withFetch(
      () => ok({ id: 1, state: "COMMENTED" }),
      () => postPendingReview(base)
    );

    expect(error).toBeDefined();
    expect(error!.message).toContain("expected a PENDING review");
    expect(error!.message).toContain("already be visible");
  });

  test("accepts a response with no state field", async () => {
    // Not every response includes it. Absence is not evidence of publication.
    const { result, error } = await withFetch(
      () => ok({ id: 7 }),
      () => postPendingReview(base)
    );

    expect(error).toBeUndefined();
    expect(result!.reviewId).toBe(7);
  });

  test("surfaces GitHub's own error text on failure", async () => {
    const { error } = await withFetch(
      () => new Response(JSON.stringify({ message: "Validation Failed" }), { status: 422 }),
      () => postPendingReview(base)
    );

    expect(error!.message).toContain("422");
    expect(error!.message).toContain("Validation Failed");
  });

  test("throws when the response carries no id, rather than storing a bad one", () => {
    return withFetch(
      () => ok({ state: "PENDING" }),
      () => postPendingReview(base)
    ).then(({ error }) => {
      expect(error!.message).toContain("no id");
    });
  });

  test("refuses to create an empty review", async () => {
    const { error, calls } = await withFetch(
      () => ok({ id: 1, state: "PENDING" }),
      () => postPendingReview({ ...base, comments: [] })
    );

    expect(error!.message).toContain("no comments");
    // And makes no request at all.
    expect(calls.length).toBe(0);
  });

  test("submitting is the one place an event is sent", async () => {
    const { calls } = await withFetch(
      () => new Response("{}", { status: 200 }),
      () => submitPendingReview({ owner: "acme", repo: "app", pr: 42, reviewId: 5, token: "t" })
    );

    expect(calls[0].url).toBe("https://api.github.com/repos/acme/app/pulls/42/reviews/5/events");
    const sent = JSON.parse(String(calls[0].init.body));
    // COMMENT, not REQUEST_CHANGES: the tool does not block a merge on the
    // author's behalf.
    expect(sent.event).toBe("COMMENT");
  });

  test("deleting a draft tolerates a 404, since the goal is that it is gone", async () => {
    const { error } = await withFetch(
      () => new Response("", { status: 404 }),
      () => deletePendingReview({ owner: "acme", repo: "app", pr: 42, reviewId: 5, token: "t" })
    );

    expect(error).toBeUndefined();
  });

  test("deleting reports a real failure", async () => {
    const { error } = await withFetch(
      () => new Response("gone wrong", { status: 500 }),
      () => deletePendingReview({ owner: "acme", repo: "app", pr: 42, reviewId: 5, token: "t" })
    );

    expect(error!.message).toContain("500");
  });
});

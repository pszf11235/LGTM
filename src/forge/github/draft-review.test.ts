/**
 * The absence of `event` in the create request is what makes a review a draft
 * instead of a published one. Getting it wrong posts comments to a real PR that
 * nobody approved, so it is asserted rather than trusted.
 *
 * v1 goes further than the old codebase, which kept one submit function and
 * guarded it. There is nothing to guard here, so the last section enumerates
 * every runtime export, drives each one, and audits the traffic it produced.
 * An export added later fails that test until someone writes its exercise,
 * and the exercise then has to survive the same audit (ADR 0001).
 */

import { describe, expect, test } from "bun:test";
import type { Finding, PRRef } from "@/core";
import { parseDiff } from "@/core/diff";
import type { ParsedDiff } from "@/core/diff";
import * as draftReviewModule from "./draft-review";
import {
  buildPendingReviewRequest,
  checkLines,
  commentableLines,
  deleteDraftReview,
  formatCommentBody,
  formatReviewSummary,
  postPendingReview,
  type PendingReviewInput,
  type PostableFinding,
} from "./draft-review";

const REF: PRRef = { owner: "acme", repo: "app", number: 42 };

function stored(over: Partial<Finding> = {}): Finding {
  return {
    id: "f1",
    file: "src/a.ts",
    line: 2,
    severity: "high",
    comment: "boom",
    state: "open",
    ...over,
  };
}

function postable(over: Partial<PostableFinding> = {}): PostableFinding {
  return { ...stored(), round: 1, agent: "reviewer", ...over };
}

function postInput(over: Partial<PendingReviewInput> = {}): PendingReviewInput {
  return {
    ref: REF,
    token: "t",
    review: { body: "1 comment", comments: [{ path: "src/a.ts", line: 2, body: "boom" }] },
    ...over,
  };
}

// ─── The draft contract ─────────────────────────────────────────────────────

describe("buildPendingReviewRequest", () => {
  const input = postInput();

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

    expect(
      buildPendingReviewRequest(postInput({ review: { body: "3 comments", comments } })).body
        .comments
    ).toEqual(comments);
  });
});

// ─── Comment bodies ─────────────────────────────────────────────────────────

describe("formatCommentBody", () => {
  test("is the comment text, with no severity label", () => {
    // The configured voice asks for "(this is an important one)" rather than
    // "**High / borderline critical**", so severity stays out of the comment.
    const body = formatCommentBody(
      stored({ severity: "critical", comment: "This will break GA4." })
    );

    expect(body).toBe("This will break GA4.");
    expect(body.toLowerCase()).not.toContain("critical");
    expect(body.toLowerCase()).not.toContain("severity");
  });

  test("appends a suggestion when there is one", () => {
    const body = formatCommentBody(
      stored({ comment: "Hardcoded key.", suggestion: "Read it from env." })
    );

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
      ref: REF, round: 1, commentCount: 2, heldCount: 0,
    });

    expect(summary).toContain("acme/app#42");
    expect(summary).toContain("2 comments");
  });

  test("says which round it is once there is more than one", () => {
    const summary = formatReviewSummary({
      ref: REF, round: 3, commentCount: 1, heldCount: 0,
    });

    expect(summary).toContain("Round 3");
    expect(summary).toContain("1 comment");
  });

  test("mentions findings still open from the previous round", () => {
    const summary = formatReviewSummary({
      ref: REF, round: 2, commentCount: 1, heldCount: 0, unresolvedFromPrior: 2,
    });

    expect(summary).toContain("2 finding(s) from the previous round still look open");
  });

  test("declares findings that could not be attached to a line", () => {
    // A finding held back silently is one the author never hears about.
    const summary = formatReviewSummary({
      ref: REF, round: 1, commentCount: 1, heldCount: 3,
    });

    expect(summary).toContain("3 finding(s) could not be attached");
  });
});

// ─── Line validation ────────────────────────────────────────────────────────

const DIFF_TEXT = `diff --git a/src/a.ts b/src/a.ts
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,3 +1,4 @@
 const x = 1;
+const key = "sk-123";
 const y = 2;
-const gone = 3;
 const z = 4;
`;

const DIFF = parseDiff(DIFF_TEXT);

describe("commentableLines", () => {
  test("includes added and context lines", () => {
    const lines = commentableLines(DIFF);

    // Context lines are commentable on GitHub, not just additions.
    expect(lines.get("src/a.ts")!.has(2)).toBe(true);
    expect(lines.get("src/a.ts")!.size).toBeGreaterThan(1);
  });

  test("excludes removed lines, which have no line on the right side of the diff", () => {
    const removed = DIFF.files[0]!.hunks.flatMap((h) => h.lines).filter((l) => l.type === "removed");

    expect(removed.length).toBeGreaterThan(0);
    // A removed line carries no newLine, so it can never enter the set.
    expect(removed.every((l) => l.newLine === undefined || l.newLine === null)).toBe(true);

    // Every right-hand line of the sample, and only those. Membership rather
    // than a count: parseDiff currently emits one phantom trailing context
    // line for a newline-terminated diff, which is reported separately.
    const lines = commentableLines(DIFF).get("src/a.ts")!;
    for (const line of [1, 2, 3, 4]) expect(lines.has(line)).toBe(true);
    expect(lines.has(900)).toBe(false);
  });

  test("excludes a removed line even when it arrives carrying a right-hand number", () => {
    // Belt and braces for the two ways a line can be uncommentable. No parser
    // produces this, but a comment on a deleted line fails the whole create
    // call, taking every good comment in the review with it.
    const hostile: ParsedDiff = {
      files: [
        {
          path: "src/a.ts",
          status: "modified",
          hunks: [
            {
              header: "@@ -1,2 +1,1 @@",
              oldStart: 1,
              oldCount: 2,
              newStart: 1,
              newCount: 1,
              lines: [
                { type: "removed", content: "const gone = 3;", oldLine: 3, newLine: 7 },
                { type: "context", content: "const x = 1;", oldLine: 1, newLine: null },
              ],
            },
          ],
        },
      ],
    };

    expect(commentableLines(hostile).get("src/a.ts")!.size).toBe(0);
  });
});

describe("checkLines", () => {
  test("passes a finding on a line that is in the diff", () => {
    const result = checkLines([postable({ file: "src/a.ts", line: 2 })], DIFF);

    expect(result.postable.length).toBe(1);
    expect(result.held).toEqual([]);
  });

  test("holds back a finding on a line outside the diff", () => {
    // GitHub rejects the entire create call if one comment is invalid, so one
    // bad line would otherwise lose every comment in the review.
    const result = checkLines([postable({ file: "src/a.ts", line: 900 })], DIFF);

    expect(result.postable).toEqual([]);
    expect(result.held.length).toBe(1);
    expect(result.held[0]!.reason).toContain("line 900");
  });

  test("holds back a finding in a file that is not in the diff", () => {
    const result = checkLines([postable({ file: "src/nowhere.ts", line: 1 })], DIFF);

    expect(result.postable).toEqual([]);
    expect(result.held[0]!.reason).toContain("not in this PR's diff");
  });

  test("one bad finding does not take the good ones with it", () => {
    const result = checkLines(
      [
        postable({ id: "f1", file: "src/a.ts", line: 2 }),
        postable({ id: "f2", file: "src/a.ts", line: 900 }),
        postable({ id: "f3", file: "src/a.ts", line: 1 }),
      ],
      DIFF
    );

    expect(result.postable.map((f) => f.id)).toEqual(["f1", "f3"]);
    expect(result.held.map((h) => h.finding.id)).toEqual(["f2"]);
  });

  test("an empty diff holds everything back rather than posting blind", () => {
    const result = checkLines([postable()], parseDiff(""));

    expect(result.postable).toEqual([]);
    expect(result.held.length).toBe(1);
  });
});

// ─── Sending ────────────────────────────────────────────────────────────────
//
// global fetch is stubbed so the request can be inspected and the response
// handling exercised without touching GitHub.

interface RecordedCall {
  url: string;
  init: RequestInit;
}

/** Every request any test in this file provoked, audited at the bottom. */
const allCalls: RecordedCall[] = [];

async function withFetch<T>(
  handler: (url: string, init: RequestInit) => Response,
  run: () => Promise<T>
): Promise<{ result?: T; error?: Error; calls: RecordedCall[] }> {
  const calls: RecordedCall[] = [];
  const original = globalThis.fetch;

  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const call = { url, init: init ?? {} };
    calls.push(call);
    allCalls.push(call);
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
  new Response(JSON.stringify(body), {
    status: 201,
    headers: { "content-type": "application/json" },
  });

describe("postPendingReview", () => {
  test("sends no event field on the wire", async () => {
    // The single most important assertion in this file. Everything else about a
    // draft review follows from this.
    const { calls } = await withFetch(
      () => ok({ id: 999, state: "PENDING" }),
      () => postPendingReview(postInput())
    );

    const sent = JSON.parse(String(calls[0]!.init.body));
    expect("event" in sent).toBe(false);
    expect(Object.keys(sent).sort()).toEqual(["body", "comments"]);
  });

  test("returns the review id, which is what links findings to the draft", async () => {
    const { result } = await withFetch(
      () =>
        ok({
          id: 2847362,
          state: "PENDING",
          html_url: "https://github.com/acme/app/pull/42#pullrequestreview-2847362",
        }),
      () => postPendingReview(postInput())
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
      () => postPendingReview(postInput())
    );

    expect(error).toBeDefined();
    expect(error!.message).toContain("expected a PENDING review");
    expect(error!.message).toContain("already be visible");
  });

  test("throws on a response with no state field", async () => {
    // The old codebase accepted this, reasoning that absence is not evidence of
    // publication. True, but the job of this module is to prove the review is
    // unpublished, and an unrecognisable response proves nothing. v1 fails loud
    // instead (design.md: "throws unless the response state is PENDING").
    const { error } = await withFetch(
      () => ok({ id: 7 }),
      () => postPendingReview(postInput())
    );

    expect(error!.message).toContain("expected a PENDING review");
    expect(error!.message).toContain("no state");
  });

  test("accepts the state in any casing GitHub might send it", async () => {
    const { result, error } = await withFetch(
      () => ok({ id: 7, state: "pending" }),
      () => postPendingReview(postInput())
    );

    expect(error).toBeUndefined();
    expect(result!.reviewId).toBe(7);
  });

  test("surfaces GitHub's own error text on failure", async () => {
    const { error } = await withFetch(
      () => new Response(JSON.stringify({ message: "Validation Failed" }), { status: 422 }),
      () => postPendingReview(postInput())
    );

    expect(error!.message).toContain("422");
    expect(error!.message).toContain("Validation Failed");
  });

  test("throws when the response carries no id, rather than storing a bad one", () => {
    return withFetch(
      () => ok({ state: "PENDING" }),
      () => postPendingReview(postInput())
    ).then(({ error }) => {
      expect(error!.message).toContain("no id");
    });
  });

  test("refuses to create an empty review", async () => {
    const { error, calls } = await withFetch(
      () => ok({ id: 1, state: "PENDING" }),
      () => postPendingReview(postInput({ review: { body: "nothing", comments: [] } }))
    );

    expect(error!.message).toContain("no comments");
    // And makes no request at all.
    expect(calls.length).toBe(0);
  });
});

describe("deleteDraftReview", () => {
  test("tolerates a 404, since the goal is that the draft is gone", async () => {
    const { error } = await withFetch(
      () => new Response("", { status: 404 }),
      () => deleteDraftReview({ ref: REF, reviewId: 5, token: "t" })
    );

    expect(error).toBeUndefined();
  });

  test("reports a real failure", async () => {
    const { error } = await withFetch(
      () => new Response("gone wrong", { status: 500 }),
      () => deleteDraftReview({ ref: REF, reviewId: 5, token: "t" })
    );

    expect(error!.message).toContain("500");
  });

  test("addresses the review by id under the PR's reviews endpoint", async () => {
    const { calls } = await withFetch(
      () => new Response("", { status: 204 }),
      () => deleteDraftReview({ ref: REF, reviewId: 5, token: "t" })
    );

    expect(calls[0]!.url).toBe("https://api.github.com/repos/acme/app/pulls/42/reviews/5");
    expect(calls[0]!.init.method).toBe("DELETE");
  });
});

// ─── The absence, enforced ──────────────────────────────────────────────────
//
// ADR 0001 claims LGTM contains no code path that can publish a review. A test
// that asserts `submitPendingReview` is not exported would pass forever while
// someone reintroduced the same request under another name, so these tests
// enumerate the module's runtime exports, run each one, and inspect what it
// returned and what it put on the wire.

/** Every key named `event`, at any depth, with the path that reaches it. */
function eventKeyPaths(value: unknown, path = "$", seen = new WeakSet<object>()): string[] {
  if (value === null || typeof value !== "object") return [];
  if (seen.has(value)) return [];
  seen.add(value);

  const found: string[] = [];

  if (value instanceof Map) {
    for (const [key, entry] of value) {
      if (typeof key === "string" && key.toLowerCase() === "event") found.push(`${path}.${key}`);
      found.push(...eventKeyPaths(entry, `${path}.${String(key)}`, seen));
    }
    return found;
  }

  if (value instanceof Set) {
    let index = 0;
    for (const entry of value) found.push(...eventKeyPaths(entry, `${path}{${index++}}`, seen));
    return found;
  }

  if (Array.isArray(value)) {
    value.forEach((entry, index) => found.push(...eventKeyPaths(entry, `${path}[${index}]`, seen)));
    return found;
  }

  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (key.toLowerCase() === "event") found.push(`${path}.${key}`);
    found.push(...eventKeyPaths(entry, `${path}.${key}`, seen));
  }

  return found;
}

/** The GitHub endpoint that publishes a review. Nothing here may address it. */
const SUBMIT_ENDPOINT = /\/reviews\/\d+\/events\b/;

const PUBLISHING_EVENTS = ["COMMENT", "APPROVE", "REQUEST_CHANGES", "DISMISS"];

/** Why a recorded request would have published something, or nothing. */
function publishingFaults(call: RecordedCall): string[] {
  const faults: string[] = [];

  if (SUBMIT_ENDPOINT.test(call.url)) faults.push(`addresses the submit endpoint: ${call.url}`);

  const raw = call.init.body == null ? "" : String(call.init.body);
  if (raw === "") return faults;

  for (const found of eventKeyPaths(JSON.parse(raw))) faults.push(`sends an event key at ${found}`);
  for (const word of PUBLISHING_EVENTS) {
    if (raw.includes(word)) faults.push(`request body contains ${word}`);
  }

  return faults;
}

/**
 * One call per runtime export, with arguments a caller would really pass.
 *
 * Adding an export without adding a row here fails the coverage test below, so
 * nothing reaches the forge unexamined. Keep the inputs ordinary: the point is
 * what a normal call does, not what a contrived one does.
 */
const EXERCISE: Record<string, () => unknown> = {
  formatCommentBody: () => formatCommentBody(stored({ suggestion: "read it from env" })),
  formatReviewSummary: () =>
    formatReviewSummary({ ref: REF, round: 2, commentCount: 1, heldCount: 1, unresolvedFromPrior: 1 }),
  commentableLines: () => commentableLines(DIFF),
  checkLines: () => checkLines([postable(), postable({ id: "f2", line: 900 })], DIFF),
  buildPendingReviewRequest: () => buildPendingReviewRequest(postInput()),
  postPendingReview: () => postPendingReview(postInput()),
  deleteDraftReview: () => deleteDraftReview({ ref: REF, reviewId: 5, token: "t" }),
};

describe("the no-publish invariant", () => {
  test("the event scanner finds a planted event key, so its silence means something", () => {
    // Without this, a scanner that always returned [] would make every
    // assertion below pass, which is the failure mode this whole section is
    // built to avoid.
    expect(eventKeyPaths({ body: { event: "COMMENT" } })).toEqual(["$.body.event"]);
    expect(eventKeyPaths({ requests: [{ Event: "APPROVE" }] })).toEqual(["$.requests[0].Event"]);
    expect(eventKeyPaths({ body: "no keys here", comments: [] })).toEqual([]);
    expect(
      publishingFaults({
        url: "https://api.github.com/repos/acme/app/pulls/42/reviews/5/events",
        init: { method: "POST", body: JSON.stringify({ event: "COMMENT" }) },
      }).length
    ).toBe(3);
  });

  test("every runtime export is exercised, so a new one cannot arrive unexamined", () => {
    // Not a stylistic check. The two tests below only prove something about the
    // exports they call, so the set of exports and the set of exercises have to
    // be the same set.
    expect(Object.keys(draftReviewModule).sort()).toEqual(Object.keys(EXERCISE).sort());
  });

  test("no exported function returns a value carrying an event key", async () => {
    const offenders: string[] = [];

    await withFetch(
      () => ok({ id: 1, state: "PENDING" }),
      async () => {
        for (const [name, exercise] of Object.entries(EXERCISE)) {
          const returned = await exercise();
          for (const found of eventKeyPaths(returned)) offenders.push(`${name} returned ${found}`);
        }
      }
    );

    expect(offenders).toEqual([]);
  });

  test("no exported function puts an event on the wire", async () => {
    const { calls, error } = await withFetch(
      (_url, init) =>
        String(init.method).toUpperCase() === "DELETE"
          ? new Response("", { status: 204 })
          : ok({ id: 1, state: "PENDING" }),
      async () => {
        for (const exercise of Object.values(EXERCISE)) await exercise();
      }
    );

    expect(error).toBeUndefined();
    // If the stub never ran, the assertion below would be vacuous.
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.flatMap(publishingFaults)).toEqual([]);
  });

  test("nothing any test in this file provoked would have published a review", () => {
    // Wider than the exercises above: this covers the odd inputs the earlier
    // tests use, including the empty review and the failure responses.
    expect(allCalls.length).toBeGreaterThan(0);
    expect(allCalls.flatMap(publishingFaults)).toEqual([]);
  });
});

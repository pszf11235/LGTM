/**
 * These tests are a transcription of design.md's "Poll cycle" section. Each
 * describe below quotes the bullet it covers, in the order the design lists
 * them, so the two documents can be read side by side and any drift shows up
 * as a bullet with no describe or a describe with no bullet.
 *
 * The last describe is not from a bullet. Sticky skip is the rule that costs
 * the user something real when it breaks, so it gets the scenario spelled out
 * in CONTEXT.md's "Skip" entry: skip, push commits, confirm it is still
 * skipped.
 */

import { describe, expect, test } from "bun:test";
import {
  classify,
  decide,
  isAutoClass,
  MAX_REVIEW_ATTEMPTS,
  qualifiesForReview,
  reviewsWhenReady,
  type Decision,
  type MetaPatch,
} from "./classify";
import type { Classification, PRMeta, PRSummary } from "./types";

const VIEWER = "ada";
const NOW = "2026-08-29T12:00:00.000Z";
const EARLIER = "2026-08-01T09:00:00.000Z";

function summary(over: Partial<PRSummary> = {}): PRSummary {
  return {
    number: 42,
    title: "Add rate limiter",
    body: "Bounds the token bucket.",
    url: "https://github.com/acme/api/pull/42",
    author: "grace",
    draft: false,
    headSha: "sha-a",
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-02T00:00:00.000Z",
    requestedReviewers: [],
    assignees: [],
    ...over,
  };
}

function meta(over: Partial<PRMeta> = {}): PRMeta {
  return {
    owner: "acme",
    repo: "api",
    number: 42,
    url: "https://github.com/acme/api/pull/42",
    title: "Add rate limiter",
    author: "grace",
    state: "triage",
    classification: "none",
    draft: false,
    headSha: "sha-a",
    lastReviewedSha: null,
    failedAttempts: 0,
    rounds: 0,
    pendingReviewId: null,
    closedAt: null,
    updatedAt: "2026-08-02T00:00:00.000Z",
    ...over,
  };
}

/** One cycle's look at one PR. `pr: null` is a PR that is no longer open. */
function cycle(existing: PRMeta | null, pr: PRSummary | null, viewer = VIEWER): Decision {
  return decide(existing, { pr, viewer, now: NOW });
}

/** meta.md as it reads after the daemon has persisted a decision. */
function applied(existing: PRMeta, patch: MetaPatch): PRMeta {
  return { ...existing, ...patch };
}

// ─── Classification ─────────────────────────────────────────────────────────

// design.md: "Classification reads the PR list item: user.login (own),
// requested_reviewers (requested), assignees (assigned), @login in title or
// body (mentioned)."
describe("classify", () => {
  test("a PR the viewer opened is own", () => {
    expect(classify(summary({ author: VIEWER }), VIEWER)).toBe("own");
  });

  test("a review request on the viewer is requested", () => {
    expect(classify(summary({ requestedReviewers: ["bob", VIEWER] }), VIEWER)).toBe("requested");
  });

  test("an assignment to the viewer is assigned", () => {
    expect(classify(summary({ assignees: [VIEWER] }), VIEWER)).toBe("assigned");
  });

  test("an @login in the title is mentioned", () => {
    expect(classify(summary({ title: "Rate limiter, cc @ada" }), VIEWER)).toBe("mentioned");
  });

  test("an @login in the body is mentioned", () => {
    expect(classify(summary({ body: "@ada does this bucket size look right?" }), VIEWER)).toBe("mentioned");
  });

  test("everything else is none, and lands in triage", () => {
    expect(classify(summary(), VIEWER)).toBe("none");
  });

  test("the strongest reason wins when several apply", () => {
    const everything = summary({
      author: VIEWER,
      requestedReviewers: [VIEWER],
      assignees: [VIEWER],
      title: "@ada",
    });
    expect(classify(everything, VIEWER)).toBe("own");
    expect(classify({ ...everything, author: "grace" }, VIEWER)).toBe("requested");
    expect(classify({ ...everything, author: "grace", requestedReviewers: [] }, VIEWER)).toBe("assigned");
    expect(
      classify({ ...everything, author: "grace", requestedReviewers: [], assignees: [] }, VIEWER),
    ).toBe("mentioned");
  });

  test("logins compare case-insensitively, as GitHub treats them", () => {
    expect(classify(summary({ author: "Ada" }), VIEWER)).toBe("own");
    expect(classify(summary({ requestedReviewers: ["ADA"] }), VIEWER)).toBe("requested");
    expect(classify(summary({ title: "cc @Ada" }), VIEWER)).toBe("mentioned");
  });

  test("a longer login that starts with the viewer's is not a mention", () => {
    expect(classify(summary({ title: "cc @adam and @ada-bot" }), VIEWER)).toBe("none");
  });

  test("an address that merely contains the login is not a mention", () => {
    expect(classify(summary({ body: "mail grace@ada.dev about it" }), VIEWER)).toBe("none");
  });

  test("the bare name without the sigil is not a mention", () => {
    expect(classify(summary({ body: "ada wrote this originally" }), VIEWER)).toBe("none");
  });

  test("regex characters in a login match literally", () => {
    expect(classify(summary({ body: "cc @a.b" }), "a.b")).toBe("mentioned");
    expect(classify(summary({ body: "cc @axb" }), "a.b")).toBe("none");
  });

  test("mention detection is tier (a): only the fields the list row carries", () => {
    // PRSummary has no comments field at all, which is the enforcement. This
    // pins the intent: a mention that lives anywhere but the title or the body
    // cannot reach the classifier (R2.2, comment scanning deferred).
    const pr = summary({ title: "Rate limiter", body: "Bounds the token bucket." });
    expect(Object.keys(pr)).not.toContain("comments");
    expect(classify(pr, VIEWER)).toBe("none");
  });

  test("no authenticated login classifies nothing", () => {
    expect(classify(summary({ author: "" }), "")).toBe("none");
  });
});

describe("isAutoClass / qualifiesForReview", () => {
  test("the four auto classes are the AutoClassPr set", () => {
    const auto: Classification[] = ["own", "requested", "assigned", "mentioned"];
    expect(auto.every(isAutoClass)).toBe(true);
    expect(isAutoClass("none")).toBe(false);
    expect(isAutoClass("manual")).toBe(false);
  });

  test("a manual approval qualifies for review without being auto-class", () => {
    expect(qualifiesForReview("manual")).toBe(true);
    expect(qualifiesForReview("own")).toBe(true);
    expect(qualifiesForReview("none")).toBe(false);
  });
});

// ─── Poll cycle ─────────────────────────────────────────────────────────────

// design.md: "Unknown PR: classify. Auto-class and not draft: state queued.
// Auto-class draft: state triage with a 'reviews when ready' marker and the
// classification recorded. Otherwise: state triage."
describe("unknown PR", () => {
  test("auto-class and not draft: queued", () => {
    const pr = summary({ author: VIEWER });
    const d = cycle(null, pr);

    expect(d.action).toBe("queue");
    expect(d.patch).toEqual({
      url: pr.url,
      title: pr.title,
      author: VIEWER,
      classification: "own",
      draft: false,
      headSha: "sha-a",
      state: "queued",
    });
  });

  test("auto-class draft: triage, classification recorded, reviews when ready", () => {
    const d = cycle(null, summary({ requestedReviewers: [VIEWER], draft: true }));

    expect(d.action).toBe("triage");
    expect(d.patch.state).toBe("triage");
    expect(d.patch.classification).toBe("requested");
    expect(d.patch.draft).toBe(true);
    expect(reviewsWhenReady(applied(meta(), d.patch))).toBe(true);
  });

  test("not auto-class: triage, and no marker", () => {
    const d = cycle(null, summary());

    expect(d.action).toBe("triage");
    expect(d.patch.state).toBe("triage");
    expect(d.patch.classification).toBe("none");
    expect(reviewsWhenReady(applied(meta(), d.patch))).toBe(false);
  });

  test("a draft nobody asked the viewer about is plain triage", () => {
    const d = cycle(null, summary({ draft: true }));

    expect(d.action).toBe("triage");
    expect(d.patch.classification).toBe("none");
    expect(reviewsWhenReady(applied(meta(), d.patch))).toBe(false);
  });
});

// design.md: "Known PR whose draft flag flipped from true to false: queue it
// when it is auto-class (or was approved manually) and its head SHA has no
// completed round. A SHA already reviewed through 'review anyway' does not
// queue again."
describe("draft flag flipped true to false", () => {
  const heldDraft = meta({ state: "triage", classification: "requested", draft: true });

  test("auto-class with no completed round: queued", () => {
    const d = cycle(heldDraft, summary({ requestedReviewers: [VIEWER], draft: false }));

    expect(d.action).toBe("queue");
    expect(d.patch.state).toBe("queued");
    expect(d.patch.draft).toBe(false);
    expect(d.patch.headSha).toBe("sha-a");
  });

  test("approved manually with no completed round: queued", () => {
    const approved = meta({ state: "triage", classification: "manual", draft: true });
    const d = cycle(approved, summary({ draft: false }));

    expect(d.action).toBe("queue");
    expect(d.patch.state).toBe("queued");
    expect(d.patch.classification).toBe("manual");
  });

  test("a SHA already reviewed through 'review anyway' does not queue again", () => {
    const reviewedAnyway = meta({
      state: "reviewed",
      classification: "manual",
      draft: true,
      headSha: "sha-a",
      lastReviewedSha: "sha-a",
      rounds: 1,
    });
    const d = cycle(reviewedAnyway, summary({ draft: false }));

    expect(d.action).toBe("refresh");
    expect(d.patch.state).toBeUndefined();
    // The flip is still recorded, or the next cycle detects it forever.
    expect(d.patch.draft).toBe(false);
    expect(applied(reviewedAnyway, d.patch).state).toBe("reviewed");
  });

  test("not auto-class: stays in triage, with the flip recorded", () => {
    const waiting = meta({ state: "triage", classification: "none", draft: true });
    const d = cycle(waiting, summary({ draft: false }));

    expect(d.action).toBe("refresh");
    expect(d.patch.state).toBeUndefined();
    expect(d.patch.draft).toBe(false);
    expect(applied(waiting, d.patch).state).toBe("triage");
  });

  test("ready and pushed in the same interval still queues, at the new SHA", () => {
    const d = cycle(heldDraft, summary({ requestedReviewers: [VIEWER], draft: false, headSha: "sha-b" }));

    expect(d.action).toBe("queue");
    expect(d.patch.headSha).toBe("sha-b");
  });
});

// design.md: "Known PR, headSha unchanged: re-queue when state is failed and
// failedAttempts is below 3; otherwise no action."
describe("known PR, head SHA unchanged", () => {
  test("a failed round below the cap is re-queued", () => {
    const failed = meta({ state: "failed", classification: "own", failedAttempts: 0 });
    const d = cycle(failed, summary({ author: VIEWER }));

    expect(d.action).toBe("queue");
    expect(d.patch).toEqual({ state: "queued" });
  });

  test("the last attempt under the cap is still re-queued", () => {
    const failed = meta({ state: "failed", classification: "own", failedAttempts: MAX_REVIEW_ATTEMPTS - 1 });

    expect(cycle(failed, summary({ author: VIEWER })).action).toBe("queue");
  });

  test("at the cap it stops, so a broken provider cannot loop forever", () => {
    const exhausted = meta({ state: "failed", classification: "own", failedAttempts: MAX_REVIEW_ATTEMPTS });
    const d = cycle(exhausted, summary({ author: VIEWER }));

    expect(d.action).toBe("none");
    expect(d.patch).toEqual({});
  });

  test("a reviewed PR with no new commits does nothing, and writes nothing", () => {
    const reviewed = meta({
      state: "reviewed",
      classification: "own",
      lastReviewedSha: "sha-a",
      rounds: 1,
    });
    const d = cycle(reviewed, summary({ author: VIEWER }));

    expect(d.action).toBe("none");
    expect(d.patch).toEqual({});
  });

  test("a PR waiting in triage keeps waiting, even once it turns auto-class", () => {
    // Being added as a reviewer on a PR already in the inbox does not queue it
    // behind the user's back. The inbox entry is the ask.
    const waiting = meta({ state: "triage", classification: "none" });
    const d = cycle(waiting, summary({ requestedReviewers: [VIEWER] }));

    expect(d.action).toBe("none");
    expect(d.patch).toEqual({});
  });

  test("a queued or in-flight PR is left alone", () => {
    expect(cycle(meta({ state: "queued", classification: "own" }), summary({ author: VIEWER })).action).toBe(
      "none",
    );
    expect(
      cycle(meta({ state: "reviewing", classification: "own" }), summary({ author: VIEWER })).action,
    ).toBe("none");
  });
});

// design.md: "Known PR, new headSha: if reviewed or failed and auto-class or
// previously approved manually, re-queue for a fresh round with failedAttempts
// reset; if skipped, stay skipped; if triage, refresh metadata."
describe("known PR, new head SHA", () => {
  const pushed = summary({ author: VIEWER, headSha: "sha-b" });

  test("reviewed and auto-class: a fresh round, attempts reset", () => {
    const reviewed = meta({
      state: "reviewed",
      classification: "own",
      lastReviewedSha: "sha-a",
      rounds: 1,
      failedAttempts: 0,
    });
    const d = cycle(reviewed, pushed);

    expect(d.action).toBe("queue");
    expect(d.patch.state).toBe("queued");
    expect(d.patch.headSha).toBe("sha-b");
    expect(d.patch.failedAttempts).toBe(0);
    // The prior round survives; the next one is a new round over the same PR.
    expect(d.patch.rounds).toBeUndefined();
    expect(d.patch.lastReviewedSha).toBeUndefined();
  });

  test("failed and auto-class: a fresh round, and the attempt count resets with the SHA", () => {
    const exhausted = meta({
      state: "failed",
      classification: "own",
      failedAttempts: MAX_REVIEW_ATTEMPTS,
    });
    const d = cycle(exhausted, pushed);

    expect(d.action).toBe("queue");
    expect(d.patch.failedAttempts).toBe(0);
  });

  test("previously approved manually: a fresh round too", () => {
    const approved = meta({
      state: "reviewed",
      classification: "manual",
      lastReviewedSha: "sha-a",
      rounds: 1,
    });
    const d = cycle(approved, summary({ headSha: "sha-b" }));

    expect(d.action).toBe("queue");
    expect(d.patch.classification).toBe("manual");
  });

  test("reviewed but no longer auto-class and never approved: metadata only", () => {
    const stale = meta({
      state: "reviewed",
      classification: "requested",
      lastReviewedSha: "sha-a",
      rounds: 1,
    });
    const d = cycle(stale, summary({ headSha: "sha-b", requestedReviewers: [] }));

    expect(d.action).toBe("refresh");
    expect(d.patch.state).toBeUndefined();
    expect(d.patch.headSha).toBe("sha-b");
  });

  test("skipped: stays skipped", () => {
    const skipped = meta({ state: "skipped" });
    const d = cycle(skipped, summary({ headSha: "sha-b" }));

    expect(d.action).toBe("none");
    expect(applied(skipped, d.patch).state).toBe("skipped");
  });

  test("triage: metadata refreshed, still waiting on a human", () => {
    const waiting = meta({ state: "triage", classification: "none" });
    const d = cycle(waiting, summary({ headSha: "sha-b", title: "Add rate limiter v2" }));

    expect(d.action).toBe("refresh");
    expect(d.patch.state).toBeUndefined();
    expect(d.patch.headSha).toBe("sha-b");
    expect(d.patch.title).toBe("Add rate limiter v2");
    expect(applied(waiting, d.patch).state).toBe("triage");
  });

  test("queued: the newer SHA replaces the queued entry", () => {
    const queued = meta({ state: "queued", classification: "own" });
    const d = cycle(queued, pushed);

    expect(d.action).toBe("queue");
    expect(d.patch.headSha).toBe("sha-b");
  });

  test("reviewing: the in-flight round finishes first, and the SHA is not overwritten", () => {
    // Overwriting headSha here would erase the comparison that re-queues the
    // PR once the round completes at the older SHA.
    const inFlight = meta({ state: "reviewing", classification: "own" });
    const d = cycle(inFlight, pushed);

    expect(d.action).toBe("none");
    expect(d.patch).toEqual({});
    expect(applied(inFlight, d.patch).headSha).toBe("sha-a");
  });
});

// design.md: "PR no longer open: state closed, closedAt stamped, hidden from
// active views."
describe("PR no longer open", () => {
  test("closed, with the stamp from the injected clock", () => {
    const reviewed = meta({ state: "reviewed", classification: "own", lastReviewedSha: "sha-a", rounds: 1 });
    const d = cycle(reviewed, null);

    expect(d.action).toBe("close");
    expect(d.patch).toEqual({ state: "closed", closedAt: NOW });
  });

  test("an already closed PR is not stamped again", () => {
    const closed = meta({ state: "closed", closedAt: EARLIER });
    const d = cycle(closed, null);

    expect(d.action).toBe("none");
    expect(d.patch).toEqual({});
  });

  test("closing keeps the review data; only state and closedAt move", () => {
    const withWork = meta({
      state: "reviewed",
      classification: "own",
      lastReviewedSha: "sha-a",
      rounds: 2,
      pendingReviewId: 987654,
    });
    const after = applied(withWork, cycle(withWork, null).patch);

    expect(after.rounds).toBe(2);
    expect(after.pendingReviewId).toBe(987654);
    expect(after.lastReviewedSha).toBe("sha-a");
  });

  test("a skipped PR keeps its skip through the close", () => {
    // Not decoration. meta.md has no field for the state before a close, so
    // this is where the reopen rule below reads the skip from.
    const skipped = meta({ state: "skipped" });
    const d = cycle(skipped, null);

    expect(d.action).toBe("close");
    expect(d.patch).toEqual({ state: "skipped", closedAt: NOW });
  });

  test("a PR that is neither open nor known is nothing at all", () => {
    const d = cycle(null, null);

    expect(d.action).toBe("none");
    expect(d.patch).toEqual({});
  });
});

// design.md: "On reopen, a previously skipped PR stays skipped; anything else
// resumes as a known PR under the rules above, keeping its rounds, findings,
// and any pendingReviewId."
describe("reopened PR", () => {
  test("a previously skipped one stays skipped", () => {
    const skipped = meta({ state: "skipped", closedAt: EARLIER });
    const d = cycle(skipped, summary({ headSha: "sha-b", requestedReviewers: [VIEWER] }));

    expect(d.patch.state).toBeUndefined();
    expect(applied(skipped, d.patch).state).toBe("skipped");
    expect(d.patch.closedAt).toBeNull();
  });

  test("a reviewed one resumes with no new round when nothing was pushed", () => {
    const closed = meta({
      state: "closed",
      classification: "own",
      headSha: "sha-a",
      lastReviewedSha: "sha-a",
      rounds: 1,
    });
    const d = cycle(closed, summary({ author: VIEWER }));

    expect(d.action).toBe("refresh");
    expect(d.patch).toEqual({ closedAt: null });
  });

  test("a reviewed one with new commits queues a fresh round", () => {
    const closed = meta({
      state: "closed",
      classification: "own",
      headSha: "sha-a",
      lastReviewedSha: "sha-a",
      rounds: 1,
    });
    const d = cycle(closed, summary({ author: VIEWER, headSha: "sha-b" }));

    expect(d.action).toBe("queue");
    expect(d.patch.state).toBe("queued");
    expect(d.patch.closedAt).toBeNull();
  });

  test("rounds, findings and any pendingReviewId survive the reopen", () => {
    const closed = meta({
      state: "closed",
      classification: "own",
      headSha: "sha-a",
      lastReviewedSha: "sha-a",
      rounds: 3,
      pendingReviewId: 987654,
      closedAt: EARLIER,
    });
    const after = applied(closed, cycle(closed, summary({ author: VIEWER, headSha: "sha-b" })).patch);

    expect(after.rounds).toBe(3);
    expect(after.pendingReviewId).toBe(987654);
    expect(after.closedAt).toBeNull();
  });

  test("one closed before any round completed is classified again from scratch", () => {
    const closed = meta({ state: "closed", classification: "own", closedAt: EARLIER });
    const d = cycle(closed, summary({ author: VIEWER }));

    expect(d.action).toBe("queue");
    expect(d.patch.state).toBe("queued");
    expect(d.patch.closedAt).toBeNull();
  });

  test("and one that nobody asked about goes back to the inbox", () => {
    const closed = meta({ state: "closed", classification: "none", closedAt: EARLIER });
    const d = cycle(closed, summary());

    expect(d.action).toBe("triage");
    expect(d.patch.state).toBe("triage");
    expect(d.patch.closedAt).toBeNull();
  });
});

// CONTEXT.md, "Skip": "The sticky decision that a TriagePr will not be
// reviewed. New activity on the pull request does not undo a Skip; only the
// human does."
describe("sticky skip", () => {
  const skipped = meta({ state: "skipped", headSha: "sha-a" });

  test("skip, push commits, still skipped", () => {
    const d = cycle(skipped, summary({ headSha: "sha-b" }));

    expect(d.action).toBe("none");
    expect(d.patch).toEqual({});
    expect(applied(skipped, d.patch).state).toBe("skipped");
  });

  test("and push again, and again", () => {
    let current = skipped;
    for (const sha of ["sha-b", "sha-c", "sha-d"]) {
      const d = cycle(current, summary({ headSha: sha }));
      current = applied(current, d.patch);
      expect(current.state).toBe("skipped");
    }
  });

  test("a review request afterwards does not undo it", () => {
    const d = cycle(skipped, summary({ requestedReviewers: [VIEWER], headSha: "sha-b" }));

    expect(d.action).toBe("none");
    expect(applied(skipped, d.patch).state).toBe("skipped");
  });

  test("neither does the viewer being assigned, or mentioned", () => {
    expect(cycle(skipped, summary({ assignees: [VIEWER] })).action).toBe("none");
    expect(cycle(skipped, summary({ body: "@ada thoughts?" })).action).toBe("none");
  });

  test("nor leaving draft state", () => {
    const skippedDraft = meta({ state: "skipped", draft: true });
    const d = cycle(skippedDraft, summary({ draft: false, requestedReviewers: [VIEWER] }));

    expect(d.action).toBe("none");
    expect(applied(skippedDraft, d.patch).state).toBe("skipped");
  });

  test("nor a close and reopen followed by more commits", () => {
    const closed = applied(skipped, cycle(skipped, null).patch);
    expect(closed.state).toBe("skipped");

    const reopened = applied(closed, cycle(closed, summary({ headSha: "sha-b" })).patch);
    expect(reopened.state).toBe("skipped");
    expect(reopened.closedAt).toBeNull();

    const pushed = applied(reopened, cycle(reopened, summary({ headSha: "sha-c" })).patch);
    expect(pushed.state).toBe("skipped");
  });

  test("only a human undoes it, through the unskip decision the API owns", () => {
    // decide() never writes "skipped" onto a PR and never writes it off one.
    // Both directions are the decision endpoint's, which is the whole point of
    // the Gate: LGTM does not overrule the user.
    const unskipped = meta({ state: "triage", classification: "none", headSha: "sha-a" });
    const d = cycle(unskipped, summary({ headSha: "sha-b" }));

    expect(d.patch.state).toBeUndefined();
    expect(applied(unskipped, d.patch).state).toBe("triage");
  });
});

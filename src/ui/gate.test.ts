/**
 * The gate as the user meets it: the confirm pane, the inbox decision
 * buttons, and the discard on a finding card.
 *
 * Two harnesses, for the reason ui.test.ts records. `renderToStaticMarkup`
 * is all this project has (bun test has no DOM), and it never runs effects,
 * so anything with a state machine is tested twice: the machine directly, as
 * `createPostController`, driven call by call; and the markup it produces,
 * rendered from a controller this file has already driven into the state
 * under test. That is how "the post button is disabled while a post is in
 * flight" becomes an assertion about a real in-flight post rather than about
 * a prop someone remembered to pass.
 *
 * The interesting failures here all post something the user did not choose:
 * a double click creating two drafts, a recreate that reads like an append,
 * a failed post rendering as a success.
 */
import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import type { PRRef } from "@/core";
import type { GateActions, GateVerdict, PostInput, PostResult } from "./actions";
import type { FindingWithContext, PRListItem } from "./api";
import { createPostController, PostPane, groupVerdictsByFile } from "./views/PostPane";
import { SkippedSection, TriageRow } from "./views/Inbox";
import { FindingCard } from "./components/FindingCard";

// ─── Fixtures and stubs ─────────────────────────────────────────────────────

const REF: PRRef = { owner: "acme", repo: "api", number: 42 };

function verdict(over: Partial<GateVerdict> & { key: string }): GateVerdict {
  return {
    round: 1,
    agent: "reviewer",
    id: "f1",
    file: "src/a.ts",
    line: 10,
    severity: "high",
    state: "open",
    postable: true,
    reason: null,
    ...over,
  };
}

const POSTABLE = [
  verdict({ key: "r1:reviewer:f1", id: "f1", file: "src/limiter.ts", line: 118 }),
  verdict({ key: "r1:reviewer:f3", id: "f3", file: "src/api/routes.ts", line: 42, severity: "low" }),
];

const HELD = [
  verdict({
    key: "r1:reviewer:f2",
    id: "f2",
    file: "src/gone.ts",
    line: 7,
    state: "held",
    postable: false,
    reason: "line 7 of src/gone.ts is not in the current diff",
  }),
];

const PREVIEW: PostResult = {
  status: "preview",
  preview: {
    key: "acme/api#42",
    url: "https://github.com/acme/api/pull/42",
    body: "## LGTM review\n\n2 findings: 1 high, 1 low.",
    postable: POSTABLE,
    held: HELD,
    counts: { checked: 3, postable: 2, held: 1 },
    pendingReviewId: null,
  },
};

const POSTED: PostResult = {
  status: "posted",
  draft: {
    key: "acme/api#42",
    url: "https://github.com/acme/api/pull/42",
    reviewId: 991,
    reviewUrl: "https://github.com/acme/api/pull/42/files",
    body: "## LGTM review",
    commentCount: 2,
    posted: POSTABLE,
    held: HELD,
    recreated: null,
    clearedReviewId: null,
  },
};

const notCalled = async (): Promise<never> => {
  throw new Error("this test did not expect that gate call");
};

const BASE_GATE: GateActions = {
  decide: notCalled,
  applyDecisions: notCalled,
  discardFinding: notCalled,
  restoreFinding: notCalled,
  validate: notCalled,
  preview: notCalled,
  post: notCalled,
};

interface PostCall {
  ref: PRRef;
  input: PostInput;
}

interface GateStub {
  actions: GateActions;
  previewCalls: PRRef[];
  postCalls: PostCall[];
}

function gateStub(handlers: {
  preview?: (ref: PRRef) => PostResult | Promise<PostResult>;
  post?: (call: PostCall) => PostResult | Promise<PostResult>;
}): GateStub {
  const previewCalls: PRRef[] = [];
  const postCalls: PostCall[] = [];

  const actions: GateActions = {
    ...BASE_GATE,
    async preview(ref) {
      previewCalls.push(ref);
      if (!handlers.preview) throw new Error("no preview handler");
      return handlers.preview(ref);
    },
    async post(ref, input = {}) {
      const call: PostCall = { ref, input };
      postCalls.push(call);
      if (!handlers.post) throw new Error("no post handler");
      return handlers.post(call);
    },
  };

  return { actions, previewCalls, postCalls };
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function paneHtml(controller: ReturnType<typeof createPostController>): string {
  return renderToStaticMarkup(createElement(PostPane, { prRef: REF, controller }));
}

/** The opening tag carrying this test id. */
function tagWith(html: string, testId: string): string {
  const marker = html.indexOf(`data-testid="${testId}"`);
  if (marker < 0) return "";
  const start = html.lastIndexOf("<", marker);
  const end = html.indexOf(">", marker);
  return html.slice(start, end + 1);
}

/**
 * Whether that element carries the `disabled` attribute. Matched on the
 * attribute, not on the substring: Tailwind puts `disabled:opacity-50` in
 * every button's class list, so a naive search says every button is
 * disabled.
 */
function isDisabled(html: string, testId: string): boolean {
  const tag = tagWith(html, testId);
  expect(tag).not.toBe("");
  return / disabled(=|>|\s)/.test(tag);
}

// ─── The controller ─────────────────────────────────────────────────────────

describe("createPostController", () => {
  test("the dry run fills the pane and seeds the editable body", async () => {
    const gate = gateStub({ preview: () => PREVIEW });
    const controller = createPostController({ ref: REF, actions: gate.actions });

    await controller.load();
    const state = controller.snapshot();

    expect(gate.previewCalls).toEqual([REF]);
    expect(state.preview.phase).toBe("ready");
    expect(state.body).toBe("## LGTM review\n\n2 findings: 1 high, 1 low.");
    expect(state.bodyEdited).toBe(false);
    expect(state.posting).toBe(false);
  });

  test("a body the human edited is never overwritten by a reload", async () => {
    const gate = gateStub({ preview: () => PREVIEW });
    const controller = createPostController({ ref: REF, actions: gate.actions });

    await controller.load();
    controller.setBody("mine, not the template's");
    await controller.load();

    expect(controller.snapshot().body).toBe("mine, not the template's");
  });

  test("the zero-valid abort is its own phase, with the reasons", async () => {
    const gate = gateStub({
      preview: () => ({
        status: "nothing-to-post",
        checked: 3,
        held: HELD,
        message: "3 finding(s) were checked and none of their lines are in the current diff",
      }),
    });
    const controller = createPostController({ ref: REF, actions: gate.actions });

    await controller.load();
    const preview = controller.snapshot().preview;

    expect(preview.phase).toBe("empty");
    if (preview.phase !== "empty") throw new Error("unreachable");
    expect(preview.checked).toBe(3);
    expect(preview.held[0]?.reason).toContain("not in the current diff");
  });

  test("a failed dry run is an error phase, not an empty pane", async () => {
    const gate = gateStub({
      preview: () => ({ status: "error", error: { kind: "forge", message: "GitHub returned 503", code: "forge-error", status: 502 } }),
    });
    const controller = createPostController({ ref: REF, actions: gate.actions });

    await controller.load();
    const preview = controller.snapshot().preview;

    expect(preview.phase).toBe("error");
    if (preview.phase !== "error") throw new Error("unreachable");
    expect(preview.error.message).toBe("GitHub returned 503");
  });

  test("posting sends the edited body verbatim and reports the draft", async () => {
    const gate = gateStub({ preview: () => PREVIEW, post: () => POSTED });
    const controller = createPostController({ ref: REF, actions: gate.actions });

    await controller.load();
    controller.setBody("body I edited");
    await controller.post();

    expect(gate.postCalls).toHaveLength(1);
    expect(gate.postCalls[0]?.input).toEqual({ body: "body I edited" });
    expect(controller.snapshot().outcome?.kind).toBe("posted");
  });

  test("an emptied body is still the body, and is sent as one", async () => {
    const gate = gateStub({ preview: () => PREVIEW, post: () => POSTED });
    const controller = createPostController({ ref: REF, actions: gate.actions });

    await controller.load();
    controller.setBody("");
    await controller.post();

    expect(gate.postCalls[0]?.input).toEqual({ body: "" });
  });

  test("a second post while one is in flight sends nothing", async () => {
    const pending = deferred<PostResult>();
    const gate = gateStub({ preview: () => PREVIEW, post: () => pending.promise });
    const controller = createPostController({ ref: REF, actions: gate.actions });

    await controller.load();

    const first = controller.post();
    expect(controller.snapshot().posting).toBe(true);

    // The double click. One create call cannot be merged with another, so a
    // second draft here would be a draft LGTM does not know about.
    await controller.post();
    await controller.post();
    expect(gate.postCalls).toHaveLength(1);

    pending.resolve(POSTED);
    await first;

    expect(controller.snapshot().posting).toBe(false);
    expect(gate.postCalls).toHaveLength(1);
  });

  test("nothing posts before the dry run has said what would post", async () => {
    const gate = gateStub({ preview: () => PREVIEW, post: () => POSTED });
    const controller = createPostController({ ref: REF, actions: gate.actions });

    await controller.post();

    expect(gate.postCalls).toHaveLength(0);
  });

  test("a PR already posted does not post again, but can be recreated", async () => {
    const gate = gateStub({ preview: () => PREVIEW, post: () => POSTED });
    const controller = createPostController({ ref: REF, actions: gate.actions });

    await controller.load();
    await controller.post();
    await controller.post();
    expect(gate.postCalls).toHaveLength(1);

    await controller.post({ recreate: true });
    expect(gate.postCalls).toHaveLength(2);
    expect(gate.postCalls[1]?.input.recreate).toBe(true);
  });

  test("a failed post is an error outcome, and no draft is claimed", async () => {
    const gate = gateStub({
      preview: () => PREVIEW,
      post: () => ({
        status: "error",
        error: { kind: "forge", message: "GitHub returned 422: line must be part of the diff", code: "forge-error", status: 502 },
      }),
    });
    const controller = createPostController({ ref: REF, actions: gate.actions });

    await controller.load();
    await controller.post();
    const state = controller.snapshot();

    expect(state.posting).toBe(false);
    expect(state.outcome?.kind).toBe("error");
    expect(state.existingDraft).toBeNull();
  });

  test("a refusal because a draft is pending becomes the recreate offer", async () => {
    const gate = gateStub({
      preview: () => PREVIEW,
      post: (call) =>
        call.input.recreate === true
          ? POSTED
          : {
              status: "draft-exists",
              pendingReviewId: 991,
              reviewUrl: "https://github.com/acme/api/pull/42/files",
              message: "acme/api#42 already has a pending draft review.",
            },
    });
    const controller = createPostController({ ref: REF, actions: gate.actions });

    await controller.load();
    await controller.post();

    expect(controller.snapshot().outcome?.kind).toBe("draft-exists");
    expect(controller.snapshot().existingDraft).toEqual({
      pendingReviewId: 991,
      reviewUrl: "https://github.com/acme/api/pull/42/files",
    });

    await controller.post({ recreate: true });

    expect(gate.postCalls[1]?.input.recreate).toBe(true);
    expect(controller.snapshot().outcome?.kind).toBe("posted");
  });

  test("a draft the store already knows about is offered for recreation up front", async () => {
    const gate = gateStub({
      preview: () => ({
        status: "preview",
        preview: { ...(PREVIEW.status === "preview" ? PREVIEW.preview : never()), pendingReviewId: 991 },
      }),
    });
    const controller = createPostController({ ref: REF, actions: gate.actions });

    await controller.load();

    expect(controller.snapshot().existingDraft).toEqual({
      pendingReviewId: 991,
      reviewUrl: "https://github.com/acme/api/pull/42/files",
    });
  });
});

function never(): never {
  throw new Error("fixture is not a preview");
}

describe("groupVerdictsByFile", () => {
  test("groups by file, orders files by name and lines within a file", () => {
    const groups = groupVerdictsByFile([
      verdict({ key: "r1:reviewer:f9", file: "src/z.ts", line: 3 }),
      verdict({ key: "r1:reviewer:f8", file: "src/a.ts", line: 40 }),
      verdict({ key: "r1:reviewer:f7", file: "src/a.ts", line: 4 }),
    ]);

    expect(groups.map(([file]) => file)).toEqual(["src/a.ts", "src/z.ts"]);
    expect(groups[0]?.[1].map((entry) => entry.line)).toEqual([4, 40]);
  });
});

// ─── The pane ───────────────────────────────────────────────────────────────

describe("PostPane", () => {
  test("says what it is before the dry run comes back", () => {
    const controller = createPostController({ ref: REF, actions: gateStub({}).actions });
    const html = paneHtml(controller);

    expect(html).toContain("Post draft review");
    expect(html).toContain("acme/api#42");
    // The promise the whole product rests on, stated where the user is
    // about to act (ADR 0001).
    expect(html).toContain("PENDING draft only you can see");
  });

  test("shows the rendered body in an editable field, what will post, and what cannot", async () => {
    const gate = gateStub({ preview: () => PREVIEW });
    const controller = createPostController({ ref: REF, actions: gate.actions });
    await controller.load();

    const html = paneHtml(controller);

    expect(html).toContain("<textarea");
    expect(html).toContain("2 findings: 1 high, 1 low.");

    // Grouped by file, both files present, keyed by the full finding key.
    expect(html).toContain("src/limiter.ts");
    expect(html).toContain("src/api/routes.ts");
    expect(html).toContain("r1:reviewer:f1");
    expect(html).toContain("r1:reviewer:f3");

    // The held finding is under its own heading, with its reason, never a
    // greyed-out row in the list above.
    expect(html).toContain("Cannot attach to the current diff");
    expect(html).toContain("line 7 of src/gone.ts is not in the current diff");

    expect(html).toContain("Post draft (2 findings)");
    expect(isDisabled(html, "post-draft")).toBe(false);
  });

  test("the post button is disabled while a post is in flight", async () => {
    const pending = deferred<PostResult>();
    const gate = gateStub({ preview: () => PREVIEW, post: () => pending.promise });
    const controller = createPostController({ ref: REF, actions: gate.actions });
    await controller.load();

    const inFlight = controller.post();
    const html = paneHtml(controller);

    expect(isDisabled(html, "post-draft")).toBe(true);
    expect(html).toContain("Posting…");
    expect(html).not.toContain("Post draft (2 findings)");

    pending.resolve(POSTED);
    await inFlight;
  });

  test("after posting it shows the per-finding outcome and the link to the draft", async () => {
    const gate = gateStub({ preview: () => PREVIEW, post: () => POSTED });
    const controller = createPostController({ ref: REF, actions: gate.actions });
    await controller.load();
    await controller.post();

    const html = paneHtml(controller);

    expect(html).toContain("Posted 2 findings");
    expect(html).toContain("held 1 back");
    expect(html).toContain("r1:reviewer:f1");
    expect(html).toContain("line 7 of src/gone.ts is not in the current diff");
    expect(html).toContain('href="https://github.com/acme/api/pull/42/files"');
    expect(html).toContain("Open pending review on GitHub");
    expect(html).toContain("LGTM cannot submit a review");

    // The editor is gone: this draft is on GitHub now.
    expect(html).not.toContain("Post draft (2 findings)");
  });

  test("a recreate is offered, and described as a replacement rather than an addition", async () => {
    const gate = gateStub({
      preview: () => ({
        status: "preview",
        preview: { ...(PREVIEW.status === "preview" ? PREVIEW.preview : never()), pendingReviewId: 991 },
      }),
    });
    const controller = createPostController({ ref: REF, actions: gate.actions });
    await controller.load();

    const html = paneHtml(controller);

    expect(html).toContain("already has a pending draft review");
    expect(html).toContain("#991");
    expect(html).toContain("Recreate draft");
    expect(html).toContain("replaces the existing draft rather than adding to it");
    expect(html).toContain("Open the existing draft on GitHub");
  });

  test("a failed post reads as a failure, not as a green tick", async () => {
    const gate = gateStub({
      preview: () => PREVIEW,
      post: () => ({
        status: "error",
        error: { kind: "forge", message: "GitHub returned 422: line must be part of the diff", code: "forge-error", status: 502 },
      }),
    });
    const controller = createPostController({ ref: REF, actions: gate.actions });
    await controller.load();
    await controller.post();

    const html = paneHtml(controller);

    expect(html).toContain("GitHub returned 422: line must be part of the diff");
    expect(html).toContain("Nothing was posted");
    expect(html).not.toContain("Open pending review on GitHub");
  });

  test("an expired token asks for a reauthentication instead of showing a blank pane", async () => {
    const gate = gateStub({
      preview: () => ({ status: "error", error: { kind: "unauthenticated", message: "whatever", code: null, status: 401 } }),
    });
    const controller = createPostController({ ref: REF, actions: gate.actions });
    await controller.load();

    expect(paneHtml(controller)).toContain("lgtm open");
  });

  test("nothing to post explains itself and lists every reason", async () => {
    const gate = gateStub({
      preview: () => ({
        status: "nothing-to-post",
        checked: 3,
        held: HELD,
        message: "3 finding(s) were checked and none of their lines are in the current diff, so nothing was sent to GitHub.",
      }),
    });
    const controller = createPostController({ ref: REF, actions: gate.actions });
    await controller.load();

    const html = paneHtml(controller);

    expect(html).toContain("none of their lines are in the current diff");
    expect(html).toContain("line 7 of src/gone.ts is not in the current diff");
    expect(html).not.toContain("data-testid=\"post-draft\"");
  });
});

// ─── Inbox decisions ────────────────────────────────────────────────────────

function prItem(over: Partial<PRListItem>): PRListItem {
  return {
    owner: "acme",
    repo: "api",
    number: 42,
    url: "https://github.com/acme/api/pull/42",
    title: "Add a rate limiter",
    author: "octocat",
    state: "triage",
    classification: "none",
    draft: false,
    headSha: "abc1234",
    createdAt: null,
    closedAt: null,
    pendingReviewId: null,
    failedAttempts: 0,
    additions: 10,
    deletions: 2,
    changedFiles: 1,
    mergeable: true,
    checkStatus: "success",
    findingCounts: { critical: 0, high: 0, medium: 0, low: 0 },
    ...over,
  };
}

describe("Inbox decision buttons", () => {
  test("skip and review are live, not placeholders", () => {
    const html = renderToStaticMarkup(createElement(TriageRow, { pr: prItem({}), actions: BASE_GATE }));

    expect(html).toContain("Skip");
    expect(html).toContain("Review");
    expect(isDisabled(html, "skip-pr")).toBe(false);
    expect(isDisabled(html, "review-pr")).toBe(false);
    expect(html).not.toContain("Coming soon");
  });

  test("a draft PR gets the review-anyway override alongside review", () => {
    const ready = renderToStaticMarkup(createElement(TriageRow, { pr: prItem({}), actions: BASE_GATE }));
    const draft = renderToStaticMarkup(createElement(TriageRow, { pr: prItem({ draft: true }), actions: BASE_GATE }));

    // R2.3: `review` on a draft records the approval and lets it queue when
    // it is ready; `review-anyway` queues it now. On a ready PR there is
    // only one thing to offer.
    expect(ready).not.toContain("Review anyway");
    expect(draft).toContain("Review anyway");
  });

  test("the skipped section stays collapsed and its unskip is live", () => {
    const html = renderToStaticMarkup(
      createElement(SkippedSection, { prs: [prItem({ state: "skipped", title: "Bump deps" })], actions: BASE_GATE }),
    );

    expect(html).toContain("<details");
    expect(html).toContain("Skipped (1)");
    expect(html).toContain("Bump deps");
    expect(isDisabled(html, "unskip-pr")).toBe(false);
  });

  test("an empty skipped list renders nothing at all", () => {
    expect(renderToStaticMarkup(createElement(SkippedSection, { prs: [], actions: BASE_GATE }))).toBe("");
  });
});

// ─── Finding card ───────────────────────────────────────────────────────────

function finding(over: Partial<FindingWithContext>): FindingWithContext {
  return {
    key: "r2:reviewer:f1",
    round: 2,
    agent: "reviewer",
    headSha: "abc1234",
    severity: "high",
    file: "src/limiter.ts",
    line: 118,
    comment: "This retries forever when the bucket is empty.",
    suggestion: null,
    state: "open",
    heldReason: null,
    hunk: null,
    ...over,
  };
}

describe("FindingCard gate action", () => {
  test("an open finding offers a live discard once the card knows its PR", () => {
    const html = renderToStaticMarkup(
      createElement(FindingCard, { owner: "acme", repo: "api", number: 42, finding: finding({}), actions: BASE_GATE }),
    );

    expect(html).toContain(">Discard</button>");
    expect(isDisabled(html, "finding-gate-action")).toBe(false);
    expect(html).toContain('data-finding-key="r2:reviewer:f1"');
    expect(html).not.toContain("Coming soon");
  });

  test("a discarded finding offers the way back, since a discard is reversible", () => {
    const html = renderToStaticMarkup(
      createElement(FindingCard, {
        owner: "acme",
        repo: "api",
        number: 42,
        finding: finding({ state: "discarded" }),
        actions: BASE_GATE,
      }),
    );

    expect(html).toContain(">Restore</button>");
    expect(isDisabled(html, "finding-gate-action")).toBe(false);
  });

  test("a held finding can still be discarded, and says why it was held", () => {
    const html = renderToStaticMarkup(
      createElement(FindingCard, {
        owner: "acme",
        repo: "api",
        number: 42,
        finding: finding({ state: "held", heldReason: "line 118 is not in the current diff" }),
        actions: BASE_GATE,
      }),
    );

    expect(html).toContain("Held: line 118 is not in the current diff");
    expect(isDisabled(html, "finding-gate-action")).toBe(false);
  });

  test("a posted finding cannot be taken back here", () => {
    const html = renderToStaticMarkup(
      createElement(FindingCard, {
        owner: "acme",
        repo: "api",
        number: 42,
        finding: finding({ state: "posted" }),
        actions: BASE_GATE,
      }),
    );

    expect(isDisabled(html, "finding-gate-action")).toBe(true);
    expect(html).toContain("pending review");
  });

  test("without a PR number there is no address to PATCH, and the card says so", () => {
    const html = renderToStaticMarkup(
      createElement(FindingCard, { owner: "acme", repo: "api", finding: finding({}), actions: BASE_GATE }),
    );

    expect(isDisabled(html, "finding-gate-action")).toBe(true);
    expect(html).toContain("no pull request number");
  });
});

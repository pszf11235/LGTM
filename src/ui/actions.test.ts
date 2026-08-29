/**
 * What the gate actually sends, and what it reports back.
 *
 * Every test here asserts on the recorded HTTP call, not on a fake of the
 * layer under test: the whole risk in this file is the mapping from a UI
 * intent to a request, and a mock that agrees with the mapping proves
 * nothing about it. The token comes from a real `ApiClient` built over a
 * stub fetch and a stub location, the same seams ui.test.ts uses, so the
 * requests carry the Authorization header the daemon will actually see.
 *
 * The two mappings worth breaking a build over:
 *
 *  - a finding is addressed by the full `r2:reviewer:f1` key, and a bare id
 *    never reaches the wire (R9.3);
 *  - a failed post is reported as a failure, and a 409 that is really a
 *    decision, a draft already pending or nothing left to post, is reported
 *    as that decision rather than flattened into an error.
 */
import { describe, expect, test } from "bun:test";

import { createGateActions, type DecisionRequest } from "./actions";
import { REAUTH_MESSAGE, createApiClient, type ApiClient, type FetchLike, type StorageLike } from "./api";

// ─── Stubs ──────────────────────────────────────────────────────────────────

const REF = { owner: "acme", repo: "api", number: 42 };

function memoryStorage(): StorageLike {
  const mem = new Map<string, string>();
  return {
    getItem: (key) => mem.get(key) ?? null,
    setItem: (key, value) => void mem.set(key, value),
    removeItem: (key) => void mem.delete(key),
  };
}

/** A client holding a token, without touching a browser global. */
function tokenClient(token: string | null): ApiClient {
  return createApiClient({
    storage: memoryStorage(),
    location: { hash: token === null ? "" : `#t=${token}`, pathname: "/", search: "" },
    history: { replaceState() {} },
    fetchImpl: async () => new Response("{}", { status: 200 }),
  });
}

interface Call {
  url: string;
  method: string;
  body: unknown;
  authorization: string | null;
}

interface Harness {
  actions: ReturnType<typeof createGateActions>;
  calls: Call[];
}

type Responder = (call: Call, index: number) => Response;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function harness(respond: Responder, token: string | null = "test-token"): Harness {
  const calls: Call[] = [];

  const fetchImpl: FetchLike = async (input, init) => {
    const headers = new Headers(init?.headers);
    const raw = init?.body;
    const call: Call = {
      url: input,
      method: init?.method ?? "GET",
      body: typeof raw === "string" && raw !== "" ? (JSON.parse(raw) as unknown) : undefined,
      authorization: headers.get("Authorization"),
    };
    calls.push(call);
    return respond(call, calls.length - 1);
  };

  return { actions: createGateActions({ client: tokenClient(token), fetchImpl }), calls };
}

function always(body: unknown, status = 200): Responder {
  return () => json(body, status);
}

// ─── Decisions ──────────────────────────────────────────────────────────────

describe("decide", () => {
  test("posts the action to the PR's decision route and reports what the store did", async () => {
    const { actions, calls } = harness(always({ state: "queued", queued: true, classification: "manual" }));

    const result = await actions.decide(REF, "review");

    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.url).toBe("/api/prs/acme/api/42/decision");
    expect(calls[0]?.body).toEqual({ action: "review" });
    expect(calls[0]?.authorization).toBe("Bearer test-token");

    expect(result).toEqual({ status: "ok", ref: REF, action: "review", state: "queued", queued: true });
  });

  test("skip and unskip send their own action, never a rewritten one", async () => {
    const { actions, calls } = harness(always({ state: "skipped" }));

    await actions.decide(REF, "skip");
    await actions.decide(REF, "unskip");

    expect(calls.map((call) => call.body)).toEqual([{ action: "skip" }, { action: "unskip" }]);
  });

  test("a refusal comes back as an error carrying the daemon's own message", async () => {
    const { actions } = harness(always({ error: "not-skipped", message: "acme/api#42 is triage, not skipped" }, 409));

    const result = await actions.decide(REF, "unskip");

    expect(result.status).toBe("error");
    if (result.status !== "error") throw new Error("unreachable");
    expect(result.error).toEqual({
      kind: "http",
      message: "acme/api#42 is triage, not skipped",
      code: "not-skipped",
      status: 409,
    });
    // The ref and action ride along, so a caller does not have to remember
    // which call this was.
    expect(result.ref).toEqual(REF);
    expect(result.action).toBe("unskip");
  });

  test("a 401 reports unauthenticated with the reauthentication message", async () => {
    const { actions } = harness(always({}, 401));
    const result = await actions.decide(REF, "review");

    expect(result.status).toBe("error");
    if (result.status !== "error") throw new Error("unreachable");
    expect(result.error.kind).toBe("unauthenticated");
    expect(result.error.message).toBe(REAUTH_MESSAGE);
  });

  test("with no token at all, nothing is sent", async () => {
    const { actions, calls } = harness(always({}), null);
    const result = await actions.decide(REF, "review");

    expect(calls).toHaveLength(0);
    expect(result.status).toBe("error");
    if (result.status !== "error") throw new Error("unreachable");
    expect(result.error.kind).toBe("unauthenticated");
  });

  test("a dropped connection is a network failure, not a thrown promise", async () => {
    const actions = createGateActions({
      client: tokenClient("test-token"),
      fetchImpl: async () => {
        throw new TypeError("Failed to fetch");
      },
    });

    const result = await actions.decide(REF, "skip");

    expect(result.status).toBe("error");
    if (result.status !== "error") throw new Error("unreachable");
    expect(result.error.kind).toBe("network");
    expect(result.error.message).toBe("Failed to fetch");
  });
});

describe("applyDecisions", () => {
  const MIXED: DecisionRequest[] = [
    { ref: { owner: "acme", repo: "api", number: 1 }, action: "review" },
    { ref: { owner: "acme", repo: "api", number: 2 }, action: "skip" },
    { ref: { owner: "other", repo: "web", number: 7 }, action: "unskip" },
    { ref: { owner: "acme", repo: "api", number: 9 }, action: "review-anyway" },
  ];

  test("a mixed selection sends exactly one call per request, in order", async () => {
    const { actions, calls } = harness(always({ state: "queued" }));

    const batch = await actions.applyDecisions(MIXED);

    expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual([
      "POST /api/prs/acme/api/1/decision",
      "POST /api/prs/acme/api/2/decision",
      "POST /api/prs/other/web/7/decision",
      "POST /api/prs/acme/api/9/decision",
    ]);
    expect(calls.map((call) => call.body)).toEqual([
      { action: "review" },
      { action: "skip" },
      { action: "unskip" },
      { action: "review-anyway" },
    ]);
    expect(batch.ok).toBe(4);
    expect(batch.failed).toBe(0);
  });

  test("one PR failing does not hide the others, and the report says which", async () => {
    const { actions } = harness((call, index) =>
      index === 2 ? json({ error: "unknown-pr", message: "other/web#7 is not in the store" }, 404) : json({ state: "queued" }),
    );

    const batch = await actions.applyDecisions(MIXED);

    expect(batch.ok).toBe(3);
    expect(batch.failed).toBe(1);

    const failed = batch.results.filter((result) => result.status === "error");
    expect(failed).toHaveLength(1);
    expect(failed[0]?.ref).toEqual({ owner: "other", repo: "web", number: 7 });
    expect(failed[0]?.action).toBe("unskip");
  });

  test("an empty selection sends nothing", async () => {
    const { actions, calls } = harness(always({}));
    const batch = await actions.applyDecisions([]);

    expect(calls).toHaveLength(0);
    expect(batch).toEqual({ results: [], ok: 0, failed: 0 });
  });
});

// ─── Findings ───────────────────────────────────────────────────────────────

describe("discardFinding and restoreFinding", () => {
  test("discard addresses the finding by its full key", async () => {
    const { actions, calls } = harness(always({ key: "r2:reviewer:f1", state: "discarded", changed: true }));

    const result = await actions.discardFinding(REF, "r2:reviewer:f1");

    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe("PATCH");
    // Percent-encoded in the path; the route decodes it before parsing.
    expect(calls[0]?.url).toBe("/api/prs/acme/api/42/findings/r2%3Areviewer%3Af1");
    expect(decodeURIComponent(calls[0]?.url ?? "")).toContain("findings/r2:reviewer:f1");
    expect(calls[0]?.body).toEqual({ state: "discarded" });

    expect(result).toEqual({ status: "ok", key: "r2:reviewer:f1", state: "discarded", changed: true });
  });

  test("restore is the same address with the opposite state", async () => {
    const { actions, calls } = harness(always({ changed: true }));

    await actions.restoreFinding(REF, "r2:reviewer:f1");

    expect(calls[0]?.url).toBe("/api/prs/acme/api/42/findings/r2%3Areviewer%3Af1");
    expect(calls[0]?.body).toEqual({ state: "open" });
  });

  test("a bare id is refused before anything is sent", async () => {
    const { actions, calls } = harness(always({ changed: true }));

    const result = await actions.discardFinding(REF, "f1");

    // The whole point: ids restart at f1 in every round file, so a bare id
    // would have addressed some other round's finding (R9.3).
    expect(calls).toHaveLength(0);
    expect(result.status).toBe("error");
    if (result.status !== "error") throw new Error("unreachable");
    expect(result.error.kind).toBe("bad-key");
    expect(result.error.message).toContain("r2:reviewer:f1");
  });

  test("a key missing its round or its agent never reaches the wire either", async () => {
    const { actions, calls } = harness(always({ changed: true }));

    for (const bad of ["reviewer:f1", "r2:f1", "rX:reviewer:f1", "2:reviewer:f1", ""]) {
      const result = await actions.discardFinding(REF, bad);
      expect(result.status).toBe("error");
    }

    expect(calls).toHaveLength(0);
  });

  test("the key is canonicalised, so the store is asked about exactly one rendering", async () => {
    const { actions, calls } = harness(always({ changed: true }));

    const result = await actions.discardFinding(REF, "r02:reviewer:f1");

    expect(calls[0]?.url).toBe("/api/prs/acme/api/42/findings/r2%3Areviewer%3Af1");
    expect(result.key).toBe("r2:reviewer:f1");
  });

  test("a finding the store refuses to move reports the refusal", async () => {
    const { actions } = harness(
      always({ error: "refused", message: "r1:reviewer:f2 is posted and cannot be moved to discarded from here" }, 409),
    );

    const result = await actions.discardFinding(REF, "r1:reviewer:f2");

    expect(result.status).toBe("error");
    if (result.status !== "error") throw new Error("unreachable");
    expect(result.error.code).toBe("refused");
    expect(result.error.status).toBe(409);
    expect(result.key).toBe("r1:reviewer:f2");
  });

  test("`changed: false` is reported honestly, not as a change", async () => {
    const { actions } = harness(always({ key: "r1:reviewer:f1", state: "discarded", changed: false }));

    const result = await actions.discardFinding(REF, "r1:reviewer:f1");

    expect(result).toEqual({ status: "ok", key: "r1:reviewer:f1", state: "discarded", changed: false });
  });
});

// ─── Validate ───────────────────────────────────────────────────────────────

describe("validate", () => {
  test("reads the report the daemon returns, verdicts and counts", async () => {
    const { actions, calls } = harness(
      always({
        ref: REF,
        key: "acme/api#42",
        url: "https://github.com/acme/api/pull/42",
        pendingReviewId: null,
        counts: { checked: 2, postable: 1, held: 1 },
        findings: [
          {
            key: "r1:reviewer:f1",
            round: 1,
            agent: "reviewer",
            id: "f1",
            file: "src/a.ts",
            line: 10,
            severity: "high",
            state: "open",
            postable: true,
            reason: null,
          },
          {
            key: "r1:reviewer:f2",
            round: 1,
            agent: "reviewer",
            id: "f2",
            file: "src/b.ts",
            line: 4,
            severity: "low",
            state: "held",
            postable: false,
            reason: "line 4 of src/b.ts is not in the current diff",
          },
        ],
      }),
    );

    const result = await actions.validate(REF);

    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.url).toBe("/api/prs/acme/api/42/validate");

    expect(result.status).toBe("ok");
    if (result.status !== "ok") throw new Error("unreachable");
    expect(result.report.counts).toEqual({ checked: 2, postable: 1, held: 1 });
    expect(result.report.findings.map((verdict) => verdict.key)).toEqual(["r1:reviewer:f1", "r1:reviewer:f2"]);
    expect(result.report.findings[1]?.reason).toBe("line 4 of src/b.ts is not in the current diff");
  });

  test("a Forge failure is a forge error, with GitHub's message intact", async () => {
    const { actions } = harness(always({ error: "forge-error", message: "GitHub returned 503" }, 502));

    const result = await actions.validate(REF);

    expect(result.status).toBe("error");
    if (result.status !== "error") throw new Error("unreachable");
    expect(result.error.kind).toBe("forge");
    expect(result.error.message).toBe("GitHub returned 503");
  });

  test("a response missing every field degrades instead of throwing", async () => {
    const { actions } = harness(always({}));

    const result = await actions.validate(REF);

    expect(result.status).toBe("ok");
    if (result.status !== "ok") throw new Error("unreachable");
    expect(result.report.findings).toEqual([]);
    expect(result.report.counts).toEqual({ checked: 0, postable: 0, held: 0 });
    expect(result.report.pendingReviewId).toBeNull();
  });
});

// ─── Post ───────────────────────────────────────────────────────────────────

const VERDICT = {
  key: "r1:reviewer:f1",
  round: 1,
  agent: "reviewer",
  id: "f1",
  file: "src/a.ts",
  line: 10,
  severity: "high",
  state: "open",
  postable: true,
  reason: null,
};

describe("preview", () => {
  test("is a dry run, and nothing else", async () => {
    const { actions, calls } = harness(
      always({
        dryRun: true,
        key: "acme/api#42",
        url: "https://github.com/acme/api/pull/42",
        body: "## LGTM review\n\n1 finding",
        postable: [VERDICT],
        held: [],
        counts: { checked: 1, postable: 1, held: 0 },
        pendingReviewId: null,
      }),
    );

    const result = await actions.preview(REF);

    expect(calls[0]?.url).toBe("/api/prs/acme/api/42/post");
    expect(calls[0]?.body).toEqual({ dryRun: true });

    expect(result.status).toBe("preview");
    if (result.status !== "preview") throw new Error("unreachable");
    expect(result.preview.body).toBe("## LGTM review\n\n1 finding");
    expect(result.preview.postable).toHaveLength(1);
    expect(result.preview.postable[0]?.key).toBe("r1:reviewer:f1");
  });
});

describe("post", () => {
  test("sends the edited body verbatim and reports the created draft", async () => {
    const { actions, calls } = harness(
      always({
        dryRun: false,
        key: "acme/api#42",
        url: "https://github.com/acme/api/pull/42",
        reviewId: 991,
        reviewUrl: "https://github.com/acme/api/pull/42/files",
        body: "edited body",
        commentCount: 1,
        posted: [VERDICT],
        held: [{ ...VERDICT, key: "r1:reviewer:f2", id: "f2", postable: false, reason: "line 4 is gone" }],
        recreated: null,
        clearedReviewId: null,
      }),
    );

    const result = await actions.post(REF, { body: "edited body" });

    expect(calls[0]?.body).toEqual({ body: "edited body" });

    expect(result.status).toBe("posted");
    if (result.status !== "posted") throw new Error("unreachable");
    expect(result.draft.reviewId).toBe(991);
    expect(result.draft.reviewUrl).toBe("https://github.com/acme/api/pull/42/files");
    expect(result.draft.posted.map((verdict) => verdict.key)).toEqual(["r1:reviewer:f1"]);
    expect(result.draft.held[0]?.reason).toBe("line 4 is gone");
  });

  test("an empty body is a deliberate edit and is sent as one", async () => {
    const { actions, calls } = harness(always({ dryRun: false, reviewId: 1, reviewUrl: "u" }));

    await actions.post(REF, { body: "" });

    expect(calls[0]?.body).toEqual({ body: "" });
  });

  test("recreate is only ever sent when it was asked for", async () => {
    const { actions, calls } = harness(always({ dryRun: false, reviewId: 1, reviewUrl: "u" }));

    await actions.post(REF, { body: "b" });
    await actions.post(REF, { body: "b", recreate: false });
    await actions.post(REF, { body: "b", recreate: true });

    expect(calls.map((call) => call.body)).toEqual([{ body: "b" }, { body: "b" }, { body: "b", recreate: true }]);
  });

  test("reads back the draft that a recreate replaced", async () => {
    const { actions } = harness(
      always({
        dryRun: false,
        reviewId: 992,
        reviewUrl: "https://github.com/acme/api/pull/42/files",
        posted: [VERDICT],
        held: [],
        recreated: { deletedReviewId: 991, reopened: ["r1:reviewer:f7"] },
        clearedReviewId: null,
      }),
    );

    const result = await actions.post(REF, { recreate: true });

    expect(result.status).toBe("posted");
    if (result.status !== "posted") throw new Error("unreachable");
    expect(result.draft.recreated).toEqual({ deletedReviewId: 991, reopened: ["r1:reviewer:f7"] });
  });

  test("an existing pending draft is a decision to offer, not an error to swallow", async () => {
    const { actions } = harness(
      always(
        {
          error: "pending-review-exists",
          message: "acme/api#42 already has a pending draft review.",
          pendingReviewId: 991,
          reviewUrl: "https://github.com/acme/api/pull/42/files",
        },
        409,
      ),
    );

    const result = await actions.post(REF, { body: "b" });

    expect(result.status).toBe("draft-exists");
    if (result.status !== "draft-exists") throw new Error("unreachable");
    expect(result.pendingReviewId).toBe(991);
    expect(result.reviewUrl).toBe("https://github.com/acme/api/pull/42/files");
  });

  test("the zero-valid abort comes back with its per-finding reasons", async () => {
    const { actions } = harness(
      always(
        {
          error: "nothing-to-post",
          message: "2 finding(s) were checked and none of their lines are in the current diff",
          checked: 2,
          held: [
            { ...VERDICT, postable: false, reason: "line 10 of src/a.ts is not in the current diff" },
            { ...VERDICT, key: "r1:reviewer:f2", id: "f2", postable: false, reason: "src/b.ts is not in the current diff" },
          ],
        },
        409,
      ),
    );

    const result = await actions.post(REF, { body: "b" });

    expect(result.status).toBe("nothing-to-post");
    if (result.status !== "nothing-to-post") throw new Error("unreachable");
    expect(result.checked).toBe(2);
    expect(result.held.map((verdict) => verdict.reason)).toEqual([
      "line 10 of src/a.ts is not in the current diff",
      "src/b.ts is not in the current diff",
    ]);
  });

  test("a failed post is a failure, never a silent success", async () => {
    const { actions } = harness(always({ error: "forge-error", message: "GitHub returned 422: line must be part of the diff" }, 502));

    const result = await actions.post(REF, { body: "b" });

    expect(result.status).toBe("error");
    if (result.status !== "error") throw new Error("unreachable");
    expect(result.error.kind).toBe("forge");
    expect(result.error.message).toContain("422");
  });

  test("a missing GitHub token surfaces the daemon's guidance verbatim", async () => {
    const { actions } = harness(
      always(
        {
          error: "no-github-token",
          message: "no GitHub token resolved. Set GITHUB_TOKEN, run `gh auth login`, or save one in ~/.lgtm-farm/credentials.json.",
        },
        503,
      ),
    );

    const result = await actions.post(REF, { body: "b" });

    expect(result.status).toBe("error");
    if (result.status !== "error") throw new Error("unreachable");
    expect(result.error.code).toBe("no-github-token");
    expect(result.error.message).toContain("gh auth login");
  });

  test("a body that is not JSON still fails on its status rather than throwing", async () => {
    const actions = createGateActions({
      client: tokenClient("test-token"),
      fetchImpl: async () => new Response("<html>gateway timeout</html>", { status: 504 }),
    });

    const result = await actions.post(REF, { body: "b" });

    expect(result.status).toBe("error");
    if (result.status !== "error") throw new Error("unreachable");
    expect(result.error.status).toBe(504);
    expect(result.error.message).toBe("The daemon answered 504.");
  });
});

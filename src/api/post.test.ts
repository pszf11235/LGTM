/**
 * Tests for the only code path in LGTM that writes to GitHub.
 *
 * Everything here runs offline. `globalThis.fetch` is stubbed and refuses any
 * request the test did not plan for, so a stray call fails loudly instead of
 * reaching a real code host, and the Forge fake throws on every adapter method
 * the post flow has no business calling.
 *
 * The tests are ordered by what they protect, worst consequence first:
 *
 *  1. The create request carries no `event` key (ADR 0001). A regression here
 *     publishes review comments under the user's name, irreversibly.
 *  2. A dry run writes nothing, to GitHub or to the store. The old codebase
 *     shipped a dry run that wrote; it is on the regression checklist.
 *  3. A failed create cannot leave findings marked `posted`. That failure mode
 *     silently deletes findings from every later review.
 *  4. Recreating a draft flips its posted findings back to `open`. Forgetting
 *     that drops their comments from the recreated review with nothing on
 *     screen to say so.
 *  5. Zero valid findings aborts before any GitHub call, so no body-only
 *     review is created.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "fs/promises";
import os from "os";
import path from "path";

import type { ForgeAdapter, PRRef } from "@/core";
import { createGitHubAdapter } from "@/forge/github/adapter";
import { createEventBus } from "@/daemon/events";
import type { DaemonEvent } from "@/daemon/events";
import { loadAllRounds, loadMeta, markFindingsPosted, saveMeta, saveRound } from "@/store/reviews";

import { postHandler, postRoutes, runPost, runValidate, validateHandler } from "./post";
import type { ApiDeps } from "./routes";

// ─── Fixture ────────────────────────────────────────────────────────────────

const REF: PRRef = { owner: "acme", repo: "api", number: 42 };
const SHA = "a".repeat(40);
const REVIEWS_URL = "https://api.github.com/repos/acme/api/pulls/42/reviews";
const CREATED_URL = "https://github.com/acme/api/pull/42#pullrequestreview-999";

/** New-file lines 1 to 9 of src/limiter.ts are commentable; nothing else is. */
const DIFF = `diff --git a/src/limiter.ts b/src/limiter.ts
index 1111111..2222222 100644
--- a/src/limiter.ts
+++ b/src/limiter.ts
@@ -1,6 +1,9 @@
 const a = 1;
 const b = 2;
+const c = 3;
+const d = 4;
+const e = 5;
 const f = 6;
 const g = 7;
 const h = 8;
 const i = 9;
`;

let store: string;
/** Every Forge call and every HTTP request, in order, so ordering is assertable. */
let trace: string[];
let httpCalls: Array<{ url: string; method: string; headers: Record<string, string>; body: unknown }>;
let respond: (url: string, init: RequestInit) => Response;
let diff: string;
let reviewStates: Map<number, "pending" | "submitted" | "gone">;
let deleteFails: Error | null;
let originalFetch: typeof globalThis.fetch;

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** What GitHub answers a create call with when all is well. */
const CREATED = { id: 999, state: "PENDING", html_url: CREATED_URL };

beforeEach(async () => {
  store = await fs.mkdtemp(path.join(os.tmpdir(), "lgtm-post-"));
  trace = [];
  httpCalls = [];
  diff = DIFF;
  reviewStates = new Map();
  deleteFails = null;

  respond = (url, init) => {
    if ((init.method ?? "GET") === "POST" && url === REVIEWS_URL) return jsonResponse(201, CREATED);
    throw new Error(`unplanned request: ${init.method ?? "GET"} ${url}`);
  };

  originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const options = init ?? {};
    const method = options.method ?? "GET";
    httpCalls.push({
      url,
      method,
      headers: (options.headers ?? {}) as Record<string, string>,
      body: typeof options.body === "string" ? JSON.parse(options.body) : options.body,
    });
    trace.push(`http ${method} ${url}`);
    return respond(url, options);
  }) as typeof fetch;
});

afterEach(async () => {
  globalThis.fetch = originalFetch;
  await fs.rm(store, { recursive: true, force: true }).catch(() => {});
});

/** A Forge that answers the three calls the post flow may make and refuses the rest. */
function fakeForge(): ForgeAdapter {
  const unexpected = (name: string) => () => {
    throw new Error(`the post flow must not call forge.${name}`);
  };

  return {
    listOpenPRs: unexpected("listOpenPRs"),
    getPR: unexpected("getPR"),
    getCheckStatus: unexpected("getCheckStatus"),
    // The create goes through draft-review.ts, so that the dry run and the
    // real post share one request builder. Nothing calls this.
    createDraftReview: unexpected("createDraftReview"),
    authenticatedUser: unexpected("authenticatedUser"),

    getDiff: async (ref) => {
      trace.push(`getDiff ${ref.number}`);
      return diff;
    },
    getReview: async (_ref, id) => {
      trace.push(`getReview ${id}`);
      return reviewStates.get(id) ?? "gone";
    },
    deleteDraftReview: async (_ref, id) => {
      trace.push(`deleteDraftReview ${id}`);
      if (deleteFails) throw deleteFails;
    },
  };
}

function makeDeps(over: Partial<ApiDeps> = {}): ApiDeps {
  return {
    lgtmDir: store,
    token: "t".repeat(64),
    port: 4747,
    version: "1.0.0-test",
    forge: fakeForge(),
    githubToken: () => "ghp_secret",
    ...over,
  };
}

interface RawFinding {
  file: string;
  line: number;
  severity: "low" | "medium" | "high" | "critical";
  comment: string;
  suggestion?: string;
}

/** The three cases every validation pass has to separate. */
const IN_DIFF: RawFinding = {
  file: "src/limiter.ts",
  line: 4,
  severity: "high",
  comment: "this overflows",
};
const LINE_GONE: RawFinding = {
  file: "src/limiter.ts",
  line: 118,
  severity: "medium",
  comment: "stale line",
};
const FILE_GONE: RawFinding = {
  file: "src/removed.ts",
  line: 3,
  severity: "low",
  comment: "not in this PR",
};

async function seed(findings: RawFinding[], meta: Parameters<typeof saveMeta>[2] = {}): Promise<void> {
  await saveRound(store, {
    ref: REF,
    round: 1,
    agent: "reviewer",
    provider: "claude-cli",
    headSha: SHA,
    status: "ok",
    startedAt: "2026-08-29T10:00:00Z",
    durationMs: 1000,
    findings,
  });
  await saveMeta(store, REF, { state: "reviewed", headSha: SHA, rounds: 1, ...meta });
}

/** Every finding on disk by canonical key, which is the only handle that is safe. */
async function statesOnDisk(): Promise<Record<string, { state: string; heldReason: string | null }>> {
  const out: Record<string, { state: string; heldReason: string | null }> = {};
  for (const round of await loadAllRounds(store, REF)) {
    for (const finding of round.findings) {
      out[`r${round.round}:${round.agent}:${finding.id}`] = {
        state: finding.state,
        heldReason: finding.heldReason ?? null,
      };
    }
  }
  return out;
}

function createCalls(): typeof httpCalls {
  return httpCalls.filter((call) => call.method === "POST" && call.url === REVIEWS_URL);
}

interface SentBody {
  body: string;
  comments: Array<{ path: string; line: number; body: string }>;
}

function sentBody(): SentBody {
  const call = createCalls()[0];
  if (!call) throw new Error("no create call was made");
  return call.body as SentBody;
}

// ─── The draft contract ─────────────────────────────────────────────────────

describe("the create request", () => {
  test("carries no event key, which is the whole draft contract", async () => {
    // Sending any event publishes the review immediately and irreversibly.
    // There is no draft:true parameter to fall back on (ADR 0001).
    await seed([IN_DIFF]);

    const result = await runPost(makeDeps(), REF);
    expect(result.status).toBe("posted");

    const call = createCalls()[0]!;
    const body = call.body as Record<string, unknown>;

    expect("event" in body).toBe(false);
    expect(Object.keys(body).sort()).toEqual(["body", "comments"]);

    const wire = JSON.stringify(body);
    expect(wire).not.toContain("event");
    expect(wire).not.toContain("COMMENT");
    expect(wire).not.toContain("APPROVE");
    expect(wire).not.toContain("REQUEST_CHANGES");
  });

  test("is one call to the PR's reviews endpoint, and only one", async () => {
    // The REST API cannot append to a pending review, so everything has to
    // travel in this single request.
    await seed([IN_DIFF, { ...IN_DIFF, line: 5, comment: "second" }]);

    await runPost(makeDeps(), REF);

    expect(httpCalls).toHaveLength(1);
    expect(httpCalls[0]!.method).toBe("POST");
    expect(httpCalls[0]!.url).toBe(REVIEWS_URL);
    expect(sentBody().comments).toHaveLength(2);
  });

  test("refuses a response that is not PENDING, and records nothing", async () => {
    // A non-PENDING answer means the comments are already public. Recording
    // it as a draft would tell the user the opposite.
    await seed([IN_DIFF]);
    respond = () => jsonResponse(200, { id: 4, state: "APPROVED" });

    await expect(runPost(makeDeps(), REF)).rejects.toThrow(/PENDING/);

    expect((await loadMeta(store, REF))!.pendingReviewId).toBeNull();
    expect((await statesOnDisk())["r1:reviewer:f1"]!.state).toBe("open");
  });
});

// ─── Dry run ────────────────────────────────────────────────────────────────

describe("dry run", () => {
  test("writes nothing to GitHub and nothing to the store", async () => {
    await seed([IN_DIFF, LINE_GONE], { pendingReviewId: 555 });
    const before = await statesOnDisk();

    const result = await runPost(makeDeps(), REF, { dryRun: true });
    expect(result.status).toBe("dry-run");

    // Not one HTTP request, and not one Forge call beyond reading the diff.
    expect(httpCalls).toEqual([]);
    expect(trace).toEqual(["getDiff 42"]);

    // The store is byte-identical in the fields that matter: no finding was
    // marked posted, none was marked held, and the recorded draft id stands.
    expect(await statesOnDisk()).toEqual(before);
    expect((await loadMeta(store, REF))!.pendingReviewId).toBe(555);
  });

  test("returns the exact request the real post would send", async () => {
    await seed([IN_DIFF]);

    const result = await runPost(makeDeps(), REF, { dryRun: true });
    if (result.status !== "dry-run") throw new Error("expected a dry run");

    const preview = result.report.request;
    expect(preview.url).toBe(REVIEWS_URL);
    expect(preview.method).toBe("POST");
    expect("event" in preview.body).toBe(false);
    expect(preview.body.comments).toEqual([
      { path: "src/limiter.ts", line: 4, body: "this overflows" },
    ]);

    // Now send it for real and compare. A preview built by different code
    // than the sender proves nothing about what would be sent.
    await runPost(makeDeps(), REF);
    expect(sentBody()).toEqual(preview.body);
  });

  test("does not leak the GitHub token into the preview", async () => {
    // The preview goes to a browser. The token never leaves the daemon.
    await seed([IN_DIFF]);

    const result = await runPost(makeDeps(), REF, { dryRun: true });
    if (result.status !== "dry-run") throw new Error("expected a dry run");

    expect(JSON.stringify(result.report)).not.toContain("ghp_secret");
    expect(result.report.request.headers.Authorization).toBe("Bearer <redacted>");
  });

  test("reports a recorded draft without asking GitHub about it", async () => {
    // Checking would be a read, but every branch of that step writes.
    await seed([IN_DIFF], { pendingReviewId: 555 });
    reviewStates.set(555, "pending");

    const result = await runPost(makeDeps(), REF, { dryRun: true, recreate: true });
    if (result.status !== "dry-run") throw new Error("expected a dry run");

    expect(result.report.pendingReviewId).toBe(555);
    expect(trace).not.toContain("getReview 555");
    expect(trace).not.toContain("deleteDraftReview 555");
  });

  test("still previews the held-back list", async () => {
    await seed([IN_DIFF, LINE_GONE, FILE_GONE]);

    const result = await runPost(makeDeps(), REF, { dryRun: true });
    if (result.status !== "dry-run") throw new Error("expected a dry run");

    expect(result.report.postable.map((v) => v.key)).toEqual(["r1:reviewer:f1"]);
    expect(result.report.held.map((v) => v.key)).toEqual(["r1:reviewer:f2", "r1:reviewer:f3"]);
    expect(result.report.counts).toEqual({ checked: 3, postable: 1, held: 2 });
  });
});

// ─── A create that fails ────────────────────────────────────────────────────

describe("a failed create", () => {
  test("cannot mark findings posted", async () => {
    // The one ordering that matters in this file: post first, record second.
    // Marked-then-posted turns any network failure into lost findings.
    await seed([IN_DIFF, LINE_GONE]);
    respond = () => new Response("upstream is having a day", { status: 500 });

    await expect(runPost(makeDeps(), REF)).rejects.toThrow(/500/);

    const states = await statesOnDisk();
    expect(states["r1:reviewer:f1"]!.state).toBe("open");
    // Not even the holds are written, so a failed post leaves the gate
    // exactly as the user left it.
    expect(states["r1:reviewer:f2"]!.state).toBe("open");
    expect((await loadMeta(store, REF))!.pendingReviewId).toBeNull();
  });

  test("surfaces as a 502 through the handler, with GitHub's own message", async () => {
    await seed([IN_DIFF]);
    respond = () => new Response("Validation Failed: line must be part of the diff", { status: 422 });

    const res = await callPost({});
    expect(res.status).toBe(502);
    expect(res.body.error).toBe("forge-error");
    expect(String(res.body.message)).toContain("Validation Failed");
  });
});

// ─── The existing draft ─────────────────────────────────────────────────────

describe("an existing pending draft", () => {
  test("refuses the post rather than creating a second draft", async () => {
    await seed([IN_DIFF], { pendingReviewId: 555 });
    reviewStates.set(555, "pending");

    const result = await runPost(makeDeps(), REF);
    expect(result.status).toBe("pending-review-exists");
    if (result.status !== "pending-review-exists") throw new Error("unreachable");
    expect(result.pendingReviewId).toBe(555);

    // Refused before anything else happened: no diff fetch, no delete, no create.
    expect(trace).toEqual(["getReview 555"]);
    expect(httpCalls).toEqual([]);
    expect((await loadMeta(store, REF))!.pendingReviewId).toBe(555);
  });

  test("recreate deletes it, reopens its posted findings, and posts fresh", async () => {
    // The flip is the whole point. Those comments left GitHub with the draft,
    // so a finding still marked posted is a comment dropped in silence.
    await seed([IN_DIFF, LINE_GONE], { pendingReviewId: 555 });
    await markFindingsPosted(store, REF, ["r1:reviewer:f1"]);
    reviewStates.set(555, "pending");

    const result = await runPost(makeDeps(), REF, { recreate: true });
    if (result.status !== "posted") throw new Error(`expected a post, got ${result.status}`);

    expect(result.report.recreated).toEqual({
      deletedReviewId: 555,
      reopened: ["r1:reviewer:f1"],
    });

    // Delete, then diff, then create. Deleting after the create would leave
    // two drafts on the PR for as long as the request took.
    expect(trace).toEqual([
      "getReview 555",
      "deleteDraftReview 555",
      "getDiff 42",
      `http POST ${REVIEWS_URL}`,
    ]);

    // The reopened finding is in the new draft, and posted again.
    expect(sentBody().comments).toEqual([
      { path: "src/limiter.ts", line: 4, body: "this overflows" },
    ]);
    const states = await statesOnDisk();
    expect(states["r1:reviewer:f1"]!.state).toBe("posted");
    expect((await loadMeta(store, REF))!.pendingReviewId).toBe(999);
  });

  test("recreate leaves everything alone when the delete fails", async () => {
    await seed([IN_DIFF], { pendingReviewId: 555 });
    await markFindingsPosted(store, REF, ["r1:reviewer:f1"]);
    reviewStates.set(555, "pending");
    deleteFails = new Error("GitHub API 500: try later");

    await expect(runPost(makeDeps(), REF, { recreate: true })).rejects.toThrow(/500/);

    // The store still describes GitHub accurately: the draft is there, its
    // findings are posted, and a retry is the whole recovery.
    expect(httpCalls).toEqual([]);
    expect((await loadMeta(store, REF))!.pendingReviewId).toBe(555);
    expect((await statesOnDisk())["r1:reviewer:f1"]!.state).toBe("posted");
  });

  test("a draft submitted in GitHub's UI clears the record and posts", async () => {
    // Without this, LGTM refuses this PR forever (R6.5).
    await seed([IN_DIFF], { pendingReviewId: 777 });
    await markFindingsPosted(store, REF, ["r1:reviewer:f1"]);
    reviewStates.set(777, "submitted");

    // A second round's finding is what the new draft is for; the submitted
    // one's finding stays posted, because its comments are still on the PR.
    await saveRound(store, {
      ref: REF,
      round: 2,
      agent: "reviewer",
      provider: "claude-cli",
      headSha: SHA,
      status: "ok",
      startedAt: "2026-08-29T11:00:00Z",
      durationMs: 900,
      findings: [{ ...IN_DIFF, line: 5, comment: "round two" }],
    });

    const result = await runPost(makeDeps(), REF);
    if (result.status !== "posted") throw new Error(`expected a post, got ${result.status}`);

    expect(result.report.clearedReviewId).toBe(777);
    expect(result.report.recreated).toBeNull();
    expect(trace).not.toContain("deleteDraftReview 777");

    const states = await statesOnDisk();
    expect(states["r1:reviewer:f1"]!.state).toBe("posted");
    expect(states["r2:reviewer:f1"]!.state).toBe("posted");
    expect(sentBody().comments).toEqual([{ path: "src/limiter.ts", line: 5, body: "round two" }]);
    expect((await loadMeta(store, REF))!.pendingReviewId).toBe(999);
  });

  test("a draft deleted in GitHub's UI clears the record too", async () => {
    await seed([IN_DIFF], { pendingReviewId: 888 });
    reviewStates.set(888, "gone");

    const result = await runPost(makeDeps(), REF);
    if (result.status !== "posted") throw new Error(`expected a post, got ${result.status}`);

    expect(result.report.clearedReviewId).toBe(888);
    expect((await loadMeta(store, REF))!.pendingReviewId).toBe(999);
  });
});

// ─── Zero valid findings ────────────────────────────────────────────────────

describe("when nothing validates", () => {
  test("aborts before any GitHub call, and creates no body-only review", async () => {
    await seed([LINE_GONE, FILE_GONE]);

    const result = await runPost(makeDeps(), REF);
    if (result.status !== "nothing-to-post") throw new Error(`expected an abort, got ${result.status}`);

    // The diff read is the only Forge traffic. Nothing was created.
    expect(httpCalls).toEqual([]);
    expect(trace).toEqual(["getDiff 42"]);
    expect(result.checked).toBe(2);
    expect(result.held.map((v) => v.reason)).toEqual([
      "line 118 of src/limiter.ts is not in the diff",
      "src/removed.ts is not in this PR's diff",
    ]);
  });

  test("records the reasons so the cards can say why", async () => {
    await seed([LINE_GONE]);

    await runPost(makeDeps(), REF);

    const states = await statesOnDisk();
    expect(states["r1:reviewer:f1"]!.state).toBe("held");
    expect(states["r1:reviewer:f1"]!.heldReason).toBe(
      "line 118 of src/limiter.ts is not in the diff"
    );
    expect((await loadMeta(store, REF))!.pendingReviewId).toBeNull();
  });

  test("answers 409 with the held list through the handler", async () => {
    await seed([FILE_GONE]);

    const res = await callPost({});
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("nothing-to-post");
    expect(res.body.held).toHaveLength(1);
  });
});

// ─── Held findings ──────────────────────────────────────────────────────────

describe("held findings", () => {
  test("return to play by themselves once the line is back in the diff", async () => {
    // The only way a held finding is ever posted (R6.3). It is held, not
    // dropped, precisely so a later commit can bring its line back.
    await seed([IN_DIFF]);
    diff = DIFF.replace("+const d = 4;", "+const changed = 4;");

    await runPost(makeDeps(), REF);
    expect((await statesOnDisk())["r1:reviewer:f1"]!.state).toBe("posted");

    // Now hold it: a diff without that file at all.
    await saveMeta(store, REF, { pendingReviewId: null });
    await saveRound(store, {
      ref: REF,
      round: 2,
      agent: "reviewer",
      provider: "claude-cli",
      headSha: SHA,
      status: "ok",
      startedAt: "2026-08-29T11:00:00Z",
      durationMs: 900,
      findings: [{ ...IN_DIFF, comment: "still here" }],
    });
    diff = `diff --git a/src/other.ts b/src/other.ts
--- a/src/other.ts
+++ b/src/other.ts
@@ -1,1 +1,2 @@
 const x = 1;
+const y = 2;
`;

    const held = await runPost(makeDeps(), REF);
    expect(held.status).toBe("nothing-to-post");
    expect((await statesOnDisk())["r2:reviewer:f1"]!.state).toBe("held");

    // The line comes back, and the held finding posts without anyone
    // reopening it by hand.
    diff = DIFF;
    const back = await runPost(makeDeps(), REF);
    if (back.status !== "posted") throw new Error(`expected a post, got ${back.status}`);

    expect(back.report.posted.map((v) => v.key)).toEqual(["r2:reviewer:f1"]);
    // The verdict reports the state it found, which is what makes the return
    // visible in the response rather than only on disk.
    expect(back.report.posted[0]!.state).toBe("held");

    const states = await statesOnDisk();
    expect(states["r2:reviewer:f1"]!.state).toBe("posted");
    expect(states["r2:reviewer:f1"]!.heldReason).toBeNull();
  });

  test("a discarded finding is never revived by a post", async () => {
    await seed([IN_DIFF, { ...IN_DIFF, line: 5, comment: "junk" }]);
    const { markFindingsDiscarded } = await import("@/store/reviews");
    await markFindingsDiscarded(store, REF, ["r1:reviewer:f2"]);

    const result = await runPost(makeDeps(), REF);
    if (result.status !== "posted") throw new Error("expected a post");

    expect(result.report.posted.map((v) => v.key)).toEqual(["r1:reviewer:f1"]);
    expect(sentBody().comments).toHaveLength(1);
    expect((await statesOnDisk())["r1:reviewer:f2"]!.state).toBe("discarded");
  });
});

// ─── Finding identity ───────────────────────────────────────────────────────

describe("finding identity", () => {
  test("a post keys on the full r<N>:<agent>:<id> triple, never a bare id", async () => {
    // Ids restart at f1 in every round file. Matching on "f1" marks other
    // rounds' findings posted, which is the bug the old codebase shipped.
    await seed([LINE_GONE]); // r1:reviewer:f1 cannot attach
    await saveRound(store, {
      ref: REF,
      round: 2,
      agent: "reviewer",
      provider: "claude-cli",
      headSha: SHA,
      status: "ok",
      startedAt: "2026-08-29T11:00:00Z",
      durationMs: 900,
      findings: [IN_DIFF], // r2:reviewer:f1 can
    });

    const result = await runPost(makeDeps(), REF);
    if (result.status !== "posted") throw new Error("expected a post");

    const states = await statesOnDisk();
    expect(states["r2:reviewer:f1"]!.state).toBe("posted");
    expect(states["r1:reviewer:f1"]!.state).toBe("held");
    expect(result.report.posted.map((v) => v.key)).toEqual(["r2:reviewer:f1"]);
    expect(result.report.held.map((v) => v.key)).toEqual(["r1:reviewer:f1"]);
  });
});

// ─── The review body ────────────────────────────────────────────────────────

describe("the review body", () => {
  test("renders templates/review-body.md, held findings included", async () => {
    await seed([IN_DIFF, LINE_GONE]);
    await fs.mkdir(path.join(store, "templates"), { recursive: true });
    await fs.writeFile(
      path.join(store, "templates", "review-body.md"),
      "{{agents}} raised {{count_high}} high and {{count_medium}} medium.{{held_findings}}",
      "utf-8"
    );

    await runPost(makeDeps(), REF);

    const body = sentBody().body;
    expect(body).toStartWith("reviewer raised 1 high and 0 medium.");
    // A finding held back in silence is a finding the author never hears
    // about, so the body says so (R6.3).
    expect(body).toContain("r1:reviewer:f2");
    expect(body).toContain("line 118 of src/limiter.ts is not in the diff");
  });

  test("falls back to the shipped default when the store has no template", async () => {
    await seed([IN_DIFF]);

    await runPost(makeDeps(), REF);

    expect(sentBody().body).toContain("reviewer");
  });

  test("uses an inline edit verbatim", async () => {
    // The confirm pane is the last human step. Second-guessing its text would
    // make the preview a different thing from what gets sent.
    await seed([IN_DIFF]);

    await runPost(makeDeps(), REF, { body: "I rewrote this myself.\n\nNo template." });

    expect(sentBody().body).toBe("I rewrote this myself.\n\nNo template.");
  });

  test("carries the suggestion into the comment", async () => {
    await seed([{ ...IN_DIFF, suggestion: "clamp it to MAX_SAFE_INTEGER" }]);

    await runPost(makeDeps(), REF);

    expect(sentBody().comments[0]!.body).toBe(
      "this overflows\n\nSuggested: clamp it to MAX_SAFE_INTEGER"
    );
  });
});

// ─── validate ───────────────────────────────────────────────────────────────

describe("validate", () => {
  test("returns a verdict per finding, with the reason when it cannot attach", async () => {
    await seed([IN_DIFF, LINE_GONE, FILE_GONE]);

    const result = await runValidate(makeDeps(), REF);
    if (result.status !== "ok") throw new Error(`expected a report, got ${result.status}`);

    expect(result.report.counts).toEqual({ checked: 3, postable: 1, held: 2 });
    expect(result.report.findings.map((v) => [v.key, v.postable, v.reason])).toEqual([
      ["r1:reviewer:f1", true, null],
      ["r1:reviewer:f2", false, "line 118 of src/limiter.ts is not in the diff"],
      ["r1:reviewer:f3", false, "src/removed.ts is not in this PR's diff"],
    ]);
  });

  test("writes nothing, to GitHub or to the store", async () => {
    // A preview that flipped findings to held would mean opening a pane
    // changed the gate.
    await seed([IN_DIFF, LINE_GONE], { pendingReviewId: 555 });
    const before = await statesOnDisk();

    await runValidate(makeDeps(), REF);

    expect(httpCalls).toEqual([]);
    expect(trace).toEqual(["getDiff 42"]);
    expect(await statesOnDisk()).toEqual(before);
    expect((await loadMeta(store, REF))!.pendingReviewId).toBe(555);
  });

  test("reads the current diff, not the round's stored snapshot", async () => {
    // GitHub validates against the head the PR has now. A snapshot would
    // approve a comment the create call then rejects, failing the whole
    // review rather than that one comment.
    await seed([IN_DIFF]);
    await fs.writeFile(
      path.join(store, "reviews", "acme", "api", "pr-42", `diff-${SHA}.patch`),
      DIFF,
      "utf-8"
    );
    diff = "diff --git a/src/other.ts b/src/other.ts\n--- a/src/other.ts\n+++ b/src/other.ts\n@@ -1,1 +1,2 @@\n const x = 1;\n+const y = 2;\n";

    const result = await runValidate(makeDeps(), REF);
    if (result.status !== "ok") throw new Error("expected a report");

    expect(result.report.findings[0]!.postable).toBe(false);
  });

  test("answers 404 for a PR the store has never seen", async () => {
    const res = await callValidate();
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("unknown-pr");
  });
});

// ─── The HTTP surface ───────────────────────────────────────────────────────

interface HandlerResult {
  status: number;
  body: Record<string, unknown>;
}

function context(target: string, body: unknown, deps: ApiDeps) {
  const url = new URL(target);
  return {
    req: new Request(target, {
      method: "POST",
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    url,
    params: { owner: REF.owner, repo: REF.repo, number: String(REF.number) },
    deps,
  };
}

async function callPost(body: unknown, deps: ApiDeps = makeDeps()): Promise<HandlerResult> {
  const res = await postHandler(context("http://127.0.0.1:4747/api/prs/acme/api/42/post", body, deps));
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

async function callValidate(deps: ApiDeps = makeDeps()): Promise<HandlerResult> {
  const res = await validateHandler(
    context("http://127.0.0.1:4747/api/prs/acme/api/42/validate", undefined, deps)
  );
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

describe("the HTTP surface", () => {
  test("posts and reports per-finding results", async () => {
    await seed([IN_DIFF, LINE_GONE]);

    const res = await callPost({});

    expect(res.status).toBe(200);
    expect(res.body.dryRun).toBe(false);
    expect(res.body.reviewId).toBe(999);
    expect(res.body.reviewUrl).toBe(CREATED_URL);
    expect(res.body.posted).toHaveLength(1);
    expect(res.body.held).toHaveLength(1);
  });

  test("409 when a draft is already pending, with the recreate hint", async () => {
    await seed([IN_DIFF], { pendingReviewId: 555 });
    reviewStates.set(555, "pending");

    const res = await callPost({});

    expect(res.status).toBe(409);
    expect(res.body.error).toBe("pending-review-exists");
    expect(res.body.pendingReviewId).toBe(555);
    expect(String(res.body.message)).toContain("recreate");
  });

  test("503 when no GitHub token resolved, before any Forge call", async () => {
    await seed([IN_DIFF]);

    const res = await callPost({}, makeDeps({ githubToken: () => null }));

    expect(res.status).toBe(503);
    expect(res.body.error).toBe("no-github-token");
    expect(trace).toEqual([]);
  });

  test("503 when the daemon has no Forge adapter", async () => {
    await seed([IN_DIFF]);

    const res = await callPost({}, makeDeps({ forge: undefined }));

    expect(res.status).toBe(503);
    expect(res.body.error).toBe("no-forge");
  });

  test("400 on a malformed body, before anything else happens", async () => {
    await seed([IN_DIFF]);

    const res = await callPost({ dryRun: "yes" });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("bad-body");
    expect(httpCalls).toEqual([]);
    expect(trace).toEqual([]);
  });

  test("400 on a ref that is not a pull request", async () => {
    const res = await postHandler({
      req: new Request("http://127.0.0.1:4747/api/prs/acme/api/x/post", { method: "POST", body: "{}" }),
      url: new URL("http://127.0.0.1:4747/api/prs/acme/api/x/post"),
      params: { owner: "acme", repo: "api", number: "x" },
      deps: makeDeps(),
    });

    expect(res.status).toBe(400);
  });

  test("emits pr-changed so an open tab refetches", async () => {
    await seed([IN_DIFF]);
    const seen: DaemonEvent[] = [];
    const events = createEventBus();
    events.on((event) => seen.push(event));

    await runPost(makeDeps({ events }), REF);

    expect(seen).toEqual([{ type: "pr-changed", ref: REF }]);
  });

  test("both routes sit under the auth choke point", async () => {
    const rows = postRoutes();

    expect(rows.map((row) => [row.method, row.path, row.name])).toEqual([
      ["POST", "/api/prs/:owner/:repo/:number/validate", "prs.validate"],
      ["POST", "/api/prs/:owner/:repo/:number/post", "prs.post"],
    ]);
    // Every row is a POST, so `mutating` is true on both or the Origin check
    // does not run. The matrix test in server.test.ts asserts the same tie.
    expect(rows.every((row) => row.bearer && row.mutating && !row.queryToken)).toBe(true);
  });
});

// ─── Through the real GitHub adapter ────────────────────────────────────────

describe("with the real GitHub adapter", () => {
  test("a recreate whose draft GitHub no longer has still posts", async () => {
    // The 404 on DELETE is the normal case when the user deleted the draft in
    // GitHub's UI between the getReview and the delete. Tolerating it is the
    // adapter's job; this drives the whole path to prove the flow relies on it.
    await seed([IN_DIFF], { pendingReviewId: 555 });
    await markFindingsPosted(store, REF, ["r1:reviewer:f1"]);

    const reviewUrl = "https://api.github.com/repos/acme/api/pulls/42/reviews/555";
    const prUrl = "https://api.github.com/repos/acme/api/pulls/42";

    respond = (url, init) => {
      const method = init.method ?? "GET";
      if (method === "GET" && url === reviewUrl) return jsonResponse(200, { id: 555, state: "PENDING" });
      if (method === "DELETE" && url === reviewUrl) return new Response("gone", { status: 404 });
      if (method === "GET" && url === prUrl) return new Response(DIFF, { status: 200 });
      if (method === "POST" && url === REVIEWS_URL) return jsonResponse(201, CREATED);
      throw new Error(`unplanned request: ${method} ${url}`);
    };

    const deps = makeDeps({
      forge: createGitHubAdapter({ resolveToken: () => "ghp_secret" }),
    });

    const result = await runPost(deps, REF, { recreate: true });
    if (result.status !== "posted") throw new Error(`expected a post, got ${result.status}`);

    expect(result.report.recreated?.reopened).toEqual(["r1:reviewer:f1"]);
    expect((await statesOnDisk())["r1:reviewer:f1"]!.state).toBe("posted");
    expect((await loadMeta(store, REF))!.pendingReviewId).toBe(999);

    const created = createCalls()[0]!;
    expect("event" in (created.body as Record<string, unknown>)).toBe(false);
  });
});

/**
 * Tests for the GitHub ForgeAdapter.
 *
 * The 13 tests from packages/plugins/review/src/infra/github.test.ts on the
 * old `main` branch are carried over here, re-aimed at the v1 method names,
 * plus what v1 added: ETag conditional listing, pagination, check runs, and
 * the draft-review lifecycle.
 *
 * fetch is mocked throughout. Nothing in this file touches the network.
 *
 * Run with: bun test src/forge/github/adapter.test.ts
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { PRRef, RepoRef } from "@/core/types";
import * as adapterModule from "./adapter";
import { buildDraftReviewRequest, createGitHubAdapter, isNotModified } from "./adapter";

const REPO: RepoRef = { owner: "acme", repo: "api" };
const PR: PRRef = { owner: "acme", repo: "api", number: 42 };

interface Recorded {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

/** Only the two variables these tests touch; bun test shares one process. */
const TOKEN_VARS = ["GITHUB_TOKEN", "GH_TOKEN"] as const;
const originalTokenVars = TOKEN_VARS.map((name) => [name, process.env[name]] as const);
let originalFetch: typeof globalThis.fetch;

/** Install a fetch mock and return the log of requests it saw. */
function mockFetch(handler: (req: Recorded) => Response | Promise<Response>): Recorded[] {
  const calls: Recorded[] = [];

  globalThis.fetch = mock(async (input: unknown, init?: RequestInit) => {
    const recorded: Recorded = {
      url: String(input),
      method: init?.method ?? "GET",
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    };
    calls.push(recorded);
    return await handler(recorded);
  }) as unknown as typeof globalThis.fetch;

  return calls;
}

function json(payload: unknown, init: { status?: number; headers?: Record<string, string> } = {}) {
  return new Response(JSON.stringify(payload), {
    status: init.status ?? 200,
    headers: { "Content-Type": "application/json", ...init.headers },
  });
}

/** An adapter whose token never touches the machine's real environment. */
function adapter(token: string | null = "test-token-123") {
  return createGitHubAdapter({ resolveToken: () => token });
}

const PULL_PAYLOAD = {
  number: 42,
  title: "feat: add thing",
  body: "This adds a thing, cc @pszf11235",
  html_url: "https://github.com/acme/api/pull/42",
  state: "open",
  draft: false,
  user: { login: "octocat" },
  head: { ref: "feat/thing", sha: "abc123" },
  base: { ref: "main" },
  created_at: "2026-08-01T10:00:00Z",
  updated_at: "2026-08-02T10:00:00Z",
  requested_reviewers: [{ login: "pszf11235" }],
  assignees: [{ login: "octocat" }],
  changed_files: 3,
  additions: 100,
  deletions: 20,
  mergeable: true,
};

beforeEach(() => {
  originalFetch = globalThis.fetch;
  process.env.GITHUB_TOKEN = "test-token-123";
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const [name, value] of originalTokenVars) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

// ─── Ported: auth resolution ────────────────────────────────────────────────

describe("auth", () => {
  test("sends the GITHUB_TOKEN as a bearer", async () => {
    process.env.GITHUB_TOKEN = "gh-token-abc";
    delete process.env.GH_TOKEN;
    const calls = mockFetch(() => json(PULL_PAYLOAD));

    await createGitHubAdapter().getPR(PR);

    expect(calls[0]?.headers.Authorization).toBe("Bearer gh-token-abc");
  });

  test("falls back to GH_TOKEN", async () => {
    delete process.env.GITHUB_TOKEN;
    process.env.GH_TOKEN = "gh-alt-token";
    const calls = mockFetch(() => json(PULL_PAYLOAD));

    await createGitHubAdapter().getPR(PR);

    expect(calls[0]?.headers.Authorization).toBe("Bearer gh-alt-token");
  });

  test("with no token resolvable, fails with guidance and never calls the API", async () => {
    const calls = mockFetch(() => json({}));

    await expect(adapter(null).getPR(PR)).rejects.toThrow(/token/i);
    expect(calls).toHaveLength(0);
  });

  test("a 401 re-resolves the token and retries once", async () => {
    let resolved = 0;
    const tokens = ["stale-token", "rotated-token"];
    const calls = mockFetch((req) =>
      req.headers.Authorization === "Bearer rotated-token"
        ? json({ login: "pszf11235" })
        : json({ message: "Bad credentials" }, { status: 401 })
    );

    const github = createGitHubAdapter({
      // A token rotated mid-run must be picked up, so resolution is cached
      // between requests but dropped on any 401.
      resolveToken: () => tokens[resolved++] ?? null,
    });

    expect(await github.authenticatedUser()).toBe("pszf11235");
    expect(resolved).toBe(2);
    expect(calls).toHaveLength(2);
  });

  test("a second 401 after re-resolution throws", async () => {
    mockFetch(() => json({ message: "Bad credentials" }, { status: 401 }));

    await expect(adapter().authenticatedUser()).rejects.toThrow("GitHub API 401");
  });
});

// ─── listOpenPRs and the NotModified sentinel ───────────────────────────────

describe("listOpenPRs", () => {
  test("maps the list payload into PRSummary", async () => {
    const calls = mockFetch(() => json([PULL_PAYLOAD]));

    const result = await adapter().listOpenPRs(REPO);
    if (isNotModified(result)) throw new Error("expected a list");

    expect(calls[0]?.url).toContain("/repos/acme/api/pulls?state=open");
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      number: 42,
      title: "feat: add thing",
      body: "This adds a thing, cc @pszf11235",
      url: "https://github.com/acme/api/pull/42",
      author: "octocat",
      draft: false,
      headSha: "abc123",
      createdAt: "2026-08-01T10:00:00Z",
      updatedAt: "2026-08-02T10:00:00Z",
      requestedReviewers: ["pszf11235"],
      assignees: ["octocat"],
    });
  });

  test("a 304 returns the NotModified sentinel, never an empty list", async () => {
    // The one that matters. An empty array means every open PR just closed,
    // so coercing 304 into [] would mark the whole watch list closed on the
    // first unchanged poll.
    mockFetch((req) =>
      req.headers["If-None-Match"]
        ? new Response(null, { status: 304, headers: { ETag: 'W/"v1"' } })
        : json([PULL_PAYLOAD], { headers: { ETag: 'W/"v1"' } })
    );

    const github = adapter();
    const first = await github.listOpenPRs(REPO);
    const second = await github.listOpenPRs(REPO);

    expect(isNotModified(first)).toBe(false);
    expect(isNotModified(second)).toBe(true);
    expect(Array.isArray(second)).toBe(false);
    expect(second).not.toEqual([]);
    expect(second).toEqual({ notModified: true });
  });

  test("an empty list is a real answer, not the sentinel", async () => {
    mockFetch(() => json([]));

    const result = await adapter().listOpenPRs(REPO);

    expect(isNotModified(result)).toBe(false);
    expect(result).toEqual([]);
  });

  test("sends no If-None-Match on the first poll, and the stored ETag on the next", async () => {
    const calls = mockFetch((req) =>
      req.headers["If-None-Match"]
        ? new Response(null, { status: 304 })
        : json([PULL_PAYLOAD], { headers: { ETag: 'W/"v1"' } })
    );

    const github = adapter();
    await github.listOpenPRs(REPO);
    await github.listOpenPRs(REPO);

    expect(calls[0]?.headers["If-None-Match"]).toBeUndefined();
    expect(calls[1]?.headers["If-None-Match"]).toBe('W/"v1"');
  });

  test("a 304 keeps the stored ETag, so the poll after it stays conditional", async () => {
    const calls = mockFetch((req) =>
      req.headers["If-None-Match"]
        ? new Response(null, { status: 304 })
        : json([PULL_PAYLOAD], { headers: { ETag: 'W/"v1"' } })
    );

    const github = adapter();
    await github.listOpenPRs(REPO);
    await github.listOpenPRs(REPO);
    await github.listOpenPRs(REPO);

    expect(calls[2]?.headers["If-None-Match"]).toBe('W/"v1"');
  });

  test("ETags are keyed per repo", async () => {
    // From the old removals audit: an unqualified cache key answers one repo's
    // conditional request with another repo's validator, and every poll after
    // that reports "nothing changed" for a repo that changed.
    const calls = mockFetch((req) =>
      req.headers["If-None-Match"]
        ? new Response(null, { status: 304 })
        : json([PULL_PAYLOAD], {
            headers: { ETag: req.url.includes("/acme/api/") ? 'W/"api"' : 'W/"web"' },
          })
    );

    const github = adapter();
    await github.listOpenPRs(REPO);
    await github.listOpenPRs({ owner: "acme", repo: "web" });
    await github.listOpenPRs(REPO);

    expect(calls[1]?.headers["If-None-Match"]).toBeUndefined();
    expect(calls[2]?.headers["If-None-Match"]).toBe('W/"api"');
  });

  test("follows Link pagination to the last page", async () => {
    const page2 = "https://api.github.com/repos/acme/api/pulls?state=open&per_page=100&page=2";
    const calls = mockFetch((req) =>
      req.url === page2
        ? json([{ ...PULL_PAYLOAD, number: 7 }])
        : json([PULL_PAYLOAD], { headers: { Link: `<${page2}>; rel="next", <${page2}>; rel="last"` } })
    );

    const result = await adapter().listOpenPRs(REPO);
    if (isNotModified(result)) throw new Error("expected a list");

    expect(calls).toHaveLength(2);
    expect(result.map((pr) => pr.number)).toEqual([42, 7]);
  });

  test("a multi-page repo stores no ETag, since the validator covers page one only", async () => {
    const page2 = "https://api.github.com/repos/acme/api/pulls?state=open&per_page=100&page=2";
    const calls = mockFetch((req) =>
      req.url === page2
        ? json([{ ...PULL_PAYLOAD, number: 7 }])
        : json([PULL_PAYLOAD], {
            headers: { ETag: 'W/"v1"', Link: `<${page2}>; rel="next"` },
          })
    );

    const github = adapter();
    await github.listOpenPRs(REPO);
    await github.listOpenPRs(REPO);

    expect(calls[2]?.headers["If-None-Match"]).toBeUndefined();
  });

  test("uses an injected ETag store, so the daemon can persist validators in watch.md", async () => {
    const entries = new Map<string, string>();
    const calls = mockFetch(() => json([PULL_PAYLOAD], { headers: { ETag: 'W/"v1"' } }));

    await createGitHubAdapter({
      resolveToken: () => "test-token-123",
      etags: {
        get: (key) => entries.get(key) ?? null,
        set: (key, etag) => {
          if (etag === null) entries.delete(key);
          else entries.set(key, etag);
        },
      },
    }).listOpenPRs(REPO);

    expect(entries.get("acme/api")).toBe('W/"v1"');
    expect(calls).toHaveLength(1);
  });
});

// ─── Ported: PR metadata and diff ───────────────────────────────────────────

describe("getPR", () => {
  test("returns the triage metadata", async () => {
    const calls = mockFetch(() => json(PULL_PAYLOAD));

    const detail = await adapter().getPR(PR);

    expect(calls[0]?.url).toContain("/repos/acme/api/pulls/42");
    expect(calls[0]?.headers.Authorization).toBe("Bearer test-token-123");
    expect(detail.number).toBe(42);
    expect(detail.title).toBe("feat: add thing");
    expect(detail.author).toBe("octocat");
    expect(detail.headSha).toBe("abc123");
    expect(detail.additions).toBe(100);
    expect(detail.deletions).toBe(20);
    expect(detail.changedFiles).toBe(3);
    expect(detail.mergeable).toBe(true);
    expect(detail.draft).toBe(false);
    expect(detail.requestedReviewers).toEqual(["pszf11235"]);
    expect(detail.assignees).toEqual(["octocat"]);
  });

  test("a null mergeable stays null, because GitHub is still computing it", async () => {
    mockFetch(() => json({ ...PULL_PAYLOAD, mergeable: null }));

    expect((await adapter().getPR(PR)).mergeable).toBeNull();
  });

  test("a missing author reads as unknown, and a null body as empty", async () => {
    mockFetch(() => json({ ...PULL_PAYLOAD, user: null, body: null }));

    const detail = await adapter().getPR(PR);

    expect(detail.author).toBe("unknown");
    expect(detail.body).toBe("");
  });

  test("a malformed owner cannot retarget the call at another endpoint", async () => {
    const calls = mockFetch(() => json(PULL_PAYLOAD));

    await adapter().getPR({ owner: "../../user", repo: "api", number: 42 });

    expect(calls[0]?.url).toBe(
      "https://api.github.com/repos/..%2F..%2Fuser/api/pulls/42"
    );
  });

  test("throws on API error", async () => {
    mockFetch(() => new Response("Not Found", { status: 404 }));

    await expect(adapter().getPR({ ...PR, number: 999 })).rejects.toThrow("GitHub API 404");
  });

  test("propagates a network failure", async () => {
    globalThis.fetch = mock(async () => {
      throw new Error("AbortError: signal timed out");
    }) as unknown as typeof globalThis.fetch;

    await expect(adapter().getPR(PR)).rejects.toThrow();
  });
});

describe("getDiff", () => {
  test("asks for the raw diff media type", async () => {
    const calls = mockFetch(() => new Response("diff --git a/file.ts b/file.ts\n+new line"));

    const diff = await adapter().getDiff(PR);

    expect(calls[0]?.headers.Accept).toBe("application/vnd.github.v3.diff");
    expect(calls[0]?.url).toContain("/repos/acme/api/pulls/42");
    expect(diff).toContain("+new line");
  });
});

// ─── Check runs ─────────────────────────────────────────────────────────────

describe("getCheckStatus", () => {
  const run = (over: Record<string, unknown> = {}) => ({
    name: "build",
    status: "completed",
    conclusion: "success",
    ...over,
  });

  test("reads the Checks API for the head SHA", async () => {
    const calls = mockFetch(() => json({ total_count: 1, check_runs: [run()] }));

    const status = await adapter().getCheckStatus(PR, "abc123");

    expect(calls[0]?.url).toContain("/repos/acme/api/commits/abc123/check-runs");
    expect(status.state).toBe("success");
    expect(status.runs).toEqual([{ name: "build", status: "completed", conclusion: "success" }]);
  });

  test("a PR with no check runs is 'none', not a failure", async () => {
    // A repo reporting CI through the legacy commit Status API registers no
    // check runs at all. Rendering that as a failure would make the triage
    // inbox lie about every PR in it.
    mockFetch(() => json({ total_count: 0, check_runs: [] }));

    const status = await adapter().getCheckStatus(PR, "abc123");

    expect(status.state).toBe("none");
    expect(status.state).not.toBe("failure");
    expect(status.runs).toEqual([]);
  });

  test("a missing check_runs key is also 'none'", async () => {
    mockFetch(() => json({ total_count: 0 }));

    expect((await adapter().getCheckStatus(PR, "abc123")).state).toBe("none");
  });

  test("an unfinished run is pending", async () => {
    mockFetch(() =>
      json({ check_runs: [run(), run({ status: "in_progress", conclusion: null })] })
    );

    expect((await adapter().getCheckStatus(PR, "abc123")).state).toBe("pending");
  });

  test("one failure outranks the runs still going", async () => {
    mockFetch(() =>
      json({
        check_runs: [run({ conclusion: "failure" }), run({ status: "queued", conclusion: null })],
      })
    );

    expect((await adapter().getCheckStatus(PR, "abc123")).state).toBe("failure");
  });

  test("neutral and skipped do not fail the rollup", async () => {
    mockFetch(() =>
      json({ check_runs: [run({ conclusion: "neutral" }), run({ conclusion: "skipped" })] })
    );

    expect((await adapter().getCheckStatus(PR, "abc123")).state).toBe("success");
  });

  test("cancelled and timed out are failures", async () => {
    mockFetch(() =>
      json({ check_runs: [run({ conclusion: "cancelled" }), run({ conclusion: "timed_out" })] })
    );

    expect((await adapter().getCheckStatus(PR, "abc123")).state).toBe("failure");
  });

  test("follows Link pagination, so a failure on a later page still counts", async () => {
    const page2 =
      "https://api.github.com/repos/acme/api/commits/abc123/check-runs?per_page=100&page=2";
    mockFetch((req) =>
      req.url === page2
        ? json({ check_runs: [run({ name: "e2e", conclusion: "failure" })] })
        : json({ check_runs: [run()] }, { headers: { Link: `<${page2}>; rel="next"` } })
    );

    const status = await adapter().getCheckStatus(PR, "abc123");

    expect(status.runs).toHaveLength(2);
    expect(status.state).toBe("failure");
  });

  test("a conclusion GitHub added later reads as a failure, not a pass", async () => {
    mockFetch(() => json({ check_runs: [run({ conclusion: "startup_failure" })] }));

    const status = await adapter().getCheckStatus(PR, "abc123");

    expect(status.state).toBe("failure");
    expect(status.runs[0]?.conclusion).toBe("failure");
  });
});

// ─── Draft reviews ──────────────────────────────────────────────────────────

const DRAFT = {
  body: "2 findings",
  comments: [{ path: "src/limiter.ts", line: 118, body: "off by one" }],
};

describe("createDraftReview", () => {
  test("posts body and comments and nothing else", async () => {
    const calls = mockFetch(() => json({ id: 987654, state: "PENDING" }));

    const created = await adapter().createDraftReview(PR, DRAFT);

    expect(created).toEqual({ id: 987654 });
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.url).toBe("https://api.github.com/repos/acme/api/pulls/42/reviews");
    expect(Object.keys(calls[0]?.body as object).sort()).toEqual(["body", "comments"]);
  });

  test("throws when GitHub answers with anything but PENDING", async () => {
    // A non-PENDING answer means the comments are already public on the PR.
    mockFetch(() => json({ id: 987654, state: "COMMENTED" }));

    await expect(adapter().createDraftReview(PR, DRAFT)).rejects.toThrow(/PENDING/);
  });

  test("throws when the state is missing entirely", async () => {
    mockFetch(() => json({ id: 987654 }));

    await expect(adapter().createDraftReview(PR, DRAFT)).rejects.toThrow(/PENDING/);
  });

  test("throws when GitHub returns no id", async () => {
    mockFetch(() => json({ state: "PENDING" }));

    await expect(adapter().createDraftReview(PR, DRAFT)).rejects.toThrow(/no id/);
  });

  test("refuses an empty comment list before making any request", async () => {
    const calls = mockFetch(() => json({ id: 1, state: "PENDING" }));

    await expect(
      adapter().createDraftReview(PR, { body: "nothing to say", comments: [] })
    ).rejects.toThrow(/no comments/);
    expect(calls).toHaveLength(0);
  });
});

describe("deleteDraftReview", () => {
  test("deletes by review id", async () => {
    const calls = mockFetch(() => json({}));

    await adapter().deleteDraftReview(PR, 987654);

    expect(calls[0]?.method).toBe("DELETE");
    expect(calls[0]?.url).toContain("/repos/acme/api/pulls/42/reviews/987654");
  });

  test("tolerates a 404, because a draft already gone is the wanted state", async () => {
    mockFetch(() => new Response("Not Found", { status: 404 }));

    await expect(adapter().deleteDraftReview(PR, 987654)).resolves.toBeUndefined();
  });

  test("still throws on a real failure", async () => {
    mockFetch(() => new Response("boom", { status: 500 }));

    await expect(adapter().deleteDraftReview(PR, 987654)).rejects.toThrow("GitHub API 500");
  });
});

describe("getReview", () => {
  test("reports a pending draft", async () => {
    const calls = mockFetch(() => json({ id: 987654, state: "PENDING" }));

    expect(await adapter().getReview(PR, 987654)).toBe("pending");
    expect(calls[0]?.url).toContain("/repos/acme/api/pulls/42/reviews/987654");
  });

  test("reports a review submitted in GitHub's UI", async () => {
    mockFetch(() => json({ id: 987654, state: "COMMENTED" }));

    expect(await adapter().getReview(PR, 987654)).toBe("submitted");
  });

  test("reports a deleted review as gone", async () => {
    mockFetch(() => new Response("Not Found", { status: 404 }));

    expect(await adapter().getReview(PR, 987654)).toBe("gone");
  });
});

describe("authenticatedUser", () => {
  test("returns the login and caches it", async () => {
    const calls = mockFetch(() => json({ login: "pszf11235" }));

    const github = adapter();

    expect(await github.authenticatedUser()).toBe("pszf11235");
    expect(await github.authenticatedUser()).toBe("pszf11235");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://api.github.com/user");
  });

  test("throws when the payload carries no login", async () => {
    mockFetch(() => json({}));

    await expect(adapter().authenticatedUser()).rejects.toThrow(/login/);
  });
});

// ─── The no-publish invariant ───────────────────────────────────────────────

describe("publishing", () => {
  // ADR 0001: LGTM creates draft reviews and can never publish one. The old
  // codebase guarded a single submit function with tests; v1 asserts an
  // absence instead, which is why these tests check names, request bodies,
  // and the source itself rather than one function's behaviour.

  const FORBIDDEN_NAME = /submit|publish|approve|dismiss|merge|event/i;

  test("the draft-review request body has no event key", () => {
    // `event` must be absent, not falsy. Sending event: "COMMENT" publishes
    // the review immediately and irreversibly, and there is no draft: true to
    // fall back on.
    const { body } = buildDraftReviewRequest(PR, DRAFT);

    expect("event" in body).toBe(false);
    expect(Object.keys(body)).toEqual(["body", "comments"]);
    expect(JSON.stringify(body)).not.toContain("event");
  });

  test("no exported member is named for submitting", () => {
    for (const name of Object.keys(adapterModule)) {
      expect(name).not.toMatch(FORBIDDEN_NAME);
    }
  });

  test("the adapter exposes the ForgeAdapter surface and nothing more", () => {
    const github = adapter() as unknown as Record<string, unknown>;

    expect(Object.keys(github).sort()).toEqual([
      "authenticatedUser",
      "createDraftReview",
      "deleteDraftReview",
      "getCheckStatus",
      "getDiff",
      "getPR",
      "getReview",
      "listOpenPRs",
    ]);
    expect(github.submitReview).toBeUndefined();
    expect(github.postReview).toBeUndefined();
    expect(github.postComment).toBeUndefined();
    expect(github.approve).toBeUndefined();
  });

  test("no method reaches the submit endpoint or sends an event field", async () => {
    // Behaviour, not naming: drive every method the adapter has and inspect
    // what actually went out. POST /pulls/{n}/reviews/{id}/events is the one
    // request that publishes; no path here may produce it.
    const calls = mockFetch((req) =>
      req.url.includes("check-runs")
        ? json({ check_runs: [] })
        : json({ ...PULL_PAYLOAD, id: 987654, state: "PENDING", login: "pszf11235" })
    );

    const github = adapter();
    await github.listOpenPRs(REPO).catch(() => {});
    await github.getPR(PR);
    await github.getDiff(PR);
    await github.getCheckStatus(PR, "abc123");
    await github.createDraftReview(PR, DRAFT);
    await github.getReview(PR, 987654);
    await github.deleteDraftReview(PR, 987654);
    await github.authenticatedUser();

    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      expect(call.url).not.toContain("/events");
      expect(call.body === null || typeof call.body !== "object" || !("event" in call.body)).toBe(
        true
      );
    }
  });

  test("the source carries no event field and no publishing endpoint", async () => {
    // The last line of defence: an edit that adds `event: "COMMENT"` fails
    // here even if no test ever calls it. The scan targets the field and the
    // endpoint rather than the word "submit", because getReview legitimately
    // answers "submitted".
    const source = await Bun.file(`${import.meta.dir}/adapter.ts`).text();

    expect(source).not.toMatch(/\bevent\s*:/);
    expect(source).not.toContain('"event"');
    expect(source).not.toContain("/events");
  });
});

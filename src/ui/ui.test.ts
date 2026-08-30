/**
 * Tests for the SPA's data layer (api.ts, hooks.ts) plus smoke-level
 * rendering for its two reading views and the finding card.
 *
 * api.ts and hooks.ts get real behavioral coverage: every browser global
 * they touch (fetch, localStorage, location, history, EventSource, timers)
 * is an injectable seam, stubbed here exactly as the daemon's own tests
 * stub Clock/Ticker/setTimer. The views get smoke tests only, on purpose —
 * `renderToStaticMarkup` never runs effects (bun test has no DOM at all;
 * see the "no DOM globals" note below), so a component's *initial* render
 * is all any harness here can exercise. FindingCard is the one exception:
 * it is pure and props-in, so it is tested with real content, not just a
 * loading placeholder.
 *
 * `Reviews.filterToQuery` gets a different treatment: it is the one place a
 * filter bar selection becomes a `/api/prs` query, and a wrong mapping
 * shows the user the wrong set of PRs while looking exactly like a healthy,
 * empty result. That is tested against the real client (`listPRs`) and a
 * stub `fetch`, asserting the literal request path for every status and
 * completed-toggle combination, not against a hand-written fixture.
 */
import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import {
  ApiError,
  createApiClient,
  emptyFindingCounts,
  githubLineUrl,
  resolveToken,
  totalFindings,
  type FetchLike,
  type HistoryLike,
  type LocationLike,
  type StorageLike,
} from "./api";
import {
  createEventStream,
  createTicker,
  type ConnectionStatus,
  type EventSourceLike,
  type InvalidationHint,
} from "./hooks";
import { FindingCard, type FindingCardProps } from "./components/FindingCard";
import {
  CLOSED_FILTERS,
  DEFAULT_ROUND_TIMEOUT_MS,
  elapsedMs,
  filterToQuery,
  formatDuration,
  quotaReason,
  reviewProgressFor,
  Reviews,
  shortSha,
  STATUS_FILTERS,
  timeoutUrgency,
  type ClosedFilter,
  type StatusFilter,
} from "./views/Reviews";
import type { PRListItem, StatusResponse } from "./api";
import { PRDetail, RoundSession, type RoundSessionProps } from "./views/PRDetail";

// ─── Stubs ──────────────────────────────────────────────────────────────────

function memoryStorage(): StorageLike {
  const mem = new Map<string, string>();
  return {
    getItem: (key) => mem.get(key) ?? null,
    setItem: (key, value) => void mem.set(key, value),
    removeItem: (key) => void mem.delete(key),
  };
}

function stubLocation(hash: string): LocationLike {
  return { hash, pathname: "/", search: "" };
}

function stubHistory(): HistoryLike & { calls: Array<{ url: string | URL | null | undefined }> } {
  const calls: Array<{ url: string | URL | null | undefined }> = [];
  return {
    calls,
    replaceState(_data, _unused, url) {
      calls.push({ url });
    },
  };
}

interface FetchCall {
  input: string;
  init: RequestInit | undefined;
}

function stubFetch(handler: (call: FetchCall) => Response | Promise<Response>): { fetch: FetchLike; calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  const fetch: FetchLike = async (input, init) => {
    const call = { input, init };
    calls.push(call);
    return handler(call);
  };
  return { fetch, calls };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

// ─── api.ts: resolveToken ───────────────────────────────────────────────────

describe("resolveToken", () => {
  test("reads the fragment, stores it, and strips the URL", () => {
    const storage = memoryStorage();
    const hist = stubHistory();
    const loc = stubLocation("#t=abc123");

    const token = resolveToken(loc, storage, hist);

    expect(token).toBe("abc123");
    expect(storage.getItem("lgtm.token")).toBe("abc123");
    expect(hist.calls).toEqual([{ url: "/" }]);
  });

  test("falls back to the stored token when the fragment is empty", () => {
    const storage = memoryStorage();
    storage.setItem("lgtm.token", "stored-token");
    const hist = stubHistory();

    const token = resolveToken(stubLocation(""), storage, hist);

    expect(token).toBe("stored-token");
    expect(hist.calls).toEqual([]); // nothing to strip
  });

  test("returns null with no fragment and nothing stored", () => {
    expect(resolveToken(stubLocation(""), memoryStorage(), stubHistory())).toBeNull();
  });

  test("a fresh fragment token overrides a stale stored one", () => {
    const storage = memoryStorage();
    storage.setItem("lgtm.token", "old-token");
    const token = resolveToken(stubLocation("#t=new-token"), storage, stubHistory());

    expect(token).toBe("new-token");
    expect(storage.getItem("lgtm.token")).toBe("new-token");
  });

  test("decodes a percent-encoded token", () => {
    const token = resolveToken(stubLocation("#t=ab%2Bcd"), memoryStorage(), stubHistory());
    expect(token).toBe("ab+cd");
  });
});

// ─── api.ts: createApiClient ────────────────────────────────────────────────

describe("createApiClient", () => {
  test("authState is unauthenticated with no token anywhere", () => {
    const client = createApiClient({
      fetchImpl: stubFetch(() => json({})).fetch,
      storage: memoryStorage(),
      location: stubLocation(""),
      history: stubHistory(),
    });
    expect(client.getAuthState()).toBe("unauthenticated");
    expect(client.getToken()).toBeNull();
  });

  test("a request with no token rejects without ever calling fetch", async () => {
    const { fetch, calls } = stubFetch(() => json([]));
    const client = createApiClient({
      fetchImpl: fetch,
      storage: memoryStorage(),
      location: stubLocation(""),
      history: stubHistory(),
    });

    await expect(client.listPRs()).rejects.toThrow();
    expect(calls).toHaveLength(0);
  });

  test("sends the resolved token as a Bearer header", async () => {
    const { fetch, calls } = stubFetch(() => json([]));
    const client = createApiClient({
      fetchImpl: fetch,
      storage: memoryStorage(),
      location: stubLocation("#t=my-token"),
      history: stubHistory(),
    });

    await client.listPRs();

    expect(calls).toHaveLength(1);
    const headers = new Headers(calls[0]?.init?.headers);
    expect(headers.get("Authorization")).toBe("Bearer my-token");
  });

  test("health() never sends a token, even when one is available", async () => {
    const { fetch, calls } = stubFetch(() => json({ app: "lgtm", version: "1.0.0", pid: 42 }));
    const client = createApiClient({
      fetchImpl: fetch,
      storage: memoryStorage(),
      location: stubLocation("#t=my-token"),
      history: stubHistory(),
    });

    const health = await client.health();

    expect(health).toEqual({ app: "lgtm", version: "1.0.0", pid: 42 });
    const headers = new Headers(calls[0]?.init?.headers);
    expect(headers.has("Authorization")).toBe(false);
  });

  test("a 401 flips authState and throws an unauthenticated ApiError", async () => {
    const { fetch } = stubFetch(() => new Response("nope", { status: 401 }));
    const client = createApiClient({
      fetchImpl: fetch,
      storage: memoryStorage(),
      location: stubLocation("#t=stale-token"),
      history: stubHistory(),
    });

    const seen: string[] = [];
    client.onAuthStateChange((state) => seen.push(state));

    let error: unknown;
    try {
      await client.listPRs();
    } catch (err) {
      error = err;
    }

    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).kind).toBe("unauthenticated");
    expect(client.getAuthState()).toBe("unauthenticated");
    expect(seen).toEqual(["unauthenticated"]);
  });

  test("onAuthStateChange returns an unsubscribe function", async () => {
    const { fetch } = stubFetch(() => new Response("nope", { status: 401 }));
    const client = createApiClient({
      fetchImpl: fetch,
      storage: memoryStorage(),
      location: stubLocation("#t=stale-token"),
      history: stubHistory(),
    });

    const seen: string[] = [];
    const unsubscribe = client.onAuthStateChange((state) => seen.push(state));
    unsubscribe();

    await client.listPRs().catch(() => {});
    expect(seen).toEqual([]);
  });

  test("a network failure surfaces as a network ApiError", async () => {
    const client = createApiClient({
      fetchImpl: async () => {
        throw new Error("connection refused");
      },
      storage: memoryStorage(),
      location: stubLocation("#t=tok"),
      history: stubHistory(),
    });

    let error: unknown;
    try {
      await client.status();
    } catch (err) {
      error = err;
    }

    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).kind).toBe("network");
  });

  test("a non-401 error status surfaces as an http ApiError with the status code", async () => {
    const client = createApiClient({
      fetchImpl: async () => new Response("boom", { status: 500 }),
      storage: memoryStorage(),
      location: stubLocation("#t=tok"),
      history: stubHistory(),
    });

    let error: unknown;
    try {
      await client.status();
    } catch (err) {
      error = err;
    }

    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).kind).toBe("http");
    expect((error as ApiError).status).toBe(500);
  });

  test("listPRs tolerantly coerces a sparse response into full PRListItem rows", async () => {
    const client = createApiClient({
      fetchImpl: async () =>
        json([
          { owner: "acme", repo: "api", number: 42, state: "triage", title: "Add rate limiter" },
          { owner: "acme", repo: "api", number: 43, state: "bogus-state" },
        ]),
      storage: memoryStorage(),
      location: stubLocation("#t=tok"),
      history: stubHistory(),
    });

    const prs = await client.listPRs();

    expect(prs).toHaveLength(2);
    expect(prs[0]).toMatchObject({
      owner: "acme",
      repo: "api",
      number: 42,
      state: "triage",
      title: "Add rate limiter",
      mergeable: null,
      checkStatus: null,
      classification: "none",
    });
    expect(prs[0]?.findingCounts).toEqual(emptyFindingCounts());
    // An unrecognised state string falls back to "triage" rather than throwing.
    expect(prs[1]?.state).toBe("triage");
  });

  test("listPRs sends the state filter as a query param", async () => {
    const { fetch, calls } = stubFetch(() => json([]));
    const client = createApiClient({
      fetchImpl: fetch,
      storage: memoryStorage(),
      location: stubLocation("#t=tok"),
      history: stubHistory(),
    });

    await client.listPRs({ state: ["triage", "skipped"] });

    expect(calls[0]?.input).toBe("/api/prs?state=triage%2Cskipped");
  });

  test("eventsUrl carries the token as a query param", () => {
    const client = createApiClient({
      fetchImpl: stubFetch(() => json({})).fetch,
      storage: memoryStorage(),
      location: stubLocation("#t=my-token"),
      history: stubHistory(),
    });

    expect(client.eventsUrl()).toBe("/api/events?token=my-token");
  });

  test("eventsUrl carries no token param when unauthenticated", () => {
    const client = createApiClient({
      fetchImpl: stubFetch(() => json({})).fetch,
      storage: memoryStorage(),
      location: stubLocation(""),
      history: stubHistory(),
    });

    expect(client.eventsUrl()).toBe("/api/events");
  });
});

// ─── api.ts: status(), the queue detail ─────────────────────────────────────
//
// This is the parser this task was asked to fix. It used to reduce the whole
// `queue` object to a single `queueLength` number and drop everything else,
// which is exactly what made a running review indistinguishable from a
// queued one.
// These pin the full shape down against a hand-built payload; the same shape
// coming out of the real route handler is covered in contract.test.ts.

function statusPayload(overrides: Record<string, unknown> = {}): unknown {
  return {
    uptimeMs: 1000,
    startedAt: "2026-08-30T00:00:00.000Z",
    scheduler: { intervalMinutes: 15 },
    queue: {
      queued: 1,
      inFlight: 2,
      pausedByGate: false,
      queuedEntries: [{ key: "acme/api#9", headSha: "sha-queued", queuedAt: "2026-08-30T00:01:00.000Z" }],
      inFlightRounds: [{ key: "acme/api#7", headSha: "sha-flight", startedAt: "2026-08-30T00:00:30.000Z" }],
    },
    quota: { mode: "throttled", maxPercent: 82 },
    counts: {},
    ...overrides,
  };
}

async function statusOf(payload: unknown) {
  const client = createApiClient({
    fetchImpl: async () => json(payload),
    storage: memoryStorage(),
    location: stubLocation("#t=tok"),
    history: stubHistory(),
  });
  return client.status();
}

describe("createApiClient: status(), the queue detail", () => {
  test("carries the in-flight rounds through, keyed and timed", async () => {
    const status = await statusOf(statusPayload());

    expect(status.queue.inFlightRounds).toEqual([
      { key: "acme/api#7", headSha: "sha-flight", startedAt: "2026-08-30T00:00:30.000Z" },
    ]);
  });

  test("carries the queued entries through, in the daemon's own FIFO order", async () => {
    const status = await statusOf(statusPayload());

    expect(status.queue.queuedEntries).toEqual([
      { key: "acme/api#9", headSha: "sha-queued", queuedAt: "2026-08-30T00:01:00.000Z" },
    ]);
  });

  test("pausedByGate arrives as an explicit boolean, not inferred from an empty queue", async () => {
    const status = await statusOf(
      statusPayload({
        queue: { queued: 1, inFlight: 0, pausedByGate: true, queuedEntries: [], inFlightRounds: [] },
      }),
    );
    expect(status.queue.pausedByGate).toBe(true);
  });

  test("the quota mode and percentage both survive, to explain a paused queue", async () => {
    const status = await statusOf(statusPayload());
    expect(status.quotaMode).toBe("throttled");
    expect(status.quotaPercent).toBe(82);
  });

  test("quotaPercent is null before any usage reading exists, not coerced to zero", async () => {
    const status = await statusOf(statusPayload({ quota: { mode: "ok", maxPercent: null } }));
    expect(status.quotaPercent).toBeNull();
  });

  test("the flat queueLength convenience field still works, for views that only read that", async () => {
    const status = await statusOf(statusPayload());
    expect(status.queueLength).toBe(3); // 1 queued + 2 in flight
  });

  test("a status with no queue at all degrades to an empty, fully-shaped queue rather than throwing", async () => {
    const status = await statusOf(statusPayload({ queue: null }));
    expect(status.queue).toEqual({ queued: 0, inFlight: 0, pausedByGate: false, queuedEntries: [], inFlightRounds: [] });
    expect(status.queueLength).toBe(0);
  });

  test("a queue entry missing a field degrades that field, not the whole row", async () => {
    const status = await statusOf(
      statusPayload({
        queue: {
          queued: 0,
          inFlight: 1,
          pausedByGate: false,
          queuedEntries: [],
          inFlightRounds: [{ key: "acme/api#7" /* headSha, startedAt absent */ }],
        },
      }),
    );
    expect(status.queue.inFlightRounds).toEqual([{ key: "acme/api#7", headSha: "", startedAt: "" }]);
  });
});

// ─── api.ts: getFindings' round parser ──────────────────────────────────────
//
// The daemon nests findings under `rounds[].findings[]`, not under a flat
// `findings` key (see the contract tests in src/api/contract.test.ts for the
// real route handler feeding the real parser). These stub the same shape by
// hand to pin down the parser's own leniency: a round missing the session
// fields entirely, not just carrying them as null, must still parse into a
// PRDetail that renders.

describe("createApiClient: getFindings, round parsing", () => {
  test("reads a round's session fields and the server's own resumeCommand", async () => {
    const client = createApiClient({
      fetchImpl: async () =>
        json({
          ref: { owner: "acme", repo: "api", number: 42 },
          pr: { title: "Add a rate limiter", author: "ada", headSha: "sha1" },
          rounds: [
            {
              round: 1,
              agent: "reviewer",
              provider: "claude-cli",
              status: "ok",
              headSha: "sha1",
              startedAt: "2026-08-30T00:00:00.000Z",
              durationMs: 1000,
              hasSnapshot: true,
              sessionId: "sess-1",
              sessionCwd: "/Users/ada/api",
              costUsd: 0.42,
              turns: 7,
              resumeCommand: "cd /Users/ada/api && claude --resume sess-1",
              findings: [
                {
                  key: "r1:reviewer:f1",
                  round: 1,
                  agent: "reviewer",
                  headSha: "sha1",
                  severity: "high",
                  file: "a.ts",
                  line: 3,
                  comment: "one",
                  state: "open",
                },
              ],
            },
          ],
        }),
      storage: memoryStorage(),
      location: stubLocation("#t=tok"),
      history: stubHistory(),
    });

    const res = await client.getFindings({ owner: "acme", repo: "api", number: 42 });

    expect(res.rounds).toHaveLength(1);
    expect(res.rounds[0]).toMatchObject({
      round: 1,
      agent: "reviewer",
      sessionId: "sess-1",
      sessionCwd: "/Users/ada/api",
      costUsd: 0.42,
      turns: 7,
      resumeCommand: "cd /Users/ada/api && claude --resume sess-1",
    });
    expect(res.findings).toHaveLength(1);
  });

  test("a round with none of the five fields at all still parses, as nulls, not as a throw", async () => {
    const client = createApiClient({
      fetchImpl: async () =>
        json({
          ref: { owner: "acme", repo: "api", number: 7 },
          pr: { author: "ada", headSha: "sha1" },
          rounds: [
            {
              round: 1,
              agent: "reviewer",
              provider: "claude-cli",
              status: "ok",
              headSha: "sha1",
              startedAt: "2026-08-30T00:00:00.000Z",
              durationMs: 1000,
              hasSnapshot: false,
              findings: [],
              // sessionId, sessionCwd, costUsd, turns, resumeCommand: absent
              // entirely, as every round file written before they existed.
            },
          ],
        }),
      storage: memoryStorage(),
      location: stubLocation("#t=tok"),
      history: stubHistory(),
    });

    const res = await client.getFindings({ owner: "acme", repo: "api", number: 7 });

    expect(res.rounds).toHaveLength(1);
    expect(res.rounds[0]).toMatchObject({
      round: 1,
      agent: "reviewer",
      sessionId: null,
      sessionCwd: null,
      costUsd: null,
      turns: null,
      resumeCommand: null,
    });
  });
});

// ─── api.ts: small pure helpers ─────────────────────────────────────────────

describe("githubLineUrl", () => {
  test("builds a blob permalink at the reviewed SHA", () => {
    expect(githubLineUrl("acme", "api", "abc123", "src/limiter.ts", 118)).toBe(
      "https://github.com/acme/api/blob/abc123/src/limiter.ts#L118",
    );
  });
});

describe("totalFindings", () => {
  test("sums every severity", () => {
    expect(totalFindings({ critical: 1, high: 2, medium: 0, low: 3 })).toBe(6);
  });

  test("is zero for an empty count", () => {
    expect(totalFindings(emptyFindingCounts())).toBe(0);
  });
});

// ─── Reviews: filterToQuery ─────────────────────────────────────────────────
//
// A wrong mapping here shows the user the wrong set of PRs and reads as
// data loss, not as a filter doing its job — so every status is asserted
// against every completed-toggle position, run through the real
// `listPRs` and a stub `fetch`, against the literal request path.

async function requestedPath(status: StatusFilter, closed: ClosedFilter): Promise<string> {
  const { fetch, calls } = stubFetch(() => json([]));
  const client = createApiClient({
    fetchImpl: fetch,
    storage: memoryStorage(),
    location: stubLocation("#t=tok"),
    history: stubHistory(),
  });

  await client.listPRs(filterToQuery(status, closed));

  const call = calls[0];
  if (!call) throw new Error("listPRs made no request");
  return call.input;
}

describe("Reviews.filterToQuery", () => {
  test("every status a PR can be in has a filter option", () => {
    expect(STATUS_FILTERS.map((f) => f.id)).toEqual([
      "all",
      "triage",
      "in-review",
      "ready-to-gate",
      "reviewed",
      "failed",
      "skipped",
    ]);
  });

  test("the completed toggle has exactly the server's three positions", () => {
    expect(CLOSED_FILTERS.map((f) => f.id)).toEqual(["exclude", "include", "only"]);
  });

  const EXPECTED: Record<StatusFilter, Record<ClosedFilter, string>> = {
    all: {
      exclude: "/api/prs?closed=exclude",
      include: "/api/prs?closed=include",
      only: "/api/prs?closed=only",
    },
    triage: {
      exclude: "/api/prs?state=triage&closed=exclude",
      include: "/api/prs?state=triage&closed=include",
      only: "/api/prs?state=triage&closed=only",
    },
    "in-review": {
      exclude: "/api/prs?state=queued%2Creviewing&closed=exclude",
      include: "/api/prs?state=queued%2Creviewing&closed=include",
      only: "/api/prs?state=queued%2Creviewing&closed=only",
    },
    "ready-to-gate": {
      exclude: "/api/prs?closed=exclude&withFindings=true",
      include: "/api/prs?closed=include&withFindings=true",
      only: "/api/prs?closed=only&withFindings=true",
    },
    reviewed: {
      exclude: "/api/prs?state=reviewed&closed=exclude",
      include: "/api/prs?state=reviewed&closed=include",
      only: "/api/prs?state=reviewed&closed=only",
    },
    failed: {
      exclude: "/api/prs?state=failed&closed=exclude",
      include: "/api/prs?state=failed&closed=include",
      only: "/api/prs?state=failed&closed=only",
    },
    skipped: {
      exclude: "/api/prs?state=skipped&closed=exclude",
      include: "/api/prs?state=skipped&closed=include",
      only: "/api/prs?state=skipped&closed=only",
    },
  };

  for (const status of STATUS_FILTERS.map((f) => f.id)) {
    for (const closed of CLOSED_FILTERS.map((f) => f.id)) {
      const expected = EXPECTED[status][closed];
      const isDefault = status === "all" && closed === "exclude";

      test(`${status} + ${closed}${isDefault ? " (the view's default)" : ""} requests exactly ${expected}`, async () => {
        expect(await requestedPath(status, closed)).toBe(expected);
      });
    }
  }

  test("ready-to-gate never sends a state param — it is not one state, it cuts across every state", () => {
    const filter = filterToQuery("ready-to-gate", "exclude");
    expect(filter.state).toBeUndefined();
    expect(filter.withFindings).toBe(true);
  });

  test("in-review means queued or reviewing, not failed — failed is its own filter", () => {
    const filter = filterToQuery("in-review", "exclude");
    expect(filter.state).toEqual(["queued", "reviewing"]);
  });
});

// ─── Reviews: live review progress ──────────────────────────────────────────
//
// `reviewProgressFor` is the one place a PR row is matched to the status
// payload's queue detail. That is the whole point of this task, and the one
// most likely to silently show the wrong PR's progress on the wrong row if
// the matching key is ever built two different ways. Every test below
// matches by `key`, never by array position or headSha, on purpose.

function basePR(overrides: Partial<PRListItem> = {}): PRListItem {
  return {
    key: "acme/api#7",
    owner: "acme",
    repo: "api",
    number: 7,
    url: "https://github.com/acme/api/pull/7",
    title: "Add a rate limiter",
    author: "ada",
    state: "reviewing",
    classification: "own",
    draft: false,
    headSha: "deadbeef",
    createdAt: null,
    closedAt: null,
    pendingReviewId: null,
    failedAttempts: 0,
    additions: null,
    deletions: null,
    changedFiles: null,
    mergeable: null,
    checkStatus: null,
    findingCounts: emptyFindingCounts(),
    ...overrides,
  };
}

function baseStatus(overrides: Partial<StatusResponse> = {}): StatusResponse {
  return {
    uptimeMs: 0,
    startedAt: null,
    intervalMinutes: 15,
    lastCycle: null,
    nextPollAt: null,
    queueLength: 0,
    queue: { queued: 0, inFlight: 0, pausedByGate: false, queuedEntries: [], inFlightRounds: [] },
    triageCount: 0,
    awaitingGate: 0,
    quotaMode: "ok",
    quotaPercent: null,
    claudePath: null,
    ghPath: null,
    ...overrides,
  };
}

describe("shortSha", () => {
  test("takes the first 7 characters, GitHub's own short-ref length", () => {
    expect(shortSha("deadbeef1234567")).toBe("deadbee");
  });

  test("an empty SHA renders as a dash, not as an empty string", () => {
    expect(shortSha("")).toBe("—");
  });
});

describe("elapsedMs", () => {
  test("the difference between now and startedAt", () => {
    expect(elapsedMs("2026-08-30T00:00:00.000Z", new Date("2026-08-30T00:02:00.000Z").getTime())).toBe(120_000);
  });

  test("a malformed timestamp reads as zero elapsed, not NaN or a thrown error", () => {
    expect(elapsedMs("not a date", 1_000_000)).toBe(0);
  });

  test("clock skew that puts startedAt after now clamps to zero, never negative", () => {
    expect(elapsedMs("2026-08-30T00:05:00.000Z", new Date("2026-08-30T00:00:00.000Z").getTime())).toBe(0);
  });
});

describe("formatDuration", () => {
  test("under a minute prints seconds only", () => {
    expect(formatDuration(45_000)).toBe("45s");
  });

  test("a minute or more prints minutes and seconds", () => {
    expect(formatDuration(134_000)).toBe("2m 14s");
  });

  test("exactly the default timeout", () => {
    expect(formatDuration(DEFAULT_ROUND_TIMEOUT_MS)).toBe("10m 0s");
  });
});

describe("timeoutUrgency", () => {
  test("well under the timeout is normal", () => {
    expect(timeoutUrgency(60_000, 600_000)).toBe("normal");
  });

  test("80% of the timeout is where near starts", () => {
    expect(timeoutUrgency(480_000, 600_000)).toBe("near");
    expect(timeoutUrgency(479_000, 600_000)).toBe("normal");
  });

  test("at or past the timeout is over", () => {
    expect(timeoutUrgency(600_000, 600_000)).toBe("over");
    expect(timeoutUrgency(700_000, 600_000)).toBe("over");
  });
});

describe("quotaReason", () => {
  test("throttled with a reading names the percentage", () => {
    expect(quotaReason("throttled", 82)).toBe("throttled at 82%");
  });

  test("throttled with no reading yet still says so, without inventing a number", () => {
    expect(quotaReason("throttled", null)).toBe("throttled");
  });

  test("fallback explains itself as the daily-cap gate, not as a generic pause", () => {
    expect(quotaReason("fallback", null)).toBe("usage unreadable, gating on the daily cap");
  });
});

describe("reviewProgressFor", () => {
  const now = new Date("2026-08-30T00:10:00.000Z").getTime();

  test("a reviewing PR matched by key reports elapsed time against the timeout", () => {
    const status = baseStatus({
      queue: {
        queued: 0,
        inFlight: 1,
        pausedByGate: false,
        queuedEntries: [],
        inFlightRounds: [{ key: "acme/api#7", headSha: "sha-current", startedAt: "2026-08-30T00:08:00.000Z" }],
      },
    });

    const progress = reviewProgressFor(basePR({ state: "reviewing" }), status, now);

    expect(progress).toEqual({
      kind: "reviewing",
      headSha: "sha-current",
      elapsedMs: 120_000,
      timeoutMs: DEFAULT_ROUND_TIMEOUT_MS,
      urgency: "normal",
    });
  });

  test("matches by key, not by array position or by headSha, since either would show the wrong PR's progress", () => {
    const status = baseStatus({
      queue: {
        queued: 0,
        inFlight: 2,
        pausedByGate: false,
        queuedEntries: [],
        inFlightRounds: [
          { key: "acme/other#1", headSha: "deadbeef", startedAt: "2026-08-30T00:09:59.000Z" }, // same headSha as the PR below, wrong PR
          { key: "acme/api#7", headSha: "sha-mine", startedAt: "2026-08-30T00:07:00.000Z" },
        ],
      },
    });

    const progress = reviewProgressFor(basePR({ state: "reviewing", headSha: "deadbeef" }), status, now);

    expect(progress).toMatchObject({ kind: "reviewing", headSha: "sha-mine", elapsedMs: 180_000 });
  });

  test("a reviewing PR with no matching in-flight round is unmatched, not a guess", () => {
    const status = baseStatus();
    expect(reviewProgressFor(basePR({ state: "reviewing" }), status, now)).toEqual({ kind: "unmatched" });
  });

  test("a queued PR reports its 1-based position and the queue's total", () => {
    const status = baseStatus({
      queue: {
        queued: 3,
        inFlight: 0,
        pausedByGate: false,
        queuedEntries: [
          { key: "acme/api#1", headSha: "s1", queuedAt: "2026-08-30T00:00:00.000Z" },
          { key: "acme/api#7", headSha: "s7", queuedAt: "2026-08-30T00:01:00.000Z" },
          { key: "acme/api#9", headSha: "s9", queuedAt: "2026-08-30T00:02:00.000Z" },
        ],
        inFlightRounds: [],
      },
    });

    const progress = reviewProgressFor(basePR({ state: "queued" }), status, now);

    expect(progress).toEqual({ kind: "queued", headSha: "s7", position: 2, total: 3 });
  });

  test("pausedByGate turns every queued row into a gate explanation, with the quota mode and percent carried along", () => {
    const status = baseStatus({
      quotaMode: "throttled",
      quotaPercent: 91,
      queue: {
        queued: 1,
        inFlight: 0,
        pausedByGate: true,
        queuedEntries: [{ key: "acme/api#7", headSha: "s7", queuedAt: "2026-08-30T00:01:00.000Z" }],
        inFlightRounds: [],
      },
    });

    const progress = reviewProgressFor(basePR({ state: "queued" }), status, now);

    expect(progress).toEqual({
      kind: "paused",
      headSha: "s7",
      position: 1,
      total: 1,
      quotaMode: "throttled",
      quotaPercent: 91,
    });
  });

  test("a queued PR with no matching entry is unmatched", () => {
    expect(reviewProgressFor(basePR({ state: "queued" }), baseStatus(), now)).toEqual({ kind: "unmatched" });
  });

  test("a PR that is neither queued nor reviewing is always unmatched, whatever the queue holds", () => {
    const status = baseStatus({
      queue: {
        queued: 0,
        inFlight: 1,
        pausedByGate: false,
        queuedEntries: [],
        inFlightRounds: [{ key: "acme/api#7", headSha: "s7", startedAt: "2026-08-30T00:00:00.000Z" }],
      },
    });

    expect(reviewProgressFor(basePR({ state: "failed" }), status, now)).toEqual({ kind: "unmatched" });
  });
});

// ─── hooks.ts: createEventStream ────────────────────────────────────────────

/** A minimal EventTarget-shaped stub: enough surface for createEventStream, nothing else. */
class StubEventSource implements EventSourceLike {
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  readonly listeners = new Map<string, Array<(ev: { data: string }) => void>>();
  closed = false;

  constructor(readonly url: string) {}

  addEventListener(type: string, listener: (ev: { data: string }) => void): void {
    const list = this.listeners.get(type) ?? [];
    list.push(listener);
    this.listeners.set(type, list);
  }

  close(): void {
    this.closed = true;
  }

  emit(type: string, data: string): void {
    for (const listener of this.listeners.get(type) ?? []) listener({ data });
  }
}

function fakeTimers() {
  const scheduled: Array<{ fn: () => void; ms: number; cancelled: boolean }> = [];
  return {
    scheduled,
    setTimer(fn: () => void, ms: number): () => void {
      const entry = { fn, ms, cancelled: false };
      scheduled.push(entry);
      return () => {
        entry.cancelled = true;
      };
    },
    /** Runs the most recently scheduled, non-cancelled timer, as if it fired. */
    fireLatest(): void {
      const entry = [...scheduled].reverse().find((e) => !e.cancelled);
      entry?.fn();
    },
  };
}

describe("createEventStream", () => {
  test("connects to the given URL and listens for every daemon event plus a generic fallback", () => {
    let created: StubEventSource | null = null;
    createEventStream({
      url: "/api/events?token=abc",
      createEventSource: (url) => (created = new StubEventSource(url)),
      onInvalidate: () => {},
    });

    expect(created).not.toBeNull();
    expect(created!.url).toBe("/api/events?token=abc");
    for (const type of ["cycle-finished", "pr-changed", "findings-ready", "quota-changed", "error"]) {
      expect(created!.listeners.has(type)).toBe(true);
    }
    expect(created!.onmessage).not.toBeNull();
  });

  test("onopen reports status open", () => {
    let source: StubEventSource | null = null;
    const statuses: ConnectionStatus[] = [];
    createEventStream({
      url: "/x",
      createEventSource: (url) => (source = new StubEventSource(url)),
      onInvalidate: () => {},
      onStatusChange: (s) => statuses.push(s),
    });

    source!.onopen?.();

    expect(statuses).toEqual(["open"]);
  });

  test("a named event with valid JSON invalidates with the parsed DaemonEvent", () => {
    let source: StubEventSource | null = null;
    const hints: InvalidationHint[] = [];
    createEventStream({
      url: "/x",
      createEventSource: (url) => (source = new StubEventSource(url)),
      onInvalidate: (hint) => hints.push(hint),
    });

    source!.emit("pr-changed", JSON.stringify({ type: "pr-changed", ref: { owner: "a", repo: "b", number: 1 } }));

    expect(hints).toEqual([{ type: "pr-changed", ref: { owner: "a", repo: "b", number: 1 } }]);
  });

  test("unparseable event data still invalidates, as type unknown", () => {
    let source: StubEventSource | null = null;
    const hints: InvalidationHint[] = [];
    createEventStream({
      url: "/x",
      createEventSource: (url) => (source = new StubEventSource(url)),
      onInvalidate: (hint) => hints.push(hint),
    });

    source!.emit("pr-changed", "not json at all");

    expect(hints).toEqual([{ type: "unknown" }]);
  });

  test("a generic message with an unrecognised type still invalidates", () => {
    let source: StubEventSource | null = null;
    const hints: InvalidationHint[] = [];
    createEventStream({
      url: "/x",
      createEventSource: (url) => (source = new StubEventSource(url)),
      onInvalidate: (hint) => hints.push(hint),
    });

    source!.onmessage?.({ data: JSON.stringify({ type: "some-future-event" }) });

    expect(hints).toEqual([{ type: "unknown" }]);
  });

  test("onerror closes the source and schedules a reconnect with the initial backoff", () => {
    let source: StubEventSource | null = null;
    const statuses: ConnectionStatus[] = [];
    const timers = fakeTimers();

    createEventStream({
      url: "/x",
      createEventSource: (url) => (source = new StubEventSource(url)),
      onInvalidate: () => {},
      onStatusChange: (s) => statuses.push(s),
      backoff: { initialMs: 1000, maxMs: 30_000, factor: 2 },
      setTimer: timers.setTimer,
      random: () => 0, // zero jitter, so the scheduled delay is exactly initialMs
    });

    source!.onerror?.();

    expect(source!.closed).toBe(true);
    expect(statuses).toEqual(["reconnecting"]);
    expect(timers.scheduled).toHaveLength(1);
    expect(timers.scheduled[0]?.ms).toBe(1000);
  });

  test("backoff grows exponentially across consecutive failures, capped at maxMs", () => {
    const timers = fakeTimers();
    const factories: StubEventSource[] = [];

    createEventStream({
      url: "/x",
      createEventSource: (url) => {
        const es = new StubEventSource(url);
        factories.push(es);
        return es;
      },
      onInvalidate: () => {},
      backoff: { initialMs: 1000, maxMs: 5000, factor: 2 },
      setTimer: timers.setTimer,
      random: () => 0,
    });

    factories[0]?.onerror?.(); // 1000ms
    timers.fireLatest(); // opens a second source
    factories[1]?.onerror?.(); // 2000ms
    timers.fireLatest(); // opens a third source
    factories[2]?.onerror?.(); // 4000ms, still under the 5000ms cap
    timers.fireLatest();
    factories[3]?.onerror?.(); // would be 8000ms, capped to 5000ms

    expect(timers.scheduled.map((t) => t.ms)).toEqual([1000, 2000, 4000, 5000]);
  });

  test("a successful open resets the backoff attempt counter", () => {
    const timers = fakeTimers();
    const factories: StubEventSource[] = [];

    createEventStream({
      url: "/x",
      createEventSource: (url) => {
        const es = new StubEventSource(url);
        factories.push(es);
        return es;
      },
      onInvalidate: () => {},
      backoff: { initialMs: 1000, maxMs: 30_000, factor: 2 },
      setTimer: timers.setTimer,
      random: () => 0,
    });

    factories[0]?.onerror?.(); // attempt -> 1, schedules 1000ms
    timers.fireLatest(); // opens factories[1]
    factories[1]?.onopen?.(); // resets attempt to 0
    factories[1]?.onerror?.(); // should schedule the *initial* delay again, not 2000ms

    expect(timers.scheduled.map((t) => t.ms)).toEqual([1000, 1000]);
  });

  test("stop() cancels a pending reconnect and closes the live source", () => {
    const timers = fakeTimers();
    let source: StubEventSource | null = null;
    const statuses: ConnectionStatus[] = [];

    const handle = createEventStream({
      url: "/x",
      createEventSource: (url) => (source = new StubEventSource(url)),
      onInvalidate: () => {},
      onStatusChange: (s) => statuses.push(s),
      setTimer: timers.setTimer,
      random: () => 0,
    });

    source!.onerror?.(); // schedules a reconnect
    handle.stop();

    expect(timers.scheduled[0]?.cancelled).toBe(true);
    expect(source!.closed).toBe(true);
    expect(handle.status()).toBe("closed");
    expect(statuses.at(-1)).toBe("closed");
  });

  test("with no EventSource available anywhere, it degrades to closed instead of throwing", () => {
    const statuses: ConnectionStatus[] = [];
    expect(() =>
      createEventStream({
        url: "/x",
        onInvalidate: () => {},
        onStatusChange: (s) => statuses.push(s),
        // No createEventSource override, and bun test has no global
        // EventSource either — this is the real "unsupported environment"
        // path, not a simulation of it.
      }),
    ).not.toThrow();
    expect(statuses).toEqual(["closed"]);
  });
});

// ─── hooks.ts: createTicker ─────────────────────────────────────────────────

describe("createTicker", () => {
  test("schedules onTick with the given interval, through the injected timer", () => {
    const scheduled: Array<{ fn: () => void; ms: number }> = [];
    createTicker(
      () => {},
      1000,
      (fn, ms) => {
        scheduled.push({ fn, ms });
        return () => {};
      },
    );

    expect(scheduled).toHaveLength(1);
    expect(scheduled[0]?.ms).toBe(1000);
  });

  test("firing the injected timer calls onTick, as many times as it fires", () => {
    let fire: (() => void) | null = null;
    let ticks = 0;
    createTicker(
      () => {
        ticks += 1;
      },
      1000,
      (fn) => {
        fire = fn;
        return () => {};
      },
    );

    fire!();
    fire!();
    fire!();

    expect(ticks).toBe(3);
  });

  test("stop() calls the timer's own canceller, exactly once", () => {
    let cancelled = 0;
    const ticker = createTicker(() => {}, 500, () => () => {
      cancelled += 1;
    });

    ticker.stop();

    expect(cancelled).toBe(1);
  });
});

// ─── Views: smoke rendering ──────────────────────────────────────────────────
//
// bun test provides no DOM (no window, document, localStorage, EventSource —
// confirmed empirically, not assumed) and renderToStaticMarkup never runs
// effects, so these assert only that mounting each view produces the
// expected *initial* markup without throwing. api.ts/hooks.ts above are
// where the actual data-flow logic is covered.

describe("Reviews (smoke)", () => {
  test("renders its initial loading state without throwing", () => {
    const html = renderToStaticMarkup(createElement(Reviews));
    expect(html).toContain("Loading");
  });
});

describe("PRDetail (smoke)", () => {
  test("renders its initial loading state without throwing", () => {
    const html = renderToStaticMarkup(
      createElement(PRDetail, { prRef: { owner: "acme", repo: "api", number: 42 } }),
    );
    expect(html).toContain("Loading");
  });
});

describe("FindingCard (smoke)", () => {
  const baseFinding: FindingCardProps["finding"] = {
    key: "r2:reviewer:f1",
    round: 2,
    agent: "reviewer",
    headSha: "abc123def456",
    severity: "high",
    file: "src/limiter.ts",
    line: 118,
    comment: "This bucket refill can go negative under bursty load.",
    suggestion: "Clamp the refill to zero before comparing.",
    state: "open",
    heldReason: null,
    hunk: {
      header: "@@ -110,7 +110,9 @@",
      lines: [
        { type: "context", content: "  function refill() {", oldLine: 110, newLine: 110 },
        { type: "added", content: "    tokens += rate;", oldLine: null, newLine: 111 },
        { type: "removed", content: "    tokens = rate;", oldLine: 111, newLine: null },
      ],
    },
  };

  test("renders severity, location, comment, suggestion, hunk lines, and the GitHub deep link", () => {
    const html = renderToStaticMarkup(
      createElement(FindingCard, { owner: "acme", repo: "api", finding: baseFinding }),
    );

    expect(html).toContain("high");
    expect(html).toContain("src/limiter.ts:118");
    expect(html).toContain("This bucket refill can go negative under bursty load.");
    expect(html).toContain("Clamp the refill to zero before comparing.");
    expect(html).toContain("tokens += rate;");
    expect(html).toContain(githubLineUrl("acme", "api", "abc123def456", "src/limiter.ts", 118));
  });

  test("falls back to a note, not a crash, when the diff snapshot is missing", () => {
    const html = renderToStaticMarkup(
      createElement(FindingCard, { owner: "acme", repo: "api", finding: { ...baseFinding, hunk: null } }),
    );
    expect(html).toContain("Diff snapshot unavailable");
  });

  test("the discard action renders disabled — this task does not wire gate mutations", () => {
    const html = renderToStaticMarkup(
      createElement(FindingCard, { owner: "acme", repo: "api", finding: baseFinding }),
    );
    expect(html).toMatch(/disabled[\s\S]*Discard/);
  });
});

// ─── RoundSession (smoke) ────────────────────────────────────────────────────
//
// Rendered directly with a RoundSummary, the same way FindingCard is tested
// above: PRDetail's own hook never resolves under renderToStaticMarkup (see
// that describe block), so this is the only way to see the populated markup
// rather than just the loading state.

describe("RoundSession (smoke)", () => {
  const baseRound: RoundSessionProps["round"] = {
    round: 2,
    agent: "reviewer",
    provider: "claude-cli",
    status: "ok",
    headSha: "abc123",
    startedAt: "2026-08-30T00:00:00.000Z",
    durationMs: 45_000,
    hasSnapshot: true,
    sessionId: "sess-abc123",
    sessionCwd: "/Users/ada/repos/api",
    costUsd: 0.42,
    turns: 7,
    resumeCommand: "cd /Users/ada/repos/api && claude --resume sess-abc123",
  };

  test("renders the resume command as pasteable text, what it does, and the cost/turns as quiet metadata", () => {
    const html = renderToStaticMarkup(createElement(RoundSession, { round: baseRound }));

    // `&&` renders HTML-escaped (`&amp;&amp;`), so the two halves are checked
    // separately rather than as one literal command string.
    expect(html).toContain("cd /Users/ada/repos/api");
    expect(html).toContain("claude --resume sess-abc123");
    expect(html).toContain("Round 2");
    expect(html).toContain("reviewer");
    expect(html).toContain("Reopen the Claude session");
    expect(html).toContain("$0.42");
    expect(html).toContain("7 turns");
    expect(html).toMatch(/Copy/);
  });

  test("a round with no session id renders nothing", () => {
    const html = renderToStaticMarkup(
      createElement(RoundSession, {
        round: { ...baseRound, sessionId: null, sessionCwd: null, resumeCommand: null },
      }),
    );

    expect(html).toBe("");
  });

  test("cost and turns are each optional and never invent the other", () => {
    const html = renderToStaticMarkup(
      createElement(RoundSession, { round: { ...baseRound, costUsd: null, turns: 1 } }),
    );

    expect(html).not.toContain("$0.42");
    expect(html).toContain("1 turn");
    expect(html).not.toContain("1 turns");
  });
});

/**
 * The API's tests, in two halves.
 *
 * The first half is the route-by-route auth matrix. It walks `apiRoutes()`
 * and asserts, for every route it finds, that a missing token, a wrong token,
 * a bad Host and a bad Origin are each refused. The enumeration is the point:
 * a per-route spot check passes happily while one route quietly skips its
 * check, and nothing about that route looks wrong in review. It just works,
 * for everyone. Adding a row to the table adds it to this matrix; there is no
 * way to add a route that the matrix does not see.
 *
 * The matrix also asserts the table's own invariants (exactly one
 * unauthenticated route, `mutating` tracking the method exactly), because a
 * new route could otherwise satisfy every case above by declaring
 * `bearer: false` and being genuinely open.
 *
 * The second half is behaviour, route by route. Two of those tests exist for
 * specific bugs rather than for coverage:
 *
 *  - a closed-and-skipped PR must not leak into the inbox. Closing a skipped
 *    PR leaves `state: "skipped"` and stamps `closedAt`, so any view that
 *    hides closed PRs by `state === "closed"` shows it forever.
 *  - a finding's hunk must come from its own round's diff snapshot. Slicing
 *    round 1's finding out of round 3's diff shows whatever is at that line
 *    now, presented as the reviewer's evidence.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "fs/promises";
import os from "os";
import path from "path";

import type {
  CheckStatus,
  DraftReview,
  ForgeAdapter,
  NotModified,
  PRDetail,
  PRRef,
  PRSummary,
  RepoRef,
} from "@/core";
import { createEventBus } from "@/daemon/events";
import type { DaemonEvent, EventBus } from "@/daemon/events";
import { diffSnapshotPath, loadAllRounds, loadMeta, saveMeta, saveRound } from "@/store/reviews";
import { addToWatchList, loadWatchList } from "@/store/watch-list";

import { apiRoutes, createApiHandler, matchRoute, startApiServer, API_HOSTNAME } from "./server";
import type { ApiDeps, RouteDef } from "./server";

// ─── Fixture ────────────────────────────────────────────────────────────────

const PORT = 4747;
const TOKEN = "f".repeat(64);
const ORIGIN = `http://127.0.0.1:${PORT}`;
const HOST = `127.0.0.1:${PORT}`;

const REVIEWED: PRRef = { owner: "acme", repo: "api", number: 42 };
const TRIAGE: PRRef = { owner: "acme", repo: "api", number: 7 };
const CLOSED_SKIP: PRRef = { owner: "acme", repo: "api", number: 9 };
const UNWATCHED: PRRef = { owner: "other", repo: "tool", number: 1 };

const SHA_R1 = "a".repeat(40);
const SHA_R2 = "b".repeat(40);

/** Round 1's snapshot. Line 4 of the new file is `const d = 4;`. */
const DIFF_R1 = `diff --git a/src/limiter.ts b/src/limiter.ts
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

/** Round 2's snapshot of the same file. Line 4 is now something else entirely. */
const DIFF_R2 = `diff --git a/src/limiter.ts b/src/limiter.ts
index 3333333..4444444 100644
--- a/src/limiter.ts
+++ b/src/limiter.ts
@@ -1,6 +1,9 @@
 const a = 1;
 const b = 2;
+const ROUND_TWO = 3;
+const ROUND_TWO_ALSO = 4;
+const ROUND_TWO_AGAIN = 5;
 const f = 6;
 const g = 7;
 const h = 8;
 const i = 9;
`;

let tmp: string;
let store: string;
let originalHome: string | undefined;
let bus: EventBus;
let seen: DaemonEvent[];
let deps: ApiDeps;
let handler: (req: Request) => Promise<Response>;

/**
 * A Forge that answers from memory. Only `POST /api/watchlist` touches one,
 * and only through `addRepoWithBackfill`, so everything else throws loudly if
 * some handler ever grows a Forge call it should not have.
 */
function fakeForge(over: Partial<ForgeAdapter> = {}): ForgeAdapter {
  const summary: PRSummary = {
    number: 3,
    title: "Add a rate limiter",
    body: "",
    url: "https://github.com/newco/svc/pull/3",
    author: "pszf11235",
    draft: false,
    headSha: "c".repeat(40),
    createdAt: "2026-08-01T00:00:00Z",
    updatedAt: "2026-08-02T00:00:00Z",
    requestedReviewers: [],
    assignees: [],
  };

  const detailStats = { additions: 12, deletions: 3, changedFiles: 2, mergeable: null };
  const detail: PRDetail = { ...summary, ...detailStats };

  const unexpected = (name: string) => () => {
    throw new Error(`the API must not call forge.${name}`);
  };

  /** The PR the store already has meta for, so re-adding acme/api reconciles. */
  const known: PRSummary = {
    ...summary,
    number: REVIEWED.number,
    url: `https://github.com/${REVIEWED.owner}/${REVIEWED.repo}/pull/${REVIEWED.number}`,
    headSha: SHA_R2,
  };

  return {
    listOpenPRs: async (repo: RepoRef): Promise<PRSummary[] | NotModified> =>
      repo.owner === REVIEWED.owner && repo.repo === REVIEWED.repo ? [known] : [summary],
    getPR: async (ref: PRRef): Promise<PRDetail> =>
      ref.number === known.number ? { ...known, ...detailStats } : detail,
    getDiff: unexpected("getDiff"),
    getCheckStatus: async (): Promise<CheckStatus> => ({ state: "success", runs: [] }),
    createDraftReview: unexpected("createDraftReview") as (
      ref: PRRef,
      review: DraftReview
    ) => Promise<{ id: number }>,
    deleteDraftReview: unexpected("deleteDraftReview") as (ref: PRRef, id: number) => Promise<void>,
    getReview: unexpected("getReview") as (
      ref: PRRef,
      id: number
    ) => Promise<"pending" | "submitted" | "gone">,
    authenticatedUser: async () => "pszf11235",
    ...over,
  };
}

async function seedStore(): Promise<void> {
  // A reviewed PR with two rounds, each with its own diff snapshot.
  await saveMeta(store, REVIEWED, {
    title: "Add rate limiter",
    author: "pszf11235",
    state: "reviewed",
    classification: "own",
    headSha: SHA_R2,
    lastReviewedSha: SHA_R2,
    rounds: 2,
  });

  await saveRound(store, {
    ref: REVIEWED,
    round: 1,
    agent: "reviewer",
    provider: "claude-cli",
    status: "ok",
    headSha: SHA_R1,
    startedAt: "2026-08-20T10:00:00Z",
    durationMs: 84_210,
    findings: [
      { severity: "high", file: "src/limiter.ts", line: 4, comment: "unbounded retry", suggestion: "cap it" },
      { severity: "low", file: "src/limiter.ts", line: 999, comment: "off the snapshot" },
    ],
  });

  await saveRound(store, {
    ref: REVIEWED,
    round: 2,
    agent: "reviewer",
    provider: "claude-cli",
    status: "ok",
    headSha: SHA_R2,
    startedAt: "2026-08-21T10:00:00Z",
    durationMs: 51_000,
    findings: [{ severity: "medium", file: "src/limiter.ts", line: 4, comment: "still unbounded" }],
  });

  await fs.writeFile(diffSnapshotPath(store, REVIEWED, SHA_R1), DIFF_R1, "utf-8");
  await fs.writeFile(diffSnapshotPath(store, REVIEWED, SHA_R2), DIFF_R2, "utf-8");

  // A PR waiting on a human.
  await saveMeta(store, TRIAGE, {
    title: "Rename the thing",
    author: "someone",
    state: "triage",
    classification: "none",
    headSha: "d".repeat(40),
  });

  // Skipped, then closed. `decide` leaves the state alone and stamps only
  // closedAt, which is the shape the inbox filter has to handle.
  await saveMeta(store, CLOSED_SKIP, {
    title: "Abandoned",
    author: "someone",
    state: "skipped",
    classification: "none",
    headSha: "e".repeat(40),
    closedAt: "2026-08-25T09:00:00Z",
  });

  // Known to the store, but its repo is not on the watch list (R9.5).
  await saveMeta(store, UNWATCHED, {
    title: "From a repo we stopped watching",
    author: "someone",
    state: "reviewed",
    classification: "own",
    headSha: "0".repeat(40),
  });

  await addToWatchList(REVIEWED.owner, REVIEWED.repo, store);
}

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "lgtm-api-"));
  store = path.join(tmp, ".lgtm-farm");
  await fs.mkdir(store, { recursive: true });

  // loadConfig/updateConfig resolve the store from HOME, so point it here for
  // the two /api/config routes.
  originalHome = process.env.HOME;
  process.env.HOME = tmp;

  bus = createEventBus();
  seen = [];
  bus.on((event) => seen.push(event));

  await seedStore();

  deps = {
    lgtmDir: store,
    token: TOKEN,
    port: PORT,
    version: "0.1.0",
    pid: 4242,
    events: bus,
    forge: fakeForge(),
    startedAt: Date.parse("2026-08-29T09:00:00Z"),
    now: () => Date.parse("2026-08-29T09:30:00Z"),
    // No real timer may outlive a test.
    heartbeatMs: 0,
  };

  handler = createApiHandler(deps);
});

afterEach(async () => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  await fs.rm(tmp, { recursive: true, force: true });
});

// ─── Request helpers ────────────────────────────────────────────────────────

interface RequestOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: unknown;
  token?: string | null;
  host?: string;
  origin?: string | null;
}

function build(pathAndQuery: string, options: RequestOptions = {}): Request {
  const method = options.method ?? "GET";
  const headers: Record<string, string> = { host: options.host ?? HOST, ...options.headers };

  if (options.token !== null) headers.authorization = `Bearer ${options.token ?? TOKEN}`;
  if (options.origin !== null) headers.origin = options.origin ?? ORIGIN;

  const init: RequestInit = { method, headers };
  if (options.body !== undefined) {
    init.body = JSON.stringify(options.body);
    headers["content-type"] = "application/json";
  }

  return new Request(`http://${HOST}${pathAndQuery}`, init);
}

function call(pathAndQuery: string, options: RequestOptions = {}): Promise<Response> {
  return handler(build(pathAndQuery, options));
}

async function callJson<T>(pathAndQuery: string, options: RequestOptions = {}): Promise<T> {
  const res = await call(pathAndQuery, options);
  return (await res.json()) as T;
}

/** Fill a pattern's `:params` with values the fixture actually has. */
function samplePath(route: RouteDef): string {
  return route.path
    .replace(":owner", REVIEWED.owner)
    .replace(":repo", REVIEWED.repo)
    .replace(":number", String(REVIEWED.number))
    .replace(":key", encodeURIComponent("r1:reviewer:f1"));
}

// ─── The route table's own invariants ───────────────────────────────────────

describe("route table", () => {
  test("covers every row of design.md's HTTP API table that v1 ships", () => {
    const named = apiRoutes().map((route) => `${route.method} ${route.path}`);

    expect(named).toEqual([
      "GET /api/health",
      "GET /api/status",
      "GET /api/events",
      "GET /api/prs",
      "POST /api/prs/:owner/:repo/:number/decision",
      "GET /api/prs/:owner/:repo/:number/findings",
      "PATCH /api/prs/:owner/:repo/:number/findings/:key",
      "GET /api/watchlist",
      "POST /api/watchlist",
      "DELETE /api/watchlist",
      "GET /api/config",
      "PATCH /api/config",
    ]);
  });

  /**
   * The hole the matrix below cannot see on its own. A new route that
   * declares `bearer: false` passes every "rejects a bad token" case by
   * having no token to reject.
   */
  test("leaves exactly one route unauthenticated, and it is the health probe", () => {
    const open = apiRoutes().filter((route) => !route.bearer);
    expect(open.map((route) => route.path)).toEqual(["/api/health"]);
  });

  test("marks every writing method mutating, and no reading one", () => {
    for (const route of apiRoutes()) {
      expect({ name: route.name, mutating: route.mutating }).toEqual({
        name: route.name,
        mutating: route.method !== "GET",
      });
    }
  });

  /**
   * `?token=` puts the secret somewhere it can be logged by a proxy and kept
   * in browser history, so it is allowed only where the alternative does not
   * exist: EventSource cannot set headers.
   */
  test("accepts a query token on the SSE route alone", () => {
    const byQuery = apiRoutes().filter((route) => route.queryToken);
    expect(byQuery.map((route) => route.path)).toEqual(["/api/events"]);
  });

  test("gives every route a unique name and a unique method plus path", () => {
    const routes = apiRoutes();
    expect(new Set(routes.map((r) => r.name)).size).toBe(routes.length);
    expect(new Set(routes.map((r) => `${r.method} ${r.path}`)).size).toBe(routes.length);
  });
});

// ─── The matrix ─────────────────────────────────────────────────────────────

describe("auth matrix, every route", () => {
  /**
   * The control. Without it the matrix could pass because every route
   * refuses everything, which would be secure and useless.
   */
  test("a correct request reaches the handler", async () => {
    for (const route of apiRoutes()) {
      const res = await call(samplePath(route), { method: route.method });
      // Cancel the SSE stream so no subscription outlives the assertion.
      await res.body?.cancel();

      expect(`${route.name}: ${res.status}`).not.toBe(`${route.name}: 401`);
      expect(`${route.name}: ${res.status}`).not.toBe(`${route.name}: 403`);
    }
  });

  test("rejects a missing token", async () => {
    for (const route of apiRoutes().filter((r) => r.bearer)) {
      const res = await call(samplePath(route), { method: route.method, token: null });
      await res.body?.cancel();
      expect(`${route.name}: ${res.status}`).toBe(`${route.name}: 401`);
    }
  });

  test("rejects a wrong token", async () => {
    for (const route of apiRoutes().filter((r) => r.bearer)) {
      const res = await call(samplePath(route), { method: route.method, token: "not-the-token" });
      await res.body?.cancel();
      expect(`${route.name}: ${res.status}`).toBe(`${route.name}: 401`);
    }
  });

  /** Including the unauthenticated health probe: rebinding must reach nothing. */
  test("rejects a rebound Host", async () => {
    for (const route of apiRoutes()) {
      const res = await call(samplePath(route), { method: route.method, host: "rebind.evil.example" });
      await res.body?.cancel();
      expect(`${route.name}: ${res.status}`).toBe(`${route.name}: 403`);
    }
  });

  test("rejects a foreign Origin on every route that writes", async () => {
    for (const route of apiRoutes().filter((r) => r.mutating)) {
      const res = await call(samplePath(route), {
        method: route.method,
        origin: "https://evil.example",
      });
      await res.body?.cancel();
      expect(`${route.name}: ${res.status}`).toBe(`${route.name}: 403`);
    }
  });

  test("rejects a missing Origin on every route that writes", async () => {
    for (const route of apiRoutes().filter((r) => r.mutating)) {
      const res = await call(samplePath(route), { method: route.method, origin: null });
      await res.body?.cancel();
      expect(`${route.name}: ${res.status}`).toBe(`${route.name}: 403`);
    }
  });

  test("sets no CORS header on any route, refused or served", async () => {
    for (const route of apiRoutes()) {
      for (const options of [{}, { token: "not-the-token" }, { origin: "https://evil.example" }]) {
        const res = await call(samplePath(route), { method: route.method, ...options });
        await res.body?.cancel();
        expect(`${route.name} ${res.headers.get("access-control-allow-origin")}`).toBe(
          `${route.name} null`
        );
      }
    }
  });

  /** No handler runs before the token is checked, so nothing is written. */
  test("a refused write changes nothing on disk", async () => {
    const before = await loadMeta(store, TRIAGE);

    await call(`/api/prs/acme/api/7/decision`, {
      method: "POST",
      token: "not-the-token",
      body: { action: "skip" },
    });
    await call(`/api/prs/acme/api/7/decision`, {
      method: "POST",
      origin: "https://evil.example",
      body: { action: "skip" },
    });

    expect((await loadMeta(store, TRIAGE))?.state).toBe(before?.state ?? "triage");
    expect((await loadMeta(store, TRIAGE))?.state).toBe("triage");
  });
});

// ─── Routing ────────────────────────────────────────────────────────────────

describe("routing", () => {
  test("answers an unknown /api path with 404, not with a handler", async () => {
    const res = await call("/api/nope");
    expect(res.status).toBe(404);
  });

  test("answers a known path with the wrong method with 405 and an Allow header", async () => {
    const res = await call("/api/config", { method: "DELETE" });
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("GET, PATCH");
  });

  test("checks Host before it even looks the path up", async () => {
    const res = await call("/api/nope", { host: "rebind.evil.example" });
    expect(res.status).toBe(403);
  });

  test("never matches a :param across a slash", () => {
    const routes = apiRoutes();
    expect(matchRoute(routes, "GET", "/api/prs/acme/api/42/findings/extra/segment")).toBeNull();

    const match = matchRoute(routes, "PATCH", "/api/prs/acme/api/42/findings/r2%3Areviewer%3Af1");
    expect(match).not.toBeNull();
    expect(match).not.toBe("method-not-allowed");
    if (match && match !== "method-not-allowed") {
      expect(match.params.key).toBe("r2:reviewer:f1");
    }
  });
});

// ─── /api/health and /api/status ────────────────────────────────────────────

describe("GET /api/health", () => {
  test("answers the port-scan handshake without a token", async () => {
    const res = await call("/api/health", { token: null });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ app: "lgtm", version: "0.1.0", pid: 4242 });
  });
});

describe("GET /api/status", () => {
  test("reports uptime, the watch list, and the counts the tray needs", async () => {
    const body = await callJson<{
      app: string;
      uptimeMs: number;
      repos: Array<{ key: string; lastPolledAt: string | null }>;
      counts: Record<string, number>;
      queue: unknown;
      quota: unknown;
      github: { tokenPresent: boolean };
    }>("/api/status");

    expect(body.app).toBe("lgtm");
    expect(body.uptimeMs).toBe(30 * 60 * 1000);
    expect(body.repos.map((r) => r.key)).toEqual(["acme/api"]);
    expect(body.counts.watchedRepos).toBe(1);
    expect(body.counts.triage).toBe(1);
    expect(body.counts.awaitingGate).toBe(1);
    expect(body.counts.pendingFindings).toBe(3);
    expect(body.github.tokenPresent).toBe(false);
  });

  /** Absent parts are null, never missing, so a tray checking for errors is not fooled. */
  test("renders a daemon with no parts wired as explicit nulls", async () => {
    const body = await callJson<Record<string, unknown>>("/api/status");
    expect(body.scheduler).toBeNull();
    expect(body.queue).toBeNull();
    expect(body.quota).toBeNull();
    expect(body.lastCycle).toBeNull();
    expect(body.binaries).toEqual([]);
  });

  test("reports the queue and the GitHub token's presence when they exist", async () => {
    deps.queue = {
      enqueue: () => "queued",
      remove: () => false,
      status: () => ({
        queued: 1,
        inFlight: 0,
        queuedEntries: [{ ref: TRIAGE, headSha: SHA_R2, queuedAt: 1_756_000_000_000 }],
        inFlightRounds: [],
        pausedByGate: true,
      }),
    };
    deps.githubToken = () => "ghp_secret";

    const body = await callJson<{
      queue: { queued: number; pausedByGate: boolean; queuedEntries: Array<{ key: string }> };
      github: { tokenPresent: boolean };
    }>("/api/status");

    expect(body.queue.queued).toBe(1);
    expect(body.queue.pausedByGate).toBe(true);
    expect(body.queue.queuedEntries[0]?.key).toBe("acme/api#7");
    expect(body.github.tokenPresent).toBe(true);
    // Presence only. The token never leaves the daemon.
    expect(JSON.stringify(body)).not.toContain("ghp_secret");
  });
});

// ─── /api/prs ───────────────────────────────────────────────────────────────

interface PRListBody {
  total: number;
  prs: Array<{
    key: string;
    state: string;
    closedAt: string | null;
    watched: boolean;
    reviewsWhenReady: boolean;
    findings: { pending: number; pendingBySeverity: Record<string, number> };
  }>;
}

describe("GET /api/prs", () => {
  test("lists the watched, open PRs", async () => {
    const body = await callJson<PRListBody>("/api/prs");
    expect(body.prs.map((pr) => pr.key).sort()).toEqual(["acme/api#42", "acme/api#7"]);
  });

  /**
   * The leak this test exists for. Closing a skipped PR keeps
   * `state: "skipped"` and only stamps `closedAt` (see `decide` in
   * @/core/classify). Hiding closed PRs by the state would show this one in
   * the skipped filter forever.
   */
  test("hides a closed PR by closedAt, so a closed-and-skipped PR does not leak", async () => {
    const meta = await loadMeta(store, CLOSED_SKIP);
    expect(meta?.state).toBe("skipped");
    expect(meta?.closedAt).not.toBeNull();

    const all = await callJson<PRListBody>("/api/prs");
    expect(all.prs.map((pr) => pr.key)).not.toContain("acme/api#9");

    const skipped = await callJson<PRListBody>("/api/prs?state=skipped");
    expect(skipped.prs.map((pr) => pr.key)).not.toContain("acme/api#9");

    const closed = await callJson<PRListBody>("/api/prs?closed=only");
    expect(closed.prs.map((pr) => pr.key)).toEqual(["acme/api#9"]);
  });

  test("filters by state", async () => {
    const body = await callJson<PRListBody>("/api/prs?state=triage");
    expect(body.prs.map((pr) => pr.key)).toEqual(["acme/api#7"]);
  });

  test("refuses a state filter that is not a state", async () => {
    const res = await call("/api/prs?state=triage,banana");
    expect(res.status).toBe(400);
  });

  /** R9.5: removing a repo keeps its files and takes its PRs out of the active views. */
  test("leaves an unwatched repo's PRs out until asked for them", async () => {
    const active = await callJson<PRListBody>("/api/prs");
    expect(active.prs.map((pr) => pr.key)).not.toContain("other/tool#1");

    const everything = await callJson<PRListBody>("/api/prs?watched=all");
    const row = everything.prs.find((pr) => pr.key === "other/tool#1");
    expect(row?.watched).toBe(false);
  });

  test("counts findings still in front of the Gate, by severity", async () => {
    const body = await callJson<PRListBody>("/api/prs?withFindings=true");
    const row = body.prs.find((pr) => pr.key === "acme/api#42");
    expect(row?.findings.pending).toBe(3);
    expect(row?.findings.pendingBySeverity).toEqual({ critical: 0, high: 1, medium: 1, low: 1 });
  });
});

// ─── decisions ──────────────────────────────────────────────────────────────

interface DecisionBody {
  state: string;
  classification: string;
  reviewsWhenReady: boolean;
  queued: boolean;
}

describe("POST /api/prs/:owner/:repo/:number/decision", () => {
  let enqueued: Array<{ ref: PRRef; headSha: string }>;
  let removed: PRRef[];

  beforeEach(() => {
    enqueued = [];
    removed = [];
    deps.queue = {
      enqueue: (ref, headSha) => {
        enqueued.push({ ref, headSha });
        return "queued";
      },
      remove: (ref) => {
        removed.push(ref);
        return true;
      },
      status: () => ({
        queued: 0,
        inFlight: 0,
        queuedEntries: [],
        inFlightRounds: [],
        pausedByGate: false,
      }),
    };
  });

  test("review approves a triage PR, records it as manual, and queues it now", async () => {
    const body = await callJson<DecisionBody>("/api/prs/acme/api/7/decision", {
      method: "POST",
      body: { action: "review" },
    });

    expect(body).toMatchObject({ state: "queued", classification: "manual", queued: true });
    expect((await loadMeta(store, TRIAGE))?.classification).toBe("manual");
    expect(enqueued).toHaveLength(1);
    expect(seen.some((event) => event.type === "pr-changed")).toBe(true);
  });

  /**
   * R2.3: a draft is never auto-reviewed. "Review" on one records the human's
   * approval and leaves it in triage, so the next cycle's "left draft state"
   * branch queues it when it is ready. Queueing here would review a draft.
   */
  test("review on a draft records the approval and waits, rather than queueing", async () => {
    await saveMeta(store, TRIAGE, { draft: true });

    const body = await callJson<DecisionBody>("/api/prs/acme/api/7/decision", {
      method: "POST",
      body: { action: "review" },
    });

    expect(body).toMatchObject({ state: "triage", classification: "manual", queued: false });
    expect(body.reviewsWhenReady).toBe(true);
    expect(enqueued).toHaveLength(0);
  });

  test("review-anyway overrides the draft hold and queues immediately", async () => {
    await saveMeta(store, TRIAGE, { draft: true });

    const body = await callJson<DecisionBody>("/api/prs/acme/api/7/decision", {
      method: "POST",
      body: { action: "review-anyway" },
    });

    expect(body).toMatchObject({ state: "queued", classification: "manual", queued: true });
    expect(enqueued).toHaveLength(1);
  });

  test("skip is sticky and drops any queued entry", async () => {
    await callJson("/api/prs/acme/api/7/decision", { method: "POST", body: { action: "skip" } });

    expect((await loadMeta(store, TRIAGE))?.state).toBe("skipped");
    expect(removed).toEqual([TRIAGE]);
  });

  /** Un-skipping asks again; it does not decide again. */
  test("unskip returns a PR to triage, not to the queue", async () => {
    await callJson("/api/prs/acme/api/7/decision", { method: "POST", body: { action: "skip" } });
    const body = await callJson<DecisionBody>("/api/prs/acme/api/7/decision", {
      method: "POST",
      body: { action: "unskip" },
    });

    expect(body.state).toBe("triage");
    expect(enqueued).toHaveLength(0);
  });

  test("refuses unskip on a PR that was never skipped", async () => {
    const res = await call("/api/prs/acme/api/7/decision", {
      method: "POST",
      body: { action: "unskip" },
    });
    expect(res.status).toBe(409);
  });

  test("refuses an unknown action, an unknown PR, and a closed one", async () => {
    expect(
      (await call("/api/prs/acme/api/7/decision", { method: "POST", body: { action: "merge" } })).status
    ).toBe(400);

    expect(
      (await call("/api/prs/acme/api/404/decision", { method: "POST", body: { action: "review" } }))
        .status
    ).toBe(404);

    expect(
      (await call("/api/prs/acme/api/9/decision", { method: "POST", body: { action: "review" } })).status
    ).toBe(409);
  });

  test("refuses a path that does not name one pull request", async () => {
    const res = await call("/api/prs/acme/api/notanumber/decision", {
      method: "POST",
      body: { action: "review" },
    });
    expect(res.status).toBe(400);
  });
});

// ─── findings ───────────────────────────────────────────────────────────────

interface FindingsBody {
  counts: { pending: number };
  rounds: Array<{
    round: number;
    headSha: string;
    hasSnapshot: boolean;
    findings: Array<{
      key: string;
      line: number;
      state: string;
      githubUrl: string;
      hunkFallback: string | null;
      hunk: { header: string; lines: Array<{ content: string }> } | null;
    }>;
  }>;
}

describe("GET /api/prs/:owner/:repo/:number/findings", () => {
  /**
   * The bug this test exists for. Both rounds have a finding on
   * `src/limiter.ts:4`, and the two snapshots hold different code at that
   * line. Slicing every finding out of the newest snapshot would show round
   * 1's reviewer quoting code it never saw.
   */
  test("slices each finding's hunk from its own round's snapshot", async () => {
    const body = await callJson<FindingsBody>("/api/prs/acme/api/42/findings");

    const round1 = body.rounds.find((r) => r.round === 1);
    const round2 = body.rounds.find((r) => r.round === 2);
    expect(round1?.headSha).toBe(SHA_R1);
    expect(round2?.headSha).toBe(SHA_R2);

    const first = round1?.findings.find((f) => f.line === 4);
    const second = round2?.findings.find((f) => f.line === 4);

    const firstText = (first?.hunk?.lines ?? []).map((l) => l.content).join("\n");
    const secondText = (second?.hunk?.lines ?? []).map((l) => l.content).join("\n");

    expect(firstText).toContain("const d = 4;");
    expect(firstText).not.toContain("ROUND_TWO_ALSO");

    expect(secondText).toContain("const ROUND_TWO_ALSO = 4;");
    expect(secondText).not.toContain("const d = 4;");
  });

  test("keys every finding by the full round:agent:id triple", async () => {
    const body = await callJson<FindingsBody>("/api/prs/acme/api/42/findings");
    const keys = body.rounds.flatMap((round) => round.findings.map((f) => f.key));
    expect(keys).toEqual(["r1:reviewer:f1", "r1:reviewer:f2", "r2:reviewer:f1"]);
  });

  /** The GitHub link R5.1 puts on every card, pinned at the SHA the round reviewed. */
  test("links every finding to GitHub at the SHA its round reviewed", async () => {
    const body = await callJson<FindingsBody>("/api/prs/acme/api/42/findings");
    const first = body.rounds[0]?.findings[0];
    expect(first?.githubUrl).toBe(`https://github.com/acme/api/blob/${SHA_R1}/src/limiter.ts#L4`);
  });

  test("says why a hunk is missing rather than rendering an empty card", async () => {
    const body = await callJson<FindingsBody>("/api/prs/acme/api/42/findings");
    const offSnapshot = body.rounds[0]?.findings.find((f) => f.line === 999);
    expect(offSnapshot?.hunk).toBeNull();
    expect(offSnapshot?.hunkFallback).toBe("line-not-in-diff");
  });

  /** A pruned or never-written snapshot falls back to GitHub, never to a newer diff. */
  test("falls back to the GitHub link when the round's snapshot is gone", async () => {
    await fs.rm(diffSnapshotPath(store, REVIEWED, SHA_R1));

    const body = await callJson<FindingsBody>("/api/prs/acme/api/42/findings");
    const round1 = body.rounds.find((r) => r.round === 1);

    expect(round1?.hasSnapshot).toBe(false);
    for (const finding of round1?.findings ?? []) {
      expect(finding.hunk).toBeNull();
      expect(finding.hunkFallback).toBe("no-snapshot");
      expect(finding.githubUrl).toContain(SHA_R1);
    }

    // Round 2 still has its own, and is unaffected.
    expect(body.rounds.find((r) => r.round === 2)?.hasSnapshot).toBe(true);
  });

  /**
   * `headSha` comes out of a hand-editable round file and becomes part of a
   * filename. A value that is not a SHA reads as "no snapshot", not as a path
   * to go and read.
   */
  test("refuses to treat a round's headSha as a path when it is not a SHA", async () => {
    await saveRound(store, {
      ref: REVIEWED,
      round: 3,
      agent: "reviewer",
      provider: "claude-cli",
      status: "ok",
      headSha: "../../../../../../etc/passwd",
      startedAt: "2026-08-22T10:00:00Z",
      durationMs: 100,
      findings: [{ severity: "low", file: "src/limiter.ts", line: 4, comment: "anything" }],
    });

    const body = await callJson<FindingsBody>("/api/prs/acme/api/42/findings");
    const round3 = body.rounds.find((r) => r.round === 3);

    expect(round3?.hasSnapshot).toBe(false);
    expect(round3?.findings[0]?.hunkFallback).toBe("no-snapshot");
  });

  test("404s for a PR the store has never seen", async () => {
    expect((await call("/api/prs/acme/api/404/findings")).status).toBe(404);
  });
});

// ─── the gate ───────────────────────────────────────────────────────────────

describe("PATCH /api/prs/:owner/:repo/:number/findings/:key", () => {
  async function stateOf(round: number, id: string): Promise<string | undefined> {
    const rounds = await loadAllRounds(store, REVIEWED);
    return rounds.find((r) => r.round === round)?.findings.find((f) => f.id === id)?.state;
  }

  test("discards a finding and puts it back", async () => {
    const discard = await call("/api/prs/acme/api/42/findings/r1:reviewer:f1", {
      method: "PATCH",
      body: { state: "discarded" },
    });
    expect(discard.status).toBe(200);
    expect(await stateOf(1, "f1")).toBe("discarded");

    const restore = await call("/api/prs/acme/api/42/findings/r1:reviewer:f1", {
      method: "PATCH",
      body: { state: "open" },
    });
    expect(restore.status).toBe(200);
    expect(await stateOf(1, "f1")).toBe("open");
  });

  /**
   * R9.3, and a real bug in the old codebase: ids restart at f1 in every
   * round file. Discarding `r1:reviewer:f1` must not touch `r2:reviewer:f1`,
   * which is a different finding that happens to share an id.
   */
  test("addresses one round's finding without touching another round's same id", async () => {
    await call("/api/prs/acme/api/42/findings/r1:reviewer:f1", {
      method: "PATCH",
      body: { state: "discarded" },
    });

    expect(await stateOf(1, "f1")).toBe("discarded");
    expect(await stateOf(2, "f1")).toBe("open");
  });

  test("refuses a bare id, which would be ambiguous between rounds", async () => {
    const res = await call("/api/prs/acme/api/42/findings/f1", {
      method: "PATCH",
      body: { state: "discarded" },
    });
    expect(res.status).toBe(400);
    expect(await stateOf(1, "f1")).toBe("open");
    expect(await stateOf(2, "f1")).toBe("open");
  });

  test("accepts a percent-encoded key, since the canonical form contains colons", async () => {
    const res = await call(`/api/prs/acme/api/42/findings/${encodeURIComponent("r2:reviewer:f1")}`, {
      method: "PATCH",
      body: { state: "discarded" },
    });
    expect(res.status).toBe(200);
    expect(await stateOf(2, "f1")).toBe("discarded");
  });

  test("404s for a key that names no finding", async () => {
    const res = await call("/api/prs/acme/api/42/findings/r9:reviewer:f4", {
      method: "PATCH",
      body: { state: "discarded" },
    });
    expect(res.status).toBe(404);
  });

  /** `posted` and `held` belong to the post flow, which reports what GitHub accepted. */
  test("refuses any state but discarded and open", async () => {
    for (const state of ["posted", "held", "banana"]) {
      const res = await call("/api/prs/acme/api/42/findings/r1:reviewer:f1", {
        method: "PATCH",
        body: { state },
      });
      expect(`${state}: ${res.status}`).toBe(`${state}: 400`);
    }
  });

  test("refuses to discard a finding that is already on GitHub", async () => {
    const { markFindingsPosted } = await import("@/store/reviews");
    await markFindingsPosted(store, REVIEWED, ["r1:reviewer:f1"]);

    const res = await call("/api/prs/acme/api/42/findings/r1:reviewer:f1", {
      method: "PATCH",
      body: { state: "discarded" },
    });
    expect(res.status).toBe(409);
    expect(await stateOf(1, "f1")).toBe("posted");
  });

  test("is idempotent when the finding is already in the asked-for state", async () => {
    const res = await call("/api/prs/acme/api/42/findings/r1:reviewer:f1", {
      method: "PATCH",
      body: { state: "open" },
    });
    expect(res.status).toBe(200);
    expect((await res.json()) as { changed: boolean }).toMatchObject({ changed: false });
  });
});

// ─── watchlist ──────────────────────────────────────────────────────────────

describe("/api/watchlist", () => {
  test("lists the watched repos with their last poll time", async () => {
    const body = await callJson<{ repos: Array<{ key: string; lastPolledAt: string | null }> }>(
      "/api/watchlist"
    );
    expect(body.repos.map((r) => r.key)).toEqual(["acme/api"]);
    expect(body.repos[0]?.lastPolledAt).toBeNull();
  });

  /**
   * R2.6's ordering, which `addRepoWithBackfill` owns: every open PR's
   * `meta.md` is on disk before the repo joins `watch.md`, so the next poll
   * cycle cannot auto-queue an auto-class PR ahead of the confirm pane. The
   * handler must delegate rather than call `addToWatchList` itself.
   */
  test("adding a repo writes triage meta for its open PRs before watching it", async () => {
    const res = await call("/api/watchlist", { method: "POST", body: { repo: "newco/svc" } });
    expect(res.status).toBe(201);

    const meta = await loadMeta(store, { owner: "newco", repo: "svc", number: 3 });
    expect(meta?.state).toBe("triage");

    const watched = await loadWatchList(store);
    expect(watched.map((e) => `${e.owner}/${e.repo}`)).toContain("newco/svc");
  });

  /**
   * The ordering that makes R2.6 true, checked from the outside: while the
   * backfill is still fetching a PR's metadata, `watch.md` must not name the
   * repo yet. A poll cycle that starts in that window sees no watch entry and
   * cannot auto-queue anything ahead of the confirm pane.
   */
  test("keeps the repo out of watch.md until the backfill has finished", async () => {
    let watchedMidBackfill: string[] = [];

    deps.forge = fakeForge({
      getCheckStatus: async (): Promise<CheckStatus> => {
        watchedMidBackfill = (await loadWatchList(store)).map((e) => `${e.owner}/${e.repo}`);
        return { state: "success", runs: [] };
      },
    });

    await call("/api/watchlist", { method: "POST", body: { repo: "newco/svc" } });

    expect(watchedMidBackfill).not.toContain("newco/svc");
    expect((await loadWatchList(store)).map((e) => `${e.owner}/${e.repo}`)).toContain("newco/svc");
  });

  test("returns the confirm pane's rows, with auto-class PRs pre-selected", async () => {
    const body = await callJson<{
      entries: Array<{ key: string; classification: string; preSelected: boolean; mergeable: string }>;
    }>("/api/watchlist", { method: "POST", body: { repo: "newco/svc" } });

    expect(body.entries).toHaveLength(1);
    expect(body.entries[0]?.classification).toBe("own");
    expect(body.entries[0]?.preSelected).toBe(true);
    // GitHub answers null while it computes mergeability; that is "computing".
    expect(body.entries[0]?.mergeable).toBe("computing");
  });

  test("accepts owner and repo as separate fields too", async () => {
    const res = await call("/api/watchlist", { method: "POST", body: { owner: "newco", repo: "svc" } });
    expect(res.status).toBe(201);
  });

  test("refuses anything that is not an owner/repo", async () => {
    for (const body of [{}, { repo: "no-slash-here-and-no-owner" }, { repo: "a/b/c" }, { repo: "../../etc" }]) {
      const res = await call("/api/watchlist", { method: "POST", body });
      expect(`${JSON.stringify(body)}: ${res.status}`).toBe(`${JSON.stringify(body)}: 400`);
    }
  });

  test("says so, rather than half-adding, when there is no Forge to backfill with", async () => {
    deps.forge = undefined;
    const res = await call("/api/watchlist", { method: "POST", body: { repo: "newco/svc" } });
    expect(res.status).toBe(503);
    expect((await loadWatchList(store)).map((e) => e.repo)).not.toContain("svc");
  });

  test("reports a backfill failure without adding the repo", async () => {
    deps.forge = fakeForge({
      listOpenPRs: async () => {
        throw new Error("401 bad credentials");
      },
    });

    const res = await call("/api/watchlist", { method: "POST", body: { repo: "newco/svc" } });
    expect(res.status).toBe(502);
    expect((await loadWatchList(store)).map((e) => e.repo)).not.toContain("svc");
    expect(seen.some((e) => e.type === "error")).toBe(true);
  });

  test("re-adding a watched repo reconciles instead of reporting new work", async () => {
    const before = await loadMeta(store, REVIEWED);

    const body = await callJson<{ added: boolean; entries: unknown[] }>("/api/watchlist", {
      method: "POST",
      body: { repo: "acme/api" },
    });

    expect(body.added).toBe(false);
    // acme/api#42 is open on the Forge and already has meta, so it is
    // reconciled silently rather than listed as new work, and its recorded
    // state survives untouched (R9.5).
    expect(body.entries).toEqual([]);
    expect((await loadMeta(store, REVIEWED))?.state).toBe(before?.state ?? "reviewed");
    expect((await loadMeta(store, REVIEWED))?.state).toBe("reviewed");
  });

  /** R9.5: the repo leaves the polled set, its reviews stay on disk. */
  test("removing a repo keeps its reviews and takes its PRs out of the active list", async () => {
    const res = await call("/api/watchlist", { method: "DELETE", body: { repo: "acme/api" } });
    expect(res.status).toBe(200);
    expect((await res.json()) as { removed: boolean }).toMatchObject({ removed: true });

    expect(await loadMeta(store, REVIEWED)).not.toBeNull();

    const active = await callJson<PRListBody>("/api/prs");
    expect(active.prs).toEqual([]);
  });

  test("removing a repo that is not watched reports it rather than failing", async () => {
    const body = await callJson<{ removed: boolean }>("/api/watchlist", {
      method: "DELETE",
      body: { repo: "nobody/nothing" },
    });
    expect(body.removed).toBe(false);
  });
});

// ─── config ─────────────────────────────────────────────────────────────────

describe("/api/config", () => {
  test("reads config.md with its defaults alongside", async () => {
    const body = await callJson<{
      config: { interval_minutes: number };
      defaults: { interval_minutes: number };
    }>("/api/config");

    expect(body.config.interval_minutes).toBe(15);
    expect(body.defaults.interval_minutes).toBe(15);
  });

  test("patches a field and tells the daemon to re-arm", async () => {
    const changes: number[] = [];
    deps.onConfigChange = (config) => changes.push(config.interval_minutes);

    const body = await callJson<{ config: { interval_minutes: number; concurrency: number } }>(
      "/api/config",
      { method: "PATCH", body: { interval_minutes: 5 } }
    );

    expect(body.config.interval_minutes).toBe(5);
    // Untouched fields keep their values.
    expect(body.config.concurrency).toBe(2);
    expect(changes).toEqual([5]);
  });

  /** A zero interval hot-loops the daemon; a zero concurrency queues work nothing runs. */
  test("refuses values that would hang or hot-loop the daemon", async () => {
    for (const body of [{ interval_minutes: 0 }, { concurrency: 0 }, { pause_above_pct: 400 }]) {
      const res = await call("/api/config", { method: "PATCH", body });
      expect(`${JSON.stringify(body)}: ${res.status}`).toBe(`${JSON.stringify(body)}: 400`);
    }
  });

  /** A typo that silently succeeds looks exactly like a setting that does not work. */
  test("refuses an unknown field instead of dropping it", async () => {
    const res = await call("/api/config", { method: "PATCH", body: { interval_mins: 5 } });
    expect(res.status).toBe(400);
  });

  test("pins a binary path and clears it again", async () => {
    const pinned = await callJson<{ config: { claude_path?: string } }>("/api/config", {
      method: "PATCH",
      body: { claude_path: "/opt/homebrew/bin/claude" },
    });
    expect(pinned.config.claude_path).toBe("/opt/homebrew/bin/claude");

    const cleared = await callJson<{ config: { claude_path?: string } }>("/api/config", {
      method: "PATCH",
      body: { claude_path: null },
    });
    expect(cleared.config.claude_path).toBeUndefined();
  });

  test("refuses a relative binary path", async () => {
    const res = await call("/api/config", { method: "PATCH", body: { gh_path: "gh" } });
    expect(res.status).toBe(400);
  });
});

// ─── SSE ────────────────────────────────────────────────────────────────────

describe("GET /api/events", () => {
  async function readFrame(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<string> {
    const decoder = new TextDecoder();
    const chunk = await reader.read();
    return chunk.value ? decoder.decode(chunk.value) : "";
  }

  test("streams the daemon's events as invalidation hints", async () => {
    const res = await call("/api/events");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");

    const reader = res.body!.getReader();
    expect(await readFrame(reader)).toContain(": lgtm");

    bus.emit({ type: "findings-ready", ref: REVIEWED });
    const frame = await readFrame(reader);

    expect(frame).toContain("event: findings-ready");
    expect(frame).toContain('"number":42');
    expect(frame).toContain("id: 1");

    await reader.cancel();
  });

  /** EventSource cannot set an Authorization header, so this one route takes a query token. */
  test("accepts the token in the query string", async () => {
    const res = await call(`/api/events?token=${TOKEN}`, { token: null });
    expect(res.status).toBe(200);
    await res.body?.cancel();
  });

  test("refuses a wrong query token", async () => {
    const res = await call("/api/events?token=nope", { token: null });
    expect(res.status).toBe(401);
    await res.body?.cancel();
  });

  /** The query form is the SSE route's alone; every other route ignores it. */
  test("does not let any other route be opened with a query token", async () => {
    const res = await call(`/api/status?token=${TOKEN}`, { token: null });
    expect(res.status).toBe(401);
  });

  test("unsubscribes when the client hangs up", async () => {
    const res = await call("/api/events");
    const reader = res.body!.getReader();
    await readFrame(reader);
    await reader.cancel();

    // A listener left behind would keep writing into a dead controller for
    // the daemon's whole life, once per event, for every tab ever opened.
    expect(() => bus.emit({ type: "cycle-finished", repoKey: "acme/api" })).not.toThrow();
  });
});

// ─── The real socket ────────────────────────────────────────────────────────

describe("startApiServer", () => {
  let server: ReturnType<typeof startApiServer> | null = null;

  afterEach(async () => {
    await server?.stop();
    server = null;
  });

  /**
   * `Bun.serve` defaults to 0.0.0.0. Binding that would put a daemon holding
   * a GitHub token on every interface the machine has (R7.2), so the hostname
   * is passed explicitly and asserted here.
   */
  test("binds loopback only, and validates against the port it actually got", async () => {
    server = startApiServer({ ...deps, port: 0 });

    expect(server.hostname).toBe(API_HOSTNAME);
    expect(server.port).toBeGreaterThan(0);
    expect(server.port).not.toBe(PORT);
    expect(server.url).toBe(`http://127.0.0.1:${server.port}`);

    // The Host check follows the bound port, not the requested one.
    const ok = await fetch(`${server.url}/api/health`);
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ app: "lgtm" });

    const rebound = await fetch(`${server.url}/api/health`, {
      headers: { host: "rebind.evil.example" },
    });
    expect(rebound.status).toBe(403);
  });

  test("serves an authenticated route over the wire", async () => {
    server = startApiServer({ ...deps, port: 0 });

    const denied = await fetch(`${server.url}/api/status`);
    expect(denied.status).toBe(401);

    const allowed = await fetch(`${server.url}/api/status`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(allowed.status).toBe(200);
  });

  test("serves the SPA shell at / without a token", async () => {
    server = startApiServer({
      ...deps,
      port: 0,
      // A stand-in for the embedded bundle, so this test asserts the route's
      // wiring rather than waiting on a React build.
      spa: new Response("<!doctype html><title>LGTM</title>", {
        headers: { "content-type": "text/html; charset=utf-8" },
      }),
    });

    const res = await fetch(`${server.url}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
  });

  test("404s an unknown path without reaching a handler", async () => {
    server = startApiServer({ ...deps, port: 0 });
    const res = await fetch(`${server.url}/nope`);
    expect(res.status).toBe(404);
  });
});

/**
 * The route table from design.md's "HTTP API" section, as data.
 *
 * Every route is a `RouteDef` in one exported array. That shape is not
 * decoration. `src/api/server.ts` runs the auth checks from `./auth.ts` over
 * `route.bearer` / `route.mutating` / `route.queryToken` at a single choke
 * point before any handler runs, and server.test.ts enumerates this same
 * array to assert that every route rejects a missing token, a wrong token, a
 * bad Host and a bad Origin. A route added below is covered by that matrix
 * the moment it exists; a route added anywhere else is not, which is why
 * there is no second place to add one and no injection seam for extra
 * routes. The validate and post endpoints (design.md's remaining two rows,
 * scheduled for M5) belong in the marked section near the bottom.
 *
 * Handlers take their collaborators from `ctx.deps` rather than closing over
 * them, so the table can be built once, without a daemon, and inspected by
 * tests and by the auth matrix.
 *
 * Two cross-module rules this file obeys everywhere, both of them bugs
 * waiting to happen:
 *
 *  - A skipped PR that closes keeps `state: "skipped"` and only gets
 *    `closedAt` stamped (see `decide` in @/core/classify). Active views
 *    therefore hide closed PRs by `closedAt !== null`, never by
 *    `state === "closed"`, or every closed-and-skipped PR leaks back in.
 *  - A finding is addressed by its full key, `r2:reviewer:f1`. Ids restart
 *    at f1 in every round file, so a bare id silently hits other rounds
 *    (R9.3). The PATCH route parses the canonical form and refuses anything
 *    else.
 */

import fs from "fs/promises";
import { postRoutes } from "./post";

import { formatFindingKey, parseFindingKey } from "@/core";
import type { CheckState, Finding, ForgeAdapter, PRMeta, PRRef, PRState, Severity } from "@/core";
import { reviewsWhenReady } from "@/core/classify";
import { parseDiff, sliceHunk } from "@/core/diff";
import type { SlicedHunk } from "@/core/diff";
import { formatRef } from "@/core/pr-ref";
import {
  diffSnapshotPath,
  listReviewedPRs,
  loadAllRounds,
  loadMeta,
  markFindingsDiscarded,
  markFindingsOpen,
  prUrl,
  saveMeta,
} from "@/store/reviews";
import type { MetaUpdate } from "@/store/reviews";
import { loadWatchList, removeFromWatchList } from "@/store/watch-list";
import { DEFAULTS, loadConfig, updateConfig } from "@/store/config";
import type { Config } from "@/store/config";
import { addRepoWithBackfill, mergeableStatus } from "@/daemon/backfill";
import type { BackfillEntry } from "@/daemon/backfill";
import type { DaemonEvent, EventBus } from "@/daemon/events";
import type { QueueSnapshot, ReviewQueue } from "@/daemon/queue";
import type { SchedulerStatus } from "@/daemon/scheduler";
import type { QuotaState } from "@/daemon/quota";
import type { BinaryStatus } from "@/daemon/binaries";
import type { PollCycleResult } from "@/daemon/cycle";

// ─── Dependencies ───────────────────────────────────────────────────────────

/**
 * Everything the API reads or writes through. `lgtmDir`, `token`, `port` and
 * `version` are the whole contract; every other field is a live daemon part
 * that the API renders when present and reports as absent when not, so the
 * server can be stood up in a test with nothing but a store directory.
 */
export interface ApiDeps {
  /** The store root, `~/.lgtm-farm` in production. */
  lgtmDir: string;
  /** The bearer token from `<lgtmDir>/token`. */
  token: string;
  /** The port actually bound. Host and Origin are checked against it. */
  port: number;
  /** Reported by `/api/health`, which is also the port-scan handshake (R7.5). */
  version: string;
  pid?: number;

  /**
   * The only Forge seam the API has, and it is used by exactly one route:
   * `POST /api/watchlist`, whose backfill has to list a repo's open PRs
   * before the repo joins the polled set. Absent means that route answers
   * 503 rather than half-adding a repo.
   */
  forge?: ForgeAdapter;

  /**
   * The live review queue. A decision writes `meta.md` either way; enqueuing
   * here is what makes "review" take effect now instead of at the next poll.
   */
  queue?: Pick<ReviewQueue, "enqueue" | "remove" | "status">;

  /** The daemon's event bus: read by `/api/events`, written by every mutation below. */
  events?: EventBus;

  scheduler?: { status(): SchedulerStatus };
  quota?: { state(): QuotaState };
  binaries?: { status(): BinaryStatus[] };
  /** The most recent poll cycle, for `/api/status`'s per-repo outcome. */
  lastCycle?: () => PollCycleResult | null;
  /** Whether a GitHub token resolved, never the token itself. */
  githubToken?: () => string | null;

  /** ms since epoch, when the daemon started. Defaults to construction time. */
  startedAt?: number;
  /** Injected clock, ms since epoch. */
  now?: () => number;

  /**
   * Config access. Defaults to the store's own `loadConfig` / `updateConfig`,
   * which resolve `~/.lgtm-farm` from `HOME` rather than from `lgtmDir`.
   * Injectable, so a test or a daemon pointed at a non-default store is not
   * silently reading a different file than every other route.
   */
  config?: {
    load(): Promise<Config>;
    update(updates: Partial<Config>): Promise<void>;
  };
  /** Called after `PATCH /api/config` writes, so the daemon can re-arm without a restart. */
  onConfigChange?: (config: Config) => void;

  /** SSE keepalive period. 0 disables it; tests use 0 so no timer outlives the test. */
  heartbeatMs?: number;
  /** Timer seam for the SSE keepalive. Returns its own canceller. */
  setTimer?: (fn: () => void, ms: number) => () => void;
}

// ─── Route shape ────────────────────────────────────────────────────────────

export type HttpMethod = "GET" | "POST" | "PATCH" | "DELETE";

export interface RouteContext {
  req: Request;
  url: URL;
  /** Path parameters, already percent-decoded. */
  params: Record<string, string>;
  deps: ApiDeps;
}

export type RouteHandler = (ctx: RouteContext) => Response | Promise<Response>;

export interface RouteDef {
  method: HttpMethod;
  /** Pattern with `:name` segments, e.g. `/api/prs/:owner/:repo/:number/findings/:key`. */
  path: string;
  /** Stable identifier, used in logs and in the auth matrix's failure messages. */
  name: string;
  /** Requires a bearer token. False for `/api/health` alone. */
  bearer: boolean;
  /** Requires a matching Origin. True for every method that writes. */
  mutating: boolean;
  /** Also accepts `?token=`. True for `/api/events` alone. */
  queryToken: boolean;
  handler: RouteHandler;
}

/** The one route that is deliberately unauthenticated: the port-scan handshake (R7.5). */
export const PUBLIC_ROUTE_PATH = "/api/health";

// ─── Small helpers ──────────────────────────────────────────────────────────

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body) + "\n", {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      // The store changes under the UI while a tab is open, and a cached PR
      // list is a stale gate, which is the one thing this product must not show.
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
}

function fail(status: number, error: string, message: string): Response {
  return json({ error, message }, status);
}

type JsonBody = Record<string, unknown>;

/**
 * Read a JSON object body. An empty body reads as `{}` so a DELETE that
 * carries its arguments in the query string does not have to send one.
 */
async function readJsonBody(req: Request): Promise<JsonBody | null> {
  let raw: string;
  try {
    raw = await req.text();
  } catch {
    return null;
  }
  if (raw.trim() === "") return {};

  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed as JsonBody;
  } catch {
    return null;
  }
}

function emit(deps: ApiDeps, event: DaemonEvent): void {
  try {
    deps.events?.emit(event);
  } catch {
    // A subscriber that throws is a notifier problem, never a failed request.
  }
}

function nowMs(deps: ApiDeps): number {
  return (deps.now ?? Date.now)();
}

/** GitHub's own naming rules, tight enough that a path segment cannot smuggle a traversal. */
const REPO_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** Same idea for a commit SHA, which `diffSnapshotPath` turns into a filename. */
const HEX_SHA = /^[0-9a-f]{7,64}$/i;

function parseRef(params: Record<string, string>): PRRef | null {
  const owner = params.owner ?? "";
  const repo = params.repo ?? "";
  const raw = params.number ?? "";

  if (!REPO_SEGMENT.test(owner) || !REPO_SEGMENT.test(repo)) return null;
  if (!/^\d+$/.test(raw)) return null;

  const number = Number(raw);
  if (!Number.isSafeInteger(number) || number <= 0) return null;

  return { owner, repo, number };
}

function repoKey(owner: string, repo: string): string {
  return `${owner}/${repo}`;
}

// ─── PR rows ────────────────────────────────────────────────────────────────

const SEVERITIES: readonly Severity[] = ["critical", "high", "medium", "low"];

export interface FindingCounts {
  total: number;
  open: number;
  held: number;
  posted: number;
  discarded: number;
  /** open + held: everything still in front of the Gate (see `pendingFindings` in @/store/reviews). */
  pending: number;
  /** Pending findings by severity, which is what the inbox badge counts. */
  pendingBySeverity: Record<Severity, number>;
}

function emptyCounts(): FindingCounts {
  return {
    total: 0,
    open: 0,
    held: 0,
    posted: 0,
    discarded: 0,
    pending: 0,
    pendingBySeverity: { critical: 0, high: 0, medium: 0, low: 0 },
  };
}

function countFindings(findings: Finding[], into: FindingCounts): void {
  for (const finding of findings) {
    into.total += 1;
    into[finding.state] += 1;
    if (finding.state === "open" || finding.state === "held") {
      into.pending += 1;
      into.pendingBySeverity[finding.severity] += 1;
    }
  }
}

export interface PRRow {
  ref: PRRef;
  /** `owner/repo#42`, the same rendering the CLI and the logs use. */
  key: string;
  url: string;
  title: string;
  author: string;
  state: PRState;
  classification: PRMeta["classification"];
  draft: boolean;
  headSha: string;
  lastReviewedSha: string | null;
  failedAttempts: number;
  rounds: number;
  pendingReviewId: number | null;
  closedAt: string | null;
  updatedAt: string;

  // ── Triage metadata ───────────────────────────────────────────────────
  //
  // Flat, and under exactly the names the browser reads (`PRListItem` in
  // src/ui/api.ts). Null travels as null. The row means "not fetched" or
  // "GitHub is still computing it", and the browser renders a dash or
  // "Computing…"; filling a null in with a zero here would turn "unknown"
  // into a measured "no changes" on its way across the wire.
  createdAt: string | null;
  additions: number | null;
  deletions: number | null;
  changedFiles: number | null;
  mergeable: boolean | null;
  checkStatus: CheckState | null;
  /** Derived, never stored: an auto-class draft held until it leaves draft state (R2.3). */
  reviewsWhenReady: boolean;
  /** False once its repo leaves the watch list. Its files stay on disk (R9.5). */
  watched: boolean;
  findings: FindingCounts;
}

/**
 * Read every PR the store knows about, with its finding counts.
 *
 * One pass over `reviews/` feeds both `/api/prs` and `/api/status`'s counts.
 * It reads every round file of every PR, which is fine at v1's scale and is
 * the honest cost of keeping the markdown store as the source of truth; if a
 * dogfooding store ever makes this slow, the fix is a cached index in the
 * daemon, not a second copy of the counts in `meta.md`.
 */
async function scanPRs(deps: ApiDeps): Promise<PRRow[]> {
  const watched = new Set((await loadWatchList(deps.lgtmDir)).map((e) => repoKey(e.owner, e.repo)));
  const refs = await listReviewedPRs(deps.lgtmDir);

  const rows: PRRow[] = [];
  for (const ref of refs) {
    const meta = await loadMeta(deps.lgtmDir, ref);
    if (!meta) continue;

    const counts = emptyCounts();
    for (const round of await loadAllRounds(deps.lgtmDir, ref)) {
      countFindings(round.findings, counts);
    }

    rows.push({
      ref,
      key: formatRef(ref),
      url: meta.url,
      title: meta.title,
      author: meta.author,
      state: meta.state,
      classification: meta.classification,
      draft: meta.draft,
      headSha: meta.headSha,
      lastReviewedSha: meta.lastReviewedSha,
      failedAttempts: meta.failedAttempts,
      rounds: meta.rounds,
      pendingReviewId: meta.pendingReviewId,
      closedAt: meta.closedAt,
      updatedAt: meta.updatedAt,
      createdAt: meta.createdAt,
      additions: meta.additions,
      deletions: meta.deletions,
      changedFiles: meta.changedFiles,
      mergeable: meta.mergeable,
      checkStatus: meta.checkStatus,
      reviewsWhenReady: reviewsWhenReady(meta),
      watched: watched.has(repoKey(ref.owner, ref.repo)),
      findings: counts,
    });
  }

  return rows;
}

// ─── GET /api/health ────────────────────────────────────────────────────────

/**
 * The signature `selectPort` probes to tell a stale LGTM daemon from a
 * foreign process squatting on 4747 (R7.5). Unauthenticated because the
 * daemon doing the probing has no way to know the occupant's token.
 */
const health: RouteHandler = ({ deps }) =>
  json({ app: "lgtm", version: deps.version, pid: deps.pid ?? process.pid });

// ─── GET /api/status ────────────────────────────────────────────────────────

/**
 * The tray contract (design.md, "HTTP API"; ADR 0003). v1.1's MenuBarExtra
 * consumes exactly this, so every field is either present or explicitly
 * null. A missing key would read as "the daemon is fine" to a client that
 * only checks for errors.
 */
const status: RouteHandler = async ({ deps }) => {
  const startedAt = deps.startedAt ?? nowMs(deps);
  const rows = await scanPRs(deps);
  const active = rows.filter((row) => row.closedAt === null && row.watched);

  const cycle = deps.lastCycle?.() ?? null;
  const outcomes = new Map((cycle?.repos ?? []).map((repo) => [repo.repoKey, repo]));

  const repos = (await loadWatchList(deps.lgtmDir)).map((entry) => {
    const key = repoKey(entry.owner, entry.repo);
    const outcome = outcomes.get(key) ?? null;
    return {
      owner: entry.owner,
      repo: entry.repo,
      key,
      addedAt: entry.addedAt,
      lastPolledAt: entry.lastPolledAt ?? null,
      lastCycle: outcome
        ? { status: outcome.status, error: outcome.error, seen: outcome.seen, queued: outcome.queued }
        : null,
    };
  });

  const queue: QueueSnapshot | null = deps.queue?.status() ?? null;

  return json({
    app: "lgtm",
    version: deps.version,
    pid: deps.pid ?? process.pid,
    port: deps.port,
    startedAt: new Date(startedAt).toISOString(),
    uptimeMs: Math.max(0, nowMs(deps) - startedAt),
    scheduler: deps.scheduler?.status() ?? null,
    lastCycle: cycle ? { startedAt: cycle.startedAt, error: cycle.error } : null,
    repos,
    queue: queue
      ? {
          queued: queue.queued,
          inFlight: queue.inFlight,
          pausedByGate: queue.pausedByGate,
          queuedEntries: queue.queuedEntries.map((entry) => ({
            key: formatRef(entry.ref),
            headSha: entry.headSha,
            queuedAt: new Date(entry.queuedAt).toISOString(),
          })),
          inFlightRounds: queue.inFlightRounds.map((round) => ({
            key: formatRef(round.ref),
            headSha: round.headSha,
            startedAt: new Date(round.startedAt).toISOString(),
          })),
        }
      : null,
    quota: deps.quota?.state() ?? null,
    binaries: deps.binaries?.status() ?? [],
    // Presence only. The token itself never leaves the daemon (R7.2).
    github: { tokenPresent: deps.githubToken ? deps.githubToken() !== null : false },
    counts: {
      watchedRepos: repos.length,
      triage: active.filter((row) => row.state === "triage").length,
      skipped: active.filter((row) => row.state === "skipped").length,
      queued: active.filter((row) => row.state === "queued").length,
      reviewing: active.filter((row) => row.state === "reviewing").length,
      failed: active.filter((row) => row.state === "failed").length,
      // "Awaiting the gate": PRs with findings a human has not decided on.
      awaitingGate: active.filter((row) => row.findings.pending > 0).length,
      pendingFindings: active.reduce((sum, row) => sum + row.findings.pending, 0),
    },
  });
};

// ─── GET /api/events ────────────────────────────────────────────────────────

function sseFrame(id: number, event: DaemonEvent): string {
  return `id: ${id}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}

const DEFAULT_HEARTBEAT_MS = 25_000;

function defaultSetTimer(fn: () => void, ms: number): () => void {
  const handle = setInterval(fn, ms);
  // A keepalive that keeps the process alive would outlive the daemon.
  (handle as unknown as { unref?: () => void }).unref?.();
  return () => clearInterval(handle);
}

/**
 * The SSE stream. Events carry their identity, not their payload. The SPA
 * treats each one as an invalidation hint and refetches, so the API stays the
 * single source of truth (design.md, "HTTP API") and a dropped event costs a
 * stale view for one poll rather than a wrong one forever.
 *
 * Accepts `?token=` because `EventSource` cannot set an Authorization header.
 * That is the only route that does, and it is declared on the route, not
 * decided here.
 */
const events: RouteHandler = ({ deps }) => {
  const bus = deps.events;
  const heartbeatMs = deps.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
  const setTimer = deps.setTimer ?? defaultSetTimer;
  const encoder = new TextEncoder();

  let sequence = 0;
  let teardown: (() => void) | null = null;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;

      const write = (chunk: string) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(chunk));
        } catch {
          // The client hung up between the check above and this enqueue.
          // Tear down here rather than waiting for `cancel`, which a broken
          // connection does not always deliver.
          teardown?.();
        }
      };

      const listener = (event: DaemonEvent) => write(sseFrame(++sequence, event));
      bus?.on(listener);

      const cancelHeartbeat =
        heartbeatMs > 0 ? setTimer(() => write(": ping\n\n"), heartbeatMs) : () => {};

      // Armed before the first write, so nothing can fail while there is no
      // way to unsubscribe the listener that was just registered.
      teardown = () => {
        closed = true;
        cancelHeartbeat();
        bus?.off(listener);
      };

      // A comment frame, so a client that buffers has something to flush and
      // the connection is provably open before any event arrives.
      write(": lgtm\n\n");
    },

    cancel() {
      teardown?.();
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store",
      // Named for the reverse proxies that would otherwise buffer the stream
      // into uselessness. Harmless on a loopback socket, cheap insurance if
      // anyone ever puts one in front of this.
      "x-accel-buffering": "no",
      connection: "keep-alive",
    },
  });
};

// ─── GET /api/prs ───────────────────────────────────────────────────────────

const PR_STATES: ReadonlySet<string> = new Set<PRState>([
  "triage",
  "skipped",
  "queued",
  "reviewing",
  "reviewed",
  "failed",
  "closed",
]);

/**
 * The PR list behind the inbox.
 *
 * Query parameters:
 *   `state=triage,queued`  one or more PRState values; omitted means all.
 *   `closed=exclude|include|only`  default `exclude`.
 *   `watched=only|all`  default `only`; `all` shows repos removed from the
 *                       watch list, whose files are kept (R9.5).
 *   `withFindings=true`  only PRs with findings still in front of the Gate.
 *
 * The closed filter reads `closedAt`, never `state`. A skipped PR that closes
 * keeps `state: "skipped"` and gets only `closedAt` stamped, so filtering on
 * the state would leak every closed-and-skipped PR back into the inbox.
 */
const listPRs: RouteHandler = async ({ url, deps }) => {
  const stateParam = url.searchParams.get("state");
  const wanted = stateParam
    ? stateParam
        .split(",")
        .map((value) => value.trim())
        .filter((value) => value.length > 0)
    : [];

  const unknown = wanted.filter((value) => !PR_STATES.has(value));
  if (unknown.length > 0) {
    return fail(400, "bad-state", `unknown state filter: ${unknown.join(", ")}`);
  }

  const closed = url.searchParams.get("closed") ?? "exclude";
  if (!["exclude", "include", "only"].includes(closed)) {
    return fail(400, "bad-closed", `closed must be exclude, include or only`);
  }

  const watchedParam = url.searchParams.get("watched") ?? "only";
  if (!["only", "all"].includes(watchedParam)) {
    return fail(400, "bad-watched", `watched must be only or all`);
  }

  const withFindings = url.searchParams.get("withFindings") === "true";

  const rows = (await scanPRs(deps)).filter((row) => {
    if (closed === "exclude" && row.closedAt !== null) return false;
    if (closed === "only" && row.closedAt === null) return false;
    if (watchedParam === "only" && !row.watched) return false;
    if (wanted.length > 0 && !wanted.includes(row.state)) return false;
    if (withFindings && row.findings.pending === 0) return false;
    return true;
  });

  return json({ prs: rows, total: rows.length });
};

// ─── POST /api/prs/:owner/:repo/:number/decision ────────────────────────────

type DecisionAction = "review" | "skip" | "unskip" | "review-anyway";

const DECISION_ACTIONS: readonly DecisionAction[] = ["review", "skip", "unskip", "review-anyway"];

/**
 * The triage decision (R2.4, R2.3's override, and the backfill confirm pane,
 * which issues one of these per selected PR).
 *
 *  - `review` approves a TriagePr. The classification becomes `manual`, which
 *    is what `qualifiesForReview` reads on every later cycle. A draft stays in
 *    triage carrying that approval, so it queues by itself when it leaves
 *    draft state rather than being reviewed early.
 *  - `review-anyway` is R2.3's explicit override and queues a draft now.
 *  - `skip` is sticky. New commits never resurrect it; only `unskip` does.
 *  - `unskip` returns a PR to triage, not to the queue. Un-skipping says "let
 *    me look at this again", and the decision that follows is a separate
 *    deliberate act.
 *
 * `meta.md` is written either way; the queue is nudged as well when there is
 * one, so a decision takes effect now instead of at the next poll.
 */
const decision: RouteHandler = async ({ req, params, deps }) => {
  const ref = parseRef(params);
  if (!ref) return fail(400, "bad-ref", "owner, repo and number must name one pull request");

  const body = await readJsonBody(req);
  if (!body) return fail(400, "bad-body", "expected a JSON object");

  const action = body.action;
  if (typeof action !== "string" || !DECISION_ACTIONS.includes(action as DecisionAction)) {
    return fail(400, "bad-action", `action must be one of ${DECISION_ACTIONS.join(", ")}`);
  }

  const meta = await loadMeta(deps.lgtmDir, ref);
  if (!meta) return fail(404, "unknown-pr", `${formatRef(ref)} is not in the store`);

  if (meta.closedAt !== null && action !== "unskip") {
    return fail(409, "closed", `${formatRef(ref)} is closed`);
  }

  let patch: MetaUpdate;
  let enqueue = false;

  switch (action as DecisionAction) {
    case "review":
      // A draft keeps waiting, but now with a human's approval recorded, so
      // the "left draft state" branch of the next cycle queues it (R2.3).
      patch = meta.draft
        ? { classification: "manual", state: "triage" }
        : { classification: "manual", state: "queued", failedAttempts: 0 };
      enqueue = !meta.draft;
      break;

    case "review-anyway":
      patch = { classification: "manual", state: "queued", failedAttempts: 0 };
      enqueue = true;
      break;

    case "skip":
      patch = { state: "skipped" };
      break;

    case "unskip":
      if (meta.state !== "skipped") {
        return fail(409, "not-skipped", `${formatRef(ref)} is ${meta.state}, not skipped`);
      }
      patch = { state: "triage" };
      break;
  }

  const saved = await saveMeta(deps.lgtmDir, ref, patch);

  if (action === "skip") deps.queue?.remove(ref);
  if (enqueue && saved.headSha) deps.queue?.enqueue(ref, saved.headSha);

  emit(deps, { type: "pr-changed", ref });

  return json({
    ref,
    key: formatRef(ref),
    action,
    state: saved.state,
    classification: saved.classification,
    reviewsWhenReady: reviewsWhenReady(saved),
    queued: enqueue && saved.headSha !== "",
  });
};

// ─── GET /api/prs/:owner/:repo/:number/findings ─────────────────────────────

export interface FindingCard {
  /** The canonical key, `r2:reviewer:f1`. The only handle the PATCH route accepts. */
  key: string;
  id: string;
  round: number;
  agent: string;
  severity: Severity;
  file: string;
  line: number;
  comment: string;
  suggestion: string | null;
  state: Finding["state"];
  heldReason: string | null;
  /** About ten lines around the finding, sliced from its own round's snapshot. */
  hunk: SlicedHunk | null;
  /** Why there is no hunk, so the card can say so instead of rendering an empty box. */
  hunkFallback: "no-snapshot" | "line-not-in-diff" | null;
  /** GitHub, at the SHA this round reviewed. What the card links to when it has no hunk (R5.1, R5.3). */
  githubUrl: string;
}

/**
 * A finding's hunk comes from the diff snapshot of *its own round*, not from
 * the PR's latest one.
 *
 * `diff-<sha>.patch` is written per reviewed head SHA (design.md, "Store
 * layout"). Round 1's finding at `src/limiter.ts:118` describes line 118 as
 * it was when round 1 ran; slicing it out of round 3's diff would show
 * whatever is at line 118 now, which is a different piece of code presented
 * as the reviewer's evidence. When the snapshot for a round's SHA is gone,
 * pruned or never written, the card falls back to the GitHub link rather
 * than to a newer diff.
 */
async function readSnapshot(
  deps: ApiDeps,
  ref: PRRef,
  sha: string,
  cache: Map<string, ReturnType<typeof parseDiff> | null>
): Promise<ReturnType<typeof parseDiff> | null> {
  if (cache.has(sha)) return cache.get(sha) ?? null;

  let parsed: ReturnType<typeof parseDiff> | null = null;
  // Round files are hand-editable, and this value becomes a path. A SHA that
  // is not a SHA reads as "no snapshot" rather than as a filename.
  if (HEX_SHA.test(sha)) {
    try {
      const raw = await fs.readFile(diffSnapshotPath(deps.lgtmDir, ref, sha), "utf-8");
      parsed = parseDiff(raw);
    } catch {
      parsed = null;
    }
  }

  cache.set(sha, parsed);
  return parsed;
}

/** A permalink to the line as the round saw it, which a PR-files anchor cannot promise. */
function findingUrl(ref: PRRef, sha: string, finding: Finding): string {
  if (!sha || !finding.file) return `${prUrl(ref)}/files`;
  const file = finding.file.split("/").map(encodeURIComponent).join("/");
  return `https://github.com/${ref.owner}/${ref.repo}/blob/${sha}/${file}#L${finding.line}`;
}

const findings: RouteHandler = async ({ params, deps }) => {
  const ref = parseRef(params);
  if (!ref) return fail(400, "bad-ref", "owner, repo and number must name one pull request");

  const meta = await loadMeta(deps.lgtmDir, ref);
  if (!meta) return fail(404, "unknown-pr", `${formatRef(ref)} is not in the store`);

  const cache = new Map<string, ReturnType<typeof parseDiff> | null>();
  const counts = emptyCounts();

  const rounds = [];
  for (const round of await loadAllRounds(deps.lgtmDir, ref)) {
    countFindings(round.findings, counts);
    const diff = await readSnapshot(deps, ref, round.headSha, cache);

    const cards: FindingCard[] = round.findings.map((finding) => {
      const hunk = diff ? sliceHunk(diff, finding.file, finding.line) : null;

      return {
        key: formatFindingKey({ round: round.round, agent: round.agent, id: finding.id }),
        id: finding.id,
        round: round.round,
        agent: round.agent,
        severity: finding.severity,
        file: finding.file,
        line: finding.line,
        comment: finding.comment,
        suggestion: finding.suggestion ?? null,
        state: finding.state,
        heldReason: finding.heldReason ?? null,
        hunk,
        hunkFallback: hunk ? null : diff ? "line-not-in-diff" : "no-snapshot",
        githubUrl: findingUrl(ref, round.headSha, finding),
      };
    });

    rounds.push({
      round: round.round,
      agent: round.agent,
      provider: round.provider,
      status: round.status,
      headSha: round.headSha,
      startedAt: round.startedAt,
      durationMs: round.durationMs,
      hasSnapshot: diff !== null,
      findings: cards,
    });
  }

  return json({
    ref,
    key: formatRef(ref),
    pr: {
      url: meta.url,
      title: meta.title,
      author: meta.author,
      state: meta.state,
      classification: meta.classification,
      draft: meta.draft,
      headSha: meta.headSha,
      lastReviewedSha: meta.lastReviewedSha,
      pendingReviewId: meta.pendingReviewId,
      closedAt: meta.closedAt,
      reviewsWhenReady: reviewsWhenReady(meta),
    },
    counts,
    rounds,
  });
};

// ─── PATCH /api/prs/:owner/:repo/:number/findings/:key ──────────────────────

/**
 * The Gate, as one request: discard a finding, or put it back (R5.2).
 *
 * `:key` is the canonical `r2:reviewer:f1`. Nothing else is accepted, and the
 * store's mutators are called with that full triple, because finding ids
 * restart at f1 in every round file and matching a bare id corrupted other
 * rounds in the old codebase (R9.3).
 *
 * `posted` and `held` are not reachable from here. Both are the post flow's
 * to set, from what GitHub accepted.
 */
const patchFinding: RouteHandler = async ({ req, params, deps }) => {
  const ref = parseRef(params);
  if (!ref) return fail(400, "bad-ref", "owner, repo and number must name one pull request");

  const printed = params.key ?? "";
  const key = parseFindingKey(printed);
  if (!key) {
    return fail(400, "bad-key", `"${printed}" is not a finding key; use the r2:reviewer:f1 form`);
  }
  // Round-trip so the store is asked about exactly the canonical rendering,
  // whatever spacing or encoding the URL carried.
  const canonical = formatFindingKey(key);

  const body = await readJsonBody(req);
  if (!body) return fail(400, "bad-body", "expected a JSON object");

  const target = body.state;
  if (target !== "discarded" && target !== "open") {
    return fail(400, "bad-state", "state must be discarded or open");
  }

  const meta = await loadMeta(deps.lgtmDir, ref);
  if (!meta) return fail(404, "unknown-pr", `${formatRef(ref)} is not in the store`);

  const rounds = await loadAllRounds(deps.lgtmDir, ref);
  const owning = rounds.find((round) => round.round === key.round && round.agent === key.agent);
  const existing = owning?.findings.find((finding) => finding.id === key.id);
  if (!existing) {
    return fail(404, "unknown-finding", `${formatRef(ref)} has no finding ${canonical}`);
  }

  if (existing.state === target) {
    return json({ ref, key: canonical, state: target, changed: false });
  }

  const changed =
    target === "discarded"
      ? await markFindingsDiscarded(deps.lgtmDir, ref, [canonical])
      : await markFindingsOpen(deps.lgtmDir, ref, [canonical]);

  if (changed.length === 0) {
    // The store refused the transition. A posted finding cannot be discarded
    // here, because it is already on GitHub, and a held one is mid-validation.
    return fail(
      409,
      "refused",
      `${canonical} is ${existing.state} and cannot be moved to ${target} from here`
    );
  }

  emit(deps, { type: "pr-changed", ref });

  return json({ ref, key: canonical, state: target, changed: true });
};

// ─── /api/watchlist ─────────────────────────────────────────────────────────

const listWatchlist: RouteHandler = async ({ deps }) => {
  const entries = await loadWatchList(deps.lgtmDir);

  return json({
    repos: entries.map((entry) => ({
      owner: entry.owner,
      repo: entry.repo,
      key: repoKey(entry.owner, entry.repo),
      addedAt: entry.addedAt,
      lastPolledAt: entry.lastPolledAt ?? null,
      // Presence only; the validator itself is the adapter's business.
      conditional: entry.etag !== undefined,
    })),
  });
};

/**
 * Read the repo out of a body or a query string.
 *
 * Two spellings, because two callers exist: `{owner, repo}` from a scripted
 * client, and the single `owner/repo` string the UI's add field and
 * `lgtm watch add` both take. Anything with more than one slash in it is
 * refused outright rather than trimmed down to its first two parts, which is
 * what keeps `../../etc` from being read as a repo named `..`.
 */
function readRepoArg(body: JsonBody, url: URL): { owner: string; repo: string } | null {
  const field = (value: unknown, param: string): string =>
    (typeof value === "string" ? value : (url.searchParams.get(param) ?? "")).trim();

  let owner = field(body.owner, "owner");
  let repo = field(body.repo, "repo");

  if (repo.includes("/")) {
    const parts = repo.split("/");
    if (parts.length !== 2) return null;
    owner = parts[0] ?? "";
    repo = parts[1] ?? "";
  }

  if (!REPO_SEGMENT.test(owner) || !REPO_SEGMENT.test(repo)) return null;
  return { owner, repo };
}

function backfillRow(entry: BackfillEntry) {
  return {
    ref: entry.ref,
    key: formatRef(entry.ref),
    url: entry.detail.url,
    title: entry.detail.title,
    author: entry.detail.author,
    draft: entry.detail.draft,
    createdAt: entry.detail.createdAt,
    updatedAt: entry.detail.updatedAt,
    headSha: entry.detail.headSha,
    additions: entry.detail.additions,
    deletions: entry.detail.deletions,
    changedFiles: entry.detail.changedFiles,
    // null is "GitHub is still computing it", never a conflict (R2.5).
    mergeable: mergeableStatus(entry.detail.mergeable),
    checks: { state: entry.checkStatus.state, runs: entry.checkStatus.runs.length },
    classification: entry.classification,
    autoClass: entry.autoClass,
    preSelected: entry.preSelected,
  };
}

/**
 * Add a repo, backfilling its open PRs first (R2.6).
 *
 * The whole thing delegates to `addRepoWithBackfill`, and that is deliberate:
 * it is the one function allowed to add a repo to `watch.md`, because it
 * writes every open PR's triage `meta.md` *before* the repo joins the polled
 * set. Reverse those two and the next poll cycle sees a repo full of unknown
 * PRs and auto-queues the auto-class ones immediately, ahead of the confirm
 * pane that R2.6 says has to come first. So this handler must never call
 * `addToWatchList` itself, however tempting the shortcut looks.
 *
 * The response is the confirm pane's data. Nothing is queued here; the pane
 * issues one `POST .../decision` per selected PR.
 */
const addWatchlist: RouteHandler = async ({ req, url, deps }) => {
  const body = await readJsonBody(req);
  if (!body) return fail(400, "bad-body", "expected a JSON object");

  const target = readRepoArg(body, url);
  if (!target) return fail(400, "bad-repo", "expected owner/repo");

  if (!deps.forge) {
    return fail(503, "no-forge", "this daemon has no Forge adapter, so it cannot backfill a repo");
  }

  const already = (await loadWatchList(deps.lgtmDir)).some(
    (entry) => entry.owner === target.owner && entry.repo === target.repo
  );

  let result;
  try {
    result = await addRepoWithBackfill(deps.lgtmDir, deps.forge, target);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    emit(deps, { type: "error", cause: `watchlist add: ${message}` });
    return fail(502, "backfill-failed", message);
  }

  // The bus carries no watchlist event, and the SPA treats every event as an
  // invalidation hint anyway, so the repo's own key is the honest signal.
  emit(deps, { type: "cycle-finished", repoKey: repoKey(target.owner, target.repo) });

  return json(
    {
      repo: target,
      key: repoKey(target.owner, target.repo),
      // False when the repo was already watched; the backfill still ran and
      // reconciled, it just had nothing new to report (R9.5).
      added: !already,
      entries: result.entries.map(backfillRow),
    },
    already ? 200 : 201
  );
};

/**
 * Stop polling a repo. Its reviews stay on disk and its PRs leave the active
 * views, which `/api/prs` does by filtering on watch-list membership (R9.5).
 */
const removeWatchlist: RouteHandler = async ({ req, url, deps }) => {
  const body = await readJsonBody(req);
  if (!body) return fail(400, "bad-body", "expected a JSON object");

  const target = readRepoArg(body, url);
  if (!target) return fail(400, "bad-repo", "expected owner/repo");

  const removed = await removeFromWatchList(target.owner, target.repo, deps.lgtmDir);
  if (removed) emit(deps, { type: "cycle-finished", repoKey: repoKey(target.owner, target.repo) });

  return json({ repo: target, key: repoKey(target.owner, target.repo), removed });
};

// ─── /api/config ────────────────────────────────────────────────────────────

function configAccess(deps: ApiDeps) {
  return deps.config ?? { load: loadConfig, update: updateConfig };
}

const readConfig: RouteHandler = async ({ deps }) => {
  const config = await configAccess(deps).load();
  return json({ config, defaults: DEFAULTS });
};

const NUMERIC_CONFIG_FIELDS = [
  "interval_minutes",
  "pause_above_pct",
  "resume_below_pct",
  "daily_cap",
  "concurrency",
] as const;

const PATH_CONFIG_FIELDS = ["claude_path", "gh_path"] as const;

/**
 * Bounds, not preferences. Every one of these is a value that would either
 * hang the daemon or hot-loop it if a typo reached the file. A zero interval
 * polls forever. A zero concurrency queues work that nothing ever runs.
 */
const NUMERIC_BOUNDS: Record<(typeof NUMERIC_CONFIG_FIELDS)[number], { min: number; max: number }> = {
  interval_minutes: { min: 1, max: 24 * 60 },
  pause_above_pct: { min: 1, max: 100 },
  resume_below_pct: { min: 0, max: 100 },
  daily_cap: { min: 0, max: 1000 },
  concurrency: { min: 1, max: 8 },
};

/**
 * Update config.md. An unknown key is a 400, never a silent drop. A typo in
 * a field name that succeeds quietly looks exactly like a setting that does
 * not work.
 *
 * A `null` path pin clears it, which is how the settings view removes a
 * manual override and lets the login-shell probe take over again (R7.3).
 */
const patchConfig: RouteHandler = async ({ req, deps }) => {
  const body = await readJsonBody(req);
  if (!body) return fail(400, "bad-body", "expected a JSON object");

  const updates: Partial<Config> = {};

  for (const [field, raw] of Object.entries(body)) {
    if ((NUMERIC_CONFIG_FIELDS as readonly string[]).includes(field)) {
      const name = field as (typeof NUMERIC_CONFIG_FIELDS)[number];
      if (typeof raw !== "number" || !Number.isFinite(raw)) {
        return fail(400, "bad-value", `${name} must be a number`);
      }
      const bounds = NUMERIC_BOUNDS[name];
      if (raw < bounds.min || raw > bounds.max) {
        return fail(400, "bad-value", `${name} must be between ${bounds.min} and ${bounds.max}`);
      }
      updates[name] = raw;
      continue;
    }

    if ((PATH_CONFIG_FIELDS as readonly string[]).includes(field)) {
      const name = field as (typeof PATH_CONFIG_FIELDS)[number];
      if (raw === null || raw === "") {
        updates[name] = undefined;
        continue;
      }
      if (typeof raw !== "string" || !raw.startsWith("/")) {
        return fail(400, "bad-value", `${name} must be an absolute path, or null to clear it`);
      }
      updates[name] = raw;
      continue;
    }

    return fail(400, "unknown-field", `config has no field named ${field}`);
  }

  const access = configAccess(deps);
  await access.update(updates);
  const config = await access.load();

  // The quota gate's hysteresis and the scheduler's interval are held in
  // memory; without this they would keep running the old numbers until the
  // next restart, and the settings view would look like it did nothing.
  try {
    deps.onConfigChange?.(config);
  } catch {
    // A daemon that cannot re-arm still wrote the file. Report the write.
  }

  return json({ config, defaults: DEFAULTS });
};

// ─── The table ──────────────────────────────────────────────────────────────

/**
 * Every route the daemon serves, in design.md's own order.
 *
 * `bearer` is false on exactly one row and `mutating` tracks the method
 * exactly; server.test.ts asserts both of those as invariants over this
 * array, so a new route cannot opt itself out of the token check or forget
 * the Origin check by declaring the wrong flags.
 */
export function apiRoutes(): RouteDef[] {
  return [
    {
      method: "GET",
      path: PUBLIC_ROUTE_PATH,
      name: "health",
      bearer: false,
      mutating: false,
      queryToken: false,
      handler: health,
    },
    {
      method: "GET",
      path: "/api/status",
      name: "status",
      bearer: true,
      mutating: false,
      queryToken: false,
      handler: status,
    },
    {
      method: "GET",
      path: "/api/events",
      name: "events",
      bearer: true,
      mutating: false,
      // EventSource cannot set an Authorization header. The only route where
      // that is true, and the only one that opts in.
      queryToken: true,
      handler: events,
    },
    {
      method: "GET",
      path: "/api/prs",
      name: "prs.list",
      bearer: true,
      mutating: false,
      queryToken: false,
      handler: listPRs,
    },
    {
      method: "POST",
      path: "/api/prs/:owner/:repo/:number/decision",
      name: "prs.decision",
      bearer: true,
      mutating: true,
      queryToken: false,
      handler: decision,
    },
    {
      method: "GET",
      path: "/api/prs/:owner/:repo/:number/findings",
      name: "prs.findings",
      bearer: true,
      mutating: false,
      queryToken: false,
      handler: findings,
    },
    {
      method: "PATCH",
      path: "/api/prs/:owner/:repo/:number/findings/:key",
      name: "prs.findings.patch",
      bearer: true,
      mutating: true,
      queryToken: false,
      handler: patchFinding,
    },

    // The two forge-writing rows live in src/api/post.ts and are spliced in
    // here, which is what puts them under the auth choke point and inside the
    // matrix test. There is no other way in, on purpose.
    ...postRoutes(),

    {
      method: "GET",
      path: "/api/watchlist",
      name: "watchlist.list",
      bearer: true,
      mutating: false,
      queryToken: false,
      handler: listWatchlist,
    },
    {
      method: "POST",
      path: "/api/watchlist",
      name: "watchlist.add",
      bearer: true,
      mutating: true,
      queryToken: false,
      handler: addWatchlist,
    },
    {
      method: "DELETE",
      path: "/api/watchlist",
      name: "watchlist.remove",
      bearer: true,
      mutating: true,
      queryToken: false,
      handler: removeWatchlist,
    },
    {
      method: "GET",
      path: "/api/config",
      name: "config.read",
      bearer: true,
      mutating: false,
      queryToken: false,
      handler: readConfig,
    },
    {
      method: "PATCH",
      path: "/api/config",
      name: "config.patch",
      bearer: true,
      mutating: true,
      queryToken: false,
      handler: patchConfig,
    },
  ];
}

// ─── Matching ───────────────────────────────────────────────────────────────

export interface RouteMatch {
  route: RouteDef;
  params: Record<string, string>;
}

/**
 * Match one path against one pattern. Segment counts must agree, so
 * `/findings` and `/findings/:key` cannot collide, and a `:param` never spans
 * a `/`.
 */
function matchPath(pattern: string, pathname: string): Record<string, string> | null {
  const patternParts = pattern.split("/");
  const pathParts = pathname.split("/");
  if (patternParts.length !== pathParts.length) return null;

  const params: Record<string, string> = {};

  for (let i = 0; i < patternParts.length; i++) {
    const expected = patternParts[i] ?? "";
    const actual = pathParts[i] ?? "";

    if (expected.startsWith(":")) {
      if (actual === "") return null;
      let decoded: string;
      try {
        decoded = decodeURIComponent(actual);
      } catch {
        // A malformed percent-escape is not this segment's value; refusing
        // the match turns it into a 404 rather than a thrown request.
        return null;
      }
      params[expected.slice(1)] = decoded;
      continue;
    }

    if (expected !== actual) return null;
  }

  return params;
}

/**
 * Find the route for a request.
 *
 * Returns `"method-not-allowed"` when a path matches but no route on it takes
 * this method, so the server can answer 405 with an `Allow` header instead of
 * a 404 that reads like a typo.
 */
export function matchRoute(
  routes: RouteDef[],
  method: string,
  pathname: string
): RouteMatch | "method-not-allowed" | null {
  let pathMatched = false;

  for (const route of routes) {
    const params = matchPath(route.path, pathname);
    if (params === null) continue;
    pathMatched = true;
    if (route.method === method) return { route, params };
  }

  return pathMatched ? "method-not-allowed" : null;
}

/** Every method a path accepts, for the `Allow` header on a 405. */
export function allowedMethods(routes: RouteDef[], pathname: string): string[] {
  return routes.filter((route) => matchPath(route.path, pathname) !== null).map((route) => route.method);
}

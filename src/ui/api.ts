/**
 * Typed HTTP client for the daemon's API (design.md, "HTTP API").
 *
 * Two things make this file worth having instead of scattered `fetch` calls:
 *
 * 1. Token lifecycle. `lgtm open` launches the browser at
 *    `http://127.0.0.1:<port>/#t=<token>` (R7.2). On load, `resolveToken`
 *    reads that fragment, hands the token to storage, and strips it with
 *    `history.replaceState` so it never sits in the address bar, browser
 *    history, or a screen-share. A later load with no fragment (a bookmark,
 *    a refresh) falls back to the stored copy. A token GitHub^H^H^H the
 *    daemon rejects — a stale token from a previous `lgtm up`, since the
 *    token file is regenerated only when it goes missing (rendezvous.ts) —
 *    flips `authState` to "unauthenticated" instead of leaving the caller to
 *    render a blank screen; every view in this SPA is expected to check that
 *    state and show the "run lgtm open to reauthenticate" message rather
 *    than an empty page.
 * 2. One coercion layer. The daemon's responses are read the same way the
 *    store reads hand-editable frontmatter (store/reviews.ts): defensively,
 *    with defaults for absent fields, never a thrown TypeError from a
 *    response shaped slightly differently than expected. A dropped network
 *    connection and a malformed field both end up as a typed `ApiError`
 *    instead of an uncaught rejection.
 *
 * Every browser global this module touches (fetch, localStorage, location,
 * history) is an injectable seam, following the same pattern as the
 * scheduler's Clock/Ticker and the queue's setTimer: real globals by
 * default, stubs in tests. Nothing here calls a global synchronously at
 * module load time, so importing this file is always safe, including under
 * `bun test`, which has no DOM.
 */

import type {
  Classification,
  FindingState,
  PRRef,
  PRState,
  RepoRef,
  Severity,
} from "@/core";
import type { SlicedHunk } from "@/core/diff";

// ─── Injectable browser seams ───────────────────────────────────────────────

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface LocationLike {
  hash: string;
  pathname: string;
  search: string;
}

export interface HistoryLike {
  replaceState(data: unknown, unused: string, url?: string | URL | null): void;
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

function memoryStorage(): StorageLike {
  const mem = new Map<string, string>();
  return {
    getItem: (key) => mem.get(key) ?? null,
    setItem: (key, value) => {
      mem.set(key, value);
    },
    removeItem: (key) => {
      mem.delete(key);
    },
  };
}

// typeof on an undeclared global identifier never throws (ECMA-262
// unresolvable-reference rule), so these are safe to evaluate even where the
// DOM does not exist. Called lazily, at client-construction time, never at
// module scope, so importing this file never touches a global.
function defaultStorage(): StorageLike {
  return typeof localStorage !== "undefined" ? localStorage : memoryStorage();
}

function defaultLocation(): LocationLike {
  return typeof location !== "undefined" ? location : { hash: "", pathname: "/", search: "" };
}

function defaultHistory(): HistoryLike {
  return typeof history !== "undefined" ? history : { replaceState() {} };
}

// ─── Token lifecycle ─────────────────────────────────────────────────────────

const TOKEN_STORAGE_KEY = "lgtm.token";
const TOKEN_HASH_PATTERN = /(?:^|[#&])t=([^&]*)/;

/**
 * Read the bearer token for this page load and leave the URL clean.
 *
 * A token in the fragment always wins over a stored one — it is the newest
 * proof of intent, `lgtm open` just ran — and is written to storage and
 * scrubbed from the URL in the same pass, so a reload of the *same* tab
 * still authenticates (from storage) even though the fragment is gone.
 */
export function resolveToken(loc: LocationLike, storage: StorageLike, hist: HistoryLike): string | null {
  const match = TOKEN_HASH_PATTERN.exec(loc.hash);
  const fromHash = match?.[1] ? decodeURIComponent(match[1]) : null;

  if (fromHash) {
    storage.setItem(TOKEN_STORAGE_KEY, fromHash);
    hist.replaceState(null, "", loc.pathname + loc.search);
    return fromHash;
  }

  return storage.getItem(TOKEN_STORAGE_KEY);
}

// ─── Errors ─────────────────────────────────────────────────────────────────

export type ApiErrorKind = "unauthenticated" | "network" | "http";

export const REAUTH_MESSAGE = "Run `lgtm open` to reauthenticate.";

export class ApiError extends Error {
  readonly kind: ApiErrorKind;
  readonly status: number | undefined;

  constructor(kind: ApiErrorKind, message: string, status?: number) {
    super(message);
    this.name = "ApiError";
    this.kind = kind;
    this.status = status;
  }
}

function toApiError(err: unknown): ApiError {
  if (err instanceof ApiError) return err;
  const message = err instanceof Error ? err.message : String(err);
  return new ApiError("network", message);
}

// ─── Response shapes ────────────────────────────────────────────────────────
//
// These mirror design.md's "HTTP API" table. The server that produces them is
// a separate task landing on this same branch, so every parser below is
// tolerant of missing or oddly-typed fields on purpose (the same posture
// store/reviews.ts takes with hand-edited frontmatter): a response that is
// merely incomplete degrades a field to a safe default instead of blanking
// the page.

export interface HealthResponse {
  app: string;
  version: string;
  pid: number;
}

export interface StatusCycleInfo {
  at: string;
  outcome: "ok" | "error";
}

export type QuotaMode = "ok" | "throttled" | "fallback";

export interface StatusResponse {
  uptimeMs: number;
  startedAt: string | null;
  intervalMinutes: number;
  lastCycle: StatusCycleInfo | null;
  nextPollAt: string | null;
  queueLength: number;
  triageCount: number;
  awaitingGate: number;
  quotaMode: QuotaMode;
  claudePath: string | null;
  ghPath: string | null;
}

export type CheckState = "success" | "failure" | "pending" | "none";

export type FindingCounts = Record<Severity, number>;

export const SEVERITY_ORDER: readonly Severity[] = ["critical", "high", "medium", "low"];

export function emptyFindingCounts(): FindingCounts {
  return { critical: 0, high: 0, medium: 0, low: 0 };
}

export function totalFindings(counts: FindingCounts): number {
  return SEVERITY_ORDER.reduce((sum, sev) => sum + counts[sev], 0);
}

/** One row of `GET /api/prs`: meta plus the triage metadata R2.5 asks the Reviews view to show. */
export interface PRListItem {
  owner: string;
  repo: string;
  number: number;
  url: string;
  title: string;
  author: string;
  state: PRState;
  classification: Classification;
  draft: boolean;
  headSha: string;
  createdAt: string | null;
  closedAt: string | null;
  pendingReviewId: number | null;
  failedAttempts: number;
  additions: number | null;
  deletions: number | null;
  changedFiles: number | null;
  /** Null while GitHub is still computing it — renders as "computing", never as a conflict (design.md, ForgeAdapter). */
  mergeable: boolean | null;
  /** Null when CI status was never fetched for this PR (only triage PRs get it). */
  checkStatus: CheckState | null;
  /** Ungated (open + held) findings by severity. All zero for a PR with no rounds yet. */
  findingCounts: FindingCounts;
}

/**
 * The three server-side filters `/api/prs` accepts (design.md, "HTTP API";
 * exact values in src/api/routes.ts's `listPRs`). `state` and `withFindings`
 * are mutually meaningful — "ready to gate" cuts across states rather than
 * naming one — so both are optional and either, both, or neither may be
 * set alongside `closed`.
 */
export interface PRListFilter {
  state?: PRState | PRState[];
  /** `exclude` | `include` | `only`; the server defaults to `exclude` when omitted. */
  closed?: "exclude" | "include" | "only";
  /** Only PRs with findings still in front of the Gate (open or held). */
  withFindings?: boolean;
}

/** One finding as the findings endpoint renders it: the round's data plus its sliced hunk. */
export interface FindingWithContext {
  /** Canonical `r<round>:<agent>:<id>` form — see @/core's FindingKey. */
  key: string;
  round: number;
  agent: string;
  /** The head SHA the round that produced this finding actually reviewed, for an accurate GitHub deep link. */
  headSha: string;
  severity: Severity;
  file: string;
  line: number;
  comment: string;
  suggestion: string | null;
  state: FindingState;
  heldReason: string | null;
  /** Null when the round's diff snapshot is missing; the GitHub link is the fallback (design.md, ForgeAdapter). */
  hunk: SlicedHunk | null;
}

export interface PRDetailMeta {
  owner: string;
  repo: string;
  number: number;
  url: string;
  title: string;
  author: string;
  classification: Classification;
  state: PRState;
  headSha: string;
  draft: boolean;
}

export interface PRFindingsResponse {
  meta: PRDetailMeta;
  findings: FindingWithContext[];
}

export type PRDecisionAction = "review" | "skip" | "unskip" | "review-anyway";

export interface FindingVerdict {
  key: string;
  valid: boolean;
  reason: string | null;
}

export interface PostResult {
  posted: string[];
  held: Array<{ key: string; reason: string }>;
  pendingReviewId: number | null;
  reviewUrl: string | null;
}

export interface WatchEntry {
  owner: string;
  repo: string;
  addedAt: string;
  lastPolledAt: string | null;
}

/** The settings themselves. */
export interface ConfigValues {
  interval_minutes: number;
  pause_above_pct: number;
  resume_below_pct: number;
  daily_cap: number;
  concurrency: number;
  claude_path?: string;
  gh_path?: string;
}

/**
 * What `/api/config` actually answers. The daemon sends the current values
 * beside the built-in defaults, so the settings view can show what a field
 * would fall back to. Declaring this flat made the type a lie that happened
 * to work, since the body was passed through unread.
 */
export interface ConfigResponse {
  config: ConfigValues;
  defaults: ConfigValues;
}

// ─── Coercion helpers ───────────────────────────────────────────────────────
// Same spirit as store/reviews.ts's normaliseFindings / loadMeta: never trust
// external input to be exactly the declared shape.

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function str(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function nullableStr(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function num(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function nullableNum(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function nullableBool(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

const SEVERITIES: ReadonlySet<string> = new Set<Severity>(["low", "medium", "high", "critical"]);
function severity(value: unknown, fallback: Severity = "medium"): Severity {
  return typeof value === "string" && SEVERITIES.has(value) ? (value as Severity) : fallback;
}

const PR_STATES: ReadonlySet<string> = new Set<PRState>([
  "triage",
  "skipped",
  "queued",
  "reviewing",
  "reviewed",
  "failed",
  "closed",
]);
function prState(value: unknown, fallback: PRState = "triage"): PRState {
  return typeof value === "string" && PR_STATES.has(value) ? (value as PRState) : fallback;
}

const CLASSIFICATIONS: ReadonlySet<string> = new Set<Classification>([
  "own",
  "requested",
  "assigned",
  "mentioned",
  "manual",
  "none",
]);
function classification(value: unknown, fallback: Classification = "none"): Classification {
  return typeof value === "string" && CLASSIFICATIONS.has(value) ? (value as Classification) : fallback;
}

const CHECK_STATES: ReadonlySet<string> = new Set<CheckState>(["success", "failure", "pending", "none"]);
function checkState(value: unknown): CheckState | null {
  return typeof value === "string" && CHECK_STATES.has(value) ? (value as CheckState) : null;
}

const FINDING_STATES: ReadonlySet<string> = new Set<FindingState>(["open", "discarded", "posted", "held"]);
function findingState(value: unknown, fallback: FindingState = "open"): FindingState {
  return typeof value === "string" && FINDING_STATES.has(value) ? (value as FindingState) : fallback;
}

function findingCounts(value: unknown): FindingCounts {
  const rec = asRecord(value);
  return {
    critical: num(rec.critical),
    high: num(rec.high),
    medium: num(rec.medium),
    low: num(rec.low),
  };
}

/**
 * Flatten one row of `GET /api/prs`.
 *
 * The server nests the reference under `ref` and reports findings as a full
 * lifecycle breakdown under `findings`, with the severities the gate cares
 * about in `findings.pendingBySeverity`. This view wants a flat row, so the
 * translation happens here rather than in every component. Reading the flat
 * keys as a fallback keeps a server that ever inlines them working too.
 */
function toPRListItem(raw: unknown): PRListItem {
  const rec = asRecord(raw);
  const ref = asRecord(rec.ref);
  const findings = asRecord(rec.findings);
  return {
    owner: str(ref.owner ?? rec.owner),
    repo: str(ref.repo ?? rec.repo),
    number: num(ref.number ?? rec.number),
    url: str(rec.url),
    title: str(rec.title, "untitled"),
    author: str(rec.author),
    state: prState(rec.state),
    classification: classification(rec.classification),
    draft: rec.draft === true,
    headSha: str(rec.headSha),
    createdAt: nullableStr(rec.createdAt),
    closedAt: nullableStr(rec.closedAt),
    pendingReviewId: nullableNum(rec.pendingReviewId),
    failedAttempts: typeof rec.failedAttempts === "number" ? rec.failedAttempts : 0,
    additions: nullableNum(rec.additions),
    deletions: nullableNum(rec.deletions),
    changedFiles: nullableNum(rec.changedFiles),
    mergeable: nullableBool(rec.mergeable),
    checkStatus: checkState(rec.checkStatus),
    findingCounts: findingCounts(findings.pendingBySeverity ?? rec.findingCounts),
  };
}

function toSlicedHunk(raw: unknown): SlicedHunk | null {
  if (!raw || typeof raw !== "object") return null;
  const rec = asRecord(raw);
  if (!Array.isArray(rec.lines)) return null;
  return {
    header: str(rec.header),
    lines: rec.lines.map((l) => {
      const line = asRecord(l);
      const type = line.type === "added" || line.type === "removed" ? line.type : "context";
      return {
        type,
        content: str(line.content),
        oldLine: nullableNum(line.oldLine),
        newLine: nullableNum(line.newLine),
      };
    }),
  };
}

function toFinding(raw: unknown): FindingWithContext {
  const rec = asRecord(raw);
  return {
    key: str(rec.key),
    round: num(rec.round),
    agent: str(rec.agent),
    headSha: str(rec.headSha),
    severity: severity(rec.severity),
    file: str(rec.file),
    line: num(rec.line),
    comment: str(rec.comment),
    suggestion: nullableStr(rec.suggestion),
    state: findingState(rec.state),
    heldReason: nullableStr(rec.heldReason),
    hunk: toSlicedHunk(rec.hunk),
  };
}

function toPRDetailMeta(raw: unknown): PRDetailMeta {
  const rec = asRecord(raw);
  return {
    owner: str(rec.owner),
    repo: str(rec.repo),
    number: num(rec.number),
    url: str(rec.url),
    title: str(rec.title, "untitled"),
    author: str(rec.author),
    classification: classification(rec.classification),
    state: prState(rec.state),
    headSha: str(rec.headSha),
    draft: rec.draft === true,
  };
}

function toPRFindingsResponse(raw: unknown): PRFindingsResponse {
  const rec = asRecord(raw);
  const findings = Array.isArray(rec.findings) ? rec.findings.map(toFinding) : [];
  return { meta: toPRDetailMeta(rec.meta), findings };
}

function toStatusResponse(raw: unknown): StatusResponse {
  const rec = asRecord(raw);
  // The daemon nests: scheduler, queue, quota, binaries and counts are each
  // their own object. Reading flat keys off the top level found nothing and
  // fell back to the defaults below, so the health panel showed a plausible
  // interval and an empty queue no matter what the daemon was doing.
  const scheduler = asRecord(rec.scheduler);
  const queue = asRecord(rec.queue);
  const quota = asRecord(rec.quota);
  const counts = asRecord(rec.counts);
  const cycle = asRecord(scheduler.lastCycleOutcome);
  const binaries = Array.isArray(rec.binaries) ? rec.binaries.map(asRecord) : [];
  const pathOf = (name: string): string | null => {
    const hit = binaries.find((b) => b.name === name);
    return hit ? nullableStr(hit.path) : null;
  };
  const mode = quota.mode;

  return {
    uptimeMs: num(rec.uptimeMs),
    startedAt: nullableStr(rec.startedAt),
    intervalMinutes: num(scheduler.intervalMinutes, 15),
    lastCycle: scheduler.lastCycleAt
      ? { at: str(scheduler.lastCycleAt), outcome: cycle.status === "error" ? "error" : "ok" }
      : null,
    nextPollAt: nullableStr(scheduler.nextCycleAt),
    queueLength: num(queue.queued) + num(queue.inFlight),
    triageCount: num(counts.triage),
    awaitingGate: num(counts.awaitingGate),
    quotaMode: mode === "throttled" || mode === "fallback" ? mode : "ok",
    claudePath: pathOf("claude"),
    ghPath: pathOf("gh"),
  };
}

// ─── GitHub deep link ───────────────────────────────────────────────────────

/**
 * A blob permalink at the exact reviewed SHA, not the PR's current head —
 * the head can move on after a round finishes, and a link built from a
 * moved head can point at the wrong line or a line that no longer exists.
 */
export function githubLineUrl(owner: string, repo: string, sha: string, file: string, line: number): string {
  return `https://github.com/${owner}/${repo}/blob/${sha}/${file}#L${line}`;
}

// ─── Client ─────────────────────────────────────────────────────────────────

export type AuthState = "ok" | "unauthenticated";
type AuthListener = (state: AuthState) => void;

export interface ApiClientOptions {
  baseUrl?: string;
  fetchImpl?: FetchLike;
  storage?: StorageLike;
  location?: LocationLike;
  history?: HistoryLike;
}

export interface ApiClient {
  getToken(): string | null;
  getAuthState(): AuthState;
  onAuthStateChange(listener: AuthListener): () => void;
  /** Full URL for the SSE endpoint, token as a query param (EventSource cannot set headers). */
  eventsUrl(): string;

  health(): Promise<HealthResponse>;
  status(): Promise<StatusResponse>;
  listPRs(filter?: PRListFilter): Promise<PRListItem[]>;
  getFindings(ref: PRRef): Promise<PRFindingsResponse>;
  decide(ref: PRRef, action: PRDecisionAction): Promise<void>;
  setFindingState(ref: PRRef, key: string, state: "discarded" | "open"): Promise<void>;
  validate(ref: PRRef): Promise<FindingVerdict[]>;
  post(ref: PRRef, input: { body?: string; recreate?: boolean; dryRun?: boolean }): Promise<PostResult>;
  listWatch(): Promise<WatchEntry[]>;
  /** The backfill list to confirm. Rows are the server's backfill shape, not PR rows. */
  addWatch(repo: RepoRef): Promise<{ repo: RepoRef; entries: unknown[] }>;
  removeWatch(repo: RepoRef): Promise<void>;
  getConfig(): Promise<ConfigResponse>;
  patchConfig(patch: Partial<ConfigValues>): Promise<ConfigResponse>;
}

function prPath(ref: PRRef, suffix: string): string {
  return `/api/prs/${encodeURIComponent(ref.owner)}/${encodeURIComponent(ref.repo)}/${ref.number}${suffix}`;
}

export function createApiClient(options: ApiClientOptions = {}): ApiClient {
  const baseUrl = options.baseUrl ?? "";
  const fetchImpl: FetchLike = options.fetchImpl ?? ((input, init) => fetch(input, init));
  const storage = options.storage ?? defaultStorage();
  const loc = options.location ?? defaultLocation();
  const hist = options.history ?? defaultHistory();

  let token = resolveToken(loc, storage, hist);
  let authState: AuthState = token ? "ok" : "unauthenticated";
  const listeners = new Set<AuthListener>();

  function setAuthState(next: AuthState) {
    if (authState === next) return;
    authState = next;
    for (const listener of listeners) listener(next);
  }

  async function raw(path: string, init: RequestInit = {}, requireAuth = true): Promise<Response> {
    if (requireAuth && !token) {
      setAuthState("unauthenticated");
      throw new ApiError("unauthenticated", REAUTH_MESSAGE);
    }

    const headers = new Headers(init.headers);
    if (requireAuth && token) headers.set("Authorization", `Bearer ${token}`);

    let res: Response;
    try {
      res = await fetchImpl(baseUrl + path, { ...init, headers });
    } catch (err) {
      throw new ApiError("network", err instanceof Error ? err.message : String(err));
    }

    if (res.status === 401) {
      setAuthState("unauthenticated");
      throw new ApiError("unauthenticated", REAUTH_MESSAGE, 401);
    }
    if (!res.ok) {
      throw new ApiError("http", `${init.method ?? "GET"} ${path} failed with ${res.status}`, res.status);
    }

    if (requireAuth) setAuthState("ok");
    return res;
  }

  async function getJson<T>(path: string): Promise<T> {
    const res = await raw(path);
    return (await res.json()) as T;
  }

  async function sendJson<T>(path: string, method: string, body?: unknown): Promise<T> {
    const res = await raw(path, {
      method,
      headers: body !== undefined ? { "Content-Type": "application/json" } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (res.status === 204) return undefined as T;
    const text = await res.text();
    return text ? (JSON.parse(text) as T) : (undefined as T);
  }

  return {
    getToken: () => token,
    getAuthState: () => authState,
    onAuthStateChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    eventsUrl: () => `${baseUrl}/api/events${token ? `?token=${encodeURIComponent(token)}` : ""}`,

    async health() {
      const res = await raw("/api/health", {}, false);
      const rec = asRecord(await res.json());
      return { app: str(rec.app, "lgtm"), version: str(rec.version), pid: num(rec.pid) };
    },

    async status() {
      return toStatusResponse(await getJson("/api/status"));
    },

    async listPRs(filter) {
      const params = new URLSearchParams();
      if (filter?.state) {
        const states = Array.isArray(filter.state) ? filter.state : [filter.state];
        params.set("state", states.join(","));
      }
      if (filter?.closed) params.set("closed", filter.closed);
      if (filter?.withFindings) params.set("withFindings", "true");
      const qs = params.toString();
      const body = await getJson<unknown>(`/api/prs${qs ? `?${qs}` : ""}`);
      // The daemon answers `{ prs, total }`. Treating a non-array as "no PRs"
      // silently emptied the whole Reviews view, so read the envelope and
      // only fall back to a bare array.
      const rows = Array.isArray(body) ? body : asRecord(body).prs;
      return Array.isArray(rows) ? rows.map(toPRListItem) : [];
    },

    async getFindings(ref) {
      return toPRFindingsResponse(await getJson(prPath(ref, "/findings")));
    },

    async decide(ref, action) {
      await sendJson(prPath(ref, "/decision"), "POST", { action });
    },

    async setFindingState(ref, key, state) {
      await sendJson(prPath(ref, `/findings/${encodeURIComponent(key)}`), "PATCH", { state });
    },

    async validate(ref) {
      const body = await sendJson<unknown>(prPath(ref, "/validate"), "POST");
      const list = Array.isArray(body) ? body : [];
      return list.map((v) => {
        const rec = asRecord(v);
        return { key: str(rec.key), valid: rec.valid === true, reason: nullableStr(rec.reason) };
      });
    },

    async post(ref, input) {
      const rec = asRecord(await sendJson<unknown>(prPath(ref, "/post"), "POST", input));
      const held = Array.isArray(rec.held)
        ? rec.held.map((h) => {
            const hr = asRecord(h);
            return { key: str(hr.key), reason: str(hr.reason) };
          })
        : [];
      return {
        posted: Array.isArray(rec.posted) ? rec.posted.filter((k): k is string => typeof k === "string") : [],
        held,
        pendingReviewId: nullableNum(rec.pendingReviewId),
        reviewUrl: nullableStr(rec.reviewUrl),
      };
    },

    async listWatch() {
      const body = await getJson<unknown>("/api/watchlist");
      // The daemon answers `{ repos }`. Same envelope shape as /api/prs, and
      // the same silent-empty-list bug if it is read as a bare array.
      const envelope = asRecord(body).repos;
      const list = Array.isArray(body) ? body : Array.isArray(envelope) ? envelope : [];
      return list.map((w) => {
        const rec = asRecord(w);
        return {
          owner: str(rec.owner),
          repo: str(rec.repo),
          addedAt: str(rec.addedAt),
          lastPolledAt: nullableStr(rec.lastPolledAt),
        };
      });
    },

    async addWatch(repo) {
      // The response is the backfill list, whose rows carry the confirm pane's
      // own vocabulary (`mergeable` as a word, `checks`, `preSelected`) rather
      // than a PR row. Parsing it as one produced a list of nulls, so it is
      // returned as sent and typed as what it is.
      const body = await sendJson<unknown>("/api/watchlist", "POST", repo);
      const rec = asRecord(body);
      return {
        repo: { owner: str(asRecord(rec.repo).owner), repo: str(asRecord(rec.repo).repo) },
        entries: Array.isArray(rec.entries) ? rec.entries : [],
      };
    },

    async removeWatch(repo) {
      await raw(`/api/watchlist?owner=${encodeURIComponent(repo.owner)}&repo=${encodeURIComponent(repo.repo)}`, {
        method: "DELETE",
      });
    },

    async getConfig() {
      return await getJson<ConfigResponse>("/api/config");
    },

    async patchConfig(patch) {
      return await sendJson<ConfigResponse>("/api/config", "PATCH", patch);
    },
  };
}

let singleton: ApiClient | null = null;

/** The one client the SPA's views share, so a token refresh or an auth flip is visible everywhere at once. */
export function getDefaultApiClient(): ApiClient {
  if (!singleton) singleton = createApiClient({});
  return singleton;
}

/** Test-only escape hatch: forces the next getDefaultApiClient() to build a fresh client. */
export function resetDefaultApiClient(): void {
  singleton = null;
}

export { toApiError };

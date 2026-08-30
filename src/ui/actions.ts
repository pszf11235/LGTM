/**
 * Every mutation the Gate can make, as one typed layer between the SPA and
 * the daemon (design.md, "HTTP API"; R5.2, R6).
 *
 * Three rules shape this file.
 *
 * A result is never a bare `void`. Each helper answers with a discriminated
 * union carrying what the daemon actually said, so a view can render "3
 * queued, 1 failed: acme/api#7 is closed" instead of a green tick over a
 * request that 409'd. A rejected promise would force every call site into a
 * try/catch and, in practice, into swallowing the reason.
 *
 * A finding is addressed by its full key, `r2:reviewer:f1`. Ids restart at
 * f1 in every round file, so a bare id silently hits a different round's
 * finding (R9.3, and a real corruption in the old codebase). `setFindingState`
 * parses the key and refuses locally rather than letting a malformed one
 * reach the wire, so the mistake surfaces as an error next to the card
 * instead of as a 400 that looks like a daemon fault.
 *
 * The requests go over `fetch` directly, taking only the bearer token from
 * `@/ui/api`'s shared client, for the reason BackfillPane records: that
 * module's typed `validate` and `post` methods parse response shapes the
 * route table does not produce (`validate` returns a report object, not an
 * array; `post` returns per-finding verdict objects, not key strings), and
 * both 409 bodies, a draft already pending and nothing left to post, carry
 * data the gate has to show rather than an error to swallow. The token
 * lifecycle stays in one place; only the parsing lives here.
 *
 * One consequence to know: a 401 here reports `unauthenticated` to the
 * caller (every view renders `REAUTH_MESSAGE` for that kind), but it cannot
 * flip the shared client's auth state, since that setter is private to the
 * client. The next query through `@/ui/api` flips it for the whole tab.
 *
 * Like api.ts, every response is read defensively: a field that is missing
 * or oddly typed degrades to a default instead of throwing halfway through
 * rendering a confirm pane.
 */

import { formatFindingKey, parseFindingKey } from "@/core";
import type { FindingState, PRRef, PRState, Severity } from "@/core";
import { REAUTH_MESSAGE, getDefaultApiClient } from "@/ui/api";
import type { ApiClient, FetchLike, PRDecisionAction } from "@/ui/api";

// ─── What the daemon answers with ───────────────────────────────────────────

/** One finding's answer to "would GitHub accept a comment here right now?" (`FindingVerdict` in src/api/post.ts). */
export interface GateVerdict {
  /** The canonical `r2:reviewer:f1`. Never a bare id. */
  key: string;
  round: number;
  agent: string;
  id: string;
  file: string;
  line: number;
  severity: Severity;
  /** The finding's state on disk when the check ran, before this post changes it. */
  state: FindingState;
  postable: boolean;
  /** Why it cannot attach. Null when it can. */
  reason: string | null;
}

export interface GateCounts {
  checked: number;
  postable: number;
  held: number;
}

/** `POST .../validate`: per-finding verdicts, nothing written anywhere. */
export interface ValidationReport {
  /** `acme/api#42`. */
  key: string;
  url: string;
  /** What the store thinks is open on GitHub. Read, not checked, by validate. */
  pendingReviewId: number | null;
  findings: GateVerdict[];
  counts: GateCounts;
}

/** `POST .../post` with `dryRun`: the confirm pane's whole input. Writes nothing (R6.7). */
export interface PostPreview {
  key: string;
  url: string;
  /** The rendered `templates/review-body.md`, before the human edits it. */
  body: string;
  postable: GateVerdict[];
  held: GateVerdict[];
  counts: GateCounts;
  pendingReviewId: number | null;
}

/** `POST .../post`: the PENDING draft that now exists on GitHub. */
export interface PostedDraft {
  key: string;
  url: string;
  reviewId: number;
  /** Where the human goes to edit and submit it. LGTM never submits (ADR 0001). */
  reviewUrl: string;
  body: string;
  commentCount: number;
  posted: GateVerdict[];
  held: GateVerdict[];
  /** The draft this post replaced, and the findings that came back with it. */
  recreated: { deletedReviewId: number; reopened: string[] } | null;
  /** A recorded draft GitHub no longer holds pending, cleared on the way through. */
  clearedReviewId: number | null;
}

// ─── Failure ────────────────────────────────────────────────────────────────

/**
 * `bad-key` is the only kind produced without a request: a finding key that
 * is not in canonical form is refused here rather than sent. `forge` covers
 * the daemon's 502/503, where the code host answered badly or no GitHub
 * token resolved. That is a different conversation with the user than a bug
 * in LGTM.
 */
export type ActionErrorKind = "unauthenticated" | "network" | "bad-key" | "forge" | "http";

export interface ActionError {
  kind: ActionErrorKind;
  /** The daemon's own `message` when it sent one; safe to show verbatim. */
  message: string;
  /** The daemon's machine-readable code (`unknown-pr`, `no-github-token`, ...), when it sent one. */
  code: string | null;
  status: number | null;
}

// ─── Results ────────────────────────────────────────────────────────────────

export interface DecisionRequest {
  ref: PRRef;
  action: PRDecisionAction;
}

/** Carries `ref` and `action` on both arms, so a batch report needs no zipping back to its input. */
export type DecisionResult =
  | { status: "ok"; ref: PRRef; action: PRDecisionAction; state: PRState; queued: boolean }
  | { status: "error"; ref: PRRef; action: PRDecisionAction; error: ActionError };

export interface DecisionBatch {
  results: DecisionResult[];
  ok: number;
  failed: number;
}

/** Carries the canonical key on both arms, so a card can match a result to itself. */
export type FindingResult =
  | { status: "ok"; key: string; state: "discarded" | "open"; changed: boolean }
  | { status: "error"; key: string; error: ActionError };

export type ValidateResult =
  | { status: "ok"; report: ValidationReport }
  | { status: "error"; error: ActionError };

/**
 * One union for both post calls, because the endpoint is one endpoint.
 *
 * `draft-exists` and `nothing-to-post` arrive as 409s but are outcomes, not
 * faults: the first is the recreate offer (R6.5), the second is the
 * zero-valid abort with its per-finding reasons (R6.3). Flattening them into
 * `error` would leave the pane with a red banner where it owes the user a
 * decision.
 */
export type PostResult =
  | { status: "posted"; draft: PostedDraft }
  | { status: "preview"; preview: PostPreview }
  | { status: "draft-exists"; pendingReviewId: number | null; reviewUrl: string | null; message: string }
  | { status: "nothing-to-post"; checked: number; held: GateVerdict[]; message: string }
  | { status: "error"; error: ActionError };

export interface PostInput {
  /** The inline-edited review body. Sent verbatim, empty string included (design.md, posting flow step 5). */
  body?: string;
  /** Delete the pending draft and post fresh. Replaces it; the REST API cannot append (R6.5). */
  recreate?: boolean;
  dryRun?: boolean;
}

export interface GateActions {
  decide(ref: PRRef, action: PRDecisionAction): Promise<DecisionResult>;
  /** One decision call per request, in order, every one settled. */
  applyDecisions(requests: readonly DecisionRequest[]): Promise<DecisionBatch>;
  discardFinding(ref: PRRef, key: string): Promise<FindingResult>;
  restoreFinding(ref: PRRef, key: string): Promise<FindingResult>;
  validate(ref: PRRef): Promise<ValidateResult>;
  /** The dry run behind the confirm pane. Never returns `posted`. */
  preview(ref: PRRef): Promise<PostResult>;
  post(ref: PRRef, input?: PostInput): Promise<PostResult>;
}

// ─── Coercion ───────────────────────────────────────────────────────────────

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

const SEVERITIES: ReadonlySet<string> = new Set<Severity>(["low", "medium", "high", "critical"]);
function severity(value: unknown): Severity {
  return typeof value === "string" && SEVERITIES.has(value) ? (value as Severity) : "medium";
}

const FINDING_STATES: ReadonlySet<string> = new Set<FindingState>(["open", "discarded", "posted", "held"]);
function findingState(value: unknown): FindingState {
  return typeof value === "string" && FINDING_STATES.has(value) ? (value as FindingState) : "open";
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
function prState(value: unknown): PRState {
  return typeof value === "string" && PR_STATES.has(value) ? (value as PRState) : "triage";
}

function toVerdict(raw: unknown): GateVerdict {
  const rec = asRecord(raw);
  return {
    key: str(rec.key),
    round: num(rec.round),
    agent: str(rec.agent),
    id: str(rec.id),
    file: str(rec.file),
    line: num(rec.line),
    severity: severity(rec.severity),
    state: findingState(rec.state),
    postable: rec.postable === true,
    reason: nullableStr(rec.reason),
  };
}

function toVerdicts(raw: unknown): GateVerdict[] {
  return Array.isArray(raw) ? raw.map(toVerdict) : [];
}

function toCounts(raw: unknown): GateCounts {
  const rec = asRecord(raw);
  return { checked: num(rec.checked), postable: num(rec.postable), held: num(rec.held) };
}

function toStrings(raw: unknown): string[] {
  return Array.isArray(raw) ? raw.filter((entry): entry is string => typeof entry === "string") : [];
}

function toRecreated(raw: unknown): PostedDraft["recreated"] {
  if (!raw || typeof raw !== "object") return null;
  const rec = asRecord(raw);
  return { deletedReviewId: num(rec.deletedReviewId), reopened: toStrings(rec.reopened) };
}

// ─── Transport ──────────────────────────────────────────────────────────────

export interface GateActionsOptions {
  /** Token source. Defaults to the SPA's shared client, resolved lazily so constructing this touches no browser global. */
  client?: ApiClient;
  fetchImpl?: FetchLike;
  baseUrl?: string;
}

interface Wire {
  status: number;
  body: unknown;
}

type Sent = { ok: true; wire: Wire } | { ok: false; error: ActionError };

function unauthenticated(status: number | null): ActionError {
  return { kind: "unauthenticated", message: REAUTH_MESSAGE, code: null, status };
}

/** A non-2xx the caller decided is a fault, rendered from the daemon's own `{error, message}` body. */
function errorFrom(status: number, body: unknown): ActionError {
  const rec = asRecord(body);
  const code = nullableStr(rec.error);
  const message = str(rec.message) || `The daemon answered ${status}.`;
  // 502 is "GitHub answered badly", 503 is "no Forge adapter" or "no GitHub
  // token". All three are about the code host rather than about LGTM being
  // broken, and the daemon's message already carries the guidance (R7.6).
  const kind: ActionErrorKind = status === 502 || status === 503 ? "forge" : "http";
  return { kind, message, code, status };
}

function prPath(ref: PRRef, suffix: string): string {
  return `/api/prs/${encodeURIComponent(ref.owner)}/${encodeURIComponent(ref.repo)}/${ref.number}${suffix}`;
}

export function createGateActions(options: GateActionsOptions = {}): GateActions {
  const baseUrl = options.baseUrl ?? "";
  const fetchImpl: FetchLike = options.fetchImpl ?? ((input, init) => fetch(input, init));

  function token(): string | null {
    return (options.client ?? getDefaultApiClient()).getToken();
  }

  async function send(method: string, path: string, payload?: unknown): Promise<Sent> {
    const bearer = token();
    if (!bearer) return { ok: false, error: unauthenticated(null) };

    const headers: Record<string, string> = { Authorization: `Bearer ${bearer}` };
    if (payload !== undefined) headers["Content-Type"] = "application/json";

    let res: Response;
    try {
      res = await fetchImpl(baseUrl + path, {
        method,
        headers,
        ...(payload !== undefined ? { body: JSON.stringify(payload) } : {}),
      });
    } catch (err) {
      return {
        ok: false,
        error: { kind: "network", message: err instanceof Error ? err.message : String(err), code: null, status: null },
      };
    }

    if (res.status === 401) return { ok: false, error: unauthenticated(401) };

    let body: unknown = null;
    try {
      const text = await res.text();
      body = text ? (JSON.parse(text) as unknown) : null;
    } catch {
      // A body that is not JSON tells us nothing the status does not. The
      // status still decides the outcome; `errorFrom` falls back to it.
      body = null;
    }

    return { ok: true, wire: { status: res.status, body } };
  }

  async function decide(ref: PRRef, action: PRDecisionAction): Promise<DecisionResult> {
    const sent = await send("POST", prPath(ref, "/decision"), { action });
    if (!sent.ok) return { status: "error", ref, action, error: sent.error };

    const { status, body } = sent.wire;
    if (status >= 400) return { status: "error", ref, action, error: errorFrom(status, body) };

    const rec = asRecord(body);
    return { status: "ok", ref, action, state: prState(rec.state), queued: rec.queued === true };
  }

  /**
   * Sequential, and every call settled.
   *
   * One PR's failure can never hide another's success, and the order of the
   * calls is the order of the requests, so a mixed selection sends exactly
   * what the user checked and the report reads back in the same order.
   */
  async function applyDecisions(requests: readonly DecisionRequest[]): Promise<DecisionBatch> {
    const results: DecisionResult[] = [];
    for (const request of requests) {
      results.push(await decide(request.ref, request.action));
    }
    const ok = results.filter((result) => result.status === "ok").length;
    return { results, ok, failed: results.length - ok };
  }

  async function setFindingState(ref: PRRef, printed: string, target: "discarded" | "open"): Promise<FindingResult> {
    const parsed = parseFindingKey(printed);
    if (!parsed) {
      // Refused before the wire. A bare id would address a different round's
      // finding on the daemon side (R9.3).
      return {
        status: "error",
        key: printed,
        error: {
          kind: "bad-key",
          message: `"${printed}" is not a finding key. The gate addresses findings as r2:reviewer:f1.`,
          code: "bad-key",
          status: null,
        },
      };
    }

    const key = formatFindingKey(parsed);
    const sent = await send("PATCH", prPath(ref, `/findings/${encodeURIComponent(key)}`), { state: target });
    if (!sent.ok) return { status: "error", key, error: sent.error };

    const { status, body } = sent.wire;
    if (status >= 400) return { status: "error", key, error: errorFrom(status, body) };

    const rec = asRecord(body);
    return { status: "ok", key, state: target, changed: rec.changed === true };
  }

  async function validate(ref: PRRef): Promise<ValidateResult> {
    const sent = await send("POST", prPath(ref, "/validate"));
    if (!sent.ok) return { status: "error", error: sent.error };

    const { status, body } = sent.wire;
    if (status >= 400) return { status: "error", error: errorFrom(status, body) };

    const rec = asRecord(body);
    return {
      status: "ok",
      report: {
        key: str(rec.key),
        url: str(rec.url),
        pendingReviewId: nullableNum(rec.pendingReviewId),
        findings: toVerdicts(rec.findings),
        counts: toCounts(rec.counts),
      },
    };
  }

  async function post(ref: PRRef, input: PostInput = {}): Promise<PostResult> {
    const payload: PostInput = {};
    // An edited body is sent as given, including an empty one: the confirm
    // pane is the last human step, and second-guessing it here would make
    // the preview a different thing from what gets sent.
    if (typeof input.body === "string") payload.body = input.body;
    if (input.recreate === true) payload.recreate = true;
    if (input.dryRun === true) payload.dryRun = true;

    const sent = await send("POST", prPath(ref, "/post"), payload);
    if (!sent.ok) return { status: "error", error: sent.error };

    const { status, body } = sent.wire;
    const rec = asRecord(body);

    if (status === 409 && rec.error === "pending-review-exists") {
      return {
        status: "draft-exists",
        pendingReviewId: nullableNum(rec.pendingReviewId),
        reviewUrl: nullableStr(rec.reviewUrl),
        message: str(rec.message, "A pending draft review already exists on GitHub."),
      };
    }

    if (status === 409 && rec.error === "nothing-to-post") {
      return {
        status: "nothing-to-post",
        checked: num(rec.checked),
        held: toVerdicts(rec.held),
        message: str(rec.message, "Nothing validated against the current diff, so nothing was sent."),
      };
    }

    if (status >= 400) return { status: "error", error: errorFrom(status, body) };

    if (rec.dryRun === true) {
      return {
        status: "preview",
        preview: {
          key: str(rec.key),
          url: str(rec.url),
          body: str(rec.body),
          postable: toVerdicts(rec.postable),
          held: toVerdicts(rec.held),
          counts: toCounts(rec.counts),
          pendingReviewId: nullableNum(rec.pendingReviewId),
        },
      };
    }

    return {
      status: "posted",
      draft: {
        key: str(rec.key),
        url: str(rec.url),
        reviewId: num(rec.reviewId),
        reviewUrl: str(rec.reviewUrl),
        body: str(rec.body),
        commentCount: num(rec.commentCount),
        posted: toVerdicts(rec.posted),
        held: toVerdicts(rec.held),
        recreated: toRecreated(rec.recreated),
        clearedReviewId: nullableNum(rec.clearedReviewId),
      },
    };
  }

  return {
    decide,
    applyDecisions,
    discardFinding: (ref, key) => setFindingState(ref, key, "discarded"),
    restoreFinding: (ref, key) => setFindingState(ref, key, "open"),
    validate,
    preview: (ref) => post(ref, { dryRun: true }),
    post,
  };
}

let singleton: GateActions | null = null;

/** The one instance the SPA's views share, so they all speak through the same token and transport. */
export function getDefaultGateActions(): GateActions {
  if (!singleton) singleton = createGateActions({});
  return singleton;
}

/** Test-only escape hatch: forces the next getDefaultGateActions() to build a fresh instance. */
export function resetDefaultGateActions(): void {
  singleton = null;
}

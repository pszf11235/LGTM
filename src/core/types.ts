/**
 * Shared vocabulary for LGTM.
 *
 * Every module under src/ imports its domain types from here rather than
 * redeclaring them, so "PR", "Finding", and "Round" mean exactly one thing
 * across the store, the API, and the UI. Names follow CONTEXT.md; shapes
 * mirror docs/spec/design.md's "Store layout" and "ForgeAdapter" sections,
 * which this file is a TypeScript rendering of, not a reinterpretation.
 */

// ─── Identity ───────────────────────────────────────────────────────────────

/** A repository on a Forge, independent of any particular pull request. */
export interface RepoRef {
  owner: string;
  repo: string;
}

/** One pull request, addressable across the store, the API, and the UI. */
export interface PRRef {
  owner: string;
  repo: string;
  number: number;
}

// ─── PR lifecycle ───────────────────────────────────────────────────────────

/**
 * A PR's place in the review lifecycle. See design.md's "Poll cycle" for the
 * transitions between these.
 */
export type PRState =
  | "triage" // TriagePr, waiting on a review/skip decision
  | "skipped" // sticky; new commits do not resurrect it
  | "queued" // waiting for a provider slot and quota
  | "reviewing" // a round is in flight
  | "reviewed" // a round completed at the current head SHA
  | "failed" // every round at the current head SHA failed to parse
  | "closed"; // no longer open on the Forge; hidden from active views

/**
 * Why a PR qualifies for review without being asked (AutoClassPr), or why it
 * doesn't. `manual` marks a TriagePr approved through an explicit "review" or
 * "review anyway" decision; `none` is a TriagePr still waiting.
 */
export type Classification = "own" | "requested" | "assigned" | "mentioned" | "manual" | "none";

// ─── Findings ───────────────────────────────────────────────────────────────

export type Severity = "low" | "medium" | "high" | "critical";

/**
 * A Finding's lifecycle state. This is the human's to change, never the
 * Agent's — it is the Gate. `held` is set by the post flow when a finding's
 * line no longer validates against the current diff, and clears back to
 * `open` automatically once it validates again.
 */
export type FindingState = "open" | "discarded" | "posted" | "held";

export interface Finding {
  /** Stable within its round file only: f1, f2, ... Restarts at f1 per round — see FindingKey. */
  id: string;
  /** Severity floor already applied; nothing below the agent's floor is ever written. */
  severity: Severity;
  file: string;
  line: number;
  comment: string;
  suggestion?: string;
  state: FindingState;
  /** Set only when state is "held"; the reason is disclosed in the review body. */
  heldReason?: string | null;
}

/**
 * The canonical, printed identity of a Finding: `r<round>:<agent>:<id>`, e.g.
 * `r2:reviewer:f1`. Ids restart at f1 per round file, so an address that
 * drops the round or the agent is ambiguous between rounds. The old codebase
 * matched on the bare id and corrupted rounds because of it; keying on the
 * full triple is the fix, carried over here as a rule with tests.
 */
export interface FindingKey {
  round: number;
  agent: string;
  id: string;
}

const FINDING_KEY_PATTERN = /^r(\d+):([^:]+):(.+)$/;

/** Format a FindingKey as its canonical printed form, e.g. `r2:reviewer:f1`. */
export function formatFindingKey(key: FindingKey): string {
  return `r${key.round}:${key.agent}:${key.id}`;
}

/**
 * Parse the canonical printed form back into a FindingKey.
 *
 * Returns null instead of throwing: callers are almost always parsing
 * external input (a PATCH route param, a URL) that is not guaranteed to be
 * well-formed, and a malformed key is a 400, not a crash.
 */
export function parseFindingKey(printed: string): FindingKey | null {
  const match = FINDING_KEY_PATTERN.exec(printed);
  if (!match) return null;
  const [, round, agent, id] = match as unknown as [string, string, string, string];
  return { round: Number(round), agent, id };
}

// ─── Rounds ─────────────────────────────────────────────────────────────────

/**
 * One review pass over one PR at one head SHA, by one Agent. Mirrors the
 * frontmatter of `r<N>-<agent>.md`; that file's markdown body is a generated
 * human-readable rendering of this same data, never a second source of truth.
 */
export interface RoundFile {
  round: number;
  /** The Agent's name (the filename stem under agents/, e.g. "reviewer"). */
  agent: string;
  /** The Provider that executed this round, e.g. "claude-cli". */
  provider: string;
  /** A failed round still writes this file, with an empty findings array, next to its .raw.txt. */
  status: "ok" | "failed";
  headSha: string;
  startedAt: string;
  durationMs: number;
  findings: Finding[];
}

// ─── PR metadata ────────────────────────────────────────────────────────────

/** Mirrors `meta.md` frontmatter field for field. */
export interface PRMeta {
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
  /** Null until the first round completes. */
  lastReviewedSha: string | null;
  /** Retry counter for the current head SHA. Resets to 0 on a new commit. */
  failedAttempts: number;
  rounds: number;
  /** Set while a draft review exists on GitHub; cleared once getReview reports it is no longer pending. */
  pendingReviewId: number | null;
  closedAt: string | null;
  updatedAt: string;
}

// ─── Forge results ──────────────────────────────────────────────────────────

/**
 * One row of `listOpenPRs` — enough to classify a PR (own / requested /
 * assigned / mentioned) without the per-PR detail call. `body` is included
 * because mention detection reads title and description both.
 */
export interface PRSummary {
  number: number;
  title: string;
  body: string;
  url: string;
  author: string;
  draft: boolean;
  headSha: string;
  createdAt: string;
  updatedAt: string;
  requestedReviewers: string[];
  assignees: string[];
}

/** Triage metadata, fetched only for PRs entering triage or the backfill list. */
export interface PRDetail extends PRSummary {
  additions: number;
  deletions: number;
  changedFiles: number;
  /** Null while GitHub is still computing it; renders as "computing", never as a failure. */
  mergeable: boolean | null;
}

/** Combined CI status for one head SHA, read from the Checks API only (see design.md, deferred decisions). */
export interface CheckStatus {
  /** "none" means no check runs are registered for this SHA. */
  state: "success" | "failure" | "pending" | "none";
  runs: Array<{
    name: string;
    status: "queued" | "in_progress" | "completed";
    conclusion:
      | "success"
      | "failure"
      | "neutral"
      | "cancelled"
      | "skipped"
      | "timed_out"
      | "action_required"
      | null;
  }>;
}

/** The unsent draft: a body and per-line comments, before any Forge call. */
export interface DraftReview {
  body: string;
  comments: Array<{ path: string; line: number; body: string }>;
}

/**
 * Sentinel returned by `listOpenPRs` when the Forge answers 304 Not Modified
 * to a conditional (ETag) request. Distinct from an empty array, which means
 * "zero open PRs" rather than "nothing changed since last time" — collapsing
 * the two would make an all-closed repo indistinguishable from a poll that
 * cost no rate limit.
 */
export interface NotModified {
  notModified: true;
}

// ─── ForgeAdapter ───────────────────────────────────────────────────────────

/**
 * The only interface allowed to speak to a code host. GitHub is the sole v1
 * implementation (src/forge/github); this interface is the seam a future
 * GitLab adapter would implement against.
 *
 * Deliberately absent: anything that submits, publishes, or sends an `event`
 * field. An interface cannot express that absence; it is enforced by tests on
 * the GitHub implementation instead (see design.md, "ForgeAdapter").
 */
export interface ForgeAdapter {
  listOpenPRs(repo: RepoRef): Promise<PRSummary[] | NotModified>;
  /** Triage metadata. */
  getPR(ref: PRRef): Promise<PRDetail>;
  /** Unified diff, current head. */
  getDiff(ref: PRRef): Promise<string>;
  getCheckStatus(ref: PRRef, sha: string): Promise<CheckStatus>;
  createDraftReview(ref: PRRef, review: DraftReview): Promise<{ id: number }>;
  deleteDraftReview(ref: PRRef, id: number): Promise<void>;
  getReview(ref: PRRef, id: number): Promise<"pending" | "submitted" | "gone">;
  authenticatedUser(): Promise<string>;
}

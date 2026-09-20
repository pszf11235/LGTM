/**
 * The wire contract: every shape that crosses between the daemon and the
 * browser, owned in one place.
 *
 * This module exists because the same defect shipped five times. The daemon
 * built a response by hand, the browser parsed it by hand from `unknown`, and
 * nothing connected the two, so a rename or a nesting change on one side was
 * invisible on the other until a view rendered empty. The PR list came back
 * as an envelope the client read as a bare array. The reference moved under
 * `ref` and the client kept reading flat keys. Findings moved under `rounds`.
 * The watch list gained an envelope. The status payload was nested all along
 * and the client read the top level and quietly used its defaults.
 *
 * The fix is not more careful reading. It is that both sides now import the
 * same types from here, so a change to a wire shape stops compiling on the
 * side that did not make it. The `decode` helpers are the runtime half, for
 * data that really did arrive from somewhere else: an older daemon, a
 * hand-edited store, a response that is not what its type claims.
 *
 * View models stay in the browser. What travels is defined here; what a
 * component renders is its own business, and the mapper between them is the
 * one place a wire change becomes a view change.
 */
import type { Classification, PRRef, PRState, Severity } from "@/core";

// ─── Shared pieces ──────────────────────────────────────────────────────────

/** How many findings sit in each lifecycle state, and the pending ones by severity. */
export interface FindingCounts {
  total: number;
  open: number;
  held: number;
  posted: number;
  discarded: number;
  /** Open plus held: everything a human has not decided on yet. */
  pending: number;
  pendingBySeverity: Record<Severity, number>;
}

export type CheckState = "success" | "failure" | "pending" | "none";

// ─── GET /api/prs ───────────────────────────────────────────────────────────

/**
 * One row of the PR list.
 *
 * `ref` is nested and `findings` is a breakdown rather than a flat count. Both
 * caught the browser out once; both are load-bearing and stay.
 */
export interface PRRow {
  ref: PRRef;
  /** `owner/repo#42`, the same rendering the CLI and the logs use. */
  key: string;
  url: string;
  title: string;
  author: string;
  state: PRState;
  classification: Classification;
  draft: boolean;
  headSha: string;
  lastReviewedSha: string | null;
  failedAttempts: number;
  rounds: number;
  pendingReviewId: number | null;
  closedAt: string | null;
  updatedAt: string;
  reviewsWhenReady: boolean;
  watched: boolean;

  /**
   * Triage metadata, all nullable. Null means "not fetched yet" or "GitHub is
   * still computing it", and must arrive as null: filling one in with a zero
   * turns "unknown" into a measured "no changes" on the way across.
   */
  createdAt: string | null;
  additions: number | null;
  deletions: number | null;
  changedFiles: number | null;
  mergeable: boolean | null;
  checkStatus: CheckState | null;

  findings: FindingCounts;
}

/** The daemon answers with an envelope, never a bare array. */
export interface PRListResponse {
  prs: PRRow[];
  total: number;
}

// ─── GET /api/prs/:owner/:repo/:number/findings ─────────────────────────────

export interface FindingCard {
  /** The canonical `r2:reviewer:f1`. Never a bare id. */
  key: string;
  id: string;
  round: number;
  agent: string;
  severity: Severity;
  file: string;
  line: number;
  comment: string;
  suggestion: string | null;
  state: "open" | "discarded" | "posted" | "held";
  heldReason: string | null;
  hunk: SlicedHunk | null;
  hunkFallback: string | null;
  githubUrl: string;
}

export interface SlicedHunk {
  header: string;
  lines: Array<{
    type: "added" | "removed" | "context";
    content: string;
    oldLine: number | null;
    newLine: number | null;
  }>;
}

/** Findings arrive grouped by the Round that produced them, oldest first. */
export interface RoundGroup {
  round: number;
  agent: string;
  provider: string;
  status: "ok" | "failed";
  headSha: string;
  startedAt: string;
  durationMs: number;
  hasSnapshot: boolean;
  sessionId: string | null;
  sessionCwd: string | null;
  costUsd: number | null;
  turns: number | null;
  /** Ready to paste: `cd <cwd> && claude --resume <id>`. Null without a session. */
  resumeCommand: string | null;
  findings: FindingCard[];
}

export interface FindingsResponse {
  ref: PRRef;
  key: string;
  /** The PR's own fields. Its reference lives in `ref`, not in here. */
  pr: {
    url: string;
    title: string;
    author: string;
    state: PRState;
    classification: Classification;
    draft: boolean;
    headSha: string;
    lastReviewedSha: string | null;
    pendingReviewId: number | null;
    closedAt: string | null;
    reviewsWhenReady: boolean;
  };
  counts: FindingCounts;
  rounds: RoundGroup[];
}

// ─── GET /api/watchlist ─────────────────────────────────────────────────────

export interface WatchRow {
  owner: string;
  repo: string;
  key: string;
  addedAt: string;
  lastPolledAt: string | null;
  conditional: boolean;
  /** null means the repo follows the daemon default rather than pinning one. */
  autoReview: boolean | null;
}

export interface WatchListResponse {
  repos: WatchRow[];
}

// ─── GET /api/config ────────────────────────────────────────────────────────

export interface ConfigValues {
  interval_minutes: number;
  pause_above_pct: number;
  resume_below_pct: number;
  daily_cap: number;
  concurrency: number;
  auto_review: boolean;
  claude_path?: string;
  gh_path?: string;
}

/** Current values beside the built-in defaults, so a field can show its fallback. */
export interface ConfigResponse {
  config: ConfigValues;
  defaults: ConfigValues;
}

// ─── Runtime decoding ───────────────────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Read an envelope's array field.
 *
 * Every list route answers `{ <field>: [...] }`. Reading one as a bare array
 * is the exact shape of two shipped bugs, so the fallback is deliberate: a
 * bare array is accepted, because a daemon that ever sends one is still
 * answering the question, and anything else is an empty list rather than a
 * crash.
 */
export function decodeList(raw: unknown, field: string): unknown[] {
  if (Array.isArray(raw)) return raw;
  if (!isRecord(raw)) return [];
  const value = raw[field];
  return Array.isArray(value) ? value : [];
}

/** Every finding from every Round, in the order the Rounds ran. */
export function decodeRoundFindings(raw: unknown): unknown[] {
  const rounds = decodeList(raw, "rounds");
  if (rounds.length === 0) return decodeList(raw, "findings");
  return rounds.flatMap((round) => (isRecord(round) ? decodeList(round, "findings") : []));
}

/**
 * The PR's own fields and its reference, merged into one object for a mapper.
 *
 * The findings route splits them, which is correct on the wire and awkward for
 * a view model that wants one shape.
 */
export function decodePRIdentity(raw: unknown): Record<string, unknown> {
  if (!isRecord(raw)) return {};
  const ref = isRecord(raw.ref) ? raw.ref : {};
  const pr = isRecord(raw.pr) ? raw.pr : isRecord(raw.meta) ? raw.meta : {};
  return { ...ref, ...pr };
}

/** A nested object off a payload, or an empty one. Never undefined. */
export function decodeSection(raw: unknown, field: string): Record<string, unknown> {
  if (!isRecord(raw)) return {};
  const value = raw[field];
  return isRecord(value) ? value : {};
}

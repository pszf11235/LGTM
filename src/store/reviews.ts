/**
 * Review store — findings on disk, one directory per PR, one file per round.
 *
 * Everything the tool learns about a PR lands here before anything is posted
 * (design.md, "Store layout"). That ordering is the point: findings are
 * local first, a human edits or drops them, and only then does GitHub hear
 * about it.
 *
 * ```
 * ~/.lgtm-farm/reviews/acme/api/pr-42/
 *   meta.md              state, classification, headSha, pendingReviewId, ...
 *   r1-reviewer.md        round 1 findings from the "reviewer" agent
 *   r2-reviewer.md        round 2, after new commits
 *   r2-reviewer.raw.txt   only when round 2 failed to parse
 *   diff-abc123.patch     diff snapshot at round 2's head SHA
 * ```
 *
 * The nested owner/repo/pr-<n> path is what makes each file locatable on its
 * own; unlike the old flat `<owner>-<repo>-<pr>` layout, splitting a
 * hyphenated repo name out of a directory name is no longer a concern the
 * store has to solve, and round files no longer need to repeat owner/repo/url
 * in their own frontmatter to be self-describing — the path already is.
 *
 * Finding identity is `r<round>:<agent>:<id>` everywhere (formatFindingKey /
 * parseFindingKey in @/core), never a bare id. Ids restart at f1 in every
 * round file, so matching on a bare id silently corrupts other rounds — the
 * old codebase shipped that bug and fixed it by keying on the full triple
 * (main: 6c0f08c). Every mutation below keys on the full triple for the same
 * reason; see the "finding identity" tests.
 *
 * Reads and writes of frontmatter documents go through okf.ts (gray-matter
 * behind a structuredClone guard). This module never touches gray-matter
 * directly, except for the two plain-text siblings that carry no
 * frontmatter at all: r<N>-<agent>.raw.txt and diff-<sha>.patch's path.
 */

import fs from "fs/promises";
import path from "path";
import { createOKFStore } from "./okf.js";
import type { OKFDocument } from "./okf.js";
import { formatFindingKey } from "@/core";
import type {
  CheckState,
  Classification,
  Finding,
  FindingState,
  PRMeta,
  PRRef,
  PRState,
  RoundFile,
  Severity,
} from "@/core";

// createOKFStore has no separately exported interface (its return type is
// inferred), so this module derives the store's shape structurally instead
// of naming an export that okf.ts may not carry.
type Store = ReturnType<typeof createOKFStore>;

// ─── Paths ──────────────────────────────────────────────────────────────────

/** A PR's review directory, absolute: `<lgtmDir>/reviews/<owner>/<repo>/pr-<n>`. */
export function reviewDir(lgtmDir: string, ref: PRRef): string {
  return path.join(lgtmDir, "reviews", ref.owner, ref.repo, `pr-${ref.number}`);
}

/** Same directory, relative to the store root — what okf.ts's read/write/list want. */
function relativeReviewDir(ref: PRRef): string {
  return path.join("reviews", ref.owner, ref.repo, `pr-${ref.number}`);
}

function relativeMetaPath(ref: PRRef): string {
  return path.join(relativeReviewDir(ref), "meta.md");
}

function relativeRoundPath(ref: PRRef, round: number, agent: string): string {
  return path.join(relativeReviewDir(ref), `r${round}-${agent}.md`);
}

/** Where unparseable provider output is kept, so a failed round can be debugged. */
export function rawOutputPath(lgtmDir: string, ref: PRRef, round: number, agent: string): string {
  return path.join(reviewDir(lgtmDir, ref), `r${round}-${agent}.raw.txt`);
}

/** Where the diff snapshot for one reviewed head SHA is kept. */
export function diffSnapshotPath(lgtmDir: string, ref: PRRef, sha: string): string {
  return path.join(reviewDir(lgtmDir, ref), `diff-${sha}.patch`);
}

export function prUrl(ref: PRRef): string {
  return `https://github.com/${ref.owner}/${ref.repo}/pull/${ref.number}`;
}

const ROUND_FILE_RE = /^r\d+-.+\.md$/;

// ─── Reading primitives ─────────────────────────────────────────────────────

/**
 * okf.ts's `read` returns null on ENOENT but lets other errors (bad YAML)
 * propagate. Frontmatter files are hand-editable, so a corrupt one must be
 * skipped, not take the whole PR down with it — see "a corrupt round file is
 * skipped" below.
 */
async function readDocSafely(store: Store, relPath: string): Promise<OKFDocument | null> {
  try {
    return await store.read(relPath);
  } catch {
    return null;
  }
}

/**
 * Round-trip through JSON to drop `undefined` values (frontmatter can't
 * serialise them) and to widen a typed interface down to the plain
 * Record<string, unknown> the store's write() takes.
 */
function clean(value: unknown): Record<string, unknown> {
  return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
}

const FINDING_STATES: ReadonlySet<string> = new Set<FindingState>(["open", "discarded", "posted", "held"]);
const SEVERITIES: ReadonlySet<string> = new Set<Severity>(["low", "medium", "high", "critical"]);

/**
 * Findings are hand-editable, so missing or malformed fields are filled
 * rather than trusted. A finding with no `state` must read as `open`, not as
 * undefined, because "is this postable" is decided on that value.
 */
function normaliseFindings(value: unknown): Finding[] {
  if (!Array.isArray(value)) return [];

  return value
    .filter((f): f is Record<string, unknown> => !!f && typeof f === "object")
    .map((f, i): Finding => {
      const state = FINDING_STATES.has(f.state as string) ? (f.state as FindingState) : "open";
      const severity = SEVERITIES.has(f.severity as string) ? (f.severity as Severity) : "medium";

      return {
        id: String(f.id ?? `f${i + 1}`),
        file: String(f.file ?? ""),
        line: Number(f.line ?? 0),
        severity,
        comment: String(f.comment ?? ""),
        suggestion: f.suggestion ? String(f.suggestion) : undefined,
        state,
        heldReason: state === "held" ? (f.heldReason != null ? String(f.heldReason) : null) : null,
      };
    })
    .filter((f) => f.file && f.comment);
}

function parseRoundFileData(data: Record<string, unknown>): RoundFile {
  return {
    round: Number(data.round ?? 0),
    agent: String(data.agent ?? ""),
    provider: String(data.provider ?? ""),
    status: data.status === "failed" ? "failed" : "ok",
    headSha: String(data.headSha ?? ""),
    startedAt: String(data.startedAt ?? ""),
    durationMs: Number(data.durationMs ?? 0),
    findings: normaliseFindings(data.findings),
  };
}

/** Load one round file. Null if it does not exist or fails to parse. */
export async function loadRound(
  lgtmDir: string,
  ref: PRRef,
  round: number,
  agent: string
): Promise<RoundFile | null> {
  const store = createOKFStore(lgtmDir);
  const doc = await readDocSafely(store, relativeRoundPath(ref, round, agent));
  return doc ? parseRoundFileData(doc.data) : null;
}

/** Every round file for a PR, oldest round first, then agent name. */
export async function loadAllRounds(lgtmDir: string, ref: PRRef): Promise<RoundFile[]> {
  const store = createOKFStore(lgtmDir);
  const relPaths = (await store.list(relativeReviewDir(ref))).filter((p) =>
    ROUND_FILE_RE.test(path.basename(p))
  );

  const rounds: RoundFile[] = [];
  for (const relPath of relPaths) {
    const doc = await readDocSafely(store, relPath);
    if (doc) rounds.push(parseRoundFileData(doc.data));
  }

  return rounds.sort((a, b) => a.round - b.round || a.agent.localeCompare(b.agent));
}

/**
 * Findings still eligible for the gate: not yet posted, not discarded.
 *
 * A held finding stays eligible on purpose — it was held because its line
 * was not in the diff at post time, and a later round or a fresh diff may
 * bring that line back (R6.3).
 */
export async function pendingFindings(
  lgtmDir: string,
  ref: PRRef
): Promise<Array<Finding & { round: number; agent: string }>> {
  const rounds = await loadAllRounds(lgtmDir, ref);
  return rounds.flatMap((r) =>
    r.findings
      .filter((f) => f.state === "open" || f.state === "held")
      .map((f) => ({ ...f, round: r.round, agent: r.agent }))
  );
}

/** Findings already on GitHub. */
export async function postedFindings(
  lgtmDir: string,
  ref: PRRef
): Promise<Array<Finding & { round: number; agent: string }>> {
  const rounds = await loadAllRounds(lgtmDir, ref);
  return rounds.flatMap((r) =>
    r.findings.filter((f) => f.state === "posted").map((f) => ({ ...f, round: r.round, agent: r.agent }))
  );
}

// ─── Writing rounds ─────────────────────────────────────────────────────────

export interface SaveRoundInput {
  ref: PRRef;
  round: number;
  agent: string;
  provider: string;
  headSha: string;
  /** A failed round still writes this file, with an empty findings array, next to its .raw.txt (R3.4). */
  status: "ok" | "failed";
  startedAt: string;
  durationMs: number;
  findings: Array<Omit<Finding, "id" | "state" | "heldReason">>;
  /** Unparseable provider output. Written only when status is "failed", so a healthy round never leaves a transcript on disk. */
  raw?: string;
}

/**
 * Write one agent's findings for one round.
 *
 * Findings get ids f1..fn in file order, stable because the file is never
 * reordered — that stability is what lets `r2:reviewer:f3` keep meaning one
 * specific finding across sessions.
 */
export async function saveRound(lgtmDir: string, input: SaveRoundInput): Promise<RoundFile> {
  const findings: Finding[] = input.findings.map((f, i) => ({
    id: `f${i + 1}`,
    file: f.file,
    line: f.line,
    severity: f.severity,
    comment: f.comment,
    suggestion: f.suggestion,
    state: "open",
    heldReason: null,
  }));

  const round: RoundFile = {
    round: input.round,
    agent: input.agent,
    provider: input.provider,
    status: input.status,
    headSha: input.headSha,
    startedAt: input.startedAt,
    durationMs: input.durationMs,
    findings,
  };

  const store = createOKFStore(lgtmDir);
  await store.write(relativeRoundPath(input.ref, input.round, input.agent), clean(round), roundBody(round));

  if (input.status === "failed" && input.raw) {
    const target = rawOutputPath(lgtmDir, input.ref, input.round, input.agent);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, input.raw, "utf-8");
  }

  return round;
}

function roundBody(round: RoundFile): string {
  const lines = [`# Round ${round.round} — ${round.agent}${round.provider ? ` (${round.provider})` : ""}`, ""];

  if (round.status === "failed") {
    lines.push("Review failed. See the .raw.txt file next to this one for the unparsed output.", "");
    return lines.join("\n");
  }

  if (round.findings.length === 0) {
    lines.push("No findings.", "");
    return lines.join("\n");
  }

  // Deliberately says nothing about state. This body is written once and
  // then left alone (see "editing the body does not get overwritten" below),
  // so a live status claim here would go stale the moment a finding's state
  // changes. Live state lives only in the frontmatter.
  lines.push(`${round.findings.length} finding(s).`, "");

  for (const f of round.findings) {
    lines.push(`### ${f.id} — \`${f.file}:${f.line}\` (${f.severity})`, "", f.comment, "");
    if (f.suggestion) lines.push(`Suggested: ${f.suggestion}`, "");
  }

  return lines.join("\n");
}

// ─── Meta ───────────────────────────────────────────────────────────────────

const PR_STATES: ReadonlySet<string> = new Set<PRState>([
  "triage",
  "skipped",
  "queued",
  "reviewing",
  "reviewed",
  "failed",
  "closed",
]);
const CLASSIFICATIONS: ReadonlySet<string> = new Set<Classification>([
  "own",
  "requested",
  "assigned",
  "mentioned",
  "manual",
  "none",
]);

const CHECK_STATES: ReadonlySet<string> = new Set<CheckState>(["success", "failure", "pending", "none"]);

/**
 * The triage-metadata fields are all nullable, and null is a real answer
 * ("never fetched"), not a parse failure. A missing key, a hand-deleted
 * value, or a string where a number belongs all read as null rather than
 * throwing or, worse, as 0.
 */
function nullableNumber(value: unknown): number | null {
  if (value == null) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * `mergeable` gets its own reader because it is the one field where a wrong
 * default does damage. GitHub answers null while it computes mergeability,
 * and that must stay null all the way to the browser, which renders it as
 * "computing". Anything that is not a real boolean is null, never false.
 * Telling someone their PR conflicts when it does not is worse than saying
 * nothing at all.
 */
function nullableBoolean(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

/**
 * Load a PR's metadata. Null means this PR has never been seen, which is how
 * the watcher tells a brand new PR from one already known.
 */
export async function loadMeta(lgtmDir: string, ref: PRRef): Promise<PRMeta | null> {
  const store = createOKFStore(lgtmDir);
  const doc = await readDocSafely(store, relativeMetaPath(ref));
  if (!doc) return null;

  const data = doc.data;

  return {
    owner: String(data.owner ?? ref.owner),
    repo: String(data.repo ?? ref.repo),
    number: Number(data.number ?? ref.number),
    url: String(data.url ?? prUrl(ref)),
    title: String(data.title ?? ""),
    author: String(data.author ?? ""),
    state: PR_STATES.has(data.state as string) ? (data.state as PRState) : "triage",
    classification: CLASSIFICATIONS.has(data.classification as string)
      ? (data.classification as Classification)
      : "none",
    draft: data.draft === true,
    headSha: String(data.headSha ?? ""),
    lastReviewedSha: data.lastReviewedSha == null ? null : String(data.lastReviewedSha),
    failedAttempts: Number(data.failedAttempts ?? 0),
    rounds: Number(data.rounds ?? 0),
    pendingReviewId: data.pendingReviewId == null ? null : Number(data.pendingReviewId),
    closedAt: data.closedAt == null ? null : String(data.closedAt),
    updatedAt: String(data.updatedAt ?? ""),
    createdAt: data.createdAt == null ? null : String(data.createdAt),
    additions: nullableNumber(data.additions),
    deletions: nullableNumber(data.deletions),
    changedFiles: nullableNumber(data.changedFiles),
    mergeable: nullableBoolean(data.mergeable),
    checkStatus: CHECK_STATES.has(data.checkStatus as string) ? (data.checkStatus as CheckState) : null,
  };
}

/**
 * Fields saveMeta may patch. Identity (owner/repo/number) is fixed by `ref`,
 * and updatedAt is always stamped by the store itself, never the caller.
 */
export type MetaUpdate = Partial<Omit<PRMeta, "owner" | "repo" | "number" | "updatedAt">>;

/**
 * Create or update a PR's metadata, merging onto whatever is already there.
 *
 * This is a plain upsert: the daemon decides *when* headSha changes, when
 * failedAttempts resets, when a round completes — this function only
 * persists whatever it is told. A field left out of `update` keeps its
 * existing value (or a tolerant default on first creation); a nullable field
 * set explicitly to `null` clears it, which is how pendingReviewId and
 * closedAt get cleared later.
 */
export async function saveMeta(lgtmDir: string, ref: PRRef, update: MetaUpdate = {}): Promise<PRMeta> {
  const existing = await loadMeta(lgtmDir, ref);

  const meta: PRMeta = {
    owner: ref.owner,
    repo: ref.repo,
    number: ref.number,
    url: update.url ?? existing?.url ?? prUrl(ref),
    title: update.title ?? existing?.title ?? "",
    author: update.author ?? existing?.author ?? "",
    state: update.state ?? existing?.state ?? "triage",
    classification: update.classification ?? existing?.classification ?? "none",
    draft: update.draft ?? existing?.draft ?? false,
    headSha: update.headSha ?? existing?.headSha ?? "",
    lastReviewedSha:
      "lastReviewedSha" in update ? (update.lastReviewedSha ?? null) : (existing?.lastReviewedSha ?? null),
    failedAttempts: update.failedAttempts ?? existing?.failedAttempts ?? 0,
    rounds: update.rounds ?? existing?.rounds ?? 0,
    pendingReviewId:
      "pendingReviewId" in update ? (update.pendingReviewId ?? null) : (existing?.pendingReviewId ?? null),
    closedAt: "closedAt" in update ? (update.closedAt ?? null) : (existing?.closedAt ?? null),
    updatedAt: new Date().toISOString(),
    // Every triage field takes the `in` form rather than `??`, so a caller
    // can write a measured null over a stale value. That matters most for
    // `mergeable`. A PR that starts conflicting and is then rebased goes
    // false -> null while GitHub recomputes, and `??` would keep showing the
    // old conflict.
    createdAt: "createdAt" in update ? (update.createdAt ?? null) : (existing?.createdAt ?? null),
    additions: "additions" in update ? (update.additions ?? null) : (existing?.additions ?? null),
    deletions: "deletions" in update ? (update.deletions ?? null) : (existing?.deletions ?? null),
    changedFiles:
      "changedFiles" in update ? (update.changedFiles ?? null) : (existing?.changedFiles ?? null),
    mergeable: "mergeable" in update ? (update.mergeable ?? null) : (existing?.mergeable ?? null),
    checkStatus: "checkStatus" in update ? (update.checkStatus ?? null) : (existing?.checkStatus ?? null),
  };

  const store = createOKFStore(lgtmDir);
  await store.write(relativeMetaPath(ref), clean(meta), metaBody(meta));
  return meta;
}

function metaBody(meta: PRMeta): string {
  const lines = [
    `# ${meta.owner}/${meta.repo}#${meta.number}`,
    "",
    `[${meta.title || "untitled"}](${meta.url})${meta.author ? ` by @${meta.author}` : ""}`,
    "",
    `State: ${meta.state}${meta.classification !== "none" ? ` (${meta.classification})` : ""}`,
    `Rounds: ${meta.rounds}`,
  ];

  if (meta.headSha) lines.push(`Head: \`${meta.headSha.slice(0, 12)}\``);
  if (meta.lastReviewedSha) lines.push(`Last reviewed: \`${meta.lastReviewedSha.slice(0, 12)}\``);

  const triage = triageLine(meta);
  if (triage) lines.push(triage);

  if (meta.pendingReviewId) {
    lines.push("", `A draft review is open on GitHub. Edit and submit it at ${meta.url}/files`);
  }

  if (meta.closedAt) {
    lines.push("", `Closed at ${meta.closedAt}.`);
  }

  return lines.join("\n") + "\n";
}

/**
 * The triage metadata as one readable line, or nothing when none of it has
 * been fetched. Each part is omitted on its own, so a PR whose detail landed
 * but whose Checks call failed still reads its size.
 *
 * `mergeable: null` is deliberately absent rather than rendered as a word.
 * The frontmatter above carries the null for anything reading the file as
 * data, and a body line claiming anything about mergeability while GitHub is
 * still computing it would be the one sentence here that could mislead.
 */
function triageLine(meta: PRMeta): string | null {
  const parts: string[] = [];

  if (meta.additions !== null || meta.deletions !== null) {
    const size = `+${meta.additions ?? 0} -${meta.deletions ?? 0}`;
    parts.push(meta.changedFiles !== null ? `${size} across ${meta.changedFiles} file(s)` : size);
  }

  if (meta.mergeable !== null) parts.push(meta.mergeable ? "mergeable" : "conflicts");
  if (meta.checkStatus !== null) parts.push(`checks: ${meta.checkStatus}`);

  return parts.length > 0 ? `Changes: ${parts.join(", ")}` : null;
}

// ─── Finding mutations ──────────────────────────────────────────────────────

/**
 * Apply a change to every finding across a PR's round files that `apply`
 * accepts, and report which ones actually changed as canonical keys.
 *
 * The body is preserved verbatim: only `findings` in the frontmatter is
 * rewritten, so a human's notes in the markdown below survive a gate action.
 */
async function updateFindings(
  lgtmDir: string,
  ref: PRRef,
  apply: (finding: Finding, round: RoundFile) => boolean
): Promise<string[]> {
  const store = createOKFStore(lgtmDir);
  const changed: string[] = [];

  const relPaths = (await store.list(relativeReviewDir(ref))).filter((p) =>
    ROUND_FILE_RE.test(path.basename(p))
  );

  for (const relPath of relPaths) {
    const doc = await readDocSafely(store, relPath);
    if (!doc) continue;

    const round = parseRoundFileData(doc.data);

    let dirty = false;
    for (const finding of round.findings) {
      if (!apply(finding, round)) continue;
      changed.push(formatFindingKey({ round: round.round, agent: round.agent, id: finding.id }));
      dirty = true;
    }

    if (!dirty) continue;

    await store.write(relPath, clean({ ...doc.data, findings: round.findings }), doc.content);
  }

  return changed;
}

function keyOf(round: RoundFile, finding: Finding): string {
  return formatFindingKey({ round: round.round, agent: round.agent, id: finding.id });
}

/**
 * Mark findings posted. Applies to `open` or `held` findings (a held one
 * that now validates returns to play automatically, R6.3); a finding already
 * `posted` or `discarded` is left alone, so re-running a post is idempotent.
 */
export async function markFindingsPosted(lgtmDir: string, ref: PRRef, keys: string[]): Promise<string[]> {
  const wanted = new Set(keys);

  return updateFindings(lgtmDir, ref, (finding, round) => {
    if (!wanted.has(keyOf(round, finding))) return false;
    if (finding.state !== "open" && finding.state !== "held") return false;

    finding.state = "posted";
    finding.heldReason = null;
    return true;
  });
}

/**
 * Hold findings back with a reason (R6.3: a line that no longer validates
 * against the current diff). Applies to `open` or `held` findings only —
 * once a finding is `posted` it is too late for a later post's validation
 * pass to relabel it, and a `discarded` finding was a deliberate human call.
 */
export async function markFindingsHeld(
  lgtmDir: string,
  ref: PRRef,
  entries: Array<{ key: string; reason: string }>
): Promise<string[]> {
  const reasons = new Map(entries.map((e) => [e.key, e.reason]));

  return updateFindings(lgtmDir, ref, (finding, round) => {
    const reason = reasons.get(keyOf(round, finding));
    if (reason === undefined) return false;
    if (finding.state !== "open" && finding.state !== "held") return false;

    finding.state = "held";
    finding.heldReason = reason;
    return true;
  });
}

/**
 * Drop findings before they are posted. They stay on disk, marked
 * discarded, so a discard is auditable rather than a deletion.
 */
export async function markFindingsDiscarded(lgtmDir: string, ref: PRRef, keys: string[]): Promise<string[]> {
  const wanted = new Set(keys);

  return updateFindings(lgtmDir, ref, (finding, round) => {
    if (!wanted.has(keyOf(round, finding))) return false;
    // Already on GitHub means it is too late to take back here.
    if (finding.state !== "open" && finding.state !== "held") return false;

    finding.state = "discarded";
    finding.heldReason = null;
    return true;
  });
}

/**
 * Reopen findings. Two callers, both in R5–R6:
 *  - a discard is reversible (R5.2): `discarded` -> `open`.
 *  - recreating a draft review flips that draft's posted findings back to
 *    open, since their comments left GitHub with the deleted draft (R6.1):
 *    `posted` -> `open`.
 * A finding already `open` or currently `held` (mid validation) is left
 * alone.
 */
export async function markFindingsOpen(lgtmDir: string, ref: PRRef, keys: string[]): Promise<string[]> {
  const wanted = new Set(keys);

  return updateFindings(lgtmDir, ref, (finding, round) => {
    if (!wanted.has(keyOf(round, finding))) return false;
    if (finding.state !== "discarded" && finding.state !== "posted") return false;

    finding.state = "open";
    finding.heldReason = null;
    return true;
  });
}

// ─── Discovery ──────────────────────────────────────────────────────────────

/**
 * Every PR with a meta file on disk, across every watched or once-watched
 * repo. Used to resolve a bare PR reference against the store and to answer
 * "what does LGTM already know about" independent of the watch list.
 */
export async function listReviewedPRs(lgtmDir: string): Promise<PRRef[]> {
  const reviewsRoot = path.join(lgtmDir, "reviews");
  const refs: PRRef[] = [];

  for (const owner of await listSubdirs(reviewsRoot)) {
    for (const repo of await listSubdirs(path.join(reviewsRoot, owner))) {
      for (const prDir of await listSubdirs(path.join(reviewsRoot, owner, repo))) {
        const match = /^pr-(\d+)$/.exec(prDir);
        if (!match) continue; // not a review directory; ignore stray entries

        const number = Number(match[1]);
        const meta = await loadMeta(lgtmDir, { owner, repo, number });
        if (meta) refs.push({ owner: meta.owner, repo: meta.repo, number: meta.number });
      }
    }
  }

  return refs.sort((a, b) => a.owner.localeCompare(b.owner) || a.repo.localeCompare(b.repo) || a.number - b.number);
}

async function listSubdirs(dir: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return [];
  }
}

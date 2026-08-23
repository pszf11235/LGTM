/**
 * Review storage — findings on disk, one directory per PR, one file per round.
 *
 * Everything the tool learns about a PR lands here before anything is posted.
 * That ordering is the point: findings are local first, a human edits or drops
 * them, and only then does GitHub hear about it.
 *
 * ```
 * ~/.lgtm-farm/reviews/pszf11235-LGTM-42/
 *   meta.md          rounds, lastReviewedSha, pendingReviewId
 *   r1-reviewer.md   round 1 findings from the "reviewer" agent
 *   r2-reviewer.md   round 2, after new commits
 * ```
 *
 * The directory name carries the repo because one store serves every
 * repository. Frontmatter repeats owner, repo and url so a single file is
 * self-describing when read on its own, which is how an agent will read it.
 */

import fs from "fs";
import path from "path";
import matter from "gray-matter";
import { getReviewDir, repoSlug } from "@lgtm/core/store/paths.js";
import type { Severity } from "@lgtm/core/store/agents.js";
import type { ProviderId } from "@lgtm/core/ai/providers.js";
import type { RawFinding } from "./providers.js";

// ─── Types ──────────────────────────────────────────────────────────────────

export interface StoredFinding {
  /** Stable within its round file: f1, f2, ... So `review discard -f f3` works. */
  id: string;

  file: string;
  line: number;
  severity: Severity;
  comment: string;
  suggestion?: string;

  /** Set once the finding is part of a review on GitHub. */
  posted: boolean;
  postedAt?: string;

  /** The pending review this went out in. */
  pendingReviewId?: number;

  /** Dropped by the user before posting. Never sent, never deleted. */
  discarded: boolean;

  /** Could not be posted, e.g. the line is not in the diff. */
  skipped?: boolean;
  skipReason?: string;

  /** Filled in by a later verification pass. */
  resolved?: boolean;
  resolvedNote?: string;
}

export interface RoundRecord {
  round: number;
  sha: string;
  reviewedAt: string;
  agents: string[];
  findingCount: number;
  postedCount: number;
  pendingReviewId?: number | null;
  submittedAt?: string;

  /** Set on rounds that re-reviewed after new commits. */
  verifiedPriorRound?: number;
  resolvedFromPrior?: number;
  unresolvedFromPrior?: number;
}

export interface ReviewMeta {
  owner: string;
  repo: string;
  pr: number;
  url: string;
  title: string;
  author: string;

  currentRound: number;

  /** Head SHA at the last review. Comparing this is how new commits are found. */
  lastReviewedSha: string;

  /** The open pending review on GitHub, if any. */
  pendingReviewId?: number | null;

  rounds: RoundRecord[];
}

export interface RoundFile {
  round: number;
  agent: string;
  provider: ProviderId | null;
  sha: string;
  reviewedAt: string;
  durationMs: number;
  findings: StoredFinding[];
  /** Set when the provider output could not be parsed. */
  error?: string | null;
}

export interface PRRef {
  owner: string;
  repo: string;
  pr: number;
}

// ─── Paths ──────────────────────────────────────────────────────────────────

export function reviewDir(lgtmDir: string, ref: PRRef): string {
  return getReviewDir(lgtmDir, ref.owner, ref.repo, ref.pr);
}

function metaPath(lgtmDir: string, ref: PRRef): string {
  return path.join(reviewDir(lgtmDir, ref), "meta.md");
}

function roundPath(lgtmDir: string, ref: PRRef, round: number, agent: string): string {
  return path.join(reviewDir(lgtmDir, ref), `r${round}-${agent}.md`);
}

/** Where unparseable provider output is kept, so a bad round can be debugged. */
export function rawOutputPath(lgtmDir: string, ref: PRRef, round: number, agent: string): string {
  return path.join(reviewDir(lgtmDir, ref), `r${round}-${agent}.raw.txt`);
}

// ─── Reading ────────────────────────────────────────────────────────────────

/**
 * Load a PR's review metadata. Null means this PR has never been reviewed,
 * which is how the watcher tells a new PR from one it has already seen.
 */
export function loadMeta(lgtmDir: string, ref: PRRef): ReviewMeta | null {
  try {
    const raw = fs.readFileSync(metaPath(lgtmDir, ref), "utf-8");
    const { data } = matter(raw);

    if (!data || typeof data !== "object") return null;

    return {
      owner: String(data.owner ?? ref.owner),
      repo: String(data.repo ?? ref.repo),
      pr: Number(data.pr ?? ref.pr),
      url: String(data.url ?? prUrl(ref)),
      title: String(data.title ?? ""),
      author: String(data.author ?? ""),
      currentRound: Number(data.currentRound ?? 0),
      lastReviewedSha: String(data.lastReviewedSha ?? ""),
      pendingReviewId: data.pendingReviewId == null ? null : Number(data.pendingReviewId),
      rounds: Array.isArray(data.rounds) ? (data.rounds as RoundRecord[]) : [],
    };
  } catch {
    return null;
  }
}

/** Load one round file. */
export function loadRound(
  lgtmDir: string,
  ref: PRRef,
  round: number,
  agent: string
): RoundFile | null {
  return readRoundFile(roundPath(lgtmDir, ref, round, agent));
}

function readRoundFile(filePath: string): RoundFile | null {
  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    const { data } = matter(raw);

    return {
      round: Number(data.round ?? 0),
      agent: String(data.agent ?? ""),
      provider: (data.provider as ProviderId) ?? null,
      sha: String(data.sha ?? ""),
      reviewedAt: String(data.reviewedAt ?? ""),
      durationMs: Number(data.durationMs ?? 0),
      findings: normaliseFindings(data.findings),
      error: (data.error as string | null) ?? null,
    };
  } catch {
    return null;
  }
}

/**
 * Findings are hand-editable, so missing fields are filled rather than trusted.
 * A finding with no `posted` field must read as unposted, not as undefined,
 * because "should this be sent to GitHub" is decided on that value.
 */
function normaliseFindings(value: unknown): StoredFinding[] {
  if (!Array.isArray(value)) return [];

  return value
    .filter((f): f is Record<string, unknown> => !!f && typeof f === "object")
    .map((f, i) => ({
      id: String(f.id ?? `f${i + 1}`),
      file: String(f.file ?? ""),
      line: Number(f.line ?? 0),
      severity: (f.severity as Severity) ?? "medium",
      comment: String(f.comment ?? ""),
      suggestion: f.suggestion ? String(f.suggestion) : undefined,
      posted: f.posted === true,
      postedAt: f.postedAt ? String(f.postedAt) : undefined,
      pendingReviewId: f.pendingReviewId == null ? undefined : Number(f.pendingReviewId),
      discarded: f.discarded === true,
      skipped: f.skipped === true ? true : undefined,
      skipReason: f.skipReason ? String(f.skipReason) : undefined,
      resolved: typeof f.resolved === "boolean" ? f.resolved : undefined,
      resolvedNote: f.resolvedNote ? String(f.resolvedNote) : undefined,
    }))
    .filter((f) => f.file && f.comment);
}

/** Every round file for a PR, oldest round first. */
export function loadAllRounds(lgtmDir: string, ref: PRRef): RoundFile[] {
  const dir = reviewDir(lgtmDir, ref);

  let files: string[];
  try {
    files = fs.readdirSync(dir).filter((f) => /^r\d+-.*\.md$/.test(f));
  } catch {
    return [];
  }

  return files
    .map((f) => readRoundFile(path.join(dir, f)))
    .filter((r): r is RoundFile => r !== null)
    .sort((a, b) => a.round - b.round || a.agent.localeCompare(b.agent));
}

/**
 * Findings eligible to be posted: not already posted, not discarded.
 *
 * A skipped finding stays eligible on purpose. It was skipped because its line
 * was not in the diff at the time, and a later round may bring that line back.
 */
export function pendingFindings(lgtmDir: string, ref: PRRef): Array<StoredFinding & { round: number; agent: string }> {
  return loadAllRounds(lgtmDir, ref).flatMap((round) =>
    round.findings
      .filter((f) => !f.posted && !f.discarded)
      .map((f) => ({ ...f, round: round.round, agent: round.agent }))
  );
}

/**
 * Findings already on GitHub. These are what a verification pass checks, since
 * a finding the author never saw cannot have been addressed.
 */
export function postedFindings(lgtmDir: string, ref: PRRef): Array<StoredFinding & { round: number; agent: string }> {
  return loadAllRounds(lgtmDir, ref).flatMap((round) =>
    round.findings
      .filter((f) => f.posted)
      .map((f) => ({ ...f, round: round.round, agent: round.agent }))
  );
}

// ─── Writing ────────────────────────────────────────────────────────────────

export function prUrl(ref: PRRef): string {
  return `https://github.com/${ref.owner}/${ref.repo}/pull/${ref.pr}`;
}

/** gray-matter cannot serialise undefined, so it has to go. */
function clean<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function writeDoc(filePath: string, data: unknown, body: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, matter.stringify(body, clean(data) as object), "utf-8");
}

export interface SaveRoundInput {
  ref: PRRef;
  title: string;
  author: string;
  sha: string;
  round: number;
  agent: string;
  provider: ProviderId | null;
  findings: RawFinding[];
  durationMs: number;
  error?: string | null;
  /** Unparseable provider output, written alongside for debugging. */
  raw?: string;
}

/**
 * Write one agent's findings for one round.
 *
 * Findings get ids `f1..fn` in file order. They are stable because the file is
 * never reordered, which is what lets `review discard -f f3` mean one specific
 * finding across sessions.
 */
export function saveRound(lgtmDir: string, input: SaveRoundInput): RoundFile {
  const reviewedAt = new Date().toISOString();

  const findings: StoredFinding[] = input.findings.map((f, i) => ({
    id: `f${i + 1}`,
    file: f.file,
    line: f.line,
    severity: f.severity,
    comment: f.comment,
    suggestion: f.suggestion,
    posted: false,
    discarded: false,
  }));

  const round: RoundFile = {
    round: input.round,
    agent: input.agent,
    provider: input.provider,
    sha: input.sha,
    reviewedAt,
    durationMs: input.durationMs,
    findings,
    error: input.error ?? null,
  };

  writeDoc(
    roundPath(lgtmDir, input.ref, input.round, input.agent),
    {
      type: "lgtm/review-findings",
      owner: input.ref.owner,
      repo: input.ref.repo,
      pr: input.ref.pr,
      url: prUrl(input.ref),
      round: input.round,
      agent: input.agent,
      provider: input.provider,
      sha: input.sha,
      reviewedAt,
      durationMs: input.durationMs,
      error: input.error ?? null,
      findings,
    },
    roundBody(input, findings)
  );

  // Keep the raw output only when we could not read it. Otherwise every review
  // would leave a copy of the full provider transcript on disk.
  if (input.raw && input.error) {
    const target = rawOutputPath(lgtmDir, input.ref, input.round, input.agent);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, input.raw, "utf-8");
  }

  return round;
}

function roundBody(input: SaveRoundInput, findings: StoredFinding[]): string {
  const lines = [
    `# Round ${input.round} — ${input.agent}${input.provider ? ` (${input.provider})` : ""}`,
    "",
    `${input.ref.owner}/${input.ref.repo}#${input.ref.pr} — [${input.title || "untitled"}](${prUrl(input.ref)})`,
    "",
  ];

  if (input.error) {
    lines.push(`Review failed: ${input.error}`, "");
    return lines.join("\n");
  }

  if (findings.length === 0) {
    lines.push("No findings.", "");
    return lines.join("\n");
  }

  // Deliberately says nothing about posted or discarded state. This body is
  // written once and then preserved, so that a user can annotate it, which
  // means any status claim here would go stale the moment findings change.
  // Live state lives in the frontmatter and in meta.md.
  lines.push(`${findings.length} finding(s).`, "");

  for (const f of findings) {
    lines.push(`### ${f.id} — \`${f.file}:${f.line}\` (${f.severity})`, "", f.comment, "");
    if (f.suggestion) lines.push(`Suggested: ${f.suggestion}`, "");
  }

  return lines.join("\n");
}

export interface SaveMetaInput {
  ref: PRRef;
  title: string;
  author: string;
  sha: string;
  round: number;
  agents: string[];
  findingCount: number;
  verifiedPriorRound?: number;
  resolvedFromPrior?: number;
  unresolvedFromPrior?: number;
}

/**
 * Record a completed round in meta.md, creating the file on the first round.
 *
 * Re-running the same round number replaces its record rather than appending,
 * so a retried review does not leave a phantom round behind.
 */
export function saveMeta(lgtmDir: string, input: SaveMetaInput): ReviewMeta {
  const existing = loadMeta(lgtmDir, input.ref);

  const record: RoundRecord = {
    round: input.round,
    sha: input.sha,
    reviewedAt: new Date().toISOString(),
    agents: input.agents,
    findingCount: input.findingCount,
    postedCount: 0,
    pendingReviewId: null,
    ...(input.verifiedPriorRound !== undefined
      ? {
          verifiedPriorRound: input.verifiedPriorRound,
          resolvedFromPrior: input.resolvedFromPrior ?? 0,
          unresolvedFromPrior: input.unresolvedFromPrior ?? 0,
        }
      : {}),
  };

  const rounds = (existing?.rounds ?? []).filter((r) => r.round !== input.round);
  rounds.push(record);
  rounds.sort((a, b) => a.round - b.round);

  const meta: ReviewMeta = {
    owner: input.ref.owner,
    repo: input.ref.repo,
    pr: input.ref.pr,
    url: prUrl(input.ref),
    title: input.title || existing?.title || "",
    author: input.author || existing?.author || "",
    currentRound: Math.max(input.round, existing?.currentRound ?? 0),
    lastReviewedSha: input.sha,
    pendingReviewId: existing?.pendingReviewId ?? null,
    rounds,
  };

  writeMeta(lgtmDir, meta);
  return meta;
}

function writeMeta(lgtmDir: string, meta: ReviewMeta): void {
  writeDoc(
    metaPath(lgtmDir, { owner: meta.owner, repo: meta.repo, pr: meta.pr }),
    { type: "lgtm/review-meta", ...meta },
    metaBody(meta)
  );
}

function metaBody(meta: ReviewMeta): string {
  const lines = [
    `# Review — ${meta.owner}/${meta.repo}#${meta.pr}`,
    "",
    `[${meta.title || "untitled"}](${meta.url})${meta.author ? ` by @${meta.author}` : ""}`,
    "",
    `Round ${meta.currentRound}. Last reviewed at \`${meta.lastReviewedSha.slice(0, 12)}\`.`,
    "",
  ];

  if (meta.pendingReviewId) {
    lines.push(
      `A draft review is open on GitHub. Edit and submit it at ${meta.url}/files`,
      ""
    );
  }

  if (meta.rounds.length > 0) {
    lines.push("| Round | SHA | Findings | Posted | Notes |", "|---|---|---|---|---|");
    for (const r of meta.rounds) {
      const notes =
        r.verifiedPriorRound !== undefined
          ? `verified round ${r.verifiedPriorRound}: ${r.resolvedFromPrior} resolved, ${r.unresolvedFromPrior} open`
          : "";
      lines.push(
        `| ${r.round} | \`${r.sha.slice(0, 8)}\` | ${r.findingCount} | ${r.postedCount} | ${notes} |`
      );
    }
    lines.push("");
  }

  return lines.join("\n");
}

// ─── Mutations ──────────────────────────────────────────────────────────────

/**
 * Apply a change to specific findings across every round file.
 *
 * Returns the ids it actually changed, so a caller can tell the user which of
 * the ids they typed did not exist rather than silently doing nothing.
 */
function updateFindings(
  lgtmDir: string,
  ref: PRRef,
  apply: (f: StoredFinding, round: RoundFile) => boolean
): string[] {
  const changed: string[] = [];
  const dir = reviewDir(lgtmDir, ref);

  let files: string[];
  try {
    files = fs.readdirSync(dir).filter((f) => /^r\d+-.*\.md$/.test(f));
  } catch {
    return [];
  }

  for (const file of files) {
    const filePath = path.join(dir, file);
    const round = readRoundFile(filePath);
    if (!round) continue;

    let dirty = false;
    for (const finding of round.findings) {
      if (!apply(finding, round)) continue;
      changed.push(finding.id);
      dirty = true;
    }

    if (!dirty) continue;

    // Preserve the body. Only the frontmatter's findings change.
    const raw = fs.readFileSync(filePath, "utf-8");
    const { data, content } = matter(raw);
    writeDoc(filePath, { ...data, findings: round.findings }, content.trim());
  }

  return changed;
}

/**
 * Address one finding across the whole store.
 *
 * Ids restart at f1 in every round file and for every agent, so a bare id names
 * several different findings. Anything that writes has to say which one.
 */
export function findingKey(round: number, agent: string, id: string): string {
  return `${round}:${agent}:${id}`;
}

/** Mark findings as posted, tying them to the pending review they went out in. */
export function markFindingsPosted(
  lgtmDir: string,
  ref: PRRef,
  keys: string[],
  pendingReviewId: number
): string[] {
  const wanted = new Set(keys);
  const postedAt = new Date().toISOString();

  const changed = updateFindings(lgtmDir, ref, (f, round) => {
    if (!wanted.has(findingKey(round.round, round.agent, f.id)) || f.posted) return false;

    f.posted = true;
    f.postedAt = postedAt;
    f.pendingReviewId = pendingReviewId;
    // It made it out, so any earlier skip no longer applies.
    f.skipped = undefined;
    f.skipReason = undefined;
    return true;
  });

  syncMetaCounts(lgtmDir, ref, pendingReviewId);
  return changed;
}

/**
 * Record that a finding could not be posted, keeping it eligible for later.
 *
 * GitHub rejects a review comment on a line outside the diff, so those are held
 * back rather than dropped. Nothing is lost silently.
 */
export function markFindingsSkipped(
  lgtmDir: string,
  ref: PRRef,
  entries: Array<{ key: string; reason: string }>
): string[] {
  const reasons = new Map(entries.map((e) => [e.key, e.reason]));

  return updateFindings(lgtmDir, ref, (f, round) => {
    const key = findingKey(round.round, round.agent, f.id);
    // Already on GitHub is not "held back". Without this a later round's skip
    // could relabel a published finding.
    if (!reasons.has(key) || f.posted) return false;

    f.skipped = true;
    f.skipReason = reasons.get(key);
    return true;
  });
}

/**
 * Drop findings before they are posted. They stay on disk, marked discarded,
 * so a discarded finding is auditable rather than vanished.
 */
export function markFindingsDiscarded(lgtmDir: string, ref: PRRef, keys: string[]): string[] {
  const wanted = new Set(keys);

  return updateFindings(lgtmDir, ref, (f, round) => {
    // Already on GitHub means it is too late for us to take it back here.
    if (!wanted.has(findingKey(round.round, round.agent, f.id)) || f.posted) return false;

    f.discarded = true;
    return true;
  });
}

/**
 * Record verification verdicts against the findings they refer to.
 *
 * Verdicts arrive as 1-based indices into the list handed to the provider, so
 * the caller passes that same list back to map them onto ids.
 */
export function applyVerdicts(
  lgtmDir: string,
  ref: PRRef,
  checked: Array<{ id: string; round: number; agent: string }>,
  verdicts: Array<{ index: number; resolved: boolean; note: string }>
): { resolved: number; unresolved: number } {
  const byId = new Map<string, { resolved: boolean; note: string }>();

  for (const verdict of verdicts) {
    const target = checked[verdict.index - 1];
    if (!target) continue;
    byId.set(`${target.round}:${target.agent}:${target.id}`, verdict);
  }

  let resolved = 0;
  let unresolved = 0;

  updateFindings(lgtmDir, ref, (f, round) => {
    // Keyed by round and agent as well as id, because ids restart at f1 in
    // every round file.
    const verdict = byId.get(`${round.round}:${round.agent}:${f.id}`);
    if (!verdict) return false;

    f.resolved = verdict.resolved;
    f.resolvedNote = verdict.note;

    if (verdict.resolved) resolved++;
    else unresolved++;

    return true;
  });

  return { resolved, unresolved };
}

/** Recompute posted counts in meta after findings change. */
function syncMetaCounts(lgtmDir: string, ref: PRRef, pendingReviewId?: number): void {
  const meta = loadMeta(lgtmDir, ref);
  if (!meta) return;

  const rounds = loadAllRounds(lgtmDir, ref);

  for (const record of meta.rounds) {
    const forRound = rounds.filter((r) => r.round === record.round);
    record.findingCount = forRound.reduce((n, r) => n + r.findings.length, 0);
    record.postedCount = forRound.reduce(
      (n, r) => n + r.findings.filter((f) => f.posted).length,
      0
    );
    if (pendingReviewId && record.round === meta.currentRound) {
      record.pendingReviewId = pendingReviewId;
    }
  }

  if (pendingReviewId) meta.pendingReviewId = pendingReviewId;

  writeMeta(lgtmDir, meta);
}

/** Record the id of a newly created pending review. */
export function setPendingReviewId(lgtmDir: string, ref: PRRef, id: number | null): void {
  const meta = loadMeta(lgtmDir, ref);
  if (!meta) return;

  meta.pendingReviewId = id;
  const current = meta.rounds.find((r) => r.round === meta.currentRound);
  if (current) current.pendingReviewId = id;

  writeMeta(lgtmDir, meta);
}

/** Record that the pending review was submitted, clearing it from meta. */
export function markSubmitted(lgtmDir: string, ref: PRRef): void {
  const meta = loadMeta(lgtmDir, ref);
  if (!meta) return;

  const submittedAt = new Date().toISOString();
  const current = meta.rounds.find((r) => r.round === meta.currentRound);
  if (current) current.submittedAt = submittedAt;

  meta.pendingReviewId = null;
  writeMeta(lgtmDir, meta);
}

// ─── Discovery ──────────────────────────────────────────────────────────────

/**
 * Every PR with a review on disk. Used by `review status` and to resolve a bare
 * PR number against the store.
 */
export function listReviewedPRs(lgtmDir: string): PRRef[] {
  const dir = path.join(lgtmDir, "reviews");

  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return [];
  }

  const refs: PRRef[] = [];

  for (const entry of entries) {
    const meta = readMetaByDirName(dir, entry);
    if (meta) refs.push(meta);
  }

  return refs.sort((a, b) => a.owner.localeCompare(b.owner) || a.repo.localeCompare(b.repo) || a.pr - b.pr);
}

/**
 * Read a PR reference out of a review directory.
 *
 * The frontmatter is trusted over the directory name, because a repo whose name
 * contains a hyphen makes `<owner>-<repo>-<pr>` ambiguous to split.
 */
function readMetaByDirName(reviewsDir: string, dirName: string): PRRef | null {
  try {
    const raw = fs.readFileSync(path.join(reviewsDir, dirName, "meta.md"), "utf-8");
    const { data } = matter(raw);
    if (!data?.owner || !data?.repo || !data?.pr) return null;
    return { owner: String(data.owner), repo: String(data.repo), pr: Number(data.pr) };
  } catch {
    return null;
  }
}

/** The directory name for a PR, for display. */
export function reviewSlug(ref: PRRef): string {
  return repoSlug(ref.owner, ref.repo, ref.pr);
}

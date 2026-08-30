/**
 * Diff snapshot writer.
 *
 * When a round finishes, finding cards need the exact diff that round
 * reviewed so hunks can be sliced later without hitting GitHub again
 * (design.md, "Review execution"; requirements.md R5.1). The naive way to
 * get that diff is wrong: ForgeAdapter#getDiff only ever returns the PR's
 * *current* head diff (design.md, "ForgeAdapter"), and a round takes
 * minutes to run (spike-provider.md measured 5m44s for a two-file PR). If
 * the head moves during that window, "the diff" by the time the round
 * completes is not the diff the round actually reviewed, and saving it
 * under the reviewed SHA's filename would mislabel it silently — a finding
 * card would then slice hunks from the wrong text.
 *
 * The fix: never trust `getDiff`'s output for a SHA without checking the
 * PR's current head against it first, and take that reading from the round
 * itself (`headSha` on RoundFile), never from `meta.headSha` or any other
 * "current" field that could have moved on since. This module checks twice,
 * immediately before and immediately after the fetch, so the only unguarded
 * window is the single round trip of the fetch itself — as tight as
 * ForgeAdapter's current-head-only contract allows. Either check failing
 * means nothing gets written. A missing snapshot is a known, handled state
 * (the findings API falls back to a GitHub link); a wrong one is not.
 */

import fs from "fs/promises";
import path from "path";
import type { ForgeAdapter, PRRef } from "@/core";
import { diffSnapshotPath, loadAllRounds, reviewDir } from "@/store/reviews";

/** The slice of ForgeAdapter this module calls, so tests can supply exactly that and nothing else. */
export type SnapshotForge = Pick<ForgeAdapter, "getPR" | "getDiff">;

export interface SnapshotLogger {
  warn(message: string): void;
}

export interface SnapshotOptions {
  logger?: SnapshotLogger;
}

export type SnapshotOutcome =
  | { status: "written"; sha: string; path: string }
  | { status: "skipped"; sha: string; reason: "head-moved" }
  | { status: "error"; sha: string; reason: string };

/**
 * Fetch and store the diff for exactly one reviewed SHA.
 *
 * `reviewedSha` must be the SHA the round recorded, not a live reading of
 * the PR's head — that is the one rule this module exists to enforce.
 */
export async function writeDiffSnapshot(
  lgtmDir: string,
  forge: SnapshotForge,
  ref: PRRef,
  reviewedSha: string,
  options: SnapshotOptions = {}
): Promise<SnapshotOutcome> {
  const logger = options.logger ?? console;

  const before = await currentHead(forge, ref);
  if (before.status === "error") return { status: "error", sha: reviewedSha, reason: before.reason };
  if (before.sha !== reviewedSha) {
    logger.warn(
      `snapshot: skipping ${refLabel(ref)} at ${reviewedSha}, current head is ${before.sha}`
    );
    return { status: "skipped", sha: reviewedSha, reason: "head-moved" };
  }

  let diff: string;
  try {
    diff = await forge.getDiff(ref);
  } catch (err) {
    return { status: "error", sha: reviewedSha, reason: errorMessage(err) };
  }

  const after = await currentHead(forge, ref);
  if (after.status === "error") return { status: "error", sha: reviewedSha, reason: after.reason };
  if (after.sha !== reviewedSha) {
    logger.warn(
      `snapshot: discarding fetched diff for ${refLabel(ref)} at ${reviewedSha}, head moved to ${after.sha} mid-fetch`
    );
    return { status: "skipped", sha: reviewedSha, reason: "head-moved" };
  }

  const target = diffSnapshotPath(lgtmDir, ref, reviewedSha);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, diff, "utf-8");

  return { status: "written", sha: reviewedSha, path: target };
}

type HeadReading = { status: "ok"; sha: string } | { status: "error"; reason: string };

async function currentHead(forge: SnapshotForge, ref: PRRef): Promise<HeadReading> {
  try {
    const detail = await forge.getPR(ref);
    return { status: "ok", sha: detail.headSha };
  } catch (err) {
    return { status: "error", reason: errorMessage(err) };
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function refLabel(ref: PRRef): string {
  return `${ref.owner}/${ref.repo}#${ref.number}`;
}

// ─── Cleanup ────────────────────────────────────────────────────────────────

const SNAPSHOT_FILE_RE = /^diff-(.+)\.patch$/;

export interface PruneResult {
  /** Absolute paths of the snapshot files removed. */
  removed: string[];
}

/**
 * Delete snapshot files for SHAs no round file references any more, so a
 * long-lived PR's directory does not grow without bound as rounds
 * accumulate (design.md, "Store layout"). "Referenced" means some round
 * file's `headSha` still names that SHA; failed rounds count too, since
 * RoundFile always carries `headSha` regardless of `status`.
 */
export async function pruneDiffSnapshots(lgtmDir: string, ref: PRRef): Promise<PruneResult> {
  const dir = reviewDir(lgtmDir, ref);

  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return { removed: [] };
  }

  const rounds = await loadAllRounds(lgtmDir, ref);
  const referenced = new Set(rounds.map((r) => r.headSha));

  const removed: string[] = [];
  for (const entry of entries) {
    const match = SNAPSHOT_FILE_RE.exec(entry);
    if (!match) continue;

    const [, sha] = match as unknown as [string, string];
    if (referenced.has(sha)) continue;

    const target = path.join(dir, entry);
    await fs.rm(target, { force: true });
    removed.push(target);
  }

  return { removed };
}

// ─── Combined entry point ──────────────────────────────────────────────────

export interface SnapshotRoundResult {
  write: SnapshotOutcome;
  pruned: string[];
}

/**
 * What the daemon calls when a round completes: write this round's
 * snapshot, then prune whatever earlier snapshots have fallen out of
 * reference. Pruning runs even when the write is skipped or errors — it is
 * independent maintenance, and a bad fetch should not also leave stale
 * snapshots piling up.
 */
export async function snapshotRound(
  lgtmDir: string,
  forge: SnapshotForge,
  ref: PRRef,
  reviewedSha: string,
  options: SnapshotOptions = {}
): Promise<SnapshotRoundResult> {
  const write = await writeDiffSnapshot(lgtmDir, forge, ref, reviewedSha, options);
  const { removed } = await pruneDiffSnapshots(lgtmDir, ref);
  return { write, pruned: removed };
}

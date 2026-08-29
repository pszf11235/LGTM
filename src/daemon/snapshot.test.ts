/**
 * The bug this module exists to prevent: a naive snapshot writer asks the
 * Forge for "the diff" once a round finishes and trusts it. ForgeAdapter's
 * getDiff always returns the PR's *current* head diff, and a round takes
 * minutes, so by the time it completes the head may already be a different
 * SHA than the one reviewed. The tests below simulate a head that moves
 * during that window and assert the module refuses to mislabel a newer
 * diff as the reviewed SHA's snapshot, both when the move has already
 * happened before the fetch and when it happens mid-fetch.
 */
import { beforeEach, describe, expect, test } from "bun:test";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { pruneDiffSnapshots, snapshotRound, writeDiffSnapshot, type SnapshotForge } from "./snapshot";
import { diffSnapshotPath, saveRound } from "@/store/reviews";
import type { PRDetail, PRRef } from "@/core";

let store: string;

const ref: PRRef = { owner: "pszf11235", repo: "LGTM", number: 42 };

const REVIEWED_SHA = "a".repeat(40);
const MOVED_SHA = "b".repeat(40);

function prDetail(headSha: string, over: Partial<PRDetail> = {}): PRDetail {
  return {
    number: ref.number,
    title: "Add rate limiter",
    body: "",
    url: `https://github.com/${ref.owner}/${ref.repo}/pull/${ref.number}`,
    author: "pszf11235",
    draft: false,
    headSha,
    createdAt: "2026-08-01T00:00:00Z",
    updatedAt: "2026-08-01T00:00:00Z",
    requestedReviewers: [],
    assignees: [],
    additions: 10,
    deletions: 2,
    changedFiles: 1,
    mergeable: true,
    ...over,
  };
}

/**
 * A forge whose getPR answers, in order, from `headShas` (repeating the
 * last entry once exhausted), and whose getDiff returns a fixed body unless
 * overridden. Lets a test script "head was already X" (one entry) or "head
 * moves between the two checks" (two entries) without a stateful mock class.
 */
function fakeForge(opts: {
  headShas: string[];
  diff?: string;
  onGetPR?: () => void;
  getPRError?: Error;
  getDiffError?: Error;
}): SnapshotForge {
  let call = 0;
  return {
    async getPR() {
      opts.onGetPR?.();
      if (opts.getPRError) throw opts.getPRError;
      const idx = Math.min(call, opts.headShas.length - 1);
      const sha = opts.headShas[idx] as string;
      call += 1;
      return prDetail(sha);
    },
    async getDiff() {
      if (opts.getDiffError) throw opts.getDiffError;
      return opts.diff ?? "--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-old\n+new\n";
    },
  };
}

function writeRound(round: number, headSha: string, over: Partial<Parameters<typeof saveRound>[1]> = {}) {
  return saveRound(store, {
    ref,
    round,
    agent: "reviewer",
    provider: "claude-cli",
    headSha,
    status: "ok",
    startedAt: "2026-08-29T10:00:00Z",
    durationMs: 84210,
    findings: [],
    ...over,
  });
}

const silentLogger = { warn: () => {} };

beforeEach(async () => {
  store = await fs.mkdtemp(path.join(os.tmpdir(), "lgtm-snapshot-test-"));
});

describe("writeDiffSnapshot", () => {
  test("writes the diff under the reviewed SHA when the head has not moved", async () => {
    const forge = fakeForge({ headShas: [REVIEWED_SHA], diff: "diff --git a/x b/x\n" });

    const outcome = await writeDiffSnapshot(store, forge, ref, REVIEWED_SHA);

    expect(outcome).toEqual({
      status: "written",
      sha: REVIEWED_SHA,
      path: diffSnapshotPath(store, ref, REVIEWED_SHA),
    });
    const written = await fs.readFile(diffSnapshotPath(store, ref, REVIEWED_SHA), "utf-8");
    expect(written).toBe("diff --git a/x b/x\n");
  });

  test("skips, and writes nothing, when the head already moved before the fetch", async () => {
    // Simulates the review taking six minutes: by the time the round
    // finishes and this runs, the PR's head is no longer the SHA reviewed.
    const forge = fakeForge({ headShas: [MOVED_SHA] });

    const outcome = await writeDiffSnapshot(store, forge, ref, REVIEWED_SHA, { logger: silentLogger });

    expect(outcome).toEqual({ status: "skipped", sha: REVIEWED_SHA, reason: "head-moved" });
    await expect(fs.access(diffSnapshotPath(store, ref, REVIEWED_SHA))).rejects.toThrow();
  });

  test("never labels the moved-to head's diff as the reviewed SHA's snapshot", async () => {
    // The literal bug: a naive writer would fetch getDiff() (current head,
    // i.e. the newer SHA's diff) and save it as diff-<reviewedSha>.patch.
    const newHeadDiff = "diff --git a/y b/y\n+++ this is the NEW head's diff, not the reviewed one\n";
    const forge = fakeForge({ headShas: [MOVED_SHA], diff: newHeadDiff });

    await writeDiffSnapshot(store, forge, ref, REVIEWED_SHA, { logger: silentLogger });

    await expect(fs.access(diffSnapshotPath(store, ref, REVIEWED_SHA))).rejects.toThrow();
    await expect(fs.access(diffSnapshotPath(store, ref, MOVED_SHA))).rejects.toThrow();
  });

  test("skips when the head moves between the pre- and post-fetch checks", async () => {
    // getPR is called twice: once before getDiff, once after. Reports the
    // reviewed SHA the first time and a different one the second, so a
    // writer that only checked once (before) would be fooled.
    const forge = fakeForge({ headShas: [REVIEWED_SHA, MOVED_SHA] });

    const outcome = await writeDiffSnapshot(store, forge, ref, REVIEWED_SHA, { logger: silentLogger });

    expect(outcome).toEqual({ status: "skipped", sha: REVIEWED_SHA, reason: "head-moved" });
    await expect(fs.access(diffSnapshotPath(store, ref, REVIEWED_SHA))).rejects.toThrow();
  });

  test("does not overwrite an existing snapshot when a later round's write is skipped", async () => {
    const goodForge = fakeForge({ headShas: [REVIEWED_SHA], diff: "the real r1 diff\n" });
    await writeDiffSnapshot(store, goodForge, ref, REVIEWED_SHA);

    const staleForge = fakeForge({ headShas: [MOVED_SHA], diff: "should never land\n" });
    await writeDiffSnapshot(store, staleForge, ref, REVIEWED_SHA, { logger: silentLogger });

    const content = await fs.readFile(diffSnapshotPath(store, ref, REVIEWED_SHA), "utf-8");
    expect(content).toBe("the real r1 diff\n");
  });

  test("logs a warning through the injected logger on a head-moved skip", async () => {
    const forge = fakeForge({ headShas: [MOVED_SHA] });
    const warnings: string[] = [];

    await writeDiffSnapshot(store, forge, ref, REVIEWED_SHA, { logger: { warn: (m) => warnings.push(m) } });

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain(REVIEWED_SHA);
    expect(warnings[0]).toContain(MOVED_SHA);
  });

  test("reports an error outcome, without throwing, when the head check fails", async () => {
    const forge = fakeForge({ headShas: [REVIEWED_SHA], getPRError: new Error("network down") });

    const outcome = await writeDiffSnapshot(store, forge, ref, REVIEWED_SHA);

    expect(outcome).toEqual({ status: "error", sha: REVIEWED_SHA, reason: "network down" });
  });

  test("reports an error outcome, without throwing, when the diff fetch fails", async () => {
    const forge = fakeForge({ headShas: [REVIEWED_SHA], getDiffError: new Error("rate limited") });

    const outcome = await writeDiffSnapshot(store, forge, ref, REVIEWED_SHA);

    expect(outcome).toEqual({ status: "error", sha: REVIEWED_SHA, reason: "rate limited" });
  });
});

describe("pruneDiffSnapshots", () => {
  test("removes snapshots for SHAs no round file references any more", async () => {
    // Round 1 reviewed shaA and left a snapshot; round 2 superseded it and
    // reviewed shaB. Only shaB's round file remains, so shaA's snapshot is
    // now unreferenced.
    const shaA = "a".repeat(40);
    const shaB = "b".repeat(40);
    await fs.mkdir(path.dirname(diffSnapshotPath(store, ref, shaA)), { recursive: true });
    await fs.writeFile(diffSnapshotPath(store, ref, shaA), "stale\n");
    await fs.writeFile(diffSnapshotPath(store, ref, shaB), "current\n");
    await writeRound(1, shaB);

    const { removed } = await pruneDiffSnapshots(store, ref);

    expect(removed).toEqual([diffSnapshotPath(store, ref, shaA)]);
    await expect(fs.access(diffSnapshotPath(store, ref, shaA))).rejects.toThrow();
    await expect(fs.access(diffSnapshotPath(store, ref, shaB))).resolves.toBeNull();
  });

  test("keeps a snapshot referenced by an earlier round even if a later round has a different SHA", async () => {
    const shaA = "a".repeat(40);
    const shaB = "b".repeat(40);
    await writeRound(1, shaA);
    await writeRound(2, shaB);
    await fs.writeFile(diffSnapshotPath(store, ref, shaA), "r1\n");
    await fs.writeFile(diffSnapshotPath(store, ref, shaB), "r2\n");

    const { removed } = await pruneDiffSnapshots(store, ref);

    expect(removed).toEqual([]);
  });

  test("keeps a snapshot referenced only by a failed round", async () => {
    const shaA = "a".repeat(40);
    await writeRound(1, shaA, { status: "failed", raw: "garbage output" });
    await fs.writeFile(diffSnapshotPath(store, ref, shaA), "kept\n");

    const { removed } = await pruneDiffSnapshots(store, ref);

    expect(removed).toEqual([]);
  });

  test("ignores files that are not diff snapshots", async () => {
    const shaA = "a".repeat(40);
    await writeRound(1, shaA);
    const dir = path.dirname(diffSnapshotPath(store, ref, shaA));
    await fs.writeFile(path.join(dir, "notes.txt"), "not a snapshot\n");

    const { removed } = await pruneDiffSnapshots(store, ref);

    expect(removed).toEqual([]);
    await expect(fs.access(path.join(dir, "notes.txt"))).resolves.toBeNull();
  });

  test("is a no-op when the PR has no review directory yet", async () => {
    const { removed } = await pruneDiffSnapshots(store, { owner: "x", repo: "y", number: 1 });
    expect(removed).toEqual([]);
  });
});

describe("snapshotRound", () => {
  test("writes the new snapshot and prunes stale ones in one call", async () => {
    const staleSha = "c".repeat(40);
    await fs.mkdir(path.dirname(diffSnapshotPath(store, ref, staleSha)), { recursive: true });
    await fs.writeFile(diffSnapshotPath(store, ref, staleSha), "old round's snapshot\n");
    await writeRound(1, REVIEWED_SHA);

    const forge = fakeForge({ headShas: [REVIEWED_SHA], diff: "fresh diff\n" });
    const result = await snapshotRound(store, forge, ref, REVIEWED_SHA);

    expect(result.write.status).toBe("written");
    expect(result.pruned).toEqual([diffSnapshotPath(store, ref, staleSha)]);
    const written = await fs.readFile(diffSnapshotPath(store, ref, REVIEWED_SHA), "utf-8");
    expect(written).toBe("fresh diff\n");
    await expect(fs.access(diffSnapshotPath(store, ref, staleSha))).rejects.toThrow();
  });

  test("still prunes stale snapshots even when the new write is skipped for a moved head", async () => {
    const staleSha = "c".repeat(40);
    await fs.mkdir(path.dirname(diffSnapshotPath(store, ref, staleSha)), { recursive: true });
    await fs.writeFile(diffSnapshotPath(store, ref, staleSha), "old\n");
    await writeRound(1, REVIEWED_SHA);

    const forge = fakeForge({ headShas: [MOVED_SHA] });
    const result = await snapshotRound(store, forge, ref, REVIEWED_SHA, { logger: silentLogger });

    expect(result.write).toEqual({ status: "skipped", sha: REVIEWED_SHA, reason: "head-moved" });
    expect(result.pruned).toEqual([diffSnapshotPath(store, ref, staleSha)]);
  });
});

/**
 * Poll cycle and dispatch tests.
 *
 * Offline throughout: a fake ForgeAdapter whose unstubbed methods throw, a
 * fake queue that records calls, a fake Provider run, and an injected clock.
 * The store is a real temp directory, because "writes nothing when nothing
 * changed" is the behaviour half these tests are about and it can only be
 * observed on disk.
 *
 * Run with: bun test src/daemon/cycle.test.ts
 */

import { beforeEach, describe, expect, test } from "bun:test";
import fs from "fs/promises";
import os from "os";
import path from "path";
import {
  formatFindingKey,
  type CheckStatus,
  type ForgeAdapter,
  type PRDetail,
  type PRRef,
  type PRSummary,
} from "@/core";
import { reviewsWhenReady } from "@/core/classify";
import { defaultAgentConfig, type AgentConfig, type ReviewInput, type ReviewOutcome } from "@/provider";
import {
  diffSnapshotPath,
  loadAllRounds,
  loadMeta,
  reviewDir,
  saveMeta,
  saveRound,
  sessionsDir,
} from "@/store/reviews";
import { addToWatchList, loadWatchList, updateETag } from "@/store/watch-list";
import type { DaemonEvent } from "./events";
import type { QueueEntry } from "./queue";
import {
  createDispatch,
  dispatchReview,
  runCycle,
  type CycleDeps,
  type DispatchDeps,
  type EtagCache,
} from "./cycle";

// ─── Fixtures ───────────────────────────────────────────────────────────────

const LOGIN = "octocat";
const NOW = "2026-08-29T12:00:00.000Z";

let store: string;

beforeEach(async () => {
  store = await fs.mkdtemp(path.join(os.tmpdir(), "lgtm-cycle-"));
});

function ref(number = 1, owner = "acme", repo = "api"): PRRef {
  return { owner, repo, number };
}

function summary(overrides: Partial<PRSummary> & { number?: number } = {}): PRSummary {
  const number = overrides.number ?? 1;
  return {
    number,
    title: "Add rate limiter",
    body: "",
    url: `https://github.com/acme/api/pull/${number}`,
    author: "someone-else",
    draft: false,
    headSha: "sha1",
    createdAt: "2026-08-01T00:00:00Z",
    updatedAt: "2026-08-01T00:00:00Z",
    requestedReviewers: [],
    assignees: [],
    ...overrides,
  };
}

function detail(overrides: Partial<PRDetail> = {}): PRDetail {
  return {
    ...summary(overrides),
    additions: 4,
    deletions: 1,
    changedFiles: 1,
    mergeable: true,
    ...overrides,
  };
}

const OK_CHECKS: CheckStatus = { state: "success", runs: [] };

/**
 * Every method not overridden throws, so an unexpected Forge call fails the
 * test loudly. Two exceptions: `getPR` and `getCheckStatus` answer by
 * default, because the cycle legitimately calls them for PRs in triage
 * (R2.5's inbox line). Whether it calls them at the right times is asserted
 * by counting instead, in `countingForge` below.
 */
function fakeForge(overrides: Partial<ForgeAdapter>): ForgeAdapter {
  const refuse =
    (name: string) =>
    (): never => {
      throw new Error(`forge.${name} should not have been called`);
    };

  return {
    listOpenPRs: refuse("listOpenPRs"),
    getPR: async (target: PRRef) => detail({ number: target.number }),
    getDiff: refuse("getDiff"),
    getCheckStatus: async () => OK_CHECKS,
    createDraftReview: refuse("createDraftReview"),
    deleteDraftReview: refuse("deleteDraftReview"),
    getReview: refuse("getReview"),
    authenticatedUser: async () => LOGIN,
    ...overrides,
  };
}

interface CountingForge extends ForgeAdapter {
  /** How many times each triage-metadata endpoint was asked. */
  calls: { detail: number; checks: number };
}

/** A forge that counts its metadata calls, so "not on every cycle" is testable. */
function countingForge(overrides: Partial<ForgeAdapter>): CountingForge {
  const base = fakeForge(overrides);
  const calls = { detail: 0, checks: 0 };

  return {
    ...base,
    calls,
    getPR: async (target) => {
      calls.detail += 1;
      return base.getPR(target);
    },
    getCheckStatus: async (target, sha) => {
      calls.checks += 1;
      return base.getCheckStatus(target, sha);
    },
  };
}

interface FakeQueue {
  enqueue(ref: PRRef, headSha: string): "queued";
  remove(ref: PRRef): boolean;
  enqueued: Array<{ ref: PRRef; headSha: string }>;
  removed: PRRef[];
}

function fakeQueue(): FakeQueue {
  const enqueued: Array<{ ref: PRRef; headSha: string }> = [];
  const removed: PRRef[] = [];

  return {
    enqueue(ref, headSha) {
      enqueued.push({ ref, headSha });
      return "queued";
    },
    remove(ref) {
      removed.push(ref);
      return true;
    },
    enqueued,
    removed,
  };
}

function recorder() {
  const events: DaemonEvent[] = [];
  return {
    events,
    sink: {
      emit(event: DaemonEvent) {
        events.push(event);
      },
    },
    causes(): string[] {
      return events.flatMap((e) => (e.type === "error" ? [e.cause] : []));
    },
    types(): string[] {
      return events.map((e) => e.type);
    },
  };
}

function memoryEtags(seed: Record<string, string> = {}): EtagCache & { entries: Map<string, string> } {
  const entries = new Map<string, string>(Object.entries(seed));
  return {
    entries,
    get: (key) => entries.get(key) ?? null,
    set: (key, etag) => {
      if (etag === null) entries.delete(key);
      else entries.set(key, etag);
    },
  };
}

async function watch(owner = "acme", repo = "api"): Promise<void> {
  await addToWatchList(owner, repo, store);
}

function deps(over: Partial<CycleDeps> & { forge: ForgeAdapter }): CycleDeps {
  return {
    lgtmDir: store,
    queue: fakeQueue(),
    now: () => NOW,
    ...over,
  };
}

// ─── Listing and ETags ──────────────────────────────────────────────────────

describe("runCycle: listing", () => {
  test("an empty watch list does nothing at all", async () => {
    const result = await runCycle(deps({ forge: fakeForge({ authenticatedUser: async () => LOGIN }) }));

    expect(result.repos).toEqual([]);
    expect(result.error).toBeNull();
  });

  test("a NotModified listing ends the repo at zero further cost", async () => {
    await watch();
    const queue = fakeQueue();
    const events = recorder();

    const result = await runCycle(
      deps({
        forge: fakeForge({ listOpenPRs: async () => ({ notModified: true }) }),
        queue,
        events: events.sink,
      })
    );

    expect(result.repos[0]?.status).toBe("not-modified");
    expect(result.repos[0]?.seen).toBe(0);
    expect(queue.enqueued).toEqual([]);
    // getPR, getReview and friends all refuse; reaching any of them would throw.
    expect(events.causes()).toEqual([]);
    expect(events.types()).toEqual(["cycle-finished"]);

    const [entry] = await loadWatchList(store);
    expect(entry?.lastPolledAt).toBeTruthy();
  });

  test("the stored ETag is handed to the adapter, and a fresh one is stored back", async () => {
    await watch();
    await updateETag("acme", "api", "W/stored", store);
    const etags = memoryEtags();
    const handedToAdapter: Array<string | null> = [];

    await runCycle(
      deps({
        etags,
        forge: fakeForge({
          listOpenPRs: async () => {
            handedToAdapter.push(etags.get("acme/api"));
            etags.set("acme/api", "W/fresh");
            return [];
          },
        }),
      })
    );

    expect(handedToAdapter).toEqual(["W/stored"]);
    const [entry] = await loadWatchList(store);
    expect(entry?.etag).toBe("W/fresh");
  });

  test("an ETag the adapter cleared is dropped from watch.md", async () => {
    // The adapter clears it for a repo whose PRs span several pages, because a
    // validator for page one would 304 away changes on page two. Keeping the
    // old value in the file would hand it straight back after a restart.
    await watch();
    await updateETag("acme", "api", "W/stale", store);
    const etags = memoryEtags();

    await runCycle(
      deps({
        etags,
        forge: fakeForge({
          listOpenPRs: async () => {
            etags.set("acme/api", null);
            return [];
          },
        }),
      })
    );

    const [entry] = await loadWatchList(store);
    expect(entry?.etag).toBeUndefined();
  });
});

// ─── Classification and writes ──────────────────────────────────────────────

describe("runCycle: open PRs", () => {
  test("an unknown auto-class PR is queued and written once", async () => {
    await watch();
    const queue = fakeQueue();
    const events = recorder();

    const result = await runCycle(
      deps({
        queue,
        events: events.sink,
        forge: fakeForge({
          listOpenPRs: async () => [summary({ requestedReviewers: [LOGIN] })],
        }),
      })
    );

    const meta = await loadMeta(store, ref());
    expect(meta?.state).toBe("queued");
    expect(meta?.classification).toBe("requested");
    expect(meta?.headSha).toBe("sha1");
    expect(queue.enqueued).toEqual([{ ref: ref(), headSha: "sha1" }]);
    expect(result.repos[0]).toMatchObject({ status: "ok", seen: 1, queued: 1 });
    expect(events.types()).toEqual(["pr-changed", "cycle-finished"]);
  });

  test("an unknown PR that is nobody's business lands in triage, unqueued", async () => {
    await watch();
    const queue = fakeQueue();

    await runCycle(deps({ queue, forge: fakeForge({ listOpenPRs: async () => [summary()] }) }));

    expect((await loadMeta(store, ref()))?.state).toBe("triage");
    expect(queue.enqueued).toEqual([]);
  });

  test("an unchanged PR writes nothing", async () => {
    // Proven through the title: a write of any kind would carry the Forge's
    // title onto disk, and the point of a `none` decision is that fs.watch
    // sees no event for a PR with no news.
    await watch();
    await saveMeta(store, ref(), {
      title: "stored title",
      state: "reviewed",
      classification: "requested",
      headSha: "sha1",
      lastReviewedSha: "sha1",
    });
    const queue = fakeQueue();
    const events = recorder();

    await runCycle(
      deps({
        queue,
        events: events.sink,
        forge: fakeForge({
          listOpenPRs: async () => [summary({ title: "renamed upstream", requestedReviewers: [LOGIN] })],
        }),
      })
    );

    expect((await loadMeta(store, ref()))?.title).toBe("stored title");
    expect(queue.enqueued).toEqual([]);
    expect(events.types()).toEqual(["cycle-finished"]);
  });

  test("new commits on a reviewed PR queue a fresh round", async () => {
    await watch();
    await saveMeta(store, ref(), {
      state: "reviewed",
      classification: "own",
      headSha: "sha1",
      lastReviewedSha: "sha1",
      rounds: 1,
    });
    const queue = fakeQueue();

    await runCycle(
      deps({
        queue,
        forge: fakeForge({ listOpenPRs: async () => [summary({ headSha: "sha2", author: LOGIN })] }),
      })
    );

    const meta = await loadMeta(store, ref());
    expect(meta?.state).toBe("queued");
    expect(meta?.headSha).toBe("sha2");
    expect(queue.enqueued).toEqual([{ ref: ref(), headSha: "sha2" }]);
  });

  test("a failed round under the retry cap is re-queued at the same SHA", async () => {
    await watch();
    await saveMeta(store, ref(), {
      state: "failed",
      classification: "own",
      headSha: "sha1",
      failedAttempts: 1,
    });
    const queue = fakeQueue();

    await runCycle(
      deps({ queue, forge: fakeForge({ listOpenPRs: async () => [summary({ author: LOGIN })] }) })
    );

    expect((await loadMeta(store, ref()))?.state).toBe("queued");
    expect(queue.enqueued).toEqual([{ ref: ref(), headSha: "sha1" }]);
  });

  test("a skipped PR stays skipped and is never queued", async () => {
    await watch();
    await saveMeta(store, ref(), {
      title: "stored title",
      state: "skipped",
      classification: "requested",
      headSha: "sha1",
    });
    const queue = fakeQueue();

    await runCycle(
      deps({
        queue,
        forge: fakeForge({
          listOpenPRs: async () => [summary({ headSha: "sha2", requestedReviewers: [LOGIN] })],
        }),
      })
    );

    expect((await loadMeta(store, ref()))?.state).toBe("skipped");
    expect(queue.enqueued).toEqual([]);
  });

  test("a PR whose stored state is queued is re-enqueued after a restart, without a write", async () => {
    // The queue lives in memory and the store does not. `resetStrandedPRs`
    // leaves crashed rounds in `queued`, and `decide` answers `none` for them
    // forever, so the cycle is the only thing that can put them back in line.
    await watch();
    await saveMeta(store, ref(), {
      title: "stored title",
      state: "queued",
      classification: "own",
      headSha: "sha1",
    });
    const queue = fakeQueue();

    await runCycle(
      deps({ queue, forge: fakeForge({ listOpenPRs: async () => [summary({ author: LOGIN })] }) })
    );

    expect(queue.enqueued).toEqual([{ ref: ref(), headSha: "sha1" }]);
    expect((await loadMeta(store, ref()))?.title).toBe("stored title");
  });
});

// ─── Triage metadata ────────────────────────────────────────────────────────
//
// R2.5's inbox line: additions, deletions, files changed, age, mergeable
// state, CI status. None of it is on the list row, so every reading costs a
// `getPR` and a `getCheckStatus`. These tests are as much about the calls
// that do NOT happen as about the data that lands.

describe("runCycle: triage metadata", () => {
  test("a PR entering triage is detail-fetched, and the numbers reach meta.md", async () => {
    await watch();
    const forge = countingForge({
      listOpenPRs: async () => [summary()],
      getPR: async () => detail({ additions: 120, deletions: 34, changedFiles: 7, mergeable: false }),
      getCheckStatus: async (): Promise<CheckStatus> => ({ state: "failure", runs: [] }),
    });

    await runCycle(deps({ forge }));

    const meta = (await loadMeta(store, ref()))!;
    expect(meta.state).toBe("triage");
    expect(meta.additions).toBe(120);
    expect(meta.deletions).toBe(34);
    expect(meta.changedFiles).toBe(7);
    expect(meta.mergeable).toBe(false);
    expect(meta.checkStatus).toBe("failure");
    expect(meta.createdAt).toBe("2026-08-01T00:00:00Z");
    expect(forge.calls).toEqual({ detail: 1, checks: 1 });
  });

  test("a PR that goes straight to the queue costs no metadata calls", async () => {
    // Only the triage inbox renders this line, and design.md is explicit
    // that the detail endpoint is not on the per-cycle path.
    await watch();
    const forge = countingForge({ listOpenPRs: async () => [summary({ author: LOGIN })] });

    await runCycle(deps({ forge }));

    expect((await loadMeta(store, ref()))?.state).toBe("queued");
    expect(forge.calls).toEqual({ detail: 0, checks: 0 });
  });

  test("a skipped PR is never detail-fetched", async () => {
    await watch();
    await saveMeta(store, ref(), { state: "skipped", headSha: "sha1" });
    const forge = countingForge({ listOpenPRs: async () => [summary({ headSha: "sha2" })] });

    await runCycle(deps({ forge }));

    expect(forge.calls).toEqual({ detail: 0, checks: 0 });
  });

  test("a triage PR with nothing new is not re-fetched, and writes nothing", async () => {
    await watch();
    await saveMeta(store, ref(), {
      title: "stored title",
      state: "triage",
      headSha: "sha1",
      additions: 4,
      deletions: 1,
      changedFiles: 1,
      mergeable: true,
      checkStatus: "success",
    });
    const events = recorder();
    const forge = countingForge({ listOpenPRs: async () => [summary({ title: "renamed upstream" })] });

    await runCycle(deps({ events: events.sink, forge }));

    expect(forge.calls).toEqual({ detail: 0, checks: 0 });
    expect((await loadMeta(store, ref()))?.title).toBe("stored title");
    expect(events.types()).toEqual(["cycle-finished"]);
  });

  test("new commits refresh the size and the mergeable flag", async () => {
    // The chosen refresh trigger. A new head SHA is when a diff's size and
    // its mergeability actually change, and a PR sitting in triage for days
    // with Monday's numbers is worse than a dash.
    await watch();
    await saveMeta(store, ref(), {
      state: "triage",
      headSha: "sha1",
      additions: 4,
      deletions: 1,
      changedFiles: 1,
      mergeable: true,
      checkStatus: "success",
    });
    const forge = countingForge({
      listOpenPRs: async () => [summary({ headSha: "sha2" })],
      getPR: async () => detail({ headSha: "sha2", additions: 200, mergeable: false }),
    });

    await runCycle(deps({ forge }));

    const meta = (await loadMeta(store, ref()))!;
    expect(meta.headSha).toBe("sha2");
    expect(meta.additions).toBe(200);
    expect(meta.mergeable).toBe(false);
    expect(forge.calls).toEqual({ detail: 1, checks: 1 });
  });

  test("CI still running is re-read every cycle, without a second detail call", async () => {
    // Checks are the one field that moves without a commit, and the re-read
    // stops itself. Once the answer is no longer "pending", nothing asks
    // again until the head SHA moves.
    await watch();
    await saveMeta(store, ref(), {
      state: "triage",
      headSha: "sha1",
      additions: 4,
      deletions: 1,
      changedFiles: 1,
      mergeable: true,
      checkStatus: "pending",
    });
    const forge = countingForge({ listOpenPRs: async () => [summary()] });

    await runCycle(deps({ forge }));

    expect((await loadMeta(store, ref()))?.checkStatus).toBe("success");
    expect(forge.calls).toEqual({ detail: 0, checks: 1 });
  });

  test("a check that is still pending confirms itself and writes nothing", async () => {
    await watch();
    await saveMeta(store, ref(), {
      title: "stored title",
      state: "triage",
      headSha: "sha1",
      additions: 4,
      deletions: 1,
      changedFiles: 1,
      mergeable: true,
      checkStatus: "pending",
    });
    const events = recorder();
    const forge = countingForge({
      listOpenPRs: async () => [summary()],
      getCheckStatus: async (): Promise<CheckStatus> => ({ state: "pending", runs: [] }),
    });

    await runCycle(deps({ events: events.sink, forge }));

    expect(forge.calls).toEqual({ detail: 0, checks: 1 });
    expect((await loadMeta(store, ref()))?.title).toBe("stored title");
    expect(events.types()).toEqual(["cycle-finished"]);
  });

  test("a PR that entered triage before this data existed is filled in exactly once", async () => {
    // Every meta.md written by an earlier version has all six fields null,
    // and its decision every cycle is `none`. One write repairs it; the
    // cycle after that has nothing left to ask.
    await watch();
    await saveMeta(store, ref(), { state: "triage", headSha: "sha1" });

    const first = countingForge({ listOpenPRs: async () => [summary()] });
    await runCycle(deps({ forge: first }));

    expect(first.calls).toEqual({ detail: 1, checks: 1 });
    expect((await loadMeta(store, ref()))?.additions).toBe(4);

    const second = countingForge({ listOpenPRs: async () => [summary()] });
    await runCycle(deps({ forge: second }));

    expect(second.calls).toEqual({ detail: 0, checks: 0 });
  });

  test("a mergeable GitHub is still computing is stored as null, never as a conflict", async () => {
    await watch();
    const forge = countingForge({
      listOpenPRs: async () => [summary()],
      getPR: async () => detail({ mergeable: null }),
    });

    await runCycle(deps({ forge }));

    expect((await loadMeta(store, ref()))?.mergeable).toBeNull();
  });

  test("a detail fetch that fails costs the PR its metadata and nothing else", async () => {
    // Classification, queueing and the close stamp are the cycle's job. None
    // of them may be lost because the size of a diff could not be read, and
    // a stale metadata line is not something to notify a human about (R8.2).
    await watch();
    const events = recorder();
    const forge = fakeForge({
      listOpenPRs: async () => [summary()],
      getPR: async () => {
        throw new Error("502 Bad Gateway");
      },
    });

    const result = await runCycle(deps({ events: events.sink, forge }));

    const meta = (await loadMeta(store, ref()))!;
    expect(meta.state).toBe("triage");
    expect(meta.additions).toBeNull();
    // The Checks call is independent, so its answer still lands.
    expect(meta.checkStatus).toBe("success");
    expect(result.repos[0]?.errors).toBe(0);
    expect(events.causes()).toEqual([]);
  });
});

// ─── Deviation (a): becoming auto-class in triage ───────────────────────────

describe("runCycle: a triage PR that becomes auto-class", () => {
  test("being added as a reviewer queues it, even with no new commits", async () => {
    // design.md's "headSha unchanged: otherwise no action" would strand this
    // PR in triage; R2.1 says auto-class PRs are queued. R2.1 wins.
    await watch();
    await saveMeta(store, ref(), {
      state: "triage",
      classification: "none",
      headSha: "sha1",
    });
    const queue = fakeQueue();

    await runCycle(
      deps({
        queue,
        forge: fakeForge({ listOpenPRs: async () => [summary({ requestedReviewers: [LOGIN] })] }),
      })
    );

    const meta = await loadMeta(store, ref());
    expect(meta?.state).toBe("queued");
    expect(meta?.classification).toBe("requested");
    expect(queue.enqueued).toEqual([{ ref: ref(), headSha: "sha1" }]);
  });

  test("a backfilled auto-class PR keeps waiting for its confirm", async () => {
    // R2.6 and CONTEXT.md's Backfill entry: backfill writes auto-class PRs
    // into triage on purpose, and nothing runs until a human confirms. The
    // trigger above is the transition into auto-class, not the state, which
    // is what keeps that promise from cycle two onwards.
    await watch();
    await saveMeta(store, ref(), {
      title: "stored title",
      state: "triage",
      classification: "requested",
      headSha: "sha1",
    });
    const queue = fakeQueue();

    await runCycle(
      deps({
        queue,
        forge: fakeForge({ listOpenPRs: async () => [summary({ requestedReviewers: [LOGIN] })] }),
      })
    );

    expect((await loadMeta(store, ref()))?.state).toBe("triage");
    expect((await loadMeta(store, ref()))?.title).toBe("stored title");
    expect(queue.enqueued).toEqual([]);
  });

  test("a draft is recorded and marked reviews-when-ready, not queued", async () => {
    await watch();
    await saveMeta(store, ref(), {
      state: "triage",
      classification: "none",
      draft: true,
      headSha: "sha1",
    });
    const queue = fakeQueue();

    await runCycle(
      deps({
        queue,
        forge: fakeForge({
          listOpenPRs: async () => [summary({ draft: true, requestedReviewers: [LOGIN] })],
        }),
      })
    );

    const meta = await loadMeta(store, ref());
    expect(meta?.state).toBe("triage");
    expect(meta?.classification).toBe("requested");
    expect(meta && reviewsWhenReady(meta)).toBe(true);
    expect(queue.enqueued).toEqual([]);
  });

  test("a SHA already reviewed through review-anyway is not reviewed twice", async () => {
    await watch();
    await saveMeta(store, ref(), {
      state: "triage",
      classification: "none",
      headSha: "sha1",
      lastReviewedSha: "sha1",
      rounds: 1,
    });
    const queue = fakeQueue();

    await runCycle(
      deps({
        queue,
        forge: fakeForge({ listOpenPRs: async () => [summary({ assignees: [LOGIN] })] }),
      })
    );

    const meta = await loadMeta(store, ref());
    expect(meta?.state).toBe("triage");
    expect(meta?.classification).toBe("assigned");
    expect(queue.enqueued).toEqual([]);
  });
});

// ─── Deviation (b): back to draft ───────────────────────────────────────────

describe("runCycle: a PR that reverts to draft", () => {
  test("is pulled out of the queue and put back in triage", async () => {
    await watch();
    await saveMeta(store, ref(), {
      state: "queued",
      classification: "requested",
      draft: false,
      headSha: "sha1",
    });
    const queue = fakeQueue();

    await runCycle(
      deps({
        queue,
        forge: fakeForge({
          listOpenPRs: async () => [summary({ draft: true, requestedReviewers: [LOGIN] })],
        }),
      })
    );

    const meta = await loadMeta(store, ref());
    expect(meta?.state).toBe("triage");
    expect(meta?.draft).toBe(true);
    expect(queue.removed).toEqual([ref()]);
    expect(queue.enqueued).toEqual([]);
  });

  test("is held even when it collects a commit in the same interval", async () => {
    // New commits on a queued PR are a `queue` decision. R2.3 outranks it.
    await watch();
    await saveMeta(store, ref(), {
      state: "queued",
      classification: "requested",
      draft: false,
      headSha: "sha1",
    });
    const queue = fakeQueue();

    await runCycle(
      deps({
        queue,
        forge: fakeForge({
          listOpenPRs: async () => [
            summary({ draft: true, headSha: "sha2", requestedReviewers: [LOGIN] }),
          ],
        }),
      })
    );

    const meta = await loadMeta(store, ref());
    expect(meta?.state).toBe("triage");
    expect(meta?.headSha).toBe("sha2");
    expect(queue.removed).toEqual([ref()]);
    expect(queue.enqueued).toEqual([]);
  });

  test("a review-anyway draft keeps its place", async () => {
    // R2.3's own escape hatch: `manual` is the human override, and the draft
    // hold must not undo it.
    await watch();
    await saveMeta(store, ref(), {
      state: "queued",
      classification: "manual",
      draft: true,
      headSha: "sha1",
    });
    const queue = fakeQueue();

    await runCycle(
      deps({ queue, forge: fakeForge({ listOpenPRs: async () => [summary({ draft: true })] }) })
    );

    expect((await loadMeta(store, ref()))?.state).toBe("queued");
    expect(queue.removed).toEqual([]);
    expect(queue.enqueued).toEqual([{ ref: ref(), headSha: "sha1" }]);
  });

  test("leaving draft state queues a review", async () => {
    await watch();
    await saveMeta(store, ref(), {
      state: "triage",
      classification: "requested",
      draft: true,
      headSha: "sha1",
    });
    const queue = fakeQueue();

    await runCycle(
      deps({
        queue,
        forge: fakeForge({ listOpenPRs: async () => [summary({ requestedReviewers: [LOGIN] })] }),
      })
    );

    expect((await loadMeta(store, ref()))?.state).toBe("queued");
    expect(queue.enqueued).toEqual([{ ref: ref(), headSha: "sha1" }]);
  });

  test("a reviewed PR that goes back to draft has its flag recorded", async () => {
    await watch();
    await saveMeta(store, ref(), {
      state: "reviewed",
      classification: "requested",
      draft: false,
      headSha: "sha1",
      lastReviewedSha: "sha1",
    });

    await runCycle(
      deps({
        forge: fakeForge({
          listOpenPRs: async () => [summary({ draft: true, requestedReviewers: [LOGIN] })],
        }),
      })
    );

    const meta = await loadMeta(store, ref());
    expect(meta?.draft).toBe(true);
    expect(meta?.state).toBe("reviewed");
  });
});

// ─── Closing ────────────────────────────────────────────────────────────────

describe("runCycle: PRs that left the open list", () => {
  test("a PR that closed is stamped and dropped from the queue", async () => {
    await watch();
    await saveMeta(store, ref(7), { state: "queued", classification: "own", headSha: "sha1" });
    const queue = fakeQueue();
    const events = recorder();

    const result = await runCycle(
      deps({ queue, events: events.sink, forge: fakeForge({ listOpenPRs: async () => [] }) })
    );

    const meta = await loadMeta(store, ref(7));
    expect(meta?.state).toBe("closed");
    expect(meta?.closedAt).toBe(NOW);
    expect(queue.removed).toEqual([ref(7)]);
    expect(result.repos[0]?.closed).toBe(1);
  });

  test("a skipped PR that closes keeps its skip", async () => {
    // The cross-module contract: closed is `closedAt !== null`, never
    // `state === "closed"`, or a skipped PR that closes loses its sticky
    // decision and comes back reviewable on reopen.
    await watch();
    await saveMeta(store, ref(7), { state: "skipped", classification: "none", headSha: "sha1" });

    await runCycle(deps({ forge: fakeForge({ listOpenPRs: async () => [] }) }));

    const meta = await loadMeta(store, ref(7));
    expect(meta?.state).toBe("skipped");
    expect(meta?.closedAt).toBe(NOW);
  });

  test("an already closed PR is not rewritten", async () => {
    await watch();
    await saveMeta(store, ref(7), {
      title: "stored title",
      state: "closed",
      headSha: "sha1",
      closedAt: "2026-08-01T00:00:00Z",
    });
    const events = recorder();

    const result = await runCycle(
      deps({ events: events.sink, forge: fakeForge({ listOpenPRs: async () => [] }) })
    );

    expect((await loadMeta(store, ref(7)))?.closedAt).toBe("2026-08-01T00:00:00Z");
    expect(result.repos[0]?.closed).toBe(0);
    expect(events.types()).toEqual(["cycle-finished"]);
  });

  test("PRs from another repo are not closed by this repo's listing", async () => {
    await watch();
    await saveMeta(store, { owner: "other", repo: "thing", number: 3 }, { state: "queued" });

    await runCycle(deps({ forge: fakeForge({ listOpenPRs: async () => [] }) }));

    const meta = await loadMeta(store, { owner: "other", repo: "thing", number: 3 });
    expect(meta?.closedAt).toBeNull();
  });

  test("nothing is closed when the listing was a 304", async () => {
    await watch();
    await saveMeta(store, ref(7), { state: "queued", classification: "own", headSha: "sha1" });

    await runCycle(deps({ forge: fakeForge({ listOpenPRs: async () => ({ notModified: true }) }) }));

    expect((await loadMeta(store, ref(7)))?.closedAt).toBeNull();
  });
});

// ─── Pending draft reviews ──────────────────────────────────────────────────

describe("runCycle: pending review reconciliation", () => {
  test("a draft submitted in GitHub's UI clears the recorded id", async () => {
    await watch();
    await saveMeta(store, ref(), {
      state: "reviewed",
      classification: "requested",
      headSha: "sha1",
      lastReviewedSha: "sha1",
      pendingReviewId: 987654,
    });

    const result = await runCycle(
      deps({
        forge: fakeForge({
          listOpenPRs: async () => [summary({ requestedReviewers: [LOGIN] })],
          getReview: async () => "submitted",
        }),
      })
    );

    expect((await loadMeta(store, ref()))?.pendingReviewId).toBeNull();
    expect(result.repos[0]?.reconciled).toBe(1);
  });

  test("a draft still pending is left alone, and writes nothing", async () => {
    await watch();
    await saveMeta(store, ref(), {
      title: "stored title",
      state: "reviewed",
      classification: "requested",
      headSha: "sha1",
      lastReviewedSha: "sha1",
      pendingReviewId: 987654,
    });
    const events = recorder();

    await runCycle(
      deps({
        events: events.sink,
        forge: fakeForge({
          listOpenPRs: async () => [summary({ requestedReviewers: [LOGIN] })],
          getReview: async () => "pending",
        }),
      })
    );

    const meta = await loadMeta(store, ref());
    expect(meta?.pendingReviewId).toBe(987654);
    expect(meta?.title).toBe("stored title");
    expect(events.types()).toEqual(["cycle-finished"]);
  });

  test("a getReview failure does not stop the PR being classified", async () => {
    await watch();
    await saveMeta(store, ref(), {
      state: "triage",
      classification: "none",
      headSha: "sha1",
      pendingReviewId: 987654,
    });
    const queue = fakeQueue();

    const result = await runCycle(
      deps({
        queue,
        forge: fakeForge({
          listOpenPRs: async () => [summary({ requestedReviewers: [LOGIN] })],
          getReview: async () => {
            throw new Error("502 Bad Gateway");
          },
        }),
      })
    );

    const meta = await loadMeta(store, ref());
    expect(meta?.state).toBe("queued");
    expect(meta?.pendingReviewId).toBe(987654);
    expect(queue.enqueued).toEqual([{ ref: ref(), headSha: "sha1" }]);
    expect(result.repos[0]?.errors).toBe(0);
  });
});

// ─── Error containment ──────────────────────────────────────────────────────

describe("runCycle: failures", () => {
  test("one repo failing leaves the others polled", async () => {
    await watch("acme", "api");
    await watch("acme", "web");
    const queue = fakeQueue();
    const events = recorder();

    const result = await runCycle(
      deps({
        queue,
        events: events.sink,
        forge: fakeForge({
          listOpenPRs: async (repo) => {
            if (repo.repo === "api") throw new Error("Not Found");
            return [summary({ number: 4, requestedReviewers: [LOGIN] })];
          },
        }),
      })
    );

    expect(result.repos.map((r) => r.status)).toEqual(["failed", "ok"]);
    expect(result.repos[0]?.error).toBe("Not Found");
    expect(queue.enqueued).toEqual([{ ref: ref(4, "acme", "web"), headSha: "sha1" }]);
    // Repo-qualified, so a 404 here can never dedupe away a different failure
    // on another repo (R8.2).
    expect(events.causes()).toEqual(["poll acme/api: Not Found"]);
    expect(events.events.filter((e) => e.type === "cycle-finished")).toHaveLength(2);
  });

  test("a failed repo does not stamp lastPolledAt", async () => {
    await watch();

    await runCycle(
      deps({
        forge: fakeForge({
          listOpenPRs: async () => {
            throw new Error("rate limit exceeded");
          },
        }),
      })
    );

    const [entry] = await loadWatchList(store);
    expect(entry?.lastPolledAt).toBeUndefined();
  });

  test("a dead token fails the whole cycle once, before any repo is polled", async () => {
    await watch();
    const events = recorder();

    const result = await runCycle(
      deps({
        events: events.sink,
        forge: fakeForge({
          authenticatedUser: async () => {
            throw new Error("401 Bad credentials");
          },
        }),
      })
    );

    expect(result.error).toBe("401 Bad credentials");
    expect(result.repos).toEqual([]);
    expect(events.causes()).toEqual(["auth: 401 Bad credentials"]);
  });

  test("one PR failing leaves the rest of the repo classified", async () => {
    await watch();
    const queue = fakeQueue();
    const broken = {
      ...queue,
      enqueue(ref: PRRef, headSha: string) {
        if (ref.number === 1) throw new Error("queue is wedged");
        return queue.enqueue(ref, headSha);
      },
    };
    const events = recorder();

    const result = await runCycle(
      deps({
        queue: broken,
        events: events.sink,
        forge: fakeForge({
          listOpenPRs: async () => [
            summary({ number: 1, requestedReviewers: [LOGIN] }),
            summary({ number: 2, requestedReviewers: [LOGIN] }),
          ],
        }),
      })
    );

    expect(result.repos[0]).toMatchObject({ status: "ok", errors: 1 });
    expect((await loadMeta(store, ref(2)))?.state).toBe("queued");
    expect(queue.enqueued.map((e) => e.ref.number)).toEqual([2]);
    expect(events.causes()).toEqual(["pr acme/api#1: queue is wedged"]);
  });

  test("a throwing event listener cannot take the cycle down", async () => {
    await watch();
    const queue = fakeQueue();

    const result = await runCycle(
      deps({
        queue,
        events: {
          emit() {
            throw new Error("the notifier exploded");
          },
        },
        forge: fakeForge({ listOpenPRs: async () => [summary({ requestedReviewers: [LOGIN] })] }),
      })
    );

    expect(result.repos[0]?.status).toBe("ok");
    expect((await loadMeta(store, ref()))?.state).toBe("queued");
  });
});

// ─── Dispatch ───────────────────────────────────────────────────────────────

function entryFor(headSha = "sha1", number = 1): QueueEntry {
  return { ref: ref(number), headSha, queuedAt: 0 };
}

function outcome(over: Partial<ReviewOutcome> = {}): ReviewOutcome {
  return {
    provider: "claude-cli",
    status: "ok",
    findings: [{ file: "src/limiter.ts", line: 118, severity: "high", comment: "off by one" }],
    raw: '{"findings":[]}',
    error: null,
    durationMs: 84210,
    dropped: 0,
    ...over,
  };
}

function snapshotForge(headSha = "sha1", diff = "diff --git a/x b/x\n") {
  return {
    getPR: async () => detail({ headSha }),
    getDiff: async () => diff,
  };
}

function dispatchDeps(over: Partial<DispatchDeps> = {}): DispatchDeps {
  return {
    lgtmDir: store,
    forge: snapshotForge(),
    now: () => NOW,
    review: async () => outcome(),
    ...over,
  };
}

describe("dispatchReview: the session behind the round", () => {
  const session = {
    sessionId: "f47ac10b-58cc-4372-a567-0e02b2c3d479",
    costUsd: 0.77,
    turns: 14,
  };

  async function queued(): Promise<void> {
    await saveMeta(store, ref(), { state: "queued", classification: "own", headSha: "sha1" });
  }

  test("spawns every Round from the one directory the store owns", async () => {
    // Not a detail of the spawn. The CLI files its session under a slug of the
    // working directory, so a Round started from wherever `lgtm up` happened
    // to run leaves a session nobody can address.
    await queued();
    let seen: ReviewInput | null = null;

    await dispatchReview(
      entryFor(),
      dispatchDeps({
        review: async (given) => {
          seen = given;
          return outcome();
        },
      })
    );

    expect((seen as ReviewInput | null)?.sessionCwd).toBe(sessionsDir(store));
    expect(await fs.exists(sessionsDir(store))).toBe(true);
  });

  test("records the session, the cost and the turns on the round file", async () => {
    await queued();

    await dispatchReview(
      entryFor(),
      dispatchDeps({ review: async () => outcome({ ...session, sessionCwd: sessionsDir(store) }) })
    );

    expect((await loadAllRounds(store, ref()))[0]).toMatchObject({
      ...session,
      sessionCwd: sessionsDir(store),
    });
  });

  test("a failed Round records its session too", async () => {
    // The review ran and only the reading of it failed, so the conversation
    // is still there to be resumed and is worth more here than anywhere.
    await queued();

    await dispatchReview(
      entryFor(),
      dispatchDeps({
        forge: { getPR: async () => detail(), getDiff: async () => "" },
        review: async () =>
          outcome({
            ...session,
            status: "failed",
            findings: [],
            error: "could not parse provider output",
          }),
      })
    );

    const round = (await loadAllRounds(store, ref()))[0];
    expect(round).toMatchObject({ status: "failed", sessionId: session.sessionId });
  });

  test("a Provider that reports no session still records where the Round ran", async () => {
    // The directory is ours to know either way, and a null session id is an
    // honest answer rather than a failure.
    await queued();

    await dispatchReview(entryFor(), dispatchDeps({ review: async () => outcome() }));

    expect((await loadAllRounds(store, ref()))[0]).toMatchObject({
      sessionId: null,
      costUsd: null,
      turns: null,
      sessionCwd: sessionsDir(store),
    });
  });

  test("logs what the Round spent, when the Provider says", async () => {
    await queued();
    const lines: string[] = [];

    await dispatchReview(
      entryFor(),
      dispatchDeps({ log: (line) => lines.push(line), review: async () => outcome(session) })
    );

    expect(lines.some((line) => line.includes("$0.77"))).toBe(true);
  });
});

describe("dispatchReview", () => {
  test("writes the round, the snapshot, and the metadata", async () => {
    await saveMeta(store, ref(), {
      state: "queued",
      classification: "requested",
      headSha: "sha1",
      url: "https://github.com/acme/api/pull/1",
    });
    const events = recorder();
    let input: ReviewInput | null = null;

    const result = await dispatchReview(
      entryFor(),
      dispatchDeps({
        events: events.sink,
        binPath: () => "/opt/homebrew/bin/claude",
        review: async (given) => {
          input = given;
          return outcome();
        },
      })
    );

    expect(result).toMatchObject({ status: "reviewed", round: 1, findings: 1 });

    const rounds = await loadAllRounds(store, ref());
    expect(rounds).toHaveLength(1);
    expect(rounds[0]).toMatchObject({ round: 1, agent: "reviewer", status: "ok", headSha: "sha1" });
    expect(rounds[0]?.findings[0]).toMatchObject({ id: "f1", file: "src/limiter.ts", state: "open" });

    const meta = await loadMeta(store, ref());
    expect(meta).toMatchObject({
      state: "reviewed",
      lastReviewedSha: "sha1",
      rounds: 1,
      failedAttempts: 0,
    });

    expect(await fs.readFile(diffSnapshotPath(store, ref(), "sha1"), "utf-8")).toContain("diff --git");
    expect(events.types()).toContain("findings-ready");

    const seen = input as ReviewInput | null;
    expect(seen?.prUrl).toBe("https://github.com/acme/api/pull/1");
    expect(seen?.binPath).toBe("/opt/homebrew/bin/claude");
  });

  test("snapshots the SHA the round reviewed, not the current head", async () => {
    // A round takes minutes and the poll cycle keeps running, so meta.headSha
    // can already have moved on. Filing this round's diff under that SHA would
    // slice every finding card's hunk out of the wrong text.
    await saveMeta(store, ref(), { state: "reviewing", classification: "own", headSha: "sha2" });

    await dispatchReview(
      entryFor("sha1"),
      dispatchDeps({ forge: snapshotForge("sha1", "reviewed diff\n") })
    );

    expect(await fs.readFile(diffSnapshotPath(store, ref(), "sha1"), "utf-8")).toBe("reviewed diff\n");
    const meta = await loadMeta(store, ref());
    expect(meta?.lastReviewedSha).toBe("sha1");
    expect((await loadAllRounds(store, ref()))[0]?.headSha).toBe("sha1");
  });

  test("a failed round writes an empty round file, a raw transcript, and no review mark", async () => {
    await saveMeta(store, ref(), { state: "queued", classification: "own", headSha: "sha1" });
    const events = recorder();

    const result = await dispatchReview(
      entryFor(),
      dispatchDeps({
        events: events.sink,
        // getPR/getDiff would throw here; a failed round must not fetch a diff.
        forge: {
          getPR: async () => {
            throw new Error("no snapshot for a failed round");
          },
          getDiff: async () => {
            throw new Error("no snapshot for a failed round");
          },
        },
        review: async () =>
          outcome({
            status: "failed",
            findings: [],
            raw: "half a sentence",
            error: "claude timed out after 10m",
          }),
      })
    );

    expect(result.status).toBe("failed");

    const rounds = await loadAllRounds(store, ref());
    expect(rounds[0]).toMatchObject({ round: 1, status: "failed", findings: [] });

    const raw = await fs.readFile(path.join(reviewDir(store, ref()), "r1-reviewer.raw.txt"), "utf-8");
    expect(raw).toContain("claude timed out after 10m");
    expect(raw).toContain("half a sentence");

    const meta = await loadMeta(store, ref());
    expect(meta?.state).toBe("failed");
    expect(meta?.lastReviewedSha).toBeNull();
    expect(meta?.failedAttempts).toBe(1);
    expect(events.types()).not.toContain("findings-ready");
    // The cause names the failure and not the PR, so a broken CLI notifies
    // once rather than once per watched PR (R8.2).
    expect(events.causes()).toEqual(["review: claude timed out after 10m"]);
  });

  test("a provider that printed nothing still leaves a transcript", async () => {
    await saveMeta(store, ref(), { state: "queued", classification: "own", headSha: "sha1" });

    await dispatchReview(
      entryFor(),
      dispatchDeps({
        forge: snapshotForge(),
        review: async () =>
          outcome({ status: "failed", findings: [], raw: "", error: "spawn claude ENOENT" }),
      })
    );

    const raw = await fs.readFile(path.join(reviewDir(store, ref()), "r1-reviewer.raw.txt"), "utf-8");
    expect(raw).toContain("spawn claude ENOENT");
  });

  test("round numbers stay monotonic across a failure", async () => {
    await saveMeta(store, ref(), { state: "queued", classification: "own", headSha: "sha1" });
    await saveRound(store, {
      ref: ref(),
      round: 1,
      agent: "reviewer",
      provider: "claude-cli",
      headSha: "sha1",
      status: "failed",
      startedAt: NOW,
      durationMs: 10,
      findings: [],
    });

    const result = await dispatchReview(entryFor(), dispatchDeps());

    expect(result.round).toBe(2);
    expect((await loadMeta(store, ref()))?.rounds).toBe(2);
  });

  test("prior findings are replayed as do-not-repeat context, by full key", async () => {
    await saveMeta(store, ref(), { state: "queued", classification: "own", headSha: "sha2", rounds: 1 });
    await saveRound(store, {
      ref: ref(),
      round: 1,
      agent: "reviewer",
      provider: "claude-cli",
      headSha: "sha1",
      status: "ok",
      startedAt: NOW,
      durationMs: 10,
      findings: [{ file: "src/limiter.ts", line: 118, severity: "high", comment: "off by one" }],
    });
    let input: ReviewInput | null = null;

    await dispatchReview(
      entryFor("sha2"),
      dispatchDeps({
        forge: snapshotForge("sha2"),
        review: async (given) => {
          input = given;
          return outcome({ findings: [] });
        },
      })
    );

    const seen = input as ReviewInput | null;
    const prior = seen?.priorFindings?.[0];
    expect(prior?.key).toEqual({ round: 1, agent: "reviewer", id: "f1" });
    expect(prior && formatFindingKey(prior.key)).toBe("r1:reviewer:f1");
    expect(prior?.file).toBe("src/limiter.ts");
  });

  test("refuses to review a PR that went back to draft", async () => {
    // The other half of R2.3: the cycle writes meta before it removes the
    // queue entry, so a round can still be handed out in between.
    await saveMeta(store, ref(), { state: "queued", classification: "requested", draft: true, headSha: "sha1" });
    let ran = false;

    const result = await dispatchReview(
      entryFor(),
      dispatchDeps({
        review: async () => {
          ran = true;
          return outcome();
        },
      })
    );

    expect(ran).toBe(false);
    expect(result).toMatchObject({ status: "skipped", reason: "draft" });
    expect((await loadMeta(store, ref()))?.state).toBe("triage");
  });

  test("a review-anyway draft still runs", async () => {
    await saveMeta(store, ref(), { state: "queued", classification: "manual", draft: true, headSha: "sha1" });

    const result = await dispatchReview(entryFor(), dispatchDeps());

    expect(result.status).toBe("reviewed");
  });

  test("refuses a PR skipped or closed while it waited", async () => {
    await saveMeta(store, ref(1), { state: "skipped", headSha: "sha1" });
    await saveMeta(store, ref(2), { state: "queued", headSha: "sha1", closedAt: NOW });
    let ran = 0;
    const run = async () => {
      ran += 1;
      return outcome();
    };

    expect(await dispatchReview(entryFor("sha1", 1), dispatchDeps({ review: run }))).toMatchObject({
      status: "skipped",
      reason: "skipped",
    });
    expect(await dispatchReview(entryFor("sha1", 2), dispatchDeps({ review: run }))).toMatchObject({
      status: "skipped",
      reason: "closed",
    });
    expect(ran).toBe(0);
  });

  test("a disabled agent runs nothing", async () => {
    await saveMeta(store, ref(), { state: "queued", classification: "own", headSha: "sha1" });
    const agent: AgentConfig = { ...defaultAgentConfig(), enabled: false };
    let ran = false;

    const result = await dispatchReview(
      entryFor(),
      dispatchDeps({
        agent,
        review: async () => {
          ran = true;
          return outcome();
        },
      })
    );

    expect(ran).toBe(false);
    expect(result).toMatchObject({ status: "skipped", reason: "agent disabled" });
  });

  test("a PR with no meta.md is skipped rather than reviewed", async () => {
    const result = await dispatchReview(entryFor(), dispatchDeps());
    expect(result).toMatchObject({ status: "skipped", reason: "unknown PR" });
  });

  test("an unexpected throw is contained and never leaves the PR reviewing", async () => {
    await saveMeta(store, ref(), { state: "queued", classification: "own", headSha: "sha1" });
    const events = recorder();

    const result = await dispatchReview(
      entryFor(),
      dispatchDeps({
        events: events.sink,
        review: async () => {
          throw new Error("the runner exploded");
        },
      })
    );

    expect(result.status).toBe("failed");
    const meta = await loadMeta(store, ref());
    expect(meta?.state).toBe("failed");
    expect(meta?.failedAttempts).toBe(1);
    expect(events.causes()).toEqual(["review: the runner exploded"]);
  });

  test("a snapshot failure does not lose the round", async () => {
    await saveMeta(store, ref(), { state: "queued", classification: "own", headSha: "sha1" });

    const result = await dispatchReview(
      entryFor(),
      dispatchDeps({
        forge: {
          getPR: async () => {
            throw new Error("502 Bad Gateway");
          },
          getDiff: async () => "",
        },
      })
    );

    expect(result.status).toBe("reviewed");
    expect((await loadAllRounds(store, ref()))[0]?.findings).toHaveLength(1);
    expect((await loadMeta(store, ref()))?.state).toBe("reviewed");
  });

  test("createDispatch fits the queue's dispatch signature", async () => {
    await saveMeta(store, ref(), { state: "queued", classification: "own", headSha: "sha1" });
    const dispatch = createDispatch(dispatchDeps());

    await dispatch(entryFor());

    expect((await loadMeta(store, ref()))?.state).toBe("reviewed");
  });
});

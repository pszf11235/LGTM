/**
 * Backfill tests.
 *
 * Classification goes through the real `classify` from `@/core/classify`
 * (backfill.ts imports it directly and carries no rule of its own), so the
 * "own" fixtures below get their classification from real author matching
 * against `LOGIN`, not from a test double.
 *
 * Run with: bun test src/daemon/backfill.test.ts
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { addToWatchList, getWatchedRepoKeys } from "@/store";
import { loadMeta, saveMeta } from "@/store/reviews";
import type {
  CheckStatus,
  ForgeAdapter,
  NotModified,
  PRDetail,
  PRRef,
  PRSummary,
  RepoRef,
} from "@/core";
import { addRepoWithBackfill, backfillOpenPRs, mergeableStatus } from "./backfill.js";

// ─── Fixtures ───────────────────────────────────────────────────────────────

const REPO: RepoRef = { owner: "acme", repo: "api" };
const LOGIN = "octocat";

function summary(overrides: Partial<PRSummary> & { number: number }): PRSummary {
  return {
    title: `PR #${overrides.number}`,
    body: "",
    url: `https://github.com/acme/api/pull/${overrides.number}`,
    author: "someone-else",
    draft: false,
    headSha: `sha${overrides.number}`,
    createdAt: "2026-08-01T00:00:00Z",
    updatedAt: "2026-08-01T00:00:00Z",
    requestedReviewers: [],
    assignees: [],
    ...overrides,
  };
}

function detail(overrides: Partial<PRDetail> & { number: number }): PRDetail {
  return {
    ...summary(overrides),
    additions: 10,
    deletions: 2,
    changedFiles: 1,
    mergeable: true,
    ...overrides,
  };
}

const OK_CHECKS: CheckStatus = { state: "success", runs: [] };

/**
 * Every ForgeAdapter method not overridden throws, so a test that expects a
 * method to go uncalled (a known PR's getPR, or anything after listOpenPRs
 * answers NotModified) fails loudly if backfill.ts calls it anyway, instead
 * of quietly returning some default that happens not to matter.
 */
function fakeForge(overrides: Partial<ForgeAdapter>): ForgeAdapter {
  const unimplemented = (name: string) => () => {
    throw new Error(`fakeForge: ${name} was not expected to be called in this test`);
  };

  return {
    listOpenPRs: overrides.listOpenPRs ?? unimplemented("listOpenPRs"),
    getPR: overrides.getPR ?? unimplemented("getPR"),
    getDiff: overrides.getDiff ?? unimplemented("getDiff"),
    getCheckStatus: overrides.getCheckStatus ?? unimplemented("getCheckStatus"),
    createDraftReview: overrides.createDraftReview ?? unimplemented("createDraftReview"),
    deleteDraftReview: overrides.deleteDraftReview ?? unimplemented("deleteDraftReview"),
    getReview: overrides.getReview ?? unimplemented("getReview"),
    authenticatedUser: overrides.authenticatedUser ?? (async () => LOGIN),
  };
}

// ─── Store isolation ────────────────────────────────────────────────────────

let store: string;
let originalHome: string | undefined;

beforeEach(async () => {
  store = await fs.mkdtemp(path.join(os.tmpdir(), "lgtm-backfill-test-"));
  originalHome = process.env.HOME;
  process.env.HOME = store;
});

afterEach(async () => {
  process.env.HOME = originalHome;
  await fs.rm(store, { recursive: true, force: true });
});

// ─── backfillOpenPRs ────────────────────────────────────────────────────────

describe("backfillOpenPRs", () => {
  test("writes triage meta for every unknown open PR, and touches the watch list not at all", async () => {
    const forge = fakeForge({
      listOpenPRs: async () => [
        summary({ number: 1, author: LOGIN }),
        summary({ number: 2, author: "someone-else" }),
      ],
      getPR: async (ref) => detail({ number: ref.number, author: ref.number === 1 ? LOGIN : "someone-else" }),
      getCheckStatus: async () => OK_CHECKS,
    });

    const result = await backfillOpenPRs(store, forge, REPO);

    expect(result.entries.map((e) => e.ref.number)).toEqual([1, 2]);

    const own = result.entries[0]!;
    expect(own.classification).toBe("own");
    expect(own.autoClass).toBe(true);
    expect(own.preSelected).toBe(true);

    const other = result.entries[1]!;
    expect(other.classification).toBe("none");
    expect(other.autoClass).toBe(false);
    expect(other.preSelected).toBe(false);

    // Nothing is queued: state is "triage" for both, auto-class included (R2.6).
    const meta1 = await loadMeta(store, { ...REPO, number: 1 });
    const meta2 = await loadMeta(store, { ...REPO, number: 2 });
    expect(meta1?.state).toBe("triage");
    expect(meta1?.classification).toBe("own");
    expect(meta2?.state).toBe("triage");
    expect(meta2?.classification).toBe("none");

    // backfillOpenPRs alone never joins the watch list.
    expect((await getWatchedRepoKeys(store)).size).toBe(0);
  });

  test("an auto-class PR that is still a draft is listed and classified but not pre-selected", async () => {
    const forge = fakeForge({
      listOpenPRs: async () => [summary({ number: 1, author: LOGIN, draft: true })],
      getPR: async (ref) => detail({ number: ref.number, author: LOGIN, draft: true }),
      getCheckStatus: async () => OK_CHECKS,
    });

    const result = await backfillOpenPRs(store, forge, REPO);

    const entry = result.entries[0]!;
    expect(entry.classification).toBe("own");
    expect(entry.autoClass).toBe(true);
    expect(entry.preSelected).toBe(false);

    const meta = await loadMeta(store, { ...REPO, number: 1 });
    expect(meta?.state).toBe("triage");
    expect(meta?.classification).toBe("own");
    expect(meta?.draft).toBe(true);
  });

  test("reconciliation: a PR with existing meta keeps its state and is excluded from the list", async () => {
    const known: PRRef = { ...REPO, number: 1 };
    await saveMeta(store, known, {
      title: "already reviewed",
      author: LOGIN,
      state: "reviewed",
      classification: "own",
      headSha: "old-sha",
    });

    const forge = fakeForge({
      listOpenPRs: async () => [summary({ number: 1, author: LOGIN }), summary({ number: 2, author: LOGIN })],
      // getPR for #1 would throw (fakeForge default), proving it is never called for a known PR.
      getPR: async (ref) => {
        if (ref.number === 1) throw new Error("must not fetch detail for a PR the store already knows");
        return detail({ number: ref.number, author: LOGIN });
      },
      getCheckStatus: async () => OK_CHECKS,
    });

    const result = await backfillOpenPRs(store, forge, REPO);

    expect(result.entries.map((e) => e.ref.number)).toEqual([2]);

    const stillKnown = await loadMeta(store, known);
    expect(stillKnown?.state).toBe("reviewed");
    expect(stillKnown?.headSha).toBe("old-sha");
  });

  test("uses the PR's current head SHA (from getPR), not the listing's, for check status and meta", async () => {
    const seenShas: string[] = [];
    const forge = fakeForge({
      listOpenPRs: async () => [summary({ number: 1, author: LOGIN, headSha: "stale-sha" })],
      getPR: async (ref) => detail({ number: ref.number, author: LOGIN, headSha: "fresh-sha" }),
      getCheckStatus: async (_ref, sha) => {
        seenShas.push(sha);
        return OK_CHECKS;
      },
    });

    await backfillOpenPRs(store, forge, REPO);

    expect(seenShas).toEqual(["fresh-sha"]);
    const meta = await loadMeta(store, { ...REPO, number: 1 });
    expect(meta?.headSha).toBe("fresh-sha");
  });

  test("a NotModified answer backfills nothing and never calls getPR", async () => {
    const notModified: NotModified = { notModified: true };
    const forge = fakeForge({
      listOpenPRs: async () => notModified,
    });

    const result = await backfillOpenPRs(store, forge, REPO);
    expect(result.entries).toEqual([]);
  });

  test("a fetch failure partway through propagates, leaving earlier writes in place", async () => {
    const forge = fakeForge({
      listOpenPRs: async () => [summary({ number: 1, author: LOGIN }), summary({ number: 2, author: LOGIN })],
      getPR: async (ref) => {
        if (ref.number === 2) throw new Error("boom");
        return detail({ number: ref.number, author: LOGIN });
      },
      getCheckStatus: async () => OK_CHECKS,
    });

    await expect(backfillOpenPRs(store, forge, REPO)).rejects.toThrow("boom");

    // #1 was written before #2 blew up.
    const meta1 = await loadMeta(store, { ...REPO, number: 1 });
    expect(meta1?.state).toBe("triage");
  });
});

// ─── addRepoWithBackfill: the ordering guarantee ────────────────────────────

describe("addRepoWithBackfill", () => {
  test("every PR's meta is written before the repo joins the watch list", async () => {
    // A mutable holder, not a bare `let`: TypeScript narrows a `let` captured
    // by a closure to its initial literal at the read site below regardless
    // of the intervening await, which would make this assertion pass for
    // the wrong reason. A property read has no such narrowing.
    const observed: { watchedDuringFetch: boolean | null } = { watchedDuringFetch: null };

    const forge = fakeForge({
      listOpenPRs: async () => [summary({ number: 1, author: LOGIN })],
      getPR: async (ref) => {
        const keys = await getWatchedRepoKeys(store);
        observed.watchedDuringFetch = keys.has(`${REPO.owner}/${REPO.repo}`);
        return detail({ number: ref.number, author: LOGIN });
      },
      getCheckStatus: async () => OK_CHECKS,
    });

    await addRepoWithBackfill(store, forge, REPO);

    // The repo was NOT yet watched at the moment its PR was being fetched...
    expect(observed.watchedDuringFetch).toBe(false);
    // ...but it is watched now that backfill has finished.
    expect((await getWatchedRepoKeys(store)).has("acme/api")).toBe(true);
    // And the PR's meta exists too, so a poll cycle running right now sees a known PR.
    expect((await loadMeta(store, { ...REPO, number: 1 }))?.state).toBe("triage");
  });

  test("a fetch failure aborts before the repo ever joins the watch list", async () => {
    const forge = fakeForge({
      listOpenPRs: async () => [summary({ number: 1, author: LOGIN })],
      getPR: async () => {
        throw new Error("network blip");
      },
    });

    await expect(addRepoWithBackfill(store, forge, REPO)).rejects.toThrow("network blip");
    expect((await getWatchedRepoKeys(store)).has("acme/api")).toBe(false);
  });

  test("a repo with zero open PRs still joins the watch list", async () => {
    const forge = fakeForge({ listOpenPRs: async () => [] });

    const result = await addRepoWithBackfill(store, forge, REPO);

    expect(result.entries).toEqual([]);
    expect((await getWatchedRepoKeys(store)).has("acme/api")).toBe(true);
  });

  test("re-adding a removed repo reconciles: only the unknown PR is backfilled, the known one is untouched", async () => {
    const known: PRRef = { ...REPO, number: 1 };
    await saveMeta(store, known, { state: "skipped", classification: "none", author: "someone-else" });
    // Simulate "previously removed": no watch entry, on-disk review data kept (R9.5).

    const forge = fakeForge({
      listOpenPRs: async () => [summary({ number: 1, author: LOGIN }), summary({ number: 2, author: LOGIN })],
      getPR: async (ref) => {
        if (ref.number === 1) throw new Error("must not refetch a known PR on re-add");
        return detail({ number: ref.number, author: LOGIN });
      },
      getCheckStatus: async () => OK_CHECKS,
    });

    const result = await addRepoWithBackfill(store, forge, REPO);

    expect(result.entries.map((e) => e.ref.number)).toEqual([2]);
    expect((await loadMeta(store, known))?.state).toBe("skipped"); // sticky skip survives (R2.4).
    expect((await getWatchedRepoKeys(store)).has("acme/api")).toBe(true);
  });
});

// ─── mergeableStatus ────────────────────────────────────────────────────────

describe("mergeableStatus", () => {
  test("null renders as computing, never as a conflict", () => {
    expect(mergeableStatus(null)).toBe("computing");
  });

  test("true renders as mergeable, false as conflict", () => {
    expect(mergeableStatus(true)).toBe("mergeable");
    expect(mergeableStatus(false)).toBe("conflict");
  });

  test("a still-computing PR's backfill entry keeps mergeable as null, not coerced to false", async () => {
    const forge = fakeForge({
      listOpenPRs: async () => [summary({ number: 1, author: LOGIN })],
      getPR: async (ref) => detail({ number: ref.number, author: LOGIN, mergeable: null }),
      getCheckStatus: async () => OK_CHECKS,
    });

    const result = await backfillOpenPRs(store, forge, REPO);

    expect(result.entries[0]!.detail.mergeable).toBeNull();
    expect(mergeableStatus(result.entries[0]!.detail.mergeable)).toBe("computing");
  });
});

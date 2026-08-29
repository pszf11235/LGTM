/**
 * Backfill: what happens when a repo joins the watch list.
 *
 * A repo does not start empty. It usually has open PRs already, and R2.6
 * ("Adding a repo backfills its open PRs into the triage inbox with the same
 * metadata. Auto-class PRs arrive pre-selected for review, and nothing runs
 * until the selection is confirmed.") is the rule this module exists to
 * satisfy: every open PR gets triage metadata and a classification, but
 * confirming is a human step even for a PR that would auto-queue on any
 * later cycle. CONTEXT.md's Backfill entry says the same thing from the
 * glossary side: "Backfill always asks; automatic classification applies
 * only to activity that happens after watching begins."
 *
 * The ordering that makes that true (design.md, "Poll cycle" / the
 * `/api/watchlist` POST row): every open PR's `meta.md` is written *before*
 * the repo is added to `watch.md`. Get this backwards and the very next poll
 * cycle treats these PRs as brand new. Its "Unknown PR" branch auto-queues
 * an auto-class PR immediately, which is exactly what "nothing runs until
 * confirmed" forbids. `addRepoWithBackfill` below is the one function that
 * is allowed to add a repo to the watch list, and it only does so after
 * `backfillOpenPRs` has finished writing meta for everything it saw.
 *
 * Classification is not reimplemented here. `src/core/classify.ts`'s
 * `classify` and `isAutoClass` (ported from the old `watch-cycle.ts`'s
 * `decidePR`, per design.md's "Ported modules" table) are the only source of
 * the auto-class rule; this module calls them and carries no rule of its
 * own.
 *
 * Reconciliation (R9.5): re-adding a previously removed repo must not
 * clobber PRs LGTM already has an opinion about. A PR with an existing
 * `meta.md` keeps its current state, whatever the last watch cycle left it
 * as: reviewed, skipped, closed. It is left out of the backfill list
 * entirely. Only PRs with no meta file are "unknown" and get a fresh triage
 * entry.
 */

import type {
  CheckStatus,
  Classification,
  ForgeAdapter,
  NotModified,
  PRDetail,
  PRRef,
  PRSummary,
  RepoRef,
} from "@/core";
import { classify, isAutoClass } from "@/core/classify";
import { loadMeta, saveMeta } from "@/store/reviews";
import { addToWatchList } from "@/store";

// ─── Results ────────────────────────────────────────────────────────────────

/** One newly-discovered PR, with everything the confirm pane needs to show a row. */
export interface BackfillEntry {
  ref: PRRef;
  /** Triage metadata: author, additions, deletions, changedFiles, mergeable, draft, age (createdAt), ... */
  detail: PRDetail;
  /** CI status for `detail.headSha`, read from the Checks API only (design.md, deferred decisions). */
  checkStatus: CheckStatus;
  classification: Classification;
  /** `isAutoClass(classification)`: this PR would auto-queue once the repo is watched. */
  autoClass: boolean;
  /**
   * Whether the confirm pane's checkbox for this PR starts checked.
   * Auto-class PRs are pre-selected (R2.6) except while still draft: R2.3
   * holds a draft PR out of auto-review until it leaves draft state or a
   * human uses the explicit "review anyway" override, and pre-checking it
   * here would only ever feed the plain "review" decision, not that
   * override. So a draft auto-class PR is listed and its classification is
   * recorded, but its box starts unchecked.
   */
  preSelected: boolean;
}

export interface BackfillResult {
  repo: RepoRef;
  /**
   * Newly-seen PRs only, in the Forge's listing order. A PR the store
   * already has meta for is reconciled silently and does not appear here.
   * See the module doc comment on reconciliation.
   */
  entries: BackfillEntry[];
}

// ─── Mergeable rendering ────────────────────────────────────────────────────

export type MergeableStatus = "mergeable" | "conflict" | "computing";

/**
 * GitHub computes a PR's mergeability asynchronously and answers `null`
 * while it works (`@/core`'s `PRDetail.mergeable` doc comment). That is
 * "computing", never a conflict. Treating a still-null value as falsy would
 * show every freshly-backfilled PR as blocked on a merge conflict nobody
 * has looked at yet, for however long GitHub's own computation takes. Kept
 * as a named function rather than an inline ternary at each call site so
 * this reading of `null` is asserted once and reused everywhere the confirm
 * list and the triage inbox need it.
 */
export function mergeableStatus(mergeable: boolean | null): MergeableStatus {
  if (mergeable === null) return "computing";
  return mergeable ? "mergeable" : "conflict";
}

// ─── Backfill ───────────────────────────────────────────────────────────────

/** Narrows `listOpenPRs`'s result without importing a concrete ForgeAdapter's own helper (see below). */
function isNotModified(result: PRSummary[] | NotModified): result is NotModified {
  return !Array.isArray(result);
}

/**
 * Fetch a repo's open PRs, classify each one, and write triage meta for
 * every PR the store does not already know about. Does not touch the watch
 * list. See `addRepoWithBackfill` for the function that adds the ordering
 * guarantee on top of this one.
 *
 * `forge.listOpenPRs` answering `NotModified` is treated as "nothing to
 * backfill" rather than an error. It should not happen for a repo with no
 * prior ETag, but the ForgeAdapter interface allows it unconditionally, and
 * failing the whole operation over an empty-diff answer would be a strange
 * way to punish a repo with zero open PRs' evil twin.
 *
 * A fetch failure partway through (`getPR` or `getCheckStatus` throwing for
 * some PR) is not caught here. It propagates, and whatever meta was already
 * written for earlier PRs in the list stays on disk. That's harmless, since
 * the repo hasn't joined the watch list yet, and idempotent, since retrying
 * the whole backfill skips those PRs as already known and picks up where it
 * left off.
 */
export async function backfillOpenPRs(
  lgtmDir: string,
  forge: ForgeAdapter,
  repo: RepoRef
): Promise<BackfillResult> {
  const listed = await forge.listOpenPRs(repo);
  const summaries = isNotModified(listed) ? [] : listed;

  if (summaries.length === 0) return { repo, entries: [] };

  // Fetched once and cached for the whole backfill, same as design.md
  // describes for the regular poll cycle.
  const authenticatedLogin = await forge.authenticatedUser();

  const entries: BackfillEntry[] = [];

  for (const summary of summaries) {
    const ref: PRRef = { owner: repo.owner, repo: repo.repo, number: summary.number };

    // Reconciliation: a PR the store already has an opinion about keeps it.
    const existing = await loadMeta(lgtmDir, ref);
    if (existing) continue;

    const detail = await forge.getPR(ref);
    const checkStatus = await forge.getCheckStatus(ref, detail.headSha);
    const classification = classify(detail, authenticatedLogin);
    const autoClass = isAutoClass(classification);
    const preSelected = autoClass && !detail.draft;

    // R2.6: state is "triage" for every backfilled PR, auto-class included.
    // The transition to "queued" happens only through the decision endpoint
    // once a human confirms, never here and never on the next poll cycle
    // either, because writing this meta now is what keeps that PR from
    // looking "unknown" to that cycle.
    await saveMeta(lgtmDir, ref, {
      url: detail.url,
      title: detail.title,
      author: detail.author,
      state: "triage",
      classification,
      draft: detail.draft,
      headSha: detail.headSha,
    });

    entries.push({ ref, detail, checkStatus, classification, autoClass, preSelected });
  }

  return { repo, entries };
}

/**
 * Add a repo to the watch list, backfilling its open PRs first.
 *
 * The one invariant this function exists to guarantee: every open PR's
 * `meta.md` is on disk before `repo` appears in `watch.md`. `backfillOpenPRs`
 * runs to completion, including every `saveMeta` write it makes, and only
 * then does `addToWatchList` run. A poll cycle that starts between those two
 * calls sees a repo with no watch entry yet, so it cannot run at all, let
 * alone auto-queue anything ahead of the confirm pane.
 */
export async function addRepoWithBackfill(
  lgtmDir: string,
  forge: ForgeAdapter,
  repo: RepoRef
): Promise<BackfillResult> {
  const result = await backfillOpenPRs(lgtmDir, forge, repo);
  await addToWatchList(repo.owner, repo.repo, lgtmDir);
  return result;
}

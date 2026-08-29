/**
 * Who a PR belongs to, and what the poll cycle should do about it.
 *
 * Two pure functions. `classify` answers the AutoClassPr question from one
 * row of `listOpenPRs` (CONTEXT.md, "AutoClassPr"). `decide` answers "what
 * happens to this PR on this cycle" from stored metadata plus that same row,
 * and it is a transcription of design.md's "Poll cycle" bullets, one branch
 * per bullet.
 *
 * Nothing here reads the disk, the network, or the clock. The daemon fetches,
 * calls `decide`, persists the returned patch through `saveMeta`, and pushes
 * anything it queued at the review queue. Keeping the rules on this side of
 * that line is what makes them testable at all: "a skipped PR stays skipped
 * after three more pushes" is a five-line test here and an integration
 * fixture anywhere else.
 *
 * The rule most worth protecting is sticky skip (CONTEXT.md, "Skip"). Getting
 * it wrong reviews a PR the user said not to, which spends quota and posts
 * findings nobody asked for, so it is checked before every other branch and
 * tested on its own below.
 */

import type { Classification, PRMeta, PRState, PRSummary } from "./types";

// ─── Constants ──────────────────────────────────────────────────────────────

/**
 * Retry cap for a failed round, counted per head SHA and reset by new commits
 * (R3.5). A provider that fails four times on the same commit is failing for a
 * reason a fifth run will not fix.
 */
export const MAX_REVIEW_ATTEMPTS = 3;

const AUTO_CLASSES: ReadonlySet<Classification> = new Set<Classification>([
  "own",
  "requested",
  "assigned",
  "mentioned",
]);

// ─── Decision shape ─────────────────────────────────────────────────────────

/**
 * The subset of `meta.md` a decision writes. Structurally identical to the
 * store's `MetaUpdate`, declared here so `src/core` keeps no dependency on
 * `src/store`; `saveMeta(dir, ref, decision.patch)` typechecks against either.
 */
export type MetaPatch = Partial<Omit<PRMeta, "owner" | "repo" | "number" | "updatedAt">>;

/**
 * - `queue`: the PR wants a review round at its current head SHA.
 * - `triage`: it lands in the inbox and waits for a human.
 * - `refresh`: metadata changed, the lifecycle state did not.
 * - `close`: it is no longer open on the Forge.
 * - `none`: nothing to do, and nothing to write. An unchanged PR must not
 *   rewrite its `meta.md` every cycle, because the daemon watches the store
 *   directory and every write is an event the UI reacts to.
 */
export type DecisionAction = "queue" | "triage" | "refresh" | "close" | "none";

export interface Decision {
  action: DecisionAction;
  /** Why, phrased for the daemon log. */
  reason: string;
  /** Fields to persist. Always empty when the action is `none`. */
  patch: MetaPatch;
}

/** One PR as this cycle found it, with everything `decide` is allowed to know. */
export interface Observation {
  /** The row from `listOpenPRs`, or null when the PR is no longer open. */
  pr: PRSummary | null;
  /** The authenticated login, from `authenticatedUser()`, cached by the daemon. */
  viewer: string;
  /** Injected clock, the only timestamp a decision produces (`closedAt`). */
  now: string;
}

// ─── Classification ─────────────────────────────────────────────────────────

/** GitHub logins are case-insensitive, and the API is not consistent about case. */
function sameLogin(a: string, b: string): boolean {
  return a.length > 0 && b.length > 0 && a.toLowerCase() === b.toLowerCase();
}

/**
 * Tier (a) mention detection: the PR title and body, never comments and never
 * the notifications API (R2.2, deferred in design.md until real mentions get
 * missed).
 *
 * `@ada` must not fire on `@adamw` or on `ada@example.com`, so the login is
 * bounded on both sides. GitHub logins allow letters, digits and hyphens, so
 * those are the characters that continue a login and block a match.
 */
function mentions(text: string, viewer: string): boolean {
  if (!text || !viewer) return false;
  const login = viewer.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`(^|[^0-9A-Za-z@_-])@${login}(?![0-9A-Za-z-])`, "i");
  return pattern.test(text);
}

/**
 * Why this PR qualifies for review without being asked, or `none` when it does
 * not and belongs in triage.
 *
 * The order is the order design.md lists: `user.login`, `requested_reviewers`,
 * `assignees`, then `@login` in title or body. A PR can match several; the
 * first one is the one recorded, because it is the strongest reason and the
 * badge in the UI shows exactly one.
 */
export function classify(pr: PRSummary, viewer: string): Classification {
  if (!viewer) return "none";
  if (sameLogin(pr.author, viewer)) return "own";
  if (pr.requestedReviewers.some((login) => sameLogin(login, viewer))) return "requested";
  if (pr.assignees.some((login) => sameLogin(login, viewer))) return "assigned";
  if (mentions(pr.title, viewer) || mentions(pr.body, viewer)) return "mentioned";
  return "none";
}

/** True for an AutoClassPr: reviewed without being asked. `manual` is not one. */
export function isAutoClass(classification: Classification): boolean {
  return AUTO_CLASSES.has(classification);
}

/**
 * True when a PR may be reviewed without asking again: it is auto-class, or a
 * human already approved it through a `review` or `review-anyway` decision,
 * which is what `manual` records.
 */
export function qualifiesForReview(classification: Classification): boolean {
  return classification === "manual" || isAutoClass(classification);
}

/**
 * The "reviews when ready" marker: an auto-class draft, held in triage until
 * it leaves draft state (R2.3). Derived rather than stored, so it can never
 * disagree with the fields it is derived from.
 */
export function reviewsWhenReady(meta: PRMeta): boolean {
  return meta.state === "triage" && meta.draft && qualifiesForReview(meta.classification);
}

// ─── The poll-cycle decision ────────────────────────────────────────────────

function none(reason: string): Decision {
  return { action: "none", reason, patch: {} };
}

/**
 * A PR with no `meta.md`, or one reopened before any round completed. Same
 * three outcomes either way, which is what design.md means by a reopened PR
 * resuming "as a known PR under the rules above".
 */
function firstSighting(pr: PRSummary, classification: Classification, identity: MetaPatch): Decision {
  const base: MetaPatch = {
    ...identity,
    classification,
    draft: pr.draft,
    headSha: pr.headSha,
  };

  if (!qualifiesForReview(classification)) {
    return { action: "triage", reason: "not auto-class, waiting on a human", patch: { ...base, state: "triage" } };
  }

  if (pr.draft) {
    // The classification is recorded now so the marker renders and so the
    // draft-to-ready transition below has something to qualify on.
    return {
      action: "triage",
      reason: `auto-class (${classification}) but still a draft, reviews when ready`,
      patch: { ...base, state: "triage" },
    };
  }

  return { action: "queue", reason: `auto-class (${classification})`, patch: { ...base, state: "queued" } };
}

/**
 * Map a reopened PR back onto a live state. `closed` overwrote whatever it
 * was, and `PRMeta` has no field for the state before the close, so a
 * completed round is the only memory left: a PR that has one resumes as
 * `reviewed`, and one that has none goes back through `firstSighting`
 * (signalled by null). A `skipped` PR never reaches here, because a close
 * leaves that state alone.
 */
function resumeState(meta: PRMeta): PRState | null {
  if (meta.state !== "closed") return meta.state;
  return meta.lastReviewedSha !== null ? "reviewed" : null;
}

function knownPR(
  existing: PRMeta,
  pr: PRSummary,
  classification: Classification,
  identity: MetaPatch,
  state: PRState,
): Decision {
  const qualifies = qualifiesForReview(classification);
  const current: MetaPatch = { ...identity, classification, draft: pr.draft, headSha: pr.headSha };
  const shaChanged = existing.headSha !== pr.headSha;

  // ── The draft flag flipped true to false ─────────────────────────────────
  if (existing.draft && !pr.draft) {
    // "review anyway" already reviewed this exact commit while it was a draft.
    // Leaving draft state is not new work, and queueing here would review the
    // same SHA twice.
    if (existing.lastReviewedSha === pr.headSha) {
      return { action: "refresh", reason: "left draft state, but this head SHA was already reviewed", patch: current };
    }
    if (!qualifies) {
      return { action: "refresh", reason: "left draft state, but it is not auto-class", patch: current };
    }
    return { action: "queue", reason: "left draft state", patch: { ...current, state: "queued" } };
  }

  // ── New commits ──────────────────────────────────────────────────────────
  if (shaChanged) {
    switch (state) {
      case "reviewed":
      case "failed":
        if (!qualifies) {
          return { action: "refresh", reason: "new commits on a PR that is not auto-class", patch: current };
        }
        // The attempt counter belongs to the SHA that failed, not to the PR.
        return {
          action: "queue",
          reason: "new commits since the last round",
          patch: { ...current, state: "queued", failedAttempts: 0 },
        };

      case "queued":
        // The queue holds one entry per PR and the newer SHA replaces it.
        return {
          action: "queue",
          reason: "new commits while queued, the newer SHA replaces the queued entry",
          patch: { ...current, state: "queued", failedAttempts: 0 },
        };

      case "reviewing":
        // An in-flight round is never cancelled. It finishes, records the SHA
        // it reviewed, and the next cycle sees these commits as new against
        // that SHA. Writing the newer SHA now would erase that comparison.
        return none("new commits while a round is in flight, which finishes first");

      default:
        // Triage, and anything hand-edited into an unexpected state. The PR
        // is waiting on a human either way, so only the metadata moves.
        return { action: "refresh", reason: "new commits while waiting in triage", patch: current };
    }
  }

  // ── Same head SHA ────────────────────────────────────────────────────────
  if (state === "failed" && existing.failedAttempts < MAX_REVIEW_ATTEMPTS) {
    return {
      action: "queue",
      reason: `retrying a failed round, attempt ${existing.failedAttempts + 1} of ${MAX_REVIEW_ATTEMPTS}`,
      patch: { state: "queued" },
    };
  }

  return none("no new commits");
}

/**
 * What this cycle should do with one PR.
 *
 * `existing` is its `meta.md`, or null when the store has never seen it.
 * Every branch corresponds to a bullet under "Poll cycle" in design.md, and
 * the tests are ordered to match.
 */
export function decide(existing: PRMeta | null, observed: Observation): Decision {
  const { pr, viewer, now } = observed;

  // ── No longer open on the Forge ──────────────────────────────────────────
  if (!pr) {
    if (!existing) return none("not open, and not in the store");
    if (existing.closedAt !== null) return none("already recorded as closed");
    // A skipped PR keeps its state through the close. That is the only place
    // the skip can survive, since `meta.md` has no field for the state before
    // a close, and on reopen the sticky rule needs to still be able to read it.
    const state: PRState = existing.state === "skipped" ? "skipped" : "closed";
    return { action: "close", reason: "no longer open on the forge", patch: { state, closedAt: now } };
  }

  // A manual approval is a human decision and outranks whatever the PR's
  // fields say now. Everything else is re-derived from the list row each
  // cycle, which is where a new review request or assignment shows up.
  const classification: Classification =
    existing?.classification === "manual" ? "manual" : classify(pr, viewer);
  const identity: MetaPatch = { url: pr.url, title: pr.title, author: pr.author };

  if (!existing) return firstSighting(pr, classification, identity);

  const resumed = resumeState(existing);
  const decision =
    // Sticky skip, before anything else can react to new activity.
    existing.state === "skipped"
      ? none("skipped, and new activity never resurrects a skipped PR")
      : resumed === null
        ? firstSighting(pr, classification, identity)
        : knownPR(existing, pr, classification, identity, resumed);

  const wasClosed = existing.state === "closed" || existing.closedAt !== null;
  if (!wasClosed) return decision;

  // Reopened. Rounds, findings and any pendingReviewId are untouched by every
  // patch above, so resuming is a matter of clearing the close stamp. A
  // decision that would otherwise write nothing still has to do that much.
  // Either signal counts, so a meta.md carrying only one of the two (a
  // hand-edit, an interrupted write) is repaired rather than left half closed.
  return {
    action: decision.action === "none" ? "refresh" : decision.action,
    reason: `reopened, ${decision.reason}`,
    patch: { ...decision.patch, closedAt: null },
  };
}

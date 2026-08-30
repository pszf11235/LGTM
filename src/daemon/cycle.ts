/**
 * The poll cycle: watched repos in, queued Rounds and stored Findings out.
 *
 * Everything under src/daemon so far is a part. The Scheduler decides when a
 * cycle runs, the queue decides what runs next, the QuotaGate decides whether
 * anything runs at all, and `decide` in @/core/classify decides what one PR
 * deserves. This module is the wiring, and it owns the two jobs nothing else
 * can: `runCycle` turns a Forge listing into store writes and queue entries,
 * and `dispatchReview` runs one whole Round from the queue's side.
 *
 * Three rules shape the code more than the spec text does.
 *
 * 1. A `none` decision writes nothing. The daemon watches the store with
 *    fs.watch and every write is an event the UI reacts to (design.md,
 *    "Store layout"). A hundred watched PRs that rewrote `meta.md` every
 *    fifteen minutes would be a hundred invalidations an hour for no news.
 *    So the write is conditional on there being something to say, and the
 *    "unchanged PR writes nothing" test exists to keep it that way.
 *
 * 2. One repo's failure is that repo's failure. A dead token, a repo renamed
 *    out from under the watch list, a rate limit: each of those must leave
 *    the other repos polled. Every repo runs inside its own try, and so does
 *    every PR inside a repo, because a single 404 from `getReview` is no
 *    reason to stop classifying the other forty PRs.
 *
 * 3. Errors surface as `error` events whose cause is stable across cycles.
 *    The notifier fires once per distinct cause (R8.2), so the cause string
 *    is what decides whether a broken CLI notifies once or once per PR per
 *    fifteen minutes. Repo failures name the repo, because a 404 on one repo
 *    is its own actionable problem. Provider failures name only the error,
 *    because a missing `claude` binary is one problem no matter how many PRs
 *    hit it.
 *
 * Two places where this module knowingly does something design.md's bullets
 * do not say, both recorded here so the difference is deliberate:
 *
 * (a) A PR sitting in triage that BECOMES auto-class is queued, even though
 *     its head SHA has not moved. design.md's "Known PR, `headSha`
 *     unchanged: ... otherwise no action" would leave it in triage forever,
 *     which loses the case the whole feature exists for: someone adds you as
 *     a reviewer on a PR that is not getting new commits. R2.1 ("each open
 *     PR is classified. Auto-class PRs are queued for review") is the rule
 *     that wins. The trigger is the transition, not the state: a PR whose
 *     stored classification is already auto-class is left alone, which is
 *     what keeps Backfill's "nothing runs until the selection is confirmed"
 *     (R2.6) intact, since backfill writes auto-class PRs into triage on
 *     purpose. `decide` stays pure and untouched; this lives here.
 *
 * (b) A PR that goes back to draft while queued is pulled out of the queue.
 *     R2.3 says a draft is never auto-reviewed, and `decide`'s branches only
 *     cover the draft-to-ready direction. `dispatchReview` re-reads the flag
 *     before spawning too, because the queue may hand out an entry in the
 *     window between the cycle writing `meta.md` and the cycle removing the
 *     entry.
 *
 * A third thing worth naming, since it looks like an accident: a PR whose
 * stored state is already `queued` is re-enqueued every cycle. The queue is
 * in memory and the store is not, so after a crash `resetStrandedPRs` leaves
 * PRs in `queued` that no queue knows about, and `decide` answers `none` for
 * them forever. Re-enqueueing costs nothing (the queue answers
 * `already-queued` or `in-flight` and does not even drain) and it is what
 * makes design.md's "a crash never strands a PR" true past the boot cycle.
 */

import type {
  Classification,
  ForgeAdapter,
  NotModified,
  PRMeta,
  PRRef,
  PRSummary,
  RepoRef,
} from "@/core";
import { classify, decide, isAutoClass, type Decision, type DecisionAction } from "@/core/classify";
import { formatRef } from "@/core/pr-ref";
import {
  defaultAgentConfig,
  runReview,
  type AgentConfig,
  type PriorFinding,
  type ReviewInput,
  type ReviewOutcome,
} from "@/provider";
import {
  loadAllRounds,
  loadMeta,
  listReviewedPRs,
  prUrl,
  saveMeta,
  saveRound,
  type MetaUpdate,
} from "@/store/reviews";
import { loadWatchList, updateETag, updateLastPolledAt, type WatchEntry } from "@/store/watch-list";
import type { DaemonEvent } from "./events";
import type { QueueEntry, ReviewQueue } from "./queue";
import { snapshotRound, type SnapshotForge } from "./snapshot";

// ─── Injected collaborators ─────────────────────────────────────────────────

/** Anything the cycle emits on. Structurally the `EventBus` from ./events. */
export interface EventSink {
  emit(event: DaemonEvent): void;
}

/** The two queue operations a cycle performs. Never `drain`; that is the gate's business. */
export type CycleQueue = Pick<ReviewQueue, "enqueue" | "remove">;

/**
 * Where conditional-request validators live between calls. Structurally the
 * GitHub adapter's `EtagStore`, declared here so the daemon can hand the same
 * object to both and this module keeps no dependency on a concrete Forge.
 *
 * The adapter reads and writes it around each `listOpenPRs`; the cycle's part
 * is only to carry the value across daemon restarts through `watch.md`.
 */
export interface EtagCache {
  get(key: string): string | null;
  set(key: string, etag: string | null): void;
}

export interface CycleDeps {
  lgtmDir: string;
  forge: ForgeAdapter;
  queue: CycleQueue;
  events?: EventSink;
  /** Shared with the Forge adapter. Omit and ETags simply do not survive a restart. */
  etags?: EtagCache;
  /** Injected clock, ISO 8601. The only timestamp the cycle produces itself. */
  now?: () => string;
  /** Daemon log line sink. Optional so tests stay quiet. */
  log?: (line: string) => void;
}

// ─── Results ────────────────────────────────────────────────────────────────

/** One repo's cycle, as `/api/status` reports it. */
export interface RepoOutcome {
  repo: RepoRef;
  /** `owner/repo`, the same key the event bus and the ETag cache use. */
  repoKey: string;
  /** `not-modified` is a successful poll that cost no rate limit. */
  status: "ok" | "not-modified" | "failed";
  error: string | null;
  /** Open PRs the Forge listed. */
  seen: number;
  queued: number;
  triaged: number;
  refreshed: number;
  closed: number;
  /** PRs whose `pendingReviewId` was cleared because the draft is no longer pending. */
  reconciled: number;
  /** PRs whose own handling threw. The rest of the repo still ran. */
  errors: number;
}

export interface PollCycleResult {
  /** ISO 8601, from the injected clock. */
  startedAt: string;
  repos: RepoOutcome[];
  /** Set when the cycle could not start at all, e.g. the token is dead. */
  error: string | null;
}

// ─── Small helpers ──────────────────────────────────────────────────────────

function repoKeyOf(repo: RepoRef): string {
  return `${repo.owner}/${repo.repo}`;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * `listOpenPRs`'s two answers are not interchangeable: a 304 means "nothing
 * changed", an empty array means "no open PRs", and only the second one may
 * close anything.
 */
function isNotModified(result: PRSummary[] | NotModified): result is NotModified {
  return !Array.isArray(result);
}

/**
 * The bus delivers synchronously to every listener and catches nothing, so a
 * notifier that throws would otherwise take the cycle down with it. Emitting
 * is a side effect of doing the work, never a step of it.
 */
function emit(deps: { events?: EventSink; log?: (line: string) => void }, event: DaemonEvent): void {
  try {
    deps.events?.emit(event);
  } catch (error) {
    deps.log?.(`cycle: event listener threw on ${event.type}: ${messageOf(error)}`);
  }
}

/** The metadata a refresh carries: everything the list row can tell us, and no state. */
function currentPatch(summary: PRSummary, classification: Classification): MetaUpdate {
  return {
    url: summary.url,
    title: summary.title,
    author: summary.author,
    classification,
    draft: summary.draft,
    headSha: summary.headSha,
  };
}

/**
 * The same rule `decide` applies: a `manual` classification is a human
 * decision and outranks whatever the list row says now. Everything else is
 * re-derived every cycle, which is where a new review request shows up.
 */
function classificationFor(meta: PRMeta | null, summary: PRSummary, viewer: string): Classification {
  return meta?.classification === "manual" ? "manual" : classify(summary, viewer);
}

// ─── The cycle ──────────────────────────────────────────────────────────────

/**
 * Poll every watched repo once.
 *
 * Never throws. A repo that fails is reported as a failed repo; a cycle that
 * cannot even identify the authenticated user is reported as a failed cycle,
 * because classification is meaningless without it and every repo would fail
 * the same way for the same reason.
 */
export async function runCycle(deps: CycleDeps): Promise<PollCycleResult> {
  const now = deps.now ?? (() => new Date().toISOString());
  const startedAt = now();

  const watched = await loadWatchList(deps.lgtmDir);
  if (watched.length === 0) return { startedAt, repos: [], error: null };

  let viewer: string;
  try {
    // design.md: "The authenticated login comes from GET /user, fetched once
    // and cached." Once per cycle, so a rotated token is picked up on the
    // next one rather than at the next daemon restart.
    viewer = await deps.forge.authenticatedUser();
  } catch (error) {
    const message = messageOf(error);
    deps.log?.(`cycle: cannot identify the authenticated user: ${message}`);
    // One cause for the whole cycle. Every repo would fail identically, and
    // R8.2 wants one notification for one problem.
    emit(deps, { type: "error", cause: `auth: ${message}` });
    return { startedAt, repos: [], error: message };
  }

  // One pass over the store per cycle rather than one per repo. These are the
  // PRs that might have fallen out of their repo's open list.
  const known = await knownRefsByRepo(deps.lgtmDir);

  const repos: RepoOutcome[] = [];
  for (const entry of watched) {
    const repo: RepoRef = { owner: entry.owner, repo: entry.repo };
    const repoKey = repoKeyOf(repo);
    const outcome = emptyOutcome(repo, repoKey);

    try {
      await pollRepo(deps, entry, viewer, now(), known.get(repoKey) ?? [], outcome);
    } catch (error) {
      const message = messageOf(error);
      outcome.status = "failed";
      outcome.error = message;
      deps.log?.(`cycle: ${repoKey} failed: ${message}`);
      // Repo-qualified so a 404 on one repo cannot suppress a 401 on another,
      // and stable across cycles so the same failure notifies once.
      emit(deps, { type: "error", cause: `poll ${repoKey}: ${message}` });
    }

    repos.push(outcome);
    emit(deps, { type: "cycle-finished", repoKey });
  }

  return { startedAt, repos, error: null };
}

function emptyOutcome(repo: RepoRef, repoKey: string): RepoOutcome {
  return {
    repo,
    repoKey,
    status: "ok",
    error: null,
    seen: 0,
    queued: 0,
    triaged: 0,
    refreshed: 0,
    closed: 0,
    reconciled: 0,
    errors: 0,
  };
}

/** Every PR the store knows about, grouped by `owner/repo`. */
async function knownRefsByRepo(lgtmDir: string): Promise<Map<string, PRRef[]>> {
  const grouped = new Map<string, PRRef[]>();

  for (const ref of await listReviewedPRs(lgtmDir)) {
    const key = repoKeyOf(ref);
    const bucket = grouped.get(key);
    if (bucket) bucket.push(ref);
    else grouped.set(key, [ref]);
  }

  return grouped;
}

async function pollRepo(
  deps: CycleDeps,
  entry: WatchEntry,
  viewer: string,
  now: string,
  known: PRRef[],
  outcome: RepoOutcome
): Promise<void> {
  seedEtag(deps, outcome.repoKey, entry.etag);

  const listed = await deps.forge.listOpenPRs(outcome.repo);

  // Both answers are a successful poll, so both stamp the watch list. A repo
  // that threw does not, which keeps `lastPolledAt` meaning "last time we
  // actually heard from the Forge" rather than "last time we tried".
  await recordPoll(deps, entry, outcome.repoKey);

  if (isNotModified(listed)) {
    // R1.5's whole point: nothing changed, so nothing is fetched, nothing is
    // classified, and nothing is written.
    outcome.status = "not-modified";
    return;
  }

  outcome.seen = listed.length;

  for (const summary of listed) {
    const ref: PRRef = { owner: entry.owner, repo: entry.repo, number: summary.number };
    try {
      const handled = await handleOpenPR(deps, ref, summary, viewer, now);
      count(outcome, handled.action);
      if (handled.reconciled) outcome.reconciled += 1;
    } catch (error) {
      const message = messageOf(error);
      outcome.errors += 1;
      deps.log?.(`cycle: ${formatRef(ref)} failed: ${message}`);
      emit(deps, { type: "error", cause: `pr ${formatRef(ref)}: ${message}` });
    }
  }

  const open = new Set(listed.map((summary) => summary.number));
  for (const ref of known) {
    if (open.has(ref.number)) continue;
    try {
      if (await closeMissingPR(deps, ref, viewer, now)) outcome.closed += 1;
    } catch (error) {
      outcome.errors += 1;
      deps.log?.(`cycle: closing ${formatRef(ref)} failed: ${messageOf(error)}`);
    }
  }
}

function count(outcome: RepoOutcome, action: DecisionAction): void {
  if (action === "queue") outcome.queued += 1;
  else if (action === "triage") outcome.triaged += 1;
  else if (action === "refresh") outcome.refreshed += 1;
}

// ─── ETags ──────────────────────────────────────────────────────────────────

/**
 * Carry the validator stored in `watch.md` into the live cache, so the first
 * cycle after a restart is conditional too. The live cache wins when it holds
 * anything, because it is this process's own reading and `watch.md` is only
 * its backup.
 */
function seedEtag(deps: CycleDeps, repoKey: string, stored: string | undefined): void {
  if (!deps.etags || !stored) return;
  if (deps.etags.get(repoKey)) return;
  deps.etags.set(repoKey, stored);
}

/**
 * Stamp `lastPolledAt`, and persist whatever validator the listing left in
 * the cache.
 *
 * Clearing matters as much as writing. The adapter drops the validator for a
 * repo whose open PRs spill past one page, because an `If-None-Match` covers
 * page one alone and a 304 would hide changes on page two. If `watch.md`
 * kept the stale value, the next daemon start would seed exactly the
 * validator the adapter deliberately threw away.
 */
async function recordPoll(deps: CycleDeps, entry: WatchEntry, repoKey: string): Promise<void> {
  await updateLastPolledAt(entry.owner, entry.repo, deps.lgtmDir);

  if (!deps.etags) return;
  const fresh = deps.etags.get(repoKey);

  if (fresh) {
    if (fresh !== entry.etag) await updateETag(entry.owner, entry.repo, fresh, deps.lgtmDir);
    return;
  }

  // An empty validator is dropped from the file rather than written blank.
  if (entry.etag) await updateETag(entry.owner, entry.repo, "", deps.lgtmDir);
}

// ─── One open PR ────────────────────────────────────────────────────────────

interface Handled {
  action: DecisionAction;
  reconciled: boolean;
}

async function handleOpenPR(
  deps: CycleDeps,
  ref: PRRef,
  summary: PRSummary,
  viewer: string,
  now: string
): Promise<Handled> {
  const meta = await loadMeta(deps.lgtmDir, ref);
  const classification = classificationFor(meta, summary, viewer);

  const { decision, dequeue } = withDraftAndClassRules(
    decide(meta, { pr: summary, viewer, now }),
    meta,
    summary,
    classification
  );

  const patch: MetaUpdate = { ...decision.patch };

  // design.md's poll cycle owns this, and `decide` deliberately does not: the
  // classifier is pure and this needs a Forge call. Without it a draft the
  // user submitted or deleted in GitHub's own UI leaves `pendingReviewId` set
  // forever, and every later post is refused for a review that no longer
  // exists (R6.5).
  const reconciled = await reconcilePendingReview(deps, ref, meta);
  if (reconciled) patch.pendingReviewId = null;

  if (dequeue) deps.queue.remove(ref);

  if (decision.action !== "none" || reconciled) {
    await saveMeta(deps.lgtmDir, ref, patch);
    deps.log?.(`cycle: ${formatRef(ref)} ${decision.action}: ${decision.reason}`);
    emit(deps, { type: "pr-changed", ref });
  }

  // Written first, then queued, so a Round that starts immediately reads the
  // metadata this cycle just wrote rather than the previous cycle's.
  const state = patch.state ?? meta?.state ?? null;
  if (state === "queued") deps.queue.enqueue(ref, summary.headSha);

  return { action: decision.action, reconciled };
}

/**
 * The two rules that live here rather than in `decide`, plus one repair.
 *
 * See the module doc comment for (a) and (b). The repair is smaller: when a
 * decision writes nothing but the draft flag on disk disagrees with the
 * Forge, record the flag. `decide` answers `none` for a skipped or already
 * reviewed PR that flips to draft, and a stored flag that contradicts GitHub
 * would render a wrong badge until the PR's next commit.
 */
function withDraftAndClassRules(
  decision: Decision,
  meta: PRMeta | null,
  summary: PRSummary,
  classification: Classification
): { decision: Decision; dequeue: boolean } {
  // (b) R2.3: a draft is never auto-reviewed. Covers both the PR that reverts
  // to draft while it waits and the one that reverts and pushes a commit in
  // the same interval, which `decide` reads as new commits on a queued PR and
  // queues. `manual` is excluded because "review anyway" is exactly the human
  // override R2.3 grants over this hold.
  const heldAsDraft =
    summary.draft &&
    classification !== "manual" &&
    (decision.action === "queue" || meta?.state === "queued");

  if (heldAsDraft) {
    const base = decision.action === "none" ? currentPatch(summary, classification) : decision.patch;
    return {
      decision: {
        action: "refresh",
        reason: "back in draft, and a draft is never auto-reviewed",
        patch: { ...base, state: "triage" },
      },
      dequeue: true,
    };
  }

  // (a) The PR became auto-class while waiting in triage. The transition is
  // the trigger: a PR whose stored classification is already auto-class is
  // left alone, which is what keeps backfilled PRs waiting for their confirm.
  const promoted =
    meta !== null &&
    meta.state === "triage" &&
    meta.closedAt === null &&
    !isAutoClass(meta.classification) &&
    isAutoClass(classification) &&
    (decision.action === "none" || decision.action === "refresh");

  if (promoted) {
    const patch = currentPatch(summary, classification);

    if (summary.draft) {
      // Recorded, not queued. `reviewsWhenReady` renders the marker off this,
      // and `decide`'s draft-to-ready branch queues it later.
      return {
        decision: {
          action: "refresh",
          reason: `now auto-class (${classification}) but still a draft, reviews when ready`,
          patch,
        },
        dequeue: false,
      };
    }

    if (meta.lastReviewedSha === summary.headSha) {
      // "Review anyway" already covered this exact commit. Being added as a
      // reviewer afterwards is not new work.
      return {
        decision: {
          action: "refresh",
          reason: `now auto-class (${classification}), but this head SHA was already reviewed`,
          patch,
        },
        dequeue: false,
      };
    }

    return {
      decision: {
        action: "queue",
        reason: `now auto-class (${classification}) while waiting in triage`,
        patch: { ...patch, state: "queued" },
      },
      dequeue: false,
    };
  }

  if (decision.action === "none" && meta !== null && meta.draft !== summary.draft) {
    return {
      decision: {
        action: "refresh",
        reason: `draft flag is now ${summary.draft}`,
        patch: currentPatch(summary, classification),
      },
      dequeue: false,
    };
  }

  return { decision, dequeue: false };
}

/**
 * True when the recorded draft review is gone from GitHub and the field
 * should be cleared.
 *
 * A Forge failure here is contained rather than propagated: not knowing
 * whether a draft is still pending is no reason to skip the PR's
 * classification, and the post flow re-checks the same field before it posts
 * anything (design.md, "Posting flow", step 1).
 */
async function reconcilePendingReview(
  deps: CycleDeps,
  ref: PRRef,
  meta: PRMeta | null
): Promise<boolean> {
  if (!meta || meta.pendingReviewId === null) return false;

  try {
    const state = await deps.forge.getReview(ref, meta.pendingReviewId);
    if (state === "pending") return false;
    deps.log?.(`cycle: ${formatRef(ref)} draft review ${meta.pendingReviewId} is ${state}, clearing`);
    return true;
  } catch (error) {
    deps.log?.(`cycle: ${formatRef(ref)} pending review check failed: ${messageOf(error)}`);
    return false;
  }
}

/**
 * A PR the store knows that the Forge no longer lists as open.
 *
 * The state a close writes is `decide`'s to choose, and it is not always
 * `closed`: a skipped PR keeps `skipped` and only gets `closedAt` stamped, so
 * that a reopen can still read the sticky decision. Everything that hides
 * closed PRs from active views therefore has to test `closedAt`, never
 * `state === "closed"`.
 */
async function closeMissingPR(
  deps: CycleDeps,
  ref: PRRef,
  viewer: string,
  now: string
): Promise<boolean> {
  const meta = await loadMeta(deps.lgtmDir, ref);
  if (!meta || meta.closedAt !== null) return false;

  const decision = decide(meta, { pr: null, viewer, now });
  if (decision.action !== "close") return false;

  // A PR that closed while it waited its turn is not worth a Round.
  deps.queue.remove(ref);

  await saveMeta(deps.lgtmDir, ref, decision.patch);
  deps.log?.(`cycle: ${formatRef(ref)} closed`);
  emit(deps, { type: "pr-changed", ref });
  return true;
}

// ─── Dispatch: one whole Round ──────────────────────────────────────────────

export interface DispatchDeps {
  lgtmDir: string;
  /** Only what the diff snapshot needs. The Round itself never touches the Forge. */
  forge: SnapshotForge;
  events?: EventSink;
  /**
   * The Agent that runs this Round. A function is re-read per Round, so an
   * edited `agents/reviewer.md` changes behaviour without a restart (R3.2).
   * Defaults to the built-in reviewer.
   */
  agent?: AgentConfig | (() => AgentConfig | Promise<AgentConfig>);
  /** Seam for tests. Production uses the Provider runner. */
  review?: (input: ReviewInput) => Promise<ReviewOutcome>;
  /**
   * Absolute path to the Provider binary, from the daemon's login-shell probe
   * (R7.3). Read per Round so an ENOENT re-probe takes effect immediately.
   */
  binPath?: () => string | null;
  /** Injected clock, ISO 8601. */
  now?: () => string;
  log?: (line: string) => void;
}

export type DispatchStatus = "reviewed" | "failed" | "skipped";

export interface DispatchResult {
  status: DispatchStatus;
  /** Why nothing ran, when the status is `skipped`. */
  reason?: string;
  round?: number;
  findings?: number;
}

/**
 * Run one Round for one queue entry, and record everything it produced.
 *
 * Owns the whole Round: the Agent config, the Provider run, the round file
 * (a failed Round writes one too, with an empty findings array and its
 * `.raw.txt` beside it), the diff snapshot at the SHA the Round actually
 * reviewed, and the metadata that decides what the next cycle does with this
 * PR.
 *
 * `entry.headSha` is the SHA under review, and it is used everywhere the head
 * is needed. `meta.headSha` may already have moved on: a Round takes minutes
 * (spike-provider.md measured 5m44s) and the poll cycle keeps running. Taking
 * the head from the store here would file this Round's findings against a
 * commit nobody reviewed and would mislabel its diff snapshot.
 *
 * Never throws. The queue frees its slot either way, but a rejection would
 * leave `meta.md` reading `reviewing` until the next daemon restart.
 */
export async function dispatchReview(entry: QueueEntry, deps: DispatchDeps): Promise<DispatchResult> {
  const now = deps.now ?? (() => new Date().toISOString());
  const ref = entry.ref;
  const label = formatRef(ref);

  const meta = await loadMeta(deps.lgtmDir, ref);
  if (!meta) {
    deps.log?.(`review: ${label} has no meta.md, skipping`);
    return { status: "skipped", reason: "unknown PR" };
  }

  const skip = await guardRound(deps, ref, meta);
  if (skip) return skip;

  const agent = await resolveAgent(deps);
  if (!agent.enabled) {
    deps.log?.(`review: ${label} skipped, agent ${agent.name} is disabled`);
    return { status: "skipped", reason: "agent disabled" };
  }

  try {
    return await runRound(deps, entry, meta, agent, now);
  } catch (error) {
    const message = messageOf(error);
    deps.log?.(`review: ${label} round failed: ${message}`);
    emit(deps, { type: "error", cause: `review: ${message}` });

    // Whatever went wrong, this PR must not be left reading `reviewing`.
    try {
      await saveMeta(deps.lgtmDir, ref, {
        state: "failed",
        failedAttempts: meta.failedAttempts + 1,
      });
      emit(deps, { type: "pr-changed", ref });
    } catch {
      // The store is unwritable; the error event above is all we can offer.
    }

    return { status: "failed", reason: message };
  }
}

/** The queue's `DispatchFn`, bound to one set of dependencies. */
export function createDispatch(deps: DispatchDeps): (entry: QueueEntry) => Promise<void> {
  return async (entry) => {
    await dispatchReview(entry, deps);
  };
}

/**
 * Everything that can have changed between "enqueued" and "a slot came free".
 * A Round is minutes long and the queue may hold an entry for much longer, so
 * these are re-read from disk rather than trusted from the entry.
 */
async function guardRound(
  deps: DispatchDeps,
  ref: PRRef,
  meta: PRMeta
): Promise<DispatchResult | null> {
  const label = formatRef(ref);

  if (meta.closedAt !== null) {
    deps.log?.(`review: ${label} closed while queued, skipping`);
    return { status: "skipped", reason: "closed" };
  }

  if (meta.state === "skipped") {
    deps.log?.(`review: ${label} skipped by the user while queued`);
    return { status: "skipped", reason: "skipped" };
  }

  // R2.3, the second half of the draft hold. The cycle removes a reverted PR
  // from the queue, but it writes `meta.md` before it removes the entry, so
  // the queue can still hand this Round out in between. `manual` is the
  // "review anyway" override and runs.
  if (meta.draft && meta.classification !== "manual") {
    deps.log?.(`review: ${label} is back in draft, skipping`);
    if (meta.state === "queued") {
      await saveMeta(deps.lgtmDir, ref, { state: "triage" });
      emit(deps, { type: "pr-changed", ref });
    }
    return { status: "skipped", reason: "draft" };
  }

  return null;
}

async function resolveAgent(deps: DispatchDeps): Promise<AgentConfig> {
  if (!deps.agent) return defaultAgentConfig();
  return typeof deps.agent === "function" ? await deps.agent() : deps.agent;
}

async function runRound(
  deps: DispatchDeps,
  entry: QueueEntry,
  meta: PRMeta,
  agent: AgentConfig,
  now: () => string
): Promise<DispatchResult> {
  const ref = entry.ref;
  const label = formatRef(ref);
  const headSha = entry.headSha;

  const priorRounds = await loadAllRounds(deps.lgtmDir, ref);
  // Monotonic across failures, and across a hand-deleted `rounds` count:
  // whichever of the two knows about more rounds wins.
  const highest = priorRounds.reduce((max, round) => Math.max(max, round.round), 0);
  const roundNumber = Math.max(highest, meta.rounds) + 1;

  await saveMeta(deps.lgtmDir, ref, { state: "reviewing" });
  emit(deps, { type: "pr-changed", ref });

  const startedAt = now();
  const run = deps.review ?? runReview;
  const outcome = await run({
    agent,
    prUrl: meta.url || prUrl(ref),
    binPath: deps.binPath?.() ?? undefined,
    priorFindings: priorFindingsFrom(priorRounds),
  });

  // The round file lands before the snapshot on purpose: pruning inside
  // `snapshotRound` keeps only the SHAs some round file still references, so
  // a snapshot written before its round file would be deleted on the spot.
  await saveRound(deps.lgtmDir, {
    ref,
    round: roundNumber,
    agent: agent.name,
    provider: outcome.provider,
    headSha,
    status: outcome.status,
    startedAt,
    durationMs: outcome.durationMs,
    findings: outcome.findings,
    raw: outcome.status === "failed" ? failureTranscript(outcome) : undefined,
  });

  if (outcome.status === "ok") {
    // A failed Round gets no snapshot. It has no findings, so nothing will
    // ever slice a hunk out of one, and the fetch is not free.
    try {
      await snapshotRound(deps.lgtmDir, deps.forge, ref, headSha, {
        logger: { warn: (message) => deps.log?.(message) },
      });
    } catch (error) {
      // A missing snapshot is a handled state: finding cards fall back to a
      // GitHub link. Losing the Round over it would not be.
      deps.log?.(`review: ${label} snapshot failed: ${messageOf(error)}`);
    }

    await saveMeta(deps.lgtmDir, ref, {
      state: "reviewed",
      lastReviewedSha: headSha,
      rounds: roundNumber,
      failedAttempts: 0,
    });
    emit(deps, { type: "pr-changed", ref });

    deps.log?.(
      `review: ${label} round ${roundNumber} ok, ${outcome.findings.length} finding(s)` +
        (outcome.dropped > 0 ? `, ${outcome.dropped} dropped` : "")
    );

    if (outcome.findings.length > 0) emit(deps, { type: "findings-ready", ref });

    return { status: "reviewed", round: roundNumber, findings: outcome.findings.length };
  }

  // R3.5: a failed Round never marks the PR reviewed, and `lastReviewedSha`
  // stays where it was so the next cycle sees this SHA as still un-reviewed
  // and retries it up to the cap.
  await saveMeta(deps.lgtmDir, ref, {
    state: "failed",
    rounds: roundNumber,
    failedAttempts: meta.failedAttempts + 1,
  });
  emit(deps, { type: "pr-changed", ref });

  const reason = outcome.error ?? "the provider failed";
  deps.log?.(`review: ${label} round ${roundNumber} failed: ${reason}`);
  // The cause carries the reason and not the PR, so one broken CLI notifies
  // once rather than once per watched PR (R8.2).
  emit(deps, { type: "error", cause: `review: ${reason}` });

  return { status: "failed", reason, round: roundNumber };
}

/**
 * Prior Findings as do-not-repeat context (R3.6), keyed `r<N>:<agent>:<id>`
 * by the Provider so a repeat can be traced to the Round that raised it.
 *
 * Discarded Findings are included deliberately. A human discarding one said
 * "not worth my attention", and the strongest way to honour that is to keep
 * the next Round from raising it again.
 */
function priorFindingsFrom(rounds: Awaited<ReturnType<typeof loadAllRounds>>): PriorFinding[] {
  return rounds.flatMap((round) =>
    round.findings.map((finding) => ({
      key: { round: round.round, agent: round.agent, id: finding.id },
      file: finding.file,
      line: finding.line,
      severity: finding.severity,
      comment: finding.comment,
    }))
  );
}

/**
 * What a failed Round leaves in `r<N>-<agent>.raw.txt`.
 *
 * Always something. R3.4 wants unparseable output preserved rather than
 * surfacing as silently missing findings, and a Provider that printed nothing
 * at all (a missing binary, an instant crash) is the case where an empty file
 * would tell the user least.
 */
function failureTranscript(outcome: ReviewOutcome): string {
  const parts: string[] = [];
  if (outcome.error) parts.push(`[lgtm] ${outcome.error}`);
  if (outcome.raw.trim()) parts.push(outcome.raw);
  return parts.join("\n\n") || "[lgtm] the provider produced no output";
}

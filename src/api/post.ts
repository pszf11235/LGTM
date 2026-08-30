/**
 * The two routes that reach GitHub: `POST .../validate` and `POST .../post`.
 *
 * Everything else in LGTM reads the Forge or writes the local store. This
 * file is the only place that creates something on a code host, under the
 * user's own name, visible in their account's audit log. That is why the
 * order of the steps below is copied from design.md's "Posting flow" rather
 * than arranged for readability, and why several of them look redundant
 * until you know which bug they are standing on.
 *
 * The draft contract comes from ADR 0001. The create request is built by
 * `buildPendingReviewRequest`, whose body has exactly two keys and no
 * `event`, which is the only thing that keeps the review PENDING and private
 * to its author. There is no submit path here or anywhere else; the human
 * submits in GitHub's editor. The dry run shows the request produced by that
 * same builder, because a preview rendered by different code proves nothing
 * about what would be sent.
 *
 * Four things that are easy to get wrong, all of them load-bearing:
 *
 *  - A dry run writes nothing. Not to GitHub, not to `meta.md`, not to a
 *    round file. The old codebase shipped a dry run that wrote, and it is on
 *    the regression checklist because of it.
 *  - Recreating a draft flips that draft's `posted` findings back to `open`
 *    BEFORE clearing `pendingReviewId`. Their comments left GitHub with the
 *    deleted draft, so a finding left marked `posted` is a comment silently
 *    dropped from the recreated review, with nothing on screen to say so.
 *  - Findings are marked `posted` only after the create call came back
 *    PENDING. Marking first and posting second turns any network failure
 *    into permanently lost findings.
 *  - Findings are addressed by the full `r<N>:<agent>:<id>` key everywhere.
 *    Ids restart at f1 in each round file, so a bare id hits other rounds.
 *
 * Routes live in `apiRoutes()` in ./routes.ts, which is what puts them under
 * the single auth choke point and inside the route-matrix test. `postRoutes()`
 * at the bottom returns the two rows to splice in there; it exists because
 * this file may not edit that table itself, not because there is a second
 * way to register a route.
 */

import { formatFindingKey } from "@/core";
import type { DraftReview, Finding, ForgeAdapter, PRRef, Severity } from "@/core";
import { parseDiff } from "@/core/diff";
import { formatRef } from "@/core/pr-ref";
import {
  buildPendingReviewRequest,
  checkLines,
  formatCommentBody,
  formatReviewSummary,
  postPendingReview,
} from "@/forge/github/draft-review";
import type {
  PendingReviewInput,
  PendingReviewRequest,
  PostableFinding,
  ReviewComment,
} from "@/forge/github/draft-review";
import {
  loadMeta,
  markFindingsHeld,
  markFindingsOpen,
  markFindingsPosted,
  pendingFindings,
  postedFindings,
  prUrl,
  saveMeta,
} from "@/store/reviews";
import { loadTemplate, renderTemplate } from "@/store/templates";
import type { DaemonEvent } from "@/daemon/events";
import type { ApiDeps, RouteDef, RouteHandler } from "./routes";

// ─── Results ────────────────────────────────────────────────────────────────

/** One finding's answer to "would GitHub accept a comment here right now?". */
export interface FindingVerdict {
  /** The canonical key, `r2:reviewer:f1`. Never a bare id (R9.3). */
  key: string;
  round: number;
  agent: string;
  id: string;
  file: string;
  line: number;
  severity: Severity;
  /** The finding's state on disk when the check ran, before this post changes it. */
  state: Finding["state"];
  postable: boolean;
  /** Why it cannot attach. Null when it can. */
  reason: string | null;
}

export interface ValidationReport {
  ref: PRRef;
  /** `acme/api#42`, the rendering the CLI and the logs use. */
  key: string;
  url: string;
  /** What the store thinks is open on GitHub. Read, never checked, by validate. */
  pendingReviewId: number | null;
  findings: FindingVerdict[];
  counts: { checked: number; postable: number; held: number };
}

export type ValidateResult =
  | { status: "ok"; report: ValidationReport }
  | { status: "unknown-pr" }
  | { status: "no-forge" };

export interface PostedReport {
  ref: PRRef;
  key: string;
  url: string;
  reviewId: number;
  /** Where the human goes to edit and submit it. */
  reviewUrl: string;
  body: string;
  commentCount: number;
  posted: FindingVerdict[];
  held: FindingVerdict[];
  /** The draft this post replaced, and the findings that came back with it. */
  recreated: { deletedReviewId: number; reopened: string[] } | null;
  /** A recorded draft that GitHub no longer holds pending, cleared on the way through. */
  clearedReviewId: number | null;
}

export interface DryRunReport {
  ref: PRRef;
  key: string;
  url: string;
  /** The exact request, minus the GitHub token. Nothing was sent. */
  request: PendingReviewRequest;
  body: string;
  postable: FindingVerdict[];
  held: FindingVerdict[];
  counts: { checked: number; postable: number; held: number };
  /** Read from the store. A dry run never asks GitHub about it. */
  pendingReviewId: number | null;
}

export type PostResult =
  | { status: "posted"; report: PostedReport }
  | { status: "dry-run"; report: DryRunReport }
  /** A draft is still pending on GitHub. Submit it there, or pass recreate. */
  | { status: "pending-review-exists"; pendingReviewId: number; reviewUrl: string }
  /** Nothing validated. No GitHub call was made, so there is no body-only review. */
  | { status: "nothing-to-post"; held: FindingVerdict[]; checked: number }
  | { status: "unknown-pr" }
  | { status: "no-forge" }
  | { status: "no-token" };

export interface PostOptions {
  /** The inline-edited review body from the confirm pane. Used verbatim, empty included. */
  body?: string;
  recreate?: boolean;
  dryRun?: boolean;
}

// ─── Shared machinery ───────────────────────────────────────────────────────

function keyOf(finding: { round: number; agent: string; id: string }): string {
  return formatFindingKey({ round: finding.round, agent: finding.agent, id: finding.id });
}

function verdictFor(finding: PostableFinding, reason: string | null): FindingVerdict {
  return {
    key: keyOf(finding),
    round: finding.round,
    agent: finding.agent,
    id: finding.id,
    file: finding.file,
    line: finding.line,
    severity: finding.severity,
    state: finding.state,
    postable: reason === null,
    reason,
  };
}

interface DiffCheck {
  postable: PostableFinding[];
  held: Array<{ finding: PostableFinding; reason: string }>;
  /** Every checked finding in store order, postable or not. */
  verdicts: FindingVerdict[];
}

/**
 * Steps 2 and 3 of the posting flow, shared by validate, dry run, and post.
 *
 * `pendingFindings` returns `open` and `held` findings both. Including the
 * held ones is not tidiness: a finding is held because its line was missing
 * from the diff at the last post, and a later commit can put that line back.
 * Re-checking held findings here is the only way one is ever posted (R6.3).
 *
 * The diff is the PR's current one, fetched now, never a stored
 * `diff-<sha>.patch`. The snapshot is what a round reviewed; GitHub validates
 * comments against the head the PR has at this moment, and one comment on a
 * line that has since moved fails the entire create call rather than just
 * that comment.
 */
async function checkAgainstCurrentDiff(
  deps: ApiDeps,
  forge: ForgeAdapter,
  ref: PRRef
): Promise<DiffCheck> {
  const pending = await pendingFindings(deps.lgtmDir, ref);
  const diff = parseDiff(await forge.getDiff(ref));

  const { postable, held } = checkLines(pending, diff);
  const reasons = new Map(held.map((entry) => [keyOf(entry.finding), entry.reason]));

  return {
    postable,
    held,
    verdicts: pending.map((finding) => verdictFor(finding, reasons.get(keyOf(finding)) ?? null)),
  };
}

function severityCounts(findings: PostableFinding[]): Record<Severity, number> {
  const counts: Record<Severity, number> = { critical: 0, high: 0, medium: 0, low: 0 };
  for (const finding of findings) counts[finding.severity] += 1;
  return counts;
}

/**
 * Step 5. Render `templates/review-body.md` over the check's results.
 *
 * A template that cannot be read or rendered falls back to the built-in
 * summary rather than failing the post. The template is a hand-editable file
 * in the store, and a typo in it must not be able to hold the gate shut.
 */
async function renderBody(deps: ApiDeps, ref: PRRef, check: DiffCheck): Promise<string> {
  try {
    const template = await loadTemplate(deps.lgtmDir);
    return renderTemplate(template, {
      counts: severityCounts(check.postable),
      agents: [...new Set(check.postable.map((finding) => finding.agent))].sort(),
      held: check.held,
    });
  } catch {
    const round = check.postable.reduce((highest, finding) => Math.max(highest, finding.round), 0);
    return formatReviewSummary({
      ref,
      round,
      commentCount: check.postable.length,
      heldCount: check.held.length,
    });
  }
}

function commentsFor(findings: PostableFinding[]): ReviewComment[] {
  return findings.map((finding) => ({
    path: finding.file,
    line: finding.line,
    body: formatCommentBody(finding),
  }));
}

/**
 * The dry run hands its request to a browser. The Authorization header holds
 * the GitHub token, which never leaves the daemon (R7.2), so the preview
 * carries a placeholder in its place. Everything a reviewer of the preview
 * cares about, the URL, the method, and every byte of the body, is the real
 * thing.
 */
function withoutToken(request: PendingReviewRequest): PendingReviewRequest {
  return { ...request, headers: { ...request.headers, Authorization: "Bearer <redacted>" } };
}

function heldEntries(check: DiffCheck): Array<{ key: string; reason: string }> {
  return check.held.map((entry) => ({ key: keyOf(entry.finding), reason: entry.reason }));
}

function heldVerdicts(check: DiffCheck): FindingVerdict[] {
  return check.verdicts.filter((verdict) => !verdict.postable);
}

function postableVerdicts(check: DiffCheck): FindingVerdict[] {
  return check.verdicts.filter((verdict) => verdict.postable);
}

function emit(deps: ApiDeps, event: DaemonEvent): void {
  try {
    deps.events?.emit(event);
  } catch {
    // A subscriber that throws is a notifier problem, never a failed post.
  }
}

/** GitHub's own review editor, which is where a draft is read and submitted. */
function reviewUrlFor(ref: PRRef): string {
  return `${prUrl(ref)}/files`;
}

// ─── validate ───────────────────────────────────────────────────────────────

/**
 * The dry run behind the confirm pane's held-back list.
 *
 * Re-fetches the diff and answers per finding. It writes nothing, to GitHub
 * or to the store: a finding's state is the human's to change, and a preview
 * that flipped findings to `held` would mean opening a pane changed the gate.
 * The real post does that marking, once it knows what it actually sent.
 */
export async function runValidate(deps: ApiDeps, ref: PRRef): Promise<ValidateResult> {
  const forge = deps.forge;
  if (!forge) return { status: "no-forge" };

  const meta = await loadMeta(deps.lgtmDir, ref);
  if (!meta) return { status: "unknown-pr" };

  const check = await checkAgainstCurrentDiff(deps, forge, ref);

  return {
    status: "ok",
    report: {
      ref,
      key: formatRef(ref),
      url: meta.url || prUrl(ref),
      pendingReviewId: meta.pendingReviewId,
      findings: check.verdicts,
      counts: {
        checked: check.verdicts.length,
        postable: check.postable.length,
        held: check.held.length,
      },
    },
  };
}

// ─── post ───────────────────────────────────────────────────────────────────

/**
 * design.md's posting flow, in its order.
 *
 * Throws only what the Forge throws. Every refusal the flow itself decides on
 * comes back as a status, so the caller can tell "GitHub is down" from "this
 * PR already has a draft".
 */
export async function runPost(
  deps: ApiDeps,
  ref: PRRef,
  options: PostOptions = {}
): Promise<PostResult> {
  const forge = deps.forge;
  if (!forge) return { status: "no-forge" };

  const meta = await loadMeta(deps.lgtmDir, ref);
  if (!meta) return { status: "unknown-pr" };

  const token = deps.githubToken?.() ?? null;
  // Needed even by a dry run: the preview is the real request, and building
  // it needs the header that a token goes into. Refusing here is honest about
  // the fact that nothing could have been posted anyway.
  if (!token) return { status: "no-token" };

  const dryRun = options.dryRun === true;

  // ── 1. The existing draft ────────────────────────────────────────────────
  // Skipped entirely by a dry run. Every branch of this step writes, either
  // to GitHub or to the store, and step 7 says a dry run writes nothing. The
  // dry run reports the recorded id instead and lets the confirm pane say so.
  let recreated: PostedReport["recreated"] = null;
  let clearedReviewId: number | null = null;

  if (!dryRun && meta.pendingReviewId !== null) {
    const existing = meta.pendingReviewId;
    const state = await forge.getReview(ref, existing);

    if (state === "pending" && options.recreate !== true) {
      // One pending review per PR (R6.5). The REST API cannot append to a
      // pending review, so posting over it would either fail or, worse,
      // create a second draft alongside the first.
      return { status: "pending-review-exists", pendingReviewId: existing, reviewUrl: reviewUrlFor(ref) };
    }

    if (state === "pending") {
      // Recreate. Deleting first means a failure here leaves the store
      // describing GitHub accurately: the draft is still there, still
      // recorded, and the user can try again.
      await forge.deleteDraftReview(ref, existing);

      // The deleted draft took its comments with it, so the findings behind
      // them are no longer on GitHub. Reopening them BEFORE clearing the
      // recorded id is deliberate. Interrupted after the flip, the next post
      // refuses and asks for a recreate again, which is recoverable and
      // loud. Interrupted after clearing the id instead, the findings would
      // stay marked `posted` forever and quietly vanish from every later
      // review, which is the failure this ordering exists to avoid.
      const posted = await postedFindings(deps.lgtmDir, ref);
      const reopened = await markFindingsOpen(deps.lgtmDir, ref, posted.map(keyOf));
      await saveMeta(deps.lgtmDir, ref, { pendingReviewId: null });

      recreated = { deletedReviewId: existing, reopened };
    } else {
      // Submitted or deleted in GitHub's UI. The record is stale, not a
      // conflict; clearing it is what stops LGTM refusing this PR forever
      // (R6.5).
      await saveMeta(deps.lgtmDir, ref, { pendingReviewId: null });
      clearedReviewId = existing;
    }

    emit(deps, { type: "pr-changed", ref });
  }

  // ── 2 and 3. The current diff, and every open or held finding against it ──
  const check = await checkAgainstCurrentDiff(deps, forge, ref);

  // ── 4. Nothing to say ────────────────────────────────────────────────────
  if (check.postable.length === 0) {
    // Before any create call, so a PR whose findings all missed never gets a
    // body-only review announcing that LGTM had nothing to add (R6.3).
    if (!dryRun && check.held.length > 0) {
      await markFindingsHeld(deps.lgtmDir, ref, heldEntries(check));
      emit(deps, { type: "pr-changed", ref });
    }

    return { status: "nothing-to-post", held: heldVerdicts(check), checked: check.verdicts.length };
  }

  // ── 5. The body ──────────────────────────────────────────────────────────
  // An edited body is used exactly as given, including an empty one. The
  // confirm pane is the last human step, and second-guessing it there would
  // make the preview a different thing from what gets sent.
  const body = typeof options.body === "string" ? options.body : await renderBody(deps, ref, check);

  const review: DraftReview = { body, comments: commentsFor(check.postable) };
  const input: PendingReviewInput = { ref, token, review };

  // ── 7. The dry run stops here, having written nothing ────────────────────
  if (dryRun) {
    return {
      status: "dry-run",
      report: {
        ref,
        key: formatRef(ref),
        url: meta.url || prUrl(ref),
        request: withoutToken(buildPendingReviewRequest(input)),
        body,
        postable: postableVerdicts(check),
        held: heldVerdicts(check),
        counts: {
          checked: check.verdicts.length,
          postable: check.postable.length,
          held: check.held.length,
        },
        pendingReviewId: meta.pendingReviewId,
      },
    };
  }

  // ── 6. One create call, no event key ─────────────────────────────────────
  // `postPendingReview` throws unless GitHub answers PENDING, so anything
  // that reaches the next line is a draft only its author can see (ADR 0001).
  // Nothing below this point runs on a failure, which is what keeps a
  // half-failed post from marking findings posted.
  const created = await postPendingReview(input);

  // The id first. Interrupted between these two writes, LGTM knows a draft
  // exists and refuses the next post instead of creating a second one; the
  // findings it did not get to mark stay `open` and post again on the retry.
  await saveMeta(deps.lgtmDir, ref, { pendingReviewId: created.reviewId });
  await markFindingsPosted(deps.lgtmDir, ref, check.postable.map(keyOf));
  if (check.held.length > 0) {
    await markFindingsHeld(deps.lgtmDir, ref, heldEntries(check));
  }

  emit(deps, { type: "pr-changed", ref });

  return {
    status: "posted",
    report: {
      ref,
      key: formatRef(ref),
      url: meta.url || prUrl(ref),
      reviewId: created.reviewId,
      reviewUrl: created.url,
      body,
      commentCount: created.commentCount,
      posted: postableVerdicts(check),
      held: heldVerdicts(check),
      recreated,
      clearedReviewId,
    },
  };
}

// ─── HTTP ───────────────────────────────────────────────────────────────────
//
// These four helpers mirror the ones in ./routes.ts, which does not export
// them. Same JSON shape, same headers, same ref rules, so both files answer
// a bad ref or a bad body identically.

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body) + "\n", {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
}

function fail(status: number, error: string, message: string): Response {
  return json({ error, message }, status);
}

/** GitHub's own naming rules, tight enough that a path segment cannot smuggle a traversal. */
const REPO_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function parseRef(params: Record<string, string>): PRRef | null {
  const owner = params.owner ?? "";
  const repo = params.repo ?? "";
  const raw = params.number ?? "";

  if (!REPO_SEGMENT.test(owner) || !REPO_SEGMENT.test(repo)) return null;
  if (!/^\d+$/.test(raw)) return null;

  const number = Number(raw);
  if (!Number.isSafeInteger(number) || number <= 0) return null;

  return { owner, repo, number };
}

async function readJsonBody(req: Request): Promise<Record<string, unknown> | null> {
  let raw: string;
  try {
    raw = await req.text();
  } catch {
    return null;
  }
  if (raw.trim() === "") return {};

  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

function forgeFailure(error: unknown): Response {
  // 502, not 500. The daemon is fine; the code host answered badly or not at
  // all, and the message is GitHub's own so the user can act on it.
  const message = error instanceof Error ? error.message : String(error);
  return fail(502, "forge-error", message);
}

export const validateHandler: RouteHandler = async ({ params, deps }) => {
  const ref = parseRef(params);
  if (!ref) return fail(400, "bad-ref", "owner, repo and number must name one pull request");

  let result: ValidateResult;
  try {
    result = await runValidate(deps, ref);
  } catch (error) {
    return forgeFailure(error);
  }

  switch (result.status) {
    case "unknown-pr":
      return fail(404, "unknown-pr", `${formatRef(ref)} is not in the store`);
    case "no-forge":
      return fail(503, "no-forge", "the daemon has no Forge adapter, so it cannot read the diff");
    case "ok":
      return json(result.report);
  }
};

export const postHandler: RouteHandler = async ({ req, params, deps }) => {
  const ref = parseRef(params);
  if (!ref) return fail(400, "bad-ref", "owner, repo and number must name one pull request");

  const body = await readJsonBody(req);
  if (!body) return fail(400, "bad-body", "expected a JSON object");

  if (body.body !== undefined && typeof body.body !== "string") {
    return fail(400, "bad-body", "body must be a string");
  }
  if (body.recreate !== undefined && typeof body.recreate !== "boolean") {
    return fail(400, "bad-body", "recreate must be a boolean");
  }
  if (body.dryRun !== undefined && typeof body.dryRun !== "boolean") {
    return fail(400, "bad-body", "dryRun must be a boolean");
  }

  const options: PostOptions = {
    ...(typeof body.body === "string" ? { body: body.body } : {}),
    ...(body.recreate === true ? { recreate: true } : {}),
    ...(body.dryRun === true ? { dryRun: true } : {}),
  };

  let result: PostResult;
  try {
    result = await runPost(deps, ref, options);
  } catch (error) {
    return forgeFailure(error);
  }

  switch (result.status) {
    case "unknown-pr":
      return fail(404, "unknown-pr", `${formatRef(ref)} is not in the store`);

    case "no-forge":
      return fail(503, "no-forge", "the daemon has no Forge adapter, so it cannot post");

    case "no-token":
      return fail(
        503,
        "no-github-token",
        "no GitHub token resolved. Set GITHUB_TOKEN, run `gh auth login`, or save one in ~/.lgtm-farm/credentials.json."
      );

    case "pending-review-exists":
      return json(
        {
          error: "pending-review-exists",
          message:
            `${formatRef(ref)} already has a pending draft review. ` +
            "Submit or delete it on GitHub, or post again with recreate to replace it.",
          pendingReviewId: result.pendingReviewId,
          reviewUrl: result.reviewUrl,
        },
        409
      );

    case "nothing-to-post":
      return json(
        {
          error: "nothing-to-post",
          message: abortMessage(result.checked),
          checked: result.checked,
          held: result.held,
        },
        409
      );

    case "dry-run":
      return json({ dryRun: true, ...result.report });

    case "posted":
      return json({ dryRun: false, ...result.report });
  }
};

/** Why the post stopped without calling GitHub. */
function abortMessage(checked: number): string {
  if (checked === 0) return "No findings are waiting at the gate, so there was nothing to post.";
  return (
    `${checked} finding(s) were checked and none of their lines are in the current diff, ` +
    "so nothing was sent to GitHub. They stay held and are retried at the next post."
  );
}

/**
 * design.md's last two API rows, ready to splice into `apiRoutes()`.
 *
 * Both are `bearer: true, mutating: true`. Validate is a read in spirit, but
 * it is a POST, and the auth matrix ties `mutating` to the method exactly, so
 * declaring anything else here would be declaring an exemption from the
 * Origin check.
 */
export function postRoutes(): RouteDef[] {
  return [
    {
      method: "POST",
      path: "/api/prs/:owner/:repo/:number/validate",
      name: "prs.validate",
      bearer: true,
      mutating: true,
      queryToken: false,
      handler: validateHandler,
    },
    {
      method: "POST",
      path: "/api/prs/:owner/:repo/:number/post",
      name: "prs.post",
      bearer: true,
      mutating: true,
      queryToken: false,
      handler: postHandler,
    },
  ];
}

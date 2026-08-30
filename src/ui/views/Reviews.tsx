/**
 * Reviews: every PR the store knows about, filtered by state and by
 * whether it is done (design.md, "Web UI"; requirements R2.4, R2.5, R5.1).
 *
 * This used to be the Inbox, which hid anything closed and dropped a PR
 * the moment it had nothing left to gate — a reviewed PR with zero findings
 * simply never appeared, so "reviewed, clean" and "never reviewed" looked
 * identical: nothing. The status filter bar fixes that by giving "reviewed"
 * its own bucket, rendered whether or not it carries findings (see
 * `ReviewedRow`'s "Reviewed, clean" badge), and the "all" option puts every
 * state on screen at once rather than only the ones the old Inbox chose to
 * show.
 *
 * Two filters, deliberately independent:
 *
 *  - Status maps straight onto the daemon's `state` query param, except for
 *    "ready to gate", which asks for `withFindings` instead: a PR can carry
 *    ungated findings from an earlier round while a fresh one is in flight,
 *    so that bucket cuts across every state rather than naming one
 *    (design.md, "Poll cycle"). `filterToQuery` is the one place this
 *    mapping happens, and it is exported so the query it builds can be
 *    asserted directly rather than inferred from what renders.
 *  - Completed is its own toggle onto `closed`, because closed is
 *    orthogonal to state: a PR that closes while skipped keeps
 *    `state: "skipped"`, and one that closes any other way has its state
 *    overwritten to `"closed"` (see `decide` in @/core/classify). That is
 *    exactly why closed PRs are never hidden by `state` here either — the
 *    hard rule is `closedAt !== null`, and the daemon enforces the same
 *    rule on the other end of this query.
 *
 * Both filters go to the server; nothing here re-filters a fetched list to
 * decide what is on screen. The filter bar's own count badges are the one
 * client-side tally, and they read an "all states, current closed setting"
 * request made for that purpose, never the request that decided which rows
 * to render.
 *
 * The decision buttons go through `@/ui/actions`. None of them updates a
 * row by hand afterwards: the decision endpoint emits `pr-changed`, and the
 * SSE subscription behind `usePRList` refetches, so a row moves between
 * buckets from the store's own answer rather than from an optimistic guess
 * this file would have to keep in step. What a button does own is its
 * in-flight state and its failure message, which is why one PR failing
 * never blanks the list.
 *
 * The rows are exported for the same reason BackfillPane exports its
 * mapping helpers: `renderToStaticMarkup` never runs effects, so a row
 * rendered through `Reviews` is always the loading placeholder and its
 * buttons can never be asserted on.
 */
import { GitPullRequest } from "lucide-react";
import { useState, type ReactNode } from "react";
import type { Classification, PRRef, PRState } from "@/core";
import {
  REAUTH_MESSAGE,
  SEVERITY_ORDER,
  totalFindings,
  type CheckState,
  type FindingCounts,
  type PRDecisionAction,
  type PRListFilter,
  type PRListItem,
} from "@/ui/api";
import { getDefaultGateActions, type GateActions } from "@/ui/actions";
import { useConnectionStatus, useStatus, usePRList, type ConnectionStatus } from "@/ui/hooks";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export interface ReviewsProps {
  /** Jump to a PR's finding cards. Absent means the caller has not wired navigation yet. */
  onOpenPR?: (ref: PRRef) => void;
  /** Injected by tests. The views share one instance otherwise. */
  actions?: GateActions;
}

function prRefOf(item: PRListItem): PRRef {
  return { owner: item.owner, repo: item.repo, number: item.number };
}

// ─── Filters ────────────────────────────────────────────────────────────────

export type StatusFilter =
  | "all"
  | "triage"
  | "in-review"
  | "ready-to-gate"
  | "reviewed"
  | "failed"
  | "skipped";

export type ClosedFilter = "exclude" | "include" | "only";

export const STATUS_FILTERS: ReadonlyArray<{ id: StatusFilter; label: string }> = [
  { id: "all", label: "All" },
  { id: "triage", label: "Triage" },
  { id: "in-review", label: "In review" },
  { id: "ready-to-gate", label: "Ready to gate" },
  { id: "reviewed", label: "Reviewed" },
  { id: "failed", label: "Failed" },
  { id: "skipped", label: "Skipped" },
];

export const CLOSED_FILTERS: ReadonlyArray<{ id: ClosedFilter; label: string }> = [
  { id: "exclude", label: "Open" },
  { id: "include", label: "All" },
  { id: "only", label: "Completed" },
];

const IN_REVIEW_STATES: readonly PRState[] = ["queued", "reviewing"];

/**
 * The one place a filter selection becomes a `/api/prs` query (design.md,
 * "HTTP API", `state`/`closed`/`withFindings`). Every option maps to a
 * server parameter, never to a client-side re-filter of an already-fetched
 * list, which is what let the old Inbox's bucketing drift from what the
 * server actually knows.
 */
export function filterToQuery(status: StatusFilter, closed: ClosedFilter): PRListFilter {
  const base: PRListFilter = { closed };
  switch (status) {
    case "all":
      return base;
    case "triage":
      return { ...base, state: "triage" };
    case "in-review":
      return { ...base, state: [...IN_REVIEW_STATES] };
    case "ready-to-gate":
      return { ...base, withFindings: true };
    case "reviewed":
      return { ...base, state: "reviewed" };
    case "failed":
      return { ...base, state: "failed" };
    case "skipped":
      return { ...base, state: "skipped" };
  }
}

function isDefaultView(status: StatusFilter, closed: ClosedFilter): boolean {
  return status === "all" && closed === "exclude";
}

/**
 * Badge counts for the filter bar. Reads the "all states, current closed
 * setting" list that is fetched for exactly this purpose (see `Reviews`
 * below) — it never touches the list that decides what actually renders.
 */
function countFor(rows: readonly PRListItem[], status: StatusFilter): number {
  switch (status) {
    case "all":
      return rows.length;
    case "triage":
      return rows.filter((pr) => pr.state === "triage").length;
    case "in-review":
      return rows.filter((pr) => IN_REVIEW_STATES.includes(pr.state)).length;
    case "ready-to-gate":
      return rows.filter((pr) => totalFindings(pr.findingCounts) > 0).length;
    case "reviewed":
      return rows.filter((pr) => pr.state === "reviewed").length;
    case "failed":
      return rows.filter((pr) => pr.state === "failed").length;
    case "skipped":
      return rows.filter((pr) => pr.state === "skipped").length;
  }
}

function StatusFilterBar({
  status,
  counts,
  onChange,
}: {
  status: StatusFilter;
  /** Null while the counts request is still loading — buttons render without a number rather than a misleading zero. */
  counts: readonly PRListItem[] | null;
  onChange: (status: StatusFilter) => void;
}) {
  return (
    <div className="flex flex-wrap gap-1.5" role="group" aria-label="Filter by status">
      {STATUS_FILTERS.map(({ id, label }) => (
        <Button
          key={id}
          size="sm"
          variant={status === id ? "secondary" : "ghost"}
          aria-pressed={status === id}
          data-testid={`status-filter-${id}`}
          onClick={() => onChange(id)}
        >
          {label}
          <span className="text-muted-foreground">{counts ? countFor(counts, id) : "…"}</span>
        </Button>
      ))}
    </div>
  );
}

function ClosedFilterBar({ closed, onChange }: { closed: ClosedFilter; onChange: (closed: ClosedFilter) => void }) {
  return (
    <div className="flex items-center gap-1.5 text-xs text-muted-foreground" role="group" aria-label="Completed work">
      <span>Completed:</span>
      {CLOSED_FILTERS.map(({ id, label }) => (
        <Button
          key={id}
          size="sm"
          variant={closed === id ? "secondary" : "ghost"}
          aria-pressed={closed === id}
          data-testid={`closed-filter-${id}`}
          onClick={() => onChange(id)}
        >
          {label}
        </Button>
      ))}
    </div>
  );
}

// ─── Small formatters ───────────────────────────────────────────────────────

function formatAge(iso: string | null): string {
  if (!iso) return "—";
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return "—";
  const hours = Math.floor(ms / (60 * 60 * 1000));
  if (hours < 1) return "just now";
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

function formatMergeable(mergeable: boolean | null): { label: string; tone: string } {
  if (mergeable === null) return { label: "Computing…", tone: "text-muted-foreground" };
  return mergeable ? { label: "Mergeable", tone: "text-green-700 dark:text-green-400" } : { label: "Conflicts", tone: "text-destructive" };
}

const CHECK_LABEL: Record<CheckState, { label: string; tone: string }> = {
  success: { label: "Checks passing", tone: "text-green-700 dark:text-green-400" },
  failure: { label: "Checks failing", tone: "text-destructive" },
  pending: { label: "Checks running", tone: "text-yellow-700 dark:text-yellow-400" },
  none: { label: "No checks", tone: "text-muted-foreground" },
};

function formatCheckStatus(status: CheckState | null): { label: string; tone: string } {
  return status ? CHECK_LABEL[status] : { label: "—", tone: "text-muted-foreground" };
}

const CLASSIFICATION_LABEL: Partial<Record<Classification, string>> = {
  own: "Yours",
  requested: "Requested",
  assigned: "Assigned",
  mentioned: "Mentioned",
};

function ClassificationTag({ classification }: { classification: Classification }) {
  const label = CLASSIFICATION_LABEL[classification];
  if (!label) return null;
  return <span className="rounded-full border bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">{label}</span>;
}

function SeverityCounts({ counts }: { counts: FindingCounts }) {
  return (
    <div className="flex gap-1.5">
      {SEVERITY_ORDER.filter((sev) => counts[sev] > 0).map((sev) => (
        <span key={sev} className="rounded-full border bg-muted px-1.5 py-0.5 text-[11px] font-medium">
          {counts[sev]} {sev}
        </span>
      ))}
    </div>
  );
}

// ─── Rows ───────────────────────────────────────────────────────────────────

function PRMetaLine({ pr }: { pr: PRListItem }) {
  const mergeable = formatMergeable(pr.mergeable);
  const checks = formatCheckStatus(pr.checkStatus);
  const changes =
    pr.additions === null && pr.deletions === null
      ? "—"
      : `+${pr.additions ?? 0} -${pr.deletions ?? 0}${pr.changedFiles !== null ? ` · ${pr.changedFiles} files` : ""}`;

  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
      <span>@{pr.author}</span>
      <span>{changes}</span>
      <span>{formatAge(pr.createdAt)} old</span>
      <span className={mergeable.tone}>{mergeable.label}</span>
      <span className={checks.tone}>{checks.label}</span>
    </div>
  );
}

interface DecisionHandle {
  /** The action currently in flight, if any. */
  pending: PRDecisionAction | null;
  error: string | null;
  run: (ref: PRRef, action: PRDecisionAction) => void;
}

/**
 * One row's decision state. The `pending` guard, plus the disabled buttons
 * it drives, is what stops a second click sending a second decision while
 * the first is still open.
 */
function useDecision(actions?: GateActions): DecisionHandle {
  const [pending, setPending] = useState<PRDecisionAction | null>(null);
  const [error, setError] = useState<string | null>(null);

  return {
    pending,
    error,
    run(ref, action) {
      if (pending !== null) return;
      setPending(action);
      setError(null);

      void (actions ?? getDefaultGateActions()).decide(ref, action).then(
        (result) => {
          setPending(null);
          setError(result.status === "error" ? result.error.message : null);
        },
        (err: unknown) => {
          // `decide` reports failure in its result and does not reject, so
          // this is a bug one layer down. Showing it beats a click that
          // silently does nothing.
          setPending(null);
          setError(err instanceof Error ? err.message : String(err));
        },
      );
    },
  };
}

export function TriageRow({ pr, actions }: { pr: PRListItem; actions?: GateActions }) {
  const decision = useDecision(actions);
  const ref = prRefOf(pr);
  const busy = decision.pending !== null;

  return (
    <div className="border-b py-3 last:border-b-0" data-testid="triage-row">
      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex items-center gap-2">
            <a href={pr.url} target="_blank" rel="noreferrer" className="truncate text-sm font-medium hover:underline">
              {pr.title}
            </a>
            <ClassificationTag classification={pr.classification} />
          </div>
          <PRMetaLine pr={pr} />
        </div>
        <div className="flex shrink-0 gap-2">
          <Button
            variant="outline"
            size="sm"
            data-testid="skip-pr"
            disabled={busy}
            onClick={() => decision.run(ref, "skip")}
          >
            {decision.pending === "skip" ? "Skipping…" : "Skip"}
          </Button>
          {/* Both buttons exist only on a draft, where they differ: `review`
              records the approval and lets the PR queue itself when it
              leaves draft state, `review-anyway` is R2.3's override and
              queues it now. On a ready PR the two are the same call. */}
          <Button
            size="sm"
            data-testid="review-pr"
            disabled={busy}
            title={pr.draft ? "Queue it as soon as it leaves draft" : undefined}
            onClick={() => decision.run(ref, "review")}
          >
            {decision.pending === "review" ? "Queueing…" : "Review"}
          </Button>
          {pr.draft && (
            <Button
              size="sm"
              variant="secondary"
              data-testid="review-anyway-pr"
              disabled={busy}
              title="Queue this draft now"
              onClick={() => decision.run(ref, "review-anyway")}
            >
              {decision.pending === "review-anyway" ? "Queueing…" : "Review anyway"}
            </Button>
          )}
        </div>
      </div>
      {decision.error && <p className="mt-1 text-xs text-destructive">{decision.error}</p>}
    </div>
  );
}

/** What the daemon is doing with this PR right now, in the user's words. */
function reviewStateLabel(pr: PRListItem): string {
  if (pr.state === "reviewing") return "reviewing now";
  if (pr.state === "queued") return "waiting for a slot";
  return pr.failedAttempts >= 3 ? "failed, no retries left" : "failed, will retry";
}

function InReviewRow({ pr, onOpenPR }: { pr: PRListItem; onOpenPR?: (ref: PRRef) => void }) {
  const stuck = pr.state === "failed" && pr.failedAttempts >= 3;
  const hasFindings = totalFindings(pr.findingCounts) > 0;

  return (
    <div className="flex items-center justify-between gap-4 border-b py-3 last:border-b-0" data-testid="in-review-row">
      <div className="min-w-0 flex-1 space-y-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-sm font-medium">{pr.title}</span>
          <ClassificationTag classification={pr.classification} />
        </div>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <span className="text-xs text-muted-foreground">@{pr.author}</span>
          <span className={stuck ? "text-xs font-medium text-destructive" : "text-xs text-muted-foreground"}>
            {reviewStateLabel(pr)}
          </span>
          {/* An earlier round's findings are still gateable while a new one runs. */}
          {hasFindings && <SeverityCounts counts={pr.findingCounts} />}
        </div>
      </div>
      {hasFindings && (
        <Button size="sm" variant="secondary" onClick={() => onOpenPR?.(prRefOf(pr))} className="shrink-0">
          View findings
        </Button>
      )}
    </div>
  );
}

/**
 * A round completed at the current head SHA. The badge is the whole point
 * of this task: zero findings renders as "Reviewed, clean", not as an
 * absent row, so a clean review and a PR nobody has looked at yet no
 * longer look the same (nothing).
 */
function ReviewedRow({ pr, onOpenPR }: { pr: PRListItem; onOpenPR?: (ref: PRRef) => void }) {
  const hasFindings = totalFindings(pr.findingCounts) > 0;

  return (
    <div className="flex items-center justify-between gap-4 border-b py-3 last:border-b-0" data-testid="reviewed-row">
      <div className="min-w-0 flex-1 space-y-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-sm font-medium">{pr.title}</span>
          <ClassificationTag classification={pr.classification} />
        </div>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <span className="text-xs text-muted-foreground">@{pr.author}</span>
          {hasFindings ? (
            <SeverityCounts counts={pr.findingCounts} />
          ) : (
            <span
              data-testid="reviewed-clean"
              className="rounded-full border bg-muted px-1.5 py-0.5 text-[11px] font-medium text-green-700 dark:text-green-400"
            >
              Reviewed, clean
            </span>
          )}
        </div>
      </div>
      {hasFindings && (
        <Button size="sm" variant="secondary" onClick={() => onOpenPR?.(prRefOf(pr))} className="shrink-0">
          View findings
        </Button>
      )}
    </div>
  );
}

/** Only reachable with the completed toggle set to include or only closed PRs. */
function ClosedRow({ pr, onOpenPR }: { pr: PRListItem; onOpenPR?: (ref: PRRef) => void }) {
  const hasFindings = totalFindings(pr.findingCounts) > 0;

  return (
    <div className="flex items-center justify-between gap-4 border-b py-3 opacity-70 last:border-b-0" data-testid="closed-row">
      <div className="min-w-0 flex-1 space-y-1">
        <div className="flex items-center gap-2">
          <a href={pr.url} target="_blank" rel="noreferrer" className="truncate text-sm font-medium hover:underline">
            {pr.title}
          </a>
          <ClassificationTag classification={pr.classification} />
        </div>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <span className="text-xs text-muted-foreground">@{pr.author}</span>
          <span className="text-xs text-muted-foreground">Closed {formatAge(pr.closedAt)} ago</span>
          {hasFindings && <SeverityCounts counts={pr.findingCounts} />}
        </div>
      </div>
      {hasFindings && (
        <Button size="sm" variant="secondary" onClick={() => onOpenPR?.(prRefOf(pr))} className="shrink-0">
          View findings
        </Button>
      )}
    </div>
  );
}

export function SkippedRow({ pr, actions }: { pr: PRListItem; actions?: GateActions }) {
  const decision = useDecision(actions);
  const ref = prRefOf(pr);

  // Unskip returns the PR to triage, not to the queue: it says "let me look
  // at this again", and the decision that follows is its own deliberate act.
  return (
    <div className="border-b py-2 last:border-b-0" data-testid="skipped-row">
      <div className="flex items-center justify-between gap-4">
        <a
          href={pr.url}
          target="_blank"
          rel="noreferrer"
          className="min-w-0 flex-1 truncate text-sm text-muted-foreground hover:underline"
        >
          {pr.title}
        </a>
        <Button
          variant="outline"
          size="sm"
          data-testid="unskip-pr"
          className="shrink-0"
          disabled={decision.pending !== null}
          onClick={() => decision.run(ref, "unskip")}
        >
          {decision.pending === "unskip" ? "Unskipping…" : "Unskip"}
        </Button>
      </div>
      {decision.error && <p className="mt-1 text-xs text-destructive">{decision.error}</p>}
    </div>
  );
}

/** Dispatches one PR to the row that renders its state. */
function ReviewRow({ pr, onOpenPR, actions }: { pr: PRListItem; onOpenPR?: (ref: PRRef) => void; actions?: GateActions }) {
  switch (pr.state) {
    case "triage":
      return <TriageRow pr={pr} actions={actions} />;
    case "skipped":
      return <SkippedRow pr={pr} actions={actions} />;
    case "queued":
    case "reviewing":
    case "failed":
      return <InReviewRow pr={pr} onOpenPR={onOpenPR} />;
    case "reviewed":
      return <ReviewedRow pr={pr} onOpenPR={onOpenPR} />;
    case "closed":
      return <ClosedRow pr={pr} onOpenPR={onOpenPR} />;
  }
}

// ─── Sections ───────────────────────────────────────────────────────────────

function Section({ title, count, children }: { title: string; count: number; children: ReactNode }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center justify-between text-base">
          <span>{title}</span>
          <span className="text-sm font-normal text-muted-foreground">{count}</span>
        </CardTitle>
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  );
}

export function SkippedSection({ prs, actions }: { prs: PRListItem[]; actions?: GateActions }) {
  if (prs.length === 0) return null;

  // A native <details> disclosure needs no extra state and stays collapsed
  // by default, matching R2.4's "collapsed skipped section" without adding
  // a Collapsible primitive this task's component set does not have.
  return (
    <details className="rounded-xl border bg-card text-card-foreground shadow-sm">
      <summary className="cursor-pointer select-none px-6 py-4 text-sm font-medium">
        Skipped ({prs.length})
      </summary>
      <div className="px-6 pb-4">
        {prs.map((pr) => (
          <SkippedRow key={`${pr.owner}/${pr.repo}#${pr.number}`} pr={pr} actions={actions} />
        ))}
      </div>
    </details>
  );
}

// ─── Health check / empty state ────────────────────────────────────────────

const CONNECTION_LABEL: Record<ConnectionStatus, { label: string; tone: string }> = {
  connecting: { label: "Connecting…", tone: "text-muted-foreground" },
  open: { label: "Live", tone: "text-green-700 dark:text-green-400" },
  reconnecting: { label: "Reconnecting…", tone: "text-yellow-700 dark:text-yellow-400" },
  closed: { label: "Offline", tone: "text-destructive" },
};

function ConnectionBadge({ status }: { status: ConnectionStatus }) {
  const { label, tone } = CONNECTION_LABEL[status];
  return (
    <span className={`flex items-center gap-1.5 text-xs ${tone}`}>
      <span className="size-1.5 rounded-full bg-current" />
      {label}
    </span>
  );
}

/**
 * The empty state doubles as a watcher health check either way, but the
 * headline only claims "you're caught up" for the default view (all
 * states, closed excluded). A narrower filter turning up nothing is not a
 * daemon problem, so it reads as "nothing matches this filter" instead —
 * the same distinction the filter bar's own counts exist to make (see the
 * module doc).
 */
function EmptyPanel({
  connection,
  status,
  closedFilter,
}: {
  connection: ConnectionStatus;
  status: StatusFilter;
  closedFilter: ClosedFilter;
}) {
  const { status: healthStatus, data } = useStatus();
  const headline = isDefaultView(status, closedFilter)
    ? "You're caught up. Nothing waiting on triage or the gate."
    : "Nothing matches this filter.";

  return (
    <Card>
      <CardContent className="space-y-3 py-8 text-center">
        <GitPullRequest className="mx-auto size-6 text-muted-foreground" />
        <p className="text-sm font-medium">{headline}</p>
        <div className="flex flex-wrap items-center justify-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
          <ConnectionBadge status={connection} />
          {healthStatus === "loading" && <span>Checking watcher status…</span>}
          {healthStatus === "ok" && data?.lastCycle && (
            <span>
              Last poll {new Date(data.lastCycle.at).toLocaleTimeString()} ({data.lastCycle.outcome})
            </span>
          )}
          {healthStatus === "ok" && data?.nextPollAt && <span>Next poll around {new Date(data.nextPollAt).toLocaleTimeString()}</span>}
          {healthStatus === "error" && <span>Could not reach the daemon status endpoint.</span>}
        </div>
      </CardContent>
    </Card>
  );
}

// ─── Reviews ────────────────────────────────────────────────────────────────

export function Reviews({ onOpenPR, actions }: ReviewsProps) {
  const [status, setStatus] = useState<StatusFilter>("all");
  const [closedFilter, setClosedFilter] = useState<ClosedFilter>("exclude");
  const connection = useConnectionStatus();

  const mainList = usePRList(filterToQuery(status, closedFilter));
  // Every status's badge count, always against the current closed setting.
  // When `status` is already "all" this duplicates `mainList`'s own
  // request; that is the price of two independent hooks (rules of hooks
  // forbid skipping one), and it stays a real server request either way,
  // never a client-side re-filter of `mainList`'s rows.
  const countsList = usePRList(filterToQuery("all", closedFilter));

  if (mainList.error?.kind === "unauthenticated") {
    return (
      <div className="mx-auto max-w-2xl p-8 text-center">
        <p className="text-sm text-muted-foreground">{REAUTH_MESSAGE}</p>
      </div>
    );
  }

  const statusLabel = STATUS_FILTERS.find((f) => f.id === status)?.label ?? "All";
  const rows = mainList.data ?? [];
  // The one client-side split left: pulling the collapsed skipped section
  // back out of an "all" response the server already filtered correctly.
  // Selecting "Skipped" directly bypasses this — that is the filter's own
  // uncollapsed view of the same rows.
  const skippedInline = status === "all" ? rows.filter((pr) => pr.state === "skipped") : [];
  const visibleRows = status === "all" ? rows.filter((pr) => pr.state !== "skipped") : rows;

  return (
    <div className="mx-auto max-w-3xl space-y-6 p-6">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold">Reviews</h1>
        <ConnectionBadge status={connection} />
      </div>

      <div className="space-y-3">
        <StatusFilterBar status={status} counts={countsList.data} onChange={setStatus} />
        <ClosedFilterBar closed={closedFilter} onChange={setClosedFilter} />
      </div>

      {mainList.status === "loading" ? (
        <div className="p-8 text-sm text-muted-foreground">Loading…</div>
      ) : mainList.status === "error" ? (
        <div className="p-8 text-sm text-destructive">
          Could not load reviews{mainList.error ? `: ${mainList.error.message}` : "."}
        </div>
      ) : rows.length === 0 ? (
        <EmptyPanel connection={connection} status={status} closedFilter={closedFilter} />
      ) : (
        <>
          {visibleRows.length > 0 && (
            <Section title={statusLabel} count={visibleRows.length}>
              {visibleRows.map((pr) => (
                <ReviewRow key={`${pr.owner}/${pr.repo}#${pr.number}`} pr={pr} onOpenPR={onOpenPR} actions={actions} />
              ))}
            </Section>
          )}

          {status === "all" && <SkippedSection prs={skippedInline} actions={actions} />}
        </>
      )}
    </div>
  );
}

export default Reviews;

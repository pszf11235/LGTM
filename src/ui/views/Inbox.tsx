/**
 * Inbox: triage PRs, PRs with ungated findings, and a collapsed skipped
 * section with unskip (design.md, "Web UI"; requirements R2.4, R2.5, R5.1).
 *
 * Every bucket below filters on `closedAt === null` before it looks at
 * `state` at all. A skipped PR that closes keeps `state: "skipped"` and only
 * gets `closedAt` stamped (design.md, "Poll cycle") — filtering on `state
 * !== "closed"` alone would let that PR leak back into the skipped list
 * forever. `closedAt` is the one field every closed PR actually sets.
 *
 * Read-only for this task: skip / review / unskip render as disabled
 * buttons. Another task wires the mutation and removes `disabled`; nothing
 * here should need to move when it does.
 */
import { GitPullRequest } from "lucide-react";
import type { ReactNode } from "react";
import type { Classification, PRRef } from "@/core";
import {
  REAUTH_MESSAGE,
  SEVERITY_ORDER,
  totalFindings,
  type CheckState,
  type FindingCounts,
  type PRListItem,
} from "@/ui/api";
import { useConnectionStatus, useStatus, usePRList, type ConnectionStatus } from "@/ui/hooks";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export interface InboxProps {
  /** Jump to a PR's finding cards. Absent means the caller has not wired navigation yet. */
  onOpenPR?: (ref: PRRef) => void;
}

function prRefOf(item: PRListItem): PRRef {
  return { owner: item.owner, repo: item.repo, number: item.number };
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

function TriageRow({ pr }: { pr: PRListItem }) {
  return (
    <div className="flex items-center justify-between gap-4 border-b py-3 last:border-b-0">
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
        <Button variant="outline" size="sm" disabled title="Coming soon">
          Skip
        </Button>
        <Button size="sm" disabled title="Coming soon">
          Review
        </Button>
      </div>
    </div>
  );
}

function FindingsRow({ pr, onOpenPR }: { pr: PRListItem; onOpenPR?: (ref: PRRef) => void }) {
  return (
    <div className="flex items-center justify-between gap-4 border-b py-3 last:border-b-0">
      <div className="min-w-0 flex-1 space-y-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-sm font-medium">{pr.title}</span>
          <ClassificationTag classification={pr.classification} />
        </div>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <span className="text-xs text-muted-foreground">@{pr.author}</span>
          <SeverityCounts counts={pr.findingCounts} />
        </div>
      </div>
      <Button size="sm" variant="secondary" onClick={() => onOpenPR?.(prRefOf(pr))} className="shrink-0">
        View findings
      </Button>
    </div>
  );
}

function SkippedRow({ pr }: { pr: PRListItem }) {
  return (
    <div className="flex items-center justify-between gap-4 border-b py-2 last:border-b-0">
      <a
        href={pr.url}
        target="_blank"
        rel="noreferrer"
        className="min-w-0 flex-1 truncate text-sm text-muted-foreground hover:underline"
      >
        {pr.title}
      </a>
      <Button variant="outline" size="sm" disabled title="Coming soon" className="shrink-0">
        Unskip
      </Button>
    </div>
  );
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

function SkippedSection({ prs }: { prs: PRListItem[] }) {
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
          <SkippedRow key={`${pr.owner}/${pr.repo}#${pr.number}`} pr={pr} />
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

function EmptyHealthPanel({ connection }: { connection: ConnectionStatus }) {
  const { status, data } = useStatus();

  return (
    <Card>
      <CardContent className="space-y-3 py-8 text-center">
        <GitPullRequest className="mx-auto size-6 text-muted-foreground" />
        <p className="text-sm font-medium">You're caught up. Nothing waiting on triage or the gate.</p>
        <div className="flex flex-wrap items-center justify-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
          <ConnectionBadge status={connection} />
          {status === "loading" && <span>Checking watcher status…</span>}
          {status === "ok" && data?.lastCycle && (
            <span>
              Last poll {new Date(data.lastCycle.at).toLocaleTimeString()} ({data.lastCycle.outcome})
            </span>
          )}
          {status === "ok" && data?.nextPollAt && <span>Next poll around {new Date(data.nextPollAt).toLocaleTimeString()}</span>}
          {status === "error" && <span>Could not reach the daemon status endpoint.</span>}
        </div>
      </CardContent>
    </Card>
  );
}

// ─── Inbox ──────────────────────────────────────────────────────────────────

export function Inbox({ onOpenPR }: InboxProps) {
  const prList = usePRList();
  const connection = useConnectionStatus();

  if (prList.error?.kind === "unauthenticated") {
    return (
      <div className="mx-auto max-w-2xl p-8 text-center">
        <p className="text-sm text-muted-foreground">{REAUTH_MESSAGE}</p>
      </div>
    );
  }

  if (prList.status === "loading") {
    return <div className="p-8 text-sm text-muted-foreground">Loading…</div>;
  }

  if (prList.status === "error") {
    return (
      <div className="p-8 text-sm text-destructive">
        Could not load the inbox{prList.error ? `: ${prList.error.message}` : "."}
      </div>
    );
  }

  const prs = prList.data ?? [];
  // Hard rule: a closed PR is hidden by `closedAt`, never by `state` alone —
  // see the module doc.
  const active = prs.filter((pr) => pr.closedAt === null);
  const triage = active.filter((pr) => pr.state === "triage");
  const skipped = active.filter((pr) => pr.state === "skipped");
  const withFindings = active.filter((pr) => totalFindings(pr.findingCounts) > 0);

  const isEmpty = triage.length === 0 && withFindings.length === 0;

  return (
    <div className="mx-auto max-w-3xl space-y-6 p-6">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold">Inbox</h1>
        <ConnectionBadge status={connection} />
      </div>

      {isEmpty ? (
        <EmptyHealthPanel connection={connection} />
      ) : (
        <>
          {triage.length > 0 && (
            <Section title="Triage" count={triage.length}>
              {triage.map((pr) => (
                <TriageRow key={`${pr.owner}/${pr.repo}#${pr.number}`} pr={pr} />
              ))}
            </Section>
          )}

          {withFindings.length > 0 && (
            <Section title="Ready for the gate" count={withFindings.length}>
              {withFindings.map((pr) => (
                <FindingsRow key={`${pr.owner}/${pr.repo}#${pr.number}`} pr={pr} onOpenPR={onOpenPR} />
              ))}
            </Section>
          )}
        </>
      )}

      <SkippedSection prs={skipped} />
    </div>
  );
}

export default Inbox;

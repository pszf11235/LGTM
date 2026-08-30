/**
 * PR detail: header plus finding cards grouped by file (design.md, "Web
 * UI", "PR detail"; this task's scope stops at the reading surface — the
 * post flow and its confirm pane are a separate task).
 */
import { useState } from "react";
import type { Classification, PRRef } from "@/core";
import { REAUTH_MESSAGE, type FindingWithContext, type RoundSummary } from "@/ui/api";
import { usePRDetail } from "@/ui/hooks";
import { FindingCard } from "@/ui/components/FindingCard";
import { PostPane } from "@/ui/views/PostPane";
import { Button } from "@/components/ui/button";

export interface PRDetailProps {
  prRef: PRRef;
  /** Optional "back to inbox" affordance; PRDetail does not own navigation. */
  onBack?: () => void;
}

const CLASSIFICATION_LABEL: Record<Classification, string> = {
  own: "Your PR",
  requested: "Review requested",
  assigned: "Assigned",
  mentioned: "Mentioned",
  manual: "Reviewed manually",
  none: "Triage",
};

function ClassificationBadge({ classification }: { classification: Classification }) {
  return (
    <span className="inline-flex items-center rounded-full border bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">
      {CLASSIFICATION_LABEL[classification]}
    </span>
  );
}

/** Two decimals, except where two decimals would round a real cost to $0.00. */
function formatUsd(value: number): string {
  return `$${value >= 0.01 ? value.toFixed(2) : value.toFixed(4)}`;
}

/**
 * A resume command the user can paste into a terminal. A browser cannot open
 * one itself, so the honest affordance is copy-to-clipboard plus a line
 * saying what the command does, not a button that pretends to run it.
 */
function CopyResumeCommand({ command }: { command: string }) {
  const [copied, setCopied] = useState(false);

  function copy(): void {
    if (typeof navigator === "undefined" || !navigator.clipboard) return;
    void navigator.clipboard.writeText(command).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }, () => {});
  }

  return (
    <div className="flex items-center gap-2">
      <code className="flex-1 overflow-x-auto rounded-md border bg-muted/30 px-2 py-1 font-mono text-xs">
        {command}
      </code>
      <Button type="button" variant="outline" size="sm" onClick={copy}>
        {copied ? "Copied" : "Copy"}
      </Button>
    </div>
  );
}

export interface RoundSessionProps {
  round: RoundSummary;
}

/**
 * One round's resume affordance. Rendered only for a round that has a
 * session to resume; a round with no session id contributes nothing here,
 * so it renders exactly as it did before this existed.
 *
 * Exported and props-in like FindingCard, so ui.test.ts can render it with
 * real content directly rather than through PRDetail's data-fetching hook,
 * which never resolves under `renderToStaticMarkup` (see that file's smoke
 * tests).
 */
export function RoundSession({ round }: RoundSessionProps) {
  if (!round.resumeCommand) return null;

  const spent: string[] = [];
  if (round.costUsd !== null) spent.push(formatUsd(round.costUsd));
  if (round.turns !== null) spent.push(`${round.turns} turn${round.turns === 1 ? "" : "s"}`);

  return (
    <div className="rounded-lg border bg-card p-3" data-testid="round-session">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-sm font-medium">
          Round {round.round} · {round.agent}
        </span>
        {spent.length > 0 && <span className="text-xs text-muted-foreground">{spent.join(" · ")}</span>}
      </div>
      <p className="mt-1 text-xs text-muted-foreground">
        Reopen the Claude session that produced this round, with its full context.
      </p>
      <div className="mt-2">
        <CopyResumeCommand command={round.resumeCommand} />
      </div>
    </div>
  );
}

function groupByFile(findings: FindingWithContext[]): Array<[string, FindingWithContext[]]> {
  const groups = new Map<string, FindingWithContext[]>();
  for (const finding of findings) {
    const list = groups.get(finding.file);
    if (list) list.push(finding);
    else groups.set(finding.file, [finding]);
  }
  for (const list of groups.values()) {
    list.sort((a, b) => a.line - b.line || a.round - b.round);
  }
  return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b));
}

export function PRDetail({ prRef, onBack }: PRDetailProps) {
  const { status, data, error } = usePRDetail(prRef);

  if (error?.kind === "unauthenticated") {
    return (
      <div className="mx-auto max-w-2xl p-8 text-center">
        <p className="text-sm text-muted-foreground">{REAUTH_MESSAGE}</p>
      </div>
    );
  }

  if (status === "loading") {
    return <div className="p-8 text-sm text-muted-foreground">Loading…</div>;
  }

  if (status === "error" || !data) {
    return (
      <div className="p-8 text-sm text-destructive">
        Could not load {prRef.owner}/{prRef.repo}#{prRef.number}
        {error ? `: ${error.message}` : "."}
      </div>
    );
  }

  const { meta, findings, rounds } = data;
  const resumable = rounds.filter((round) => round.resumeCommand);
  const groups = groupByFile(findings);
  const shortSha = meta.headSha ? meta.headSha.slice(0, 12) : "unknown";

  return (
    <div className="mx-auto max-w-3xl space-y-6 p-6">
      {onBack && (
        <button type="button" onClick={onBack} className="text-sm text-muted-foreground hover:text-foreground">
          ← Back to inbox
        </button>
      )}

      <header className="space-y-2 border-b pb-4">
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-lg font-semibold">{meta.title}</h1>
          <ClassificationBadge classification={meta.classification} />
          {meta.draft && (
            <span className="inline-flex items-center rounded-full border bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">
              Draft
            </span>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted-foreground">
          <span>
            {meta.owner}/{meta.repo}#{meta.number} by @{meta.author}
          </span>
          <code className="text-xs">{shortSha}</code>
          <a href={meta.url} target="_blank" rel="noreferrer" className="text-primary underline-offset-4 hover:underline">
            View on GitHub →
          </a>
        </div>
      </header>

      {findings.length === 0 ? (
        <p className="text-sm text-muted-foreground">No findings on this PR yet.</p>
      ) : (
        <div className="space-y-8">
          {groups.map(([file, fileFindings]) => (
            <section key={file} aria-label={file}>
              <h2 className="mb-3 font-mono text-sm font-medium text-foreground">{file}</h2>
              <div className="space-y-3">
                {fileFindings.map((finding) => (
                  <FindingCard
                    key={finding.key}
                    owner={meta.owner}
                    repo={meta.repo}
                    number={meta.number}
                    finding={finding}
                  />
                ))}
              </div>
            </section>
          ))}
        </div>
      )}

      {resumable.length > 0 && (
        <section className="space-y-3 border-t pt-6" aria-label="Review sessions">
          <h2 className="text-sm font-medium text-foreground">Review sessions</h2>
          <div className="space-y-2">
            {resumable.map((round) => (
              <RoundSession key={`${round.round}-${round.agent}`} round={round} />
            ))}
          </div>
        </section>
      )}

      {findings.length > 0 && (
        <footer className="border-t pt-6">
          <PostPane prRef={{ owner: meta.owner, repo: meta.repo, number: meta.number }} />
        </footer>
      )}
    </div>
  );
}

export default PRDetail;

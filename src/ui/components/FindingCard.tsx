/**
 * One Finding, exactly as design.md's "Web UI" describes the card: severity
 * chip, `file:line`, comment, suggestion, the sliced diff hunk, and a deep
 * link to that exact line on GitHub.
 *
 * Pure and props-in: every value it renders is already resolved server-side
 * (the hunk is sliced by the API, not by this component — R5.1). That keeps
 * it independent of hooks.ts entirely, which is what makes it worth smoke
 * testing directly with real content instead of only a loading placeholder
 * (ui.test.ts renders it standalone, not through Inbox or PR detail).
 *
 * Read-only for this task: the discard action other tasks wire up renders
 * disabled here rather than absent, so the layout it lands in does not
 * shift later.
 */
import type { DiffLine } from "@/core/diff";
import type { Severity } from "@/core";
import { githubLineUrl, type FindingWithContext } from "@/ui/api";
import { Button } from "@/components/ui/button";

const SEVERITY_STYLES: Record<Severity, string> = {
  critical: "bg-red-100 text-red-900 border-red-300 dark:bg-red-950 dark:text-red-300 dark:border-red-900",
  high:
    "bg-orange-100 text-orange-900 border-orange-300 dark:bg-orange-950 dark:text-orange-300 dark:border-orange-900",
  medium:
    "bg-yellow-100 text-yellow-900 border-yellow-300 dark:bg-yellow-950 dark:text-yellow-300 dark:border-yellow-900",
  low: "bg-slate-100 text-slate-700 border-slate-300 dark:bg-slate-800 dark:text-slate-300 dark:border-slate-700",
};

function SeverityChip({ severity }: { severity: Severity }) {
  return (
    <span
      className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium uppercase tracking-wide ${SEVERITY_STYLES[severity]}`}
    >
      {severity}
    </span>
  );
}

const DIFF_LINE_STYLES: Record<DiffLine["type"], string> = {
  added: "bg-green-50 text-green-900 dark:bg-green-950/50 dark:text-green-300",
  removed: "bg-red-50 text-red-900 dark:bg-red-950/50 dark:text-red-300",
  context: "text-muted-foreground",
};

const DIFF_LINE_PREFIX: Record<DiffLine["type"], string> = {
  added: "+",
  removed: "-",
  context: " ",
};

function DiffHunkView({ lines }: { lines: DiffLine[] }) {
  return (
    <div className="overflow-x-auto rounded-md border bg-muted/30">
      <pre className="min-w-max px-3 py-2 font-mono text-xs leading-5">
        {lines.map((line, i) => (
          <div key={i} className={DIFF_LINE_STYLES[line.type]}>
            <span className="select-none pr-2 text-muted-foreground/60">
              {String(line.newLine ?? line.oldLine ?? "").padStart(5, " ")}
            </span>
            <span className="select-none">{DIFF_LINE_PREFIX[line.type]}</span>
            {line.content}
          </div>
        ))}
      </pre>
    </div>
  );
}

const FINDING_STATE_LABEL: Partial<Record<FindingWithContext["state"], string>> = {
  discarded: "Discarded",
  posted: "Posted",
};

export interface FindingCardProps {
  owner: string;
  repo: string;
  finding: FindingWithContext;
  /** Rendered disabled: another task wires the mutation (design.md, "Findings and the gate"). */
  onDiscard?: (key: string) => void;
}

export function FindingCard({ owner, repo, finding }: FindingCardProps) {
  const link = githubLineUrl(owner, repo, finding.headSha || "HEAD", finding.file, finding.line);
  const stateLabel =
    finding.state === "held" ? `Held${finding.heldReason ? `: ${finding.heldReason}` : ""}` : FINDING_STATE_LABEL[finding.state];

  return (
    <div className="rounded-lg border bg-card p-4" data-testid="finding-card" data-finding-key={finding.key}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <SeverityChip severity={finding.severity} />
          <code className="text-sm font-medium">
            {finding.file}:{finding.line}
          </code>
        </div>
        {stateLabel && <span className="text-xs text-muted-foreground">{stateLabel}</span>}
      </div>

      <p className="mt-3 text-sm text-foreground">{finding.comment}</p>

      {finding.suggestion && (
        <div className="mt-3 rounded-md border border-dashed bg-muted/40 p-3">
          <div className="text-xs font-medium text-muted-foreground">Suggestion</div>
          <p className="mt-1 text-sm">{finding.suggestion}</p>
        </div>
      )}

      <div className="mt-3">
        {finding.hunk ? (
          <DiffHunkView lines={finding.hunk.lines} />
        ) : (
          <p className="text-xs italic text-muted-foreground">
            Diff snapshot unavailable for this round — see the file on GitHub.
          </p>
        )}
      </div>

      <div className="mt-3 flex items-center justify-between">
        <Button variant="outline" size="sm" disabled title="Coming soon">
          Discard
        </Button>
        <a
          href={link}
          target="_blank"
          rel="noreferrer"
          className="text-sm text-primary underline-offset-4 hover:underline"
        >
          View on GitHub →
        </a>
      </div>
    </div>
  );
}

export default FindingCard;

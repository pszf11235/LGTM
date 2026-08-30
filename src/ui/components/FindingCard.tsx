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
 * The one impure thing it does is the gate action in its footer (R5.2), and
 * that stays a single call into `@/ui/actions` keyed by the finding's full
 * `r2:reviewer:f1`. A discard is reversible and the finding stays on disk,
 * so the same button reads Restore once it is discarded. A posted finding is
 * already on GitHub, where the pending review is the only place to take it
 * back, so its button is disabled rather than hidden.
 *
 * Nothing is refetched here: the PATCH emits `pr-changed`, and the SSE
 * subscription behind the view refetches from the store rather than from an
 * optimistic guess this card would have to keep in step.
 */
import { useState } from "react";
import type { DiffLine } from "@/core/diff";
import type { PRRef, Severity } from "@/core";
import { getDefaultGateActions, type GateActions } from "@/ui/actions";
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

/**
 * A card without a PR number cannot address its finding, so the button says
 * why instead of failing on click. Every view that renders findings has the
 * number; this is the one prop that must not be forgotten.
 */
const NO_REF_REASON = "This card has no pull request number, so the gate cannot address the finding.";

interface GateAction {
  target: "discarded" | "open";
  label: string;
  busyLabel: string;
  disabled: boolean;
  reason: string | null;
}

/**
 * What the gate can do with a finding in this state.
 *
 * `open` and `held` discard; `discarded` restores, since a discard is
 * reversible and the finding never leaves the disk (R5.2). `posted` is
 * deliberately out of reach:
 * its comment is on GitHub, and the pending review is the only honest place
 * to edit or drop it.
 */
function gateAction(state: FindingWithContext["state"], addressable: boolean): GateAction {
  if (state === "posted") {
    return {
      target: "open",
      label: "Discard",
      busyLabel: "Discarding…",
      disabled: true,
      reason: "Already on GitHub. Edit or delete this comment in the pending review.",
    };
  }

  const reason = addressable ? null : NO_REF_REASON;

  if (state === "discarded") {
    return { target: "open", label: "Restore", busyLabel: "Restoring…", disabled: !addressable, reason };
  }

  return { target: "discarded", label: "Discard", busyLabel: "Discarding…", disabled: !addressable, reason };
}

export interface FindingCardProps {
  owner: string;
  repo: string;
  /**
   * The PR the finding belongs to. Optional only because the card predates
   * the gate; without it there is no ref to PATCH and the button stays
   * disabled, so the view that renders these has to pass it.
   */
  number?: number;
  finding: FindingWithContext;
  /** Injected by tests. The views share one instance otherwise. */
  actions?: GateActions;
  /** Fired after the store confirms the change, for a caller that wants to react beyond the SSE refetch. */
  onChanged?: (key: string, state: "discarded" | "open") => void;
}

export function FindingCard({ owner, repo, number, finding, actions, onChanged }: FindingCardProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const link = githubLineUrl(owner, repo, finding.headSha || "HEAD", finding.file, finding.line);
  const stateLabel =
    finding.state === "held" ? `Held${finding.heldReason ? `: ${finding.heldReason}` : ""}` : FINDING_STATE_LABEL[finding.state];

  const prRef: PRRef | null = number === undefined ? null : { owner, repo, number };
  const gate = gateAction(finding.state, prRef !== null);

  function run(): void {
    if (prRef === null || gate.disabled || busy) return;

    setBusy(true);
    setError(null);

    // The full `r2:reviewer:f1` key, never the bare id: ids restart at f1 in
    // every round file (R9.3).
    const client = actions ?? getDefaultGateActions();
    const call =
      gate.target === "discarded"
        ? client.discardFinding(prRef, finding.key)
        : client.restoreFinding(prRef, finding.key);

    void call.then(
      (result) => {
        setBusy(false);
        if (result.status === "error") {
          setError(result.error.message);
          return;
        }
        onChanged?.(result.key, result.state);
      },
      (err: unknown) => {
        setBusy(false);
        setError(err instanceof Error ? err.message : String(err));
      },
    );
  }

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

      {error && <p className="mt-3 text-xs text-destructive">{error}</p>}

      <div className="mt-3 flex items-center justify-between">
        <Button
          variant="outline"
          size="sm"
          data-testid="finding-gate-action"
          disabled={gate.disabled || busy}
          {...(gate.reason ? { title: gate.reason } : {})}
          onClick={run}
        >
          {busy ? gate.busyLabel : gate.label}
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

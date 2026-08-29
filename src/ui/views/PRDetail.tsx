/**
 * PR detail: header plus finding cards grouped by file (design.md, "Web
 * UI", "PR detail"; this task's scope stops at the reading surface — the
 * post flow and its confirm pane are a separate task).
 */
import type { Classification, PRRef } from "@/core";
import { REAUTH_MESSAGE, type FindingWithContext } from "@/ui/api";
import { usePRDetail } from "@/ui/hooks";
import { FindingCard } from "@/ui/components/FindingCard";

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

  const { meta, findings } = data;
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
                  <FindingCard key={finding.key} owner={meta.owner} repo={meta.repo} finding={finding} />
                ))}
              </div>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}

export default PRDetail;

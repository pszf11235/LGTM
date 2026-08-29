/**
 * The confirm pane for backfilling one repo's open PRs into triage
 * (design.md, "Web UI", the Repos view; requirements R2.6).
 *
 * `POST /api/watchlist` writes triage-state `meta.md` for every open PR and
 * adds the repo to `watch.md` before it answers, so by the time this pane
 * can render a row, that PR is already sitting in triage on disk rather than
 * "unknown" to the next poll cycle. That ordering is what makes R2.6 true:
 * nothing here can queue a review ahead of a human looking at it.
 *
 * Auto-class rows arrive pre-checked, because they would auto-queue on the
 * next cycle anyway, but the Confirm button is the only thing in this file
 * that can start a review, and it never fires on mount or on a checkbox
 * click by itself. It issues one decision call per selected PR, never a
 * bulk endpoint, and settles each one independently, so a batch with one
 * failure still reports which PRs queued and which didn't instead of one
 * pass/fail flag for the whole confirm. See `runConfirm`.
 *
 * A draft PR's checkbox starts unchecked regardless of classification
 * (`preSelected` in the row below already encodes this). Checking one and
 * confirming sends `review-anyway`, the explicit override R2.3 requires to
 * review a draft, never a plain `review` (see the `decision` handler in
 * `src/api/routes.ts`: a plain `review` on a draft records approval but
 * leaves it in triage until it leaves draft state by itself).
 */
import { useEffect, useState } from "react";
import { CircleAlert, CircleCheck, CircleX, Clock, GitPullRequestDraft, Loader2 } from "lucide-react";
import type { ReactNode } from "react";
import type { Classification, PRRef, RepoRef } from "@/core";
import { getDefaultApiClient } from "@/ui/api";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";

// ─── Wire shapes ────────────────────────────────────────────────────────────
//
// `POST /api/watchlist`'s response (src/api/routes.ts, `addWatchlist` and
// `backfillRow`), mirrored field for field rather than imported: the
// daemon's own `BackfillEntry` nests `detail` and `checkStatus` and carries
// `mergeable` as `boolean | null`, and the API flattens both before they
// cross the wire.

export interface BackfillRow {
  ref: PRRef;
  key: string;
  url: string;
  title: string;
  author: string;
  draft: boolean;
  createdAt: string;
  updatedAt: string;
  headSha: string;
  additions: number;
  deletions: number;
  changedFiles: number;
  /** GitHub computes this asynchronously; `computing` is not a conflict (R2.5). */
  mergeable: "mergeable" | "conflict" | "computing";
  checks: { state: "success" | "failure" | "pending" | "none"; runs: number };
  classification: Classification;
  autoClass: boolean;
  preSelected: boolean;
}

export interface AddWatchlistResponse {
  repo: RepoRef;
  key: string;
  added: boolean;
  entries: BackfillRow[];
}

// ─── Wire access ────────────────────────────────────────────────────────────
//
// `@/ui/api`'s `getDefaultApiClient()` owns the token lifecycle (the
// `#t=<token>` fragment `lgtm open` launches with, storage, and the
// unauthenticated flip on a 401), shared with every other view so a token
// refresh is visible everywhere at once. Its typed methods for watchlist,
// config, and status do not match this route table's actual response shapes
// as of this writing (`{repos:[...]}`, `{config,defaults}`, and the fuller
// `/api/status` in src/api/routes.ts are all wrapped or shaped differently
// than what `@/ui/api.ts` parses), so the requests below go over `fetch`
// directly rather than through those methods; only the token comes from the
// shared client.

async function apiRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const token = getDefaultApiClient().getToken();

  const res = await fetch(path, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(init?.headers ?? {}),
    },
  });

  const text = await res.text();

  if (!res.ok) {
    let message = text;
    try {
      const parsed = JSON.parse(text) as { message?: unknown };
      if (typeof parsed.message === "string") message = parsed.message;
    } catch {
      // Not JSON. Fall back to whatever the body carried.
    }
    throw new Error(message || `${init?.method ?? "GET"} ${path} failed (${res.status})`);
  }

  return (text ? JSON.parse(text) : undefined) as T;
}

async function fetchBackfillFromApi(repo: RepoRef): Promise<AddWatchlistResponse> {
  return apiRequest<AddWatchlistResponse>("/api/watchlist", {
    method: "POST",
    body: JSON.stringify({ owner: repo.owner, repo: repo.repo }),
  });
}

async function postDecisionViaApi(ref: PRRef, action: ConfirmAction): Promise<void> {
  await apiRequest<unknown>(`/api/prs/${ref.owner}/${ref.repo}/${ref.number}/decision`, {
    method: "POST",
    body: JSON.stringify({ action }),
  });
}

// ─── Selection → request mapping ───────────────────────────────────────────
//
// Pure, and deliberately the only place that turns "which boxes are
// checked" into "what gets sent to the daemon". Everything below is
// exported so the test file can call it directly, without rendering a
// component or faking a DOM.

export function prKey(ref: PRRef): string {
  return `${ref.owner}/${ref.repo}#${ref.number}`;
}

/** The checkbox state Confirm starts with: exactly the pre-selected rows. */
export function computeInitialSelection(entries: readonly BackfillRow[]): Set<string> {
  return new Set(entries.filter((entry) => entry.preSelected).map((entry) => prKey(entry.ref)));
}

/**
 * Everything Confirm can send. `skip` and `unskip` exist on the decision
 * endpoint (design.md, "HTTP API") but never come from this pane: an
 * unchecked row is left alone, not skipped, so it still shows up in the
 * triage inbox for a later decision.
 */
export type ConfirmAction = "review" | "review-anyway";

export interface ConfirmRequest {
  ref: PRRef;
  action: ConfirmAction;
}

/**
 * The exact set of decision calls Confirm makes for the current selection.
 * A row not in `selected` produces no entry, checked or not matters,
 * nothing else does. A draft row sends `review-anyway`; every other
 * selected row sends `review`. Order follows `entries`.
 */
export function buildConfirmRequests(
  entries: readonly BackfillRow[],
  selected: ReadonlySet<string>,
): ConfirmRequest[] {
  return entries
    .filter((entry) => selected.has(prKey(entry.ref)))
    .map((entry) => ({ ref: entry.ref, action: entry.draft ? "review-anyway" : "review" }));
}

export interface ConfirmOutcome extends ConfirmRequest {
  ok: boolean;
  error?: string;
}

export type PostDecision = (ref: PRRef, action: ConfirmAction) => Promise<void>;

/**
 * Runs `buildConfirmRequests` and settles every call on its own, so one
 * PR's failure can never hide another PR's success. The returned array is
 * the honest partial-failure report: which PRs queued, and why any that
 * didn't failed.
 */
export async function runConfirm(
  entries: readonly BackfillRow[],
  selected: ReadonlySet<string>,
  postDecision: PostDecision,
): Promise<ConfirmOutcome[]> {
  const requests = buildConfirmRequests(entries, selected);
  return Promise.all(
    requests.map(async (request) => {
      try {
        await postDecision(request.ref, request.action);
        return { ...request, ok: true };
      } catch (err) {
        return { ...request, ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    }),
  );
}

// ─── Display helpers ────────────────────────────────────────────────────────

function classificationLabel(c: Classification): string {
  switch (c) {
    case "own":
      return "yours";
    case "requested":
      return "review requested";
    case "assigned":
      return "assigned";
    case "mentioned":
      return "mentioned";
    case "manual":
      return "approved";
    default:
      return "triage";
  }
}

function formatAge(iso: string, now: number = Date.now()): string {
  const ms = Math.max(0, now - new Date(iso).getTime());
  const days = Math.floor(ms / 86_400_000);
  if (days >= 1) return `${days}d`;
  const hours = Math.floor(ms / 3_600_000);
  if (hours >= 1) return `${hours}h`;
  const minutes = Math.floor(ms / 60_000);
  return `${minutes}m`;
}

function Badge({ tone, children }: { tone: "neutral" | "good" | "bad" | "warn"; children: ReactNode }) {
  const toneClass: Record<typeof tone, string> = {
    neutral: "bg-muted text-muted-foreground border-border",
    good: "bg-emerald-500/10 text-emerald-600 border-emerald-500/30 dark:text-emerald-400",
    bad: "bg-destructive/10 text-destructive border-destructive/30",
    warn: "bg-amber-500/10 text-amber-600 border-amber-500/30 dark:text-amber-400",
  };
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-xs font-medium",
        toneClass[tone],
      )}
    >
      {children}
    </span>
  );
}

function MergeableBadge({ mergeable }: { mergeable: BackfillRow["mergeable"] }) {
  if (mergeable === "computing") {
    return (
      <Badge tone="neutral">
        <Loader2 className="size-3 animate-spin" /> computing
      </Badge>
    );
  }
  if (mergeable === "mergeable") {
    return (
      <Badge tone="good">
        <CircleCheck className="size-3" /> mergeable
      </Badge>
    );
  }
  return (
    <Badge tone="bad">
      <CircleAlert className="size-3" /> conflicts
    </Badge>
  );
}

function CheckStatusBadge({ checks }: { checks: BackfillRow["checks"] }) {
  switch (checks.state) {
    case "success":
      return (
        <Badge tone="good">
          <CircleCheck className="size-3" /> checks passing
        </Badge>
      );
    case "failure":
      return (
        <Badge tone="bad">
          <CircleX className="size-3" /> checks failing
        </Badge>
      );
    case "pending":
      return (
        <Badge tone="warn">
          <Loader2 className="size-3 animate-spin" /> checks running
        </Badge>
      );
    default:
      return <Badge tone="neutral">no checks</Badge>;
  }
}

// ─── Component ──────────────────────────────────────────────────────────────

export interface BackfillPaneProps {
  repo: RepoRef;
  onClose: () => void;
  /** Called once Confirm has attempted at least one decision call. */
  onConfirmed?: () => void;
  /** Testing seams. Default to the real API. */
  fetchBackfillList?: (repo: RepoRef) => Promise<AddWatchlistResponse>;
  postDecision?: PostDecision;
}

type PaneState = "loading" | "ready" | "error" | "confirming" | "done";

export function BackfillPane({
  repo,
  onClose,
  onConfirmed,
  fetchBackfillList = fetchBackfillFromApi,
  postDecision = postDecisionViaApi,
}: BackfillPaneProps) {
  const [state, setState] = useState<PaneState>("loading");
  const [entries, setEntries] = useState<BackfillRow[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [loadError, setLoadError] = useState<string | null>(null);
  const [outcomes, setOutcomes] = useState<ConfirmOutcome[]>([]);

  useEffect(() => {
    let cancelled = false;
    setState("loading");
    setLoadError(null);

    fetchBackfillList(repo)
      .then((result) => {
        if (cancelled) return;
        setEntries(result.entries);
        setSelected(computeInitialSelection(result.entries));
        setState("ready");
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setLoadError(err instanceof Error ? err.message : String(err));
        setState("error");
      });

    return () => {
      cancelled = true;
    };
    // repo identity is what should re-trigger the fetch; fetchBackfillList's
    // default is a stable module-level function, and a caller that swaps it
    // per render is a test doing so on purpose.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repo.owner, repo.repo]);

  function toggle(ref: PRRef) {
    setSelected((prev) => {
      const next = new Set(prev);
      const key = prKey(ref);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  async function confirm() {
    setState("confirming");
    const results = await runConfirm(entries, selected, postDecision);
    setOutcomes(results);
    setState("done");
    onConfirmed?.();
  }

  const selectedCount = selected.size;
  const failedCount = outcomes.filter((o) => !o.ok).length;
  const busy = state === "confirming" || state === "done";

  return (
    <Card className="w-full">
      <CardHeader>
        <CardTitle>
          Backfill {repo.owner}/{repo.repo}
        </CardTitle>
        <CardDescription>
          Open pull requests found when this repo was added. Auto-class PRs are pre-checked, and nothing is
          reviewed until you confirm.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {state === "loading" && (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" /> Fetching open PRs…
          </div>
        )}
        {state === "error" && (
          <div className="flex items-center gap-2 text-sm text-destructive">
            <CircleAlert className="size-4 shrink-0" /> {loadError}
          </div>
        )}
        {state !== "loading" && state !== "error" && entries.length === 0 && (
          <p className="text-sm text-muted-foreground">Nothing to triage. Every open PR here is already known.</p>
        )}
        {entries.map((entry) => {
          const key = prKey(entry.ref);
          const outcome = outcomes.find((o) => prKey(o.ref) === key);
          const checked = selected.has(key);
          return (
            <div key={key} className="flex items-start gap-3 rounded-md border p-3">
              <input
                type="checkbox"
                id={key}
                checked={checked}
                disabled={busy}
                onChange={() => toggle(entry.ref)}
                className="mt-1 size-4 rounded border-input accent-primary disabled:opacity-50"
              />
              <label htmlFor={key} className="flex-1 space-y-1 text-sm">
                <div className="flex flex-wrap items-center gap-2">
                  <a
                    href={entry.url}
                    target="_blank"
                    rel="noreferrer"
                    className="font-medium hover:underline"
                    onClick={(e) => e.stopPropagation()}
                  >
                    #{entry.ref.number} {entry.title}
                  </a>
                  {entry.autoClass && <Badge tone="good">{classificationLabel(entry.classification)}</Badge>}
                  {entry.draft && (
                    <Badge tone="neutral">
                      <GitPullRequestDraft className="size-3" /> draft
                    </Badge>
                  )}
                </div>
                <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                  <span>{entry.author}</span>
                  <span>
                    +{entry.additions} -{entry.deletions} · {entry.changedFiles} files
                  </span>
                  <span className="inline-flex items-center gap-1">
                    <Clock className="size-3" /> {formatAge(entry.createdAt)}
                  </span>
                  <MergeableBadge mergeable={entry.mergeable} />
                  <CheckStatusBadge checks={entry.checks} />
                </div>
                {outcome && (
                  <div
                    className={cn(
                      "flex items-center gap-1 text-xs",
                      outcome.ok ? "text-emerald-600 dark:text-emerald-400" : "text-destructive",
                    )}
                  >
                    {outcome.ok ? <CircleCheck className="size-3" /> : <CircleX className="size-3" />}
                    {outcome.ok
                      ? outcome.action === "review-anyway"
                        ? "queued (review anyway)"
                        : "queued for review"
                      : outcome.error}
                  </div>
                )}
              </label>
            </div>
          );
        })}
      </CardContent>
      <CardFooter className="flex items-center justify-between gap-3">
        <div className="text-sm text-muted-foreground">
          {state === "done"
            ? failedCount > 0
              ? `${outcomes.length - failedCount} of ${outcomes.length} queued, ${failedCount} failed`
              : outcomes.length > 0
                ? `${outcomes.length} queued for review`
                : "Nothing was selected"
            : `${selectedCount} selected`}
        </div>
        <div className="flex gap-2">
          <Button variant="outline" onClick={onClose}>
            {state === "done" ? "Done" : "Close"}
          </Button>
          {state !== "done" && (
            <Button onClick={() => void confirm()} disabled={state !== "ready" || selectedCount === 0}>
              {state === "confirming" ? (
                <>
                  <Loader2 className="size-4 animate-spin" /> Confirming…
                </>
              ) : (
                `Confirm (${selectedCount})`
              )}
            </Button>
          )}
        </div>
      </CardFooter>
    </Card>
  );
}

export default BackfillPane;

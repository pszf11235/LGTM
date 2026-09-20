/**
 * The watch list (design.md, "Web UI", "Repos"). Shows every repo in
 * `watch.md` with its last poll time, offers an `owner/repo` add field, and
 * lets a repo be removed. Removing is never destructive: R9.5 keeps the
 * repo's reviews on disk and only hides its PRs from active views, so a
 * repo can be re-added later without losing anything.
 *
 * Adding a repo does not review anything by itself. It opens
 * `BackfillPane`, the only place in this flow that can queue a review, and
 * only after a human confirms (R2.6).
 */
import { useCallback, useEffect, useState } from "react";
import { Loader2, Plus, RefreshCw, Trash2 } from "lucide-react";
import type { FormEvent } from "react";
import type { RepoRef } from "@/core";
import { getDefaultApiClient } from "@/ui/api";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { BackfillPane } from "./BackfillPane";

// ─── Wire shapes ────────────────────────────────────────────────────────────
//
// `GET /api/watchlist`'s response (src/api/routes.ts, `listWatchlist`).

interface WatchRow {
  owner: string;
  repo: string;
  key: string;
  addedAt: string;
  lastPolledAt: string | null;
  conditional: boolean;
  /** null means the repo follows the daemon default rather than pinning one. */
  autoReview: boolean | null;
}

interface WatchlistResponse {
  repos: WatchRow[];
}

const REPO_PATTERN = /^([\w.-]+)\/([\w.-]+)$/;

// See BackfillPane.tsx's matching comment: `@/ui/api`'s shared client owns
// the token lifecycle (the `#t=<token>` handoff from `lgtm open`, storage,
// the unauthenticated flip on a 401), but its typed `listWatch`/`addWatch`
// methods do not match `/api/watchlist`'s actual response shape as of this
// writing, so this view fetches directly and only borrows the token.

function formatLastPolled(iso: string | null): string {
  if (!iso) return "never polled";
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60_000) return "just now";
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

/**
 * One repo's auto-review setting: follow the daemon, or pin it on or off.
 *
 * Three states rather than a switch, because "following the default" is a real
 * answer and a two-way toggle would have to pick one the moment you touched it.
 */
function AutoReviewControl({
  entry,
  daemonDefault,
  busy,
  onChange,
}: {
  entry: WatchRow;
  daemonDefault: boolean;
  busy: boolean;
  onChange: (value: boolean | null) => void;
}) {
  const effective = entry.autoReview ?? daemonDefault;
  const options: Array<{ value: boolean | null; label: string }> = [
    { value: null, label: `Default (${daemonDefault ? "auto" : "manual"})` },
    { value: true, label: "Auto" },
    { value: false, label: "Manual" },
  ];

  return (
    <div className="flex items-center gap-2" data-testid={`auto-review-${entry.key}`}>
      <span className={`text-xs ${effective ? "text-muted-foreground" : "text-foreground"}`}>
        {effective ? "Reviews automatically" : "Waits for you"}
      </span>
      <select
        aria-label={`Auto review for ${entry.key}`}
        className="rounded-md border bg-background px-2 py-1 text-xs"
        disabled={busy}
        value={entry.autoReview === null ? "default" : String(entry.autoReview)}
        onChange={(e) => {
          const raw = e.target.value;
          onChange(raw === "default" ? null : raw === "true");
        }}
      >
        {options.map((o) => (
          <option key={String(o.value)} value={o.value === null ? "default" : String(o.value)}>
            {o.label}
          </option>
        ))}
      </select>
    </div>
  );
}

export function Repos() {

  const [entries, setEntries] = useState<WatchRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [listError, setListError] = useState<string | null>(null);
  const [input, setInput] = useState("");
  const [addError, setAddError] = useState<string | null>(null);
  const [pending, setPending] = useState<RepoRef | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  const [settingAuto, setSettingAuto] = useState<string | null>(null);
  // What "Default" resolves to, so the option can say which it means rather
  // than making the reader go and look it up in Settings.
  const [daemonAutoReview, setDaemonAutoReview] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    setListError(null);
    try {
      const response = await getDefaultApiClient().request<WatchlistResponse>("/api/watchlist");
      setEntries(response.repos);
      try {
        const status = await getDefaultApiClient().request<{ autoReview?: boolean }>("/api/status");
        setDaemonAutoReview(status.autoReview !== false);
      } catch {
        // The list is the point of this view. A status call that failed only
        // costs the label on one option, so it must not blank the page.
      }
    } catch (err) {
      setListError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function handleAutoReview(entry: WatchRow, value: boolean | null) {
    setSettingAuto(entry.key);
    try {
      await getDefaultApiClient().request("/api/watchlist", {
        method: "PATCH",
        body: JSON.stringify({ owner: entry.owner, repo: entry.repo, autoReview: value }),
      });
      setEntries((rows) =>
        rows.map((r) => (r.key === entry.key ? { ...r, autoReview: value } : r))
      );
    } catch (err) {
      setListError(err instanceof Error ? err.message : String(err));
    } finally {
      setSettingAuto(null);
    }
  }

  function handleAdd(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const match = REPO_PATTERN.exec(input.trim());
    const owner = match?.[1];
    const repo = match?.[2];
    if (!owner || !repo) {
      setAddError("expected owner/repo, e.g. facebook/react");
      return;
    }
    setAddError(null);
    setInput("");
    setPending({ owner, repo });
  }

  async function handleRemove(entry: WatchRow) {
    setRemoving(entry.key);
    try {
      const query = new URLSearchParams({ owner: entry.owner, repo: entry.repo });
      await getDefaultApiClient().request<unknown>(`/api/watchlist?${query.toString()}`, { method: "DELETE" });
      await load();
    } catch (err) {
      setListError(err instanceof Error ? err.message : String(err));
    } finally {
      setRemoving(null);
    }
  }

  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-6 p-6">
      <Card>
        <CardHeader>
          <CardTitle>Watched repositories</CardTitle>
          <CardDescription>LGTM polls every repository here for open PRs.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <form onSubmit={handleAdd} className="flex items-end gap-2">
            <div className="flex-1 space-y-1">
              <Label htmlFor="repo-input">Add a repository</Label>
              <Input
                id="repo-input"
                placeholder="owner/repo"
                value={input}
                onChange={(e) => setInput(e.target.value)}
              />
            </div>
            <Button type="submit">
              <Plus className="size-4" /> Add
            </Button>
          </form>
          {addError && <p className="text-sm text-destructive">{addError}</p>}

          {loading && (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" /> Loading watch list…
            </div>
          )}
          {listError && !loading && (
            <div className="flex items-center justify-between gap-2 text-sm text-destructive">
              <span>{listError}</span>
              <Button type="button" variant="outline" size="sm" onClick={() => void load()}>
                <RefreshCw className="size-3.5" /> Retry
              </Button>
            </div>
          )}
          {!loading && !listError && entries.length === 0 && (
            <p className="text-sm text-muted-foreground">No repositories watched yet.</p>
          )}
          {entries.length > 0 && (
            <ul className="divide-y">
              {entries.map((entry) => (
                <li key={entry.key} className="flex items-center justify-between gap-3 py-3">
                  <div>
                    <a
                      href={`https://github.com/${entry.owner}/${entry.repo}`}
                      target="_blank"
                      rel="noreferrer"
                      className="font-medium hover:underline"
                    >
                      {entry.key}
                    </a>
                    <p className="text-xs text-muted-foreground">{formatLastPolled(entry.lastPolledAt)}</p>
                  </div>
                  <AutoReviewControl
                    entry={entry}
                    daemonDefault={daemonAutoReview}
                    busy={settingAuto === entry.key}
                    onChange={(value) => void handleAutoReview(entry, value)}
                  />
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    disabled={removing === entry.key}
                    onClick={() => void handleRemove(entry)}
                  >
                    {removing === entry.key ? (
                      <Loader2 className="size-4 animate-spin" />
                    ) : (
                      <Trash2 className="size-4" />
                    )}
                    Remove
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      {pending && (
        <BackfillPane
          repo={pending}
          onClose={() => setPending(null)}
          onConfirmed={() => {
            void load();
          }}
        />
      )}
    </div>
  );
}

export default Repos;

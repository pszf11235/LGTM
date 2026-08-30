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

export function Repos() {
  const [entries, setEntries] = useState<WatchRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [listError, setListError] = useState<string | null>(null);
  const [input, setInput] = useState("");
  const [addError, setAddError] = useState<string | null>(null);
  const [pending, setPending] = useState<RepoRef | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setListError(null);
    try {
      const response = await apiRequest<WatchlistResponse>("/api/watchlist");
      setEntries(response.repos);
    } catch (err) {
      setListError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

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
      await apiRequest<unknown>(`/api/watchlist?${query.toString()}`, { method: "DELETE" });
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

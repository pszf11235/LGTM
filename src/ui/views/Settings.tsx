/**
 * Provider and GitHub detection, quota, polling, and daemon health
 * (design.md, "Web UI", "Settings"). No notification toggles: the spec
 * fixes notification behavior (R8), and there is nothing here to configure.
 *
 * Reads `GET /api/status` (design.md's tray contract, the same one v1.1's
 * menu bar shell reads) and `GET /api/config`, and writes back through
 * `PATCH /api/config`. Every field below mirrors those two routes in
 * `src/api/routes.ts` rather than the daemon's in-memory types directly,
 * because that is what actually crosses the wire.
 */
import { useCallback, useEffect, useState } from "react";
import { CircleAlert, CircleCheck, Loader2, Save } from "lucide-react";
import type { FormEvent, ReactNode } from "react";
import type { BinaryName, BinaryStatus } from "@/daemon/binaries";
import type { QuotaMode, QuotaState } from "@/daemon/quota";
import type { SchedulerStatus } from "@/daemon/scheduler";
import type { Config } from "@/store";
import { getDefaultApiClient } from "@/ui/api";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";

// ─── Wire shapes ────────────────────────────────────────────────────────────
//
// `GET /api/status`'s response (src/api/routes.ts, the `status` handler).
// Only the fields this view renders are declared; the route sends more
// (repos, per-PR counts) that belong to the Inbox view instead.

interface StatusResponse {
  version: string;
  pid: number;
  port: number;
  startedAt: string;
  uptimeMs: number;
  scheduler: SchedulerStatus | null;
  quota: QuotaState | null;
  binaries: BinaryStatus[];
  github: { tokenPresent: boolean };
}

interface ConfigResponse {
  config: Config;
  defaults: Config;
}

// See BackfillPane.tsx's matching comment: `@/ui/api`'s shared client owns
// the token lifecycle, but its typed `status`/`getConfig`/`patchConfig`
// methods do not match those routes' actual response shapes as of this
// writing (src/api/routes.ts's `/api/status`, `/api/config`), so this view
// fetches directly and only borrows the token.
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

// ─── Display helpers ────────────────────────────────────────────────────────

function Badge({ tone, children }: { tone: "neutral" | "good" | "bad" | "warn"; children: ReactNode }) {
  const toneClass: Record<typeof tone, string> = {
    neutral: "bg-muted text-muted-foreground border-border",
    good: "bg-emerald-500/10 text-emerald-600 border-emerald-500/30 dark:text-emerald-400",
    bad: "bg-destructive/10 text-destructive border-destructive/30",
    warn: "bg-amber-500/10 text-amber-600 border-amber-500/30 dark:text-amber-400",
  };
  return (
    <span
      className={cn("inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-xs font-medium", toneClass[tone])}
    >
      {children}
    </span>
  );
}

const BINARY_LABELS: Record<BinaryName, string> = {
  claude: "Claude CLI",
  gh: "GitHub CLI",
  "terminal-notifier": "terminal-notifier",
};

function binaryTone(source: BinaryStatus["source"]): "good" | "bad" | "neutral" {
  if (source === "missing") return "bad";
  return "good";
}

function quotaTone(mode: QuotaMode): "good" | "bad" | "warn" {
  if (mode === "ok") return "good";
  if (mode === "throttled") return "bad";
  return "warn";
}

function formatUptime(ms: number): string {
  const totalMinutes = Math.floor(ms / 60_000);
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

function formatWhen(iso: string | null): string {
  if (!iso) return "never";
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

function toInt(value: string, fallback: number): number {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

// ─── Editable config draft ──────────────────────────────────────────────────

interface ConfigDraft {
  intervalMinutes: string;
  pauseAbovePct: string;
  resumeBelowPct: string;
  dailyCap: string;
  claudePath: string;
  ghPath: string;
}

function draftFromConfig(config: Config): ConfigDraft {
  return {
    intervalMinutes: String(config.interval_minutes),
    pauseAbovePct: String(config.pause_above_pct),
    resumeBelowPct: String(config.resume_below_pct),
    dailyCap: String(config.daily_cap),
    claudePath: config.claude_path ?? "",
    ghPath: config.gh_path ?? "",
  };
}

// ─── Component ──────────────────────────────────────────────────────────────

export function Settings() {
  const [status, setStatus] = useState<StatusResponse | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [config, setConfig] = useState<Config | null>(null);
  const [configError, setConfigError] = useState<string | null>(null);
  const [draft, setDraft] = useState<ConfigDraft | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    const [statusResult, configResult] = await Promise.allSettled([
      apiRequest<StatusResponse>("/api/status"),
      apiRequest<ConfigResponse>("/api/config"),
    ]);

    if (statusResult.status === "fulfilled") {
      setStatus(statusResult.value);
      setStatusError(null);
    } else {
      setStatusError(
        statusResult.reason instanceof Error ? statusResult.reason.message : String(statusResult.reason),
      );
    }

    if (configResult.status === "fulfilled") {
      setConfig(configResult.value.config);
      setDraft(draftFromConfig(configResult.value.config));
      setConfigError(null);
    } else {
      setConfigError(configResult.reason instanceof Error ? configResult.reason.message : String(configResult.reason));
    }

    setLoading(false);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function handleSave(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!draft) return;

    setSaving(true);
    setSaveError(null);

    const patch = {
      interval_minutes: toInt(draft.intervalMinutes, config?.interval_minutes ?? 15),
      pause_above_pct: toInt(draft.pauseAbovePct, config?.pause_above_pct ?? 70),
      resume_below_pct: toInt(draft.resumeBelowPct, config?.resume_below_pct ?? 60),
      daily_cap: toInt(draft.dailyCap, config?.daily_cap ?? 20),
      claude_path: draft.claudePath.trim() === "" ? null : draft.claudePath.trim(),
      gh_path: draft.ghPath.trim() === "" ? null : draft.ghPath.trim(),
    };

    try {
      const response = await apiRequest<ConfigResponse>("/api/config", {
        method: "PATCH",
        body: JSON.stringify(patch),
      });
      setConfig(response.config);
      setDraft(draftFromConfig(response.config));
      setSavedAt(Date.now());
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return (
      <div className="mx-auto flex max-w-2xl items-center gap-2 p-6 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" /> Loading settings…
      </div>
    );
  }

  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-6 p-6">
      <form onSubmit={(e) => void handleSave(e)} className="flex flex-col gap-6">
        <Card>
          <CardHeader>
            <CardTitle>Provider and GitHub CLI</CardTitle>
            <CardDescription>
              Resolved at daemon startup via a login-shell probe. A manual pin below skips the probe for that
              binary.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {statusError && (
              <p className="flex items-center gap-2 text-sm text-destructive">
                <CircleAlert className="size-4 shrink-0" /> {statusError}
              </p>
            )}
            {status && (
              <ul className="space-y-2">
                {status.binaries.map((binary) => (
                  <li key={binary.name} className="flex items-center justify-between gap-2 text-sm">
                    <span className="font-medium">{BINARY_LABELS[binary.name]}</span>
                    <span className="flex items-center gap-2">
                      <span className="truncate text-xs text-muted-foreground">{binary.path ?? "not found"}</span>
                      <Badge tone={binaryTone(binary.source)}>{binary.source}</Badge>
                    </span>
                  </li>
                ))}
              </ul>
            )}
            {configError && (
              <p className="flex items-center gap-2 text-sm text-destructive">
                <CircleAlert className="size-4 shrink-0" /> {configError}
              </p>
            )}
            {draft && (
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-1">
                  <Label htmlFor="claude-path">Claude binary override</Label>
                  <Input
                    id="claude-path"
                    placeholder="/opt/homebrew/bin/claude"
                    value={draft.claudePath}
                    onChange={(e) => setDraft({ ...draft, claudePath: e.target.value })}
                  />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="gh-path">gh binary override</Label>
                  <Input
                    id="gh-path"
                    placeholder="/opt/homebrew/bin/gh"
                    value={draft.ghPath}
                    onChange={(e) => setDraft({ ...draft, ghPath: e.target.value })}
                  />
                </div>
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>GitHub authentication</CardTitle>
            <CardDescription>
              Resolved from GITHUB_TOKEN or GH_TOKEN, then `gh auth token`, then a saved credential file. The token
              itself never leaves the daemon.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {status ? (
              status.github.tokenPresent ? (
                <p className="flex items-center gap-2 text-sm text-emerald-600 dark:text-emerald-400">
                  <CircleCheck className="size-4" /> A GitHub token is resolved.
                </p>
              ) : (
                <p className="flex items-center gap-2 text-sm text-destructive">
                  <CircleAlert className="size-4 shrink-0" />
                  No GitHub token found. Set GITHUB_TOKEN, run `gh auth login`, or add a saved credential.
                </p>
              )
            ) : (
              <p className="text-sm text-muted-foreground">Unknown, status did not load.</p>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Quota</CardTitle>
            <CardDescription>Reviews pause before they compete with your own subscription usage.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {status?.quota ? (
              <div className="space-y-2 rounded-md border p-3">
                <div className="flex items-center justify-between">
                  <Badge tone={quotaTone(status.quota.mode)}>{status.quota.mode}</Badge>
                  <span className="text-xs text-muted-foreground">
                    {status.quota.maxPercent !== null ? `${status.quota.maxPercent}% of the highest window` : "no reading yet"}
                  </span>
                </div>
                {status.quota.windows.length > 0 && (
                  <ul className="space-y-1 text-xs text-muted-foreground">
                    {status.quota.windows.map((window) => (
                      <li key={window.label} className="flex items-center justify-between gap-2">
                        <span>{window.label}</span>
                        <span>
                          {window.percent}%{window.resetText ? ` · ${window.resetText}` : ""}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
                <p className="text-xs text-muted-foreground">
                  Runs today: {status.quota.runsToday} of {status.quota.dailyCap}
                  {status.quota.readAt !== null
                    ? ` · last read ${formatWhen(new Date(status.quota.readAt).toISOString())}`
                    : ""}
                </p>
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">No quota reading yet.</p>
            )}

            {draft && (
              <div className="grid gap-3 sm:grid-cols-3">
                <div className="space-y-1">
                  <Label htmlFor="pause-pct">Pause above %</Label>
                  <Input
                    id="pause-pct"
                    type="number"
                    min={1}
                    max={100}
                    value={draft.pauseAbovePct}
                    onChange={(e) => setDraft({ ...draft, pauseAbovePct: e.target.value })}
                  />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="resume-pct">Resume below %</Label>
                  <Input
                    id="resume-pct"
                    type="number"
                    min={0}
                    max={100}
                    value={draft.resumeBelowPct}
                    onChange={(e) => setDraft({ ...draft, resumeBelowPct: e.target.value })}
                  />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="daily-cap">Daily cap</Label>
                  <Input
                    id="daily-cap"
                    type="number"
                    min={0}
                    max={1000}
                    value={draft.dailyCap}
                    onChange={(e) => setDraft({ ...draft, dailyCap: e.target.value })}
                  />
                </div>
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Polling</CardTitle>
            <CardDescription>How often every watched repository is polled for open PRs.</CardDescription>
          </CardHeader>
          <CardContent>
            {draft && (
              <div className="max-w-[10rem] space-y-1">
                <Label htmlFor="interval">Interval (minutes)</Label>
                <Input
                  id="interval"
                  type="number"
                  min={1}
                  max={1440}
                  value={draft.intervalMinutes}
                  onChange={(e) => setDraft({ ...draft, intervalMinutes: e.target.value })}
                />
              </div>
            )}
            {status?.scheduler && (
              <p className="mt-3 text-xs text-muted-foreground">
                Last cycle {formatWhen(status.scheduler.lastCycleAt)} · next {formatWhen(status.scheduler.nextCycleAt)}
              </p>
            )}
          </CardContent>
        </Card>

        <div className="flex items-center gap-3">
          <Button type="submit" disabled={saving || !draft}>
            {saving ? (
              <>
                <Loader2 className="size-4 animate-spin" /> Saving…
              </>
            ) : (
              <>
                <Save className="size-4" /> Save settings
              </>
            )}
          </Button>
          {saveError && <span className="text-sm text-destructive">{saveError}</span>}
          {!saveError && savedAt && <span className="text-sm text-muted-foreground">Saved.</span>}
        </div>
      </form>

      <Card>
        <CardHeader>
          <CardTitle>Daemon</CardTitle>
          <CardDescription>The background process this UI talks to.</CardDescription>
        </CardHeader>
        <CardContent>
          {status ? (
            <dl className="grid grid-cols-2 gap-y-2 text-sm">
              <dt className="text-muted-foreground">Version</dt>
              <dd>{status.version}</dd>
              <dt className="text-muted-foreground">PID</dt>
              <dd>{status.pid}</dd>
              <dt className="text-muted-foreground">Port</dt>
              <dd>{status.port}</dd>
              <dt className="text-muted-foreground">Started</dt>
              <dd>{formatWhen(status.startedAt)}</dd>
              <dt className="text-muted-foreground">Uptime</dt>
              <dd>{formatUptime(status.uptimeMs)}</dd>
            </dl>
          ) : (
            <p className="text-sm text-muted-foreground">Unknown, status did not load.</p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

export default Settings;

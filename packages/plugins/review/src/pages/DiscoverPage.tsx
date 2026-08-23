/**
 * Repos Discovery TUI Page — browse and manage discovered repos.
 *
 * Shows all repos found on the local machine with status indicators.
 * Accept/deny/unwatch inline with keyboard shortcuts.
 * Runs background scan on page open. Sorted by relevance.
 */

import React, { useState, useEffect } from "react";
import { Box, Text, useInput } from "ink";
import { useScrollableList, useFlash } from "@lgtm/core/tui/hooks/index.js";
import type { ScannedRepo } from "@lgtm/core/registry/scanner.js";
import type { RepoStatus } from "@lgtm/core/registry/reconcile.js";

type RepoEntry = ScannedRepo & { status: RepoStatus };

interface DiscoverPageProps {
  onStatusHint: (hint: string) => void;
}

export function DiscoverPage({ onStatusHint }: DiscoverPageProps) {
  const [repos, setRepos] = useState<RepoEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [counts, setCounts] = useState({ total: 0, watching: 0, new: 0, denied: 0, removed: 0 });
  const [removedCount, setRemovedCount] = useState(0);
  const { flash, showFlash } = useFlash();

  const {
    selectedIdx, visibleItems, moveDown, moveUp, pageDown, pageUp, goTop, goBottom, position,
  } = useScrollableList(repos, { reservedLines: 10 });

  useEffect(() => {
    onStatusHint("↑↓ navigate  a accept  s skip  w unwatch  A all new  r rescan  d/u page");
    runScan();
  }, []);

  async function runScan() {
    setLoading(true);
    try {
      const { scanAllRepos } = await import("@lgtm/core/registry/scanner.js");
      const { reconcile, pruneIngestRegistry, sortRepos } = await import("@lgtm/core/registry/reconcile.js");

      const scanned = await scanAllRepos();
      const result = reconcile(scanned);

      if (result.removed.length > 0) {
        pruneIngestRegistry();
        setRemovedCount(result.removed.length);
      }

      const sorted = sortRepos(result.repos);
      setRepos(sorted);
      setCounts(result.counts);
    } catch (err) {
      showFlash(`Scan failed: ${(err as Error).message}`, "red");
    }
    setLoading(false);
  }

  async function handleAccept(idx: number) {
    const repo = repos[idx];
    if (!repo || repo.status === "watching") return;

    try {
      const { acceptRepo } = await import("@lgtm/core/registry/reconcile.js");
      const result = acceptRepo(repo);

      // No remote means no pull requests to poll, so the repo is recorded but
      // never watched. Reflect that instead of showing a green tick.
      if (!result.changed && result.reason && result.reason !== "already watching") {
        showFlash(`⚠ ${repo.name}: ${result.reason}`, "yellow");
        return;
      }

      updateRepoStatus(idx, "watching");
      setCounts((c) => ({
        ...c,
        watching: c.watching + 1,
        new: repo.status === "new" ? c.new - 1 : c.new,
        denied: repo.status === "denied" ? c.denied - 1 : c.denied,
      }));
      showFlash(`✓ ${repo.name} watching`, "green");
    } catch {
      showFlash("✗ Failed", "red");
    }
  }

  async function handleDeny(idx: number) {
    const repo = repos[idx];
    if (!repo || repo.status === "denied") return;

    try {
      const { denyRepo } = await import("@lgtm/core/registry/reconcile.js");
      denyRepo(repo);
      const wasWatching = repo.status === "watching";
      updateRepoStatus(idx, "denied");
      setCounts((c) => ({
        ...c,
        denied: c.denied + 1,
        watching: wasWatching ? c.watching - 1 : c.watching,
        new: repo.status === "new" ? c.new - 1 : c.new,
      }));
      showFlash(`○ ${repo.name} skipped`, "gray");
    } catch {
      showFlash("✗ Failed", "red");
    }
  }

  async function handleUnwatch(idx: number) {
    const repo = repos[idx];
    if (!repo || repo.status !== "watching") return;

    try {
      const { denyRepo } = await import("@lgtm/core/registry/reconcile.js");
      denyRepo(repo);
      updateRepoStatus(idx, "denied");
      setCounts((c) => ({ ...c, watching: c.watching - 1, denied: c.denied + 1 }));
      showFlash(`⊘ ${repo.name} unwatched`, "yellow");
    } catch {
      showFlash("✗ Failed", "red");
    }
  }

  async function handleAcceptAllNew() {
    const { acceptRepo } = await import("@lgtm/core/registry/reconcile.js");
    let watched = 0;
    let unwatchable = 0;

    const updated = repos.map((r) => {
      if (r.status !== "new") return r;

      const result = acceptRepo(r);
      const reachedWatcher = result.changed || result.reason === "already watching";

      if (reachedWatcher) {
        watched++;
        return { ...r, status: "watching" as const };
      }

      unwatchable++;
      return r;
    });

    setRepos(updated);
    setCounts((c) => ({ ...c, watching: c.watching + watched, new: unwatchable }));
    showFlash(
      unwatchable > 0
        ? `✓ ${watched} watching, ${unwatchable} without a remote`
        : `✓ Accepted ${watched} repos`,
      unwatchable > 0 ? "yellow" : "green"
    );
  }

  function updateRepoStatus(idx: number, newStatus: RepoStatus) {
    setRepos((prev) => {
      const updated = [...prev];
      updated[idx] = { ...updated[idx], status: newStatus };
      return updated;
    });
  }

  useInput((input, key) => {
    if (loading) return;
    if (key.downArrow || input === "j") moveDown();
    if (key.upArrow || input === "k") moveUp();
    if (input === "d") pageDown();
    if (input === "u") pageUp();
    if (input === "g") goTop();
    if (input === "G") goBottom();
    if (input === "a") handleAccept(selectedIdx);
    if (input === "s") handleDeny(selectedIdx);
    if (input === "w") handleUnwatch(selectedIdx);
    if (input === "A") handleAcceptAllNew();
    if (input === "r") { showFlash("Scanning...", "gray"); runScan(); }
  });

  // ── Render ──────────────────────────────────────────────────────────────

  if (loading) {
    return <Text color="gray">  Scanning for repos...</Text>;
  }

  if (repos.length === 0) {
    return (
      <Box flexDirection="column" paddingY={1}>
        <Text color="gray">  No git repos found. Try: lgtm discover --ingest ~/projects</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      {/* Header */}
      <Text bold>
        {"  "}Repos — {counts.total} discovered ({" "}
        <Text color="green">{counts.watching} watching</Text>,{" "}
        <Text color="cyan">{counts.new} new</Text>,{" "}
        <Text color="gray">{counts.denied} skipped</Text>){"  "}
        <Text color="gray">{position}</Text>
      </Text>
      <Text> </Text>

      {/* Flash message */}
      {flash && <Text color={flash.color}>  {flash.text}</Text>}

      {/* Column headers */}
      <Text color="gray">
        {"  "}{"Stat".padEnd(6)}{"Name".padEnd(22)}{"Remote".padEnd(28)}{"Activity".padEnd(10)}{"Lang"}
      </Text>
      <Text color="gray">{"  " + "─".repeat(70)}</Text>

      {/* Repo list */}
      {visibleItems.map((repo) => {
        const isSelected = repos.indexOf(repo) === selectedIdx;
        const cursor = isSelected ? "▸" : " ";
        const icon = statusIcon(repo.status);
        const name = repo.name.slice(0, 20).padEnd(22);
        const remote = repo.owner && repo.repoName
          ? `${repo.platform ?? ""}:${repo.owner}/${repo.repoName}`.slice(0, 26).padEnd(28)
          : "(local)".padEnd(28);
        const activity = formatActivity(repo.lastCommitDate).padEnd(10);
        const lang = (repo.language ?? "—").slice(0, 10);

        return (
          <Text key={repo.path} color={isSelected ? "cyan" : undefined} bold={isSelected}>
            {`  ${cursor} ${icon} ${name}${remote}${activity}${lang}`}
          </Text>
        );
      })}

      {/* Removed warning */}
      {removedCount > 0 && (
        <Box marginTop={1}>
          <Text color="yellow">{"  "}⚠ {removedCount} repo(s) removed (no longer on disk)</Text>
        </Box>
      )}
    </Box>
  );
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function statusIcon(status: RepoStatus): string {
  switch (status) {
    case "watching": return "👁";
    case "new": return "✦";
    case "denied": return "○";
    case "removed": return "⚠";
  }
}

function formatActivity(date?: string): string {
  if (!date) return "—";
  const now = Date.now();
  const then = new Date(date).getTime();
  const diffMs = now - then;
  const days = Math.floor(diffMs / (24 * 60 * 60 * 1000));

  if (days === 0) return "today";
  if (days === 1) return "1d ago";
  if (days < 30) return `${days}d ago`;
  if (days < 365) return `${Math.floor(days / 30)}mo ago`;
  return `${Math.floor(days / 365)}y ago`;
}

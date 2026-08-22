/**
 * History Page — browse past review sessions with drill-down.
 *
 * List view: shows sessions by date with PR counts.
 * Detail view (Enter): shows individual PR reviews with comments.
 */

import React, { useState, useEffect } from "react";
import { Box, Text, useInput, useApp } from "ink";

interface SessionSummary {
  date: string;
  prsReviewed: number;
  approved: number;
  flagged: number;
}

interface ReviewDetail {
  prNumber: number;
  title: string;
  state: string;
  comments: number;
  reviewedAt?: string;
  body: string;
}

interface HistoryPageProps {
  onStatusHint: (hint: string) => void;
}

type View = { type: "list" } | { type: "detail"; date: string; reviews: ReviewDetail[]; selectedIdx: number };

export function HistoryPage({ onStatusHint }: HistoryPageProps) {
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [selectedIdx, setSelectedIdx] = useState(0);
  const [view, setView] = useState<View>({ type: "list" });
  const [loading, setLoading] = useState(true);
  const { exit } = useApp();

  useEffect(() => {
    onStatusHint("↑↓ navigate  enter view  q quit");
    loadHistory();
  }, []);

  async function loadHistory() {
    try {
      const { createOKFStore } = await import("@lgtm/core/store/okf.js");
      const { findGitRoot } = await import("@lgtm/core/store/paths.js");
      const { loadBootstrap, resolveLgtmDir } = await import("@lgtm/core/config/loader.js");
      const fs = await import("fs");
      const path = await import("path");

      const repoRoot = findGitRoot();
      const bootstrap = loadBootstrap();
      const lgtmDir = resolveLgtmDir(bootstrap, repoRoot);
      const sessionsDir = path.default.join(lgtmDir, "sessions");

      if (!fs.default.existsSync(sessionsDir)) {
        setLoading(false);
        return;
      }

      const dirs = fs.default.readdirSync(sessionsDir, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name)
        .sort()
        .reverse();

      const store = createOKFStore(lgtmDir);
      const summaries: SessionSummary[] = [];

      for (const date of dirs.slice(0, 20)) {
        const doc = await store.read(`sessions/${date}/index.md`);
        if (!doc?.data?.prs) continue;

        const prs = doc.data.prs as Array<{ state: string }>;
        summaries.push({
          date,
          prsReviewed: prs.length,
          approved: prs.filter((p) => p.state === "approved").length,
          flagged: prs.filter((p) => p.state === "flagged").length,
        });
      }

      setSessions(summaries);
    } catch { /* no history */ }
    setLoading(false);
  }

  async function drillIntoSession(date: string) {
    try {
      const { createOKFStore } = await import("@lgtm/core/store/okf.js");
      const { findGitRoot } = await import("@lgtm/core/store/paths.js");
      const { loadBootstrap, resolveLgtmDir } = await import("@lgtm/core/config/loader.js");

      const repoRoot = findGitRoot();
      const bootstrap = loadBootstrap();
      const lgtmDir = resolveLgtmDir(bootstrap, repoRoot);
      const store = createOKFStore(lgtmDir);

      // List all pr-*.md files in this session directory
      const files = await store.list(`sessions/${date}`);
      const reviews: ReviewDetail[] = [];

      for (const file of files) {
        if (file.endsWith("index.md")) continue;
        const doc = await store.read(file);
        if (!doc || doc.data.type !== "lgtm/review") continue;

        reviews.push({
          prNumber: (doc.data.pr as number) ?? 0,
          title: (doc.data.title as string) ?? `PR #${doc.data.pr}`,
          state: (doc.data.state as string) ?? "unknown",
          comments: (doc.data.comments_count as number) ?? 0,
          reviewedAt: doc.data.reviewed_at as string | undefined,
          body: doc.content,
        });
      }

      reviews.sort((a, b) => a.prNumber - b.prNumber);

      onStatusHint("↑↓ navigate  esc/backspace back  q quit");
      setView({ type: "detail", date, reviews, selectedIdx: 0 });
    } catch {
      // Can't drill — stay on list
    }
  }

  useInput((input, key) => {
    if (view.type === "list") {
      if (key.downArrow || input === "j") {
        setSelectedIdx((prev) => Math.min(prev + 1, sessions.length - 1));
      }
      if (key.upArrow || input === "k") {
        setSelectedIdx((prev) => Math.max(prev - 1, 0));
      }
      if (key.return && sessions[selectedIdx]) {
        drillIntoSession(sessions[selectedIdx].date);
      }
      if (input === "q") {
        exit();
      }
    } else if (view.type === "detail") {
      if (key.downArrow || input === "j") {
        setView({ ...view, selectedIdx: Math.min(view.selectedIdx + 1, view.reviews.length - 1) });
      }
      if (key.upArrow || input === "k") {
        setView({ ...view, selectedIdx: Math.max(view.selectedIdx - 1, 0) });
      }
      if (key.escape || key.backspace || input === "b") {
        onStatusHint("↑↓ navigate  enter view  q quit");
        setView({ type: "list" });
      }
      if (input === "q") {
        exit();
      }
    }
  });

  if (loading) return <Text color="gray">Loading history...</Text>;

  // ─── Detail View ──────────────────────────────────────────────────────
  if (view.type === "detail") {
    if (view.reviews.length === 0) {
      return (
        <Box flexDirection="column" paddingY={1}>
          <Text color="gray">← {view.date}</Text>
          <Text color="gray">No review files found for this session.</Text>
          <Text color="gray">Press Esc or 'b' to go back.</Text>
        </Box>
      );
    }

    const selected = view.reviews[view.selectedIdx];

    return (
      <Box flexDirection="column">
        <Box marginBottom={1}>
          <Text bold>Session: {view.date}</Text>
          <Text color="gray"> — {view.reviews.length} PR(s) reviewed</Text>
          <Text color="gray">  (esc/b to go back)</Text>
        </Box>

        {/* PR list */}
        {view.reviews.map((r, i) => {
          const isSelected = i === view.selectedIdx;
          const stateIcon = r.state === "approved" ? "✓" : r.state === "flagged" ? "✗" : "◉";
          const stateColor = r.state === "approved" ? "green" : r.state === "flagged" ? "red" : "yellow";

          return (
            <Box key={r.prNumber}>
              <Text inverse={isSelected} bold={isSelected}>
                {isSelected ? "❯ " : "  "}
                <Text color={stateColor}>{stateIcon}</Text>
                {" "}#{r.prNumber} {r.title.slice(0, 40)}
                <Text color="gray"> ({r.comments} comment{r.comments !== 1 ? "s" : ""})</Text>
              </Text>
            </Box>
          );
        })}

        {/* Detail panel for selected review */}
        {selected && (
          <Box flexDirection="column" marginTop={1} paddingLeft={2} borderStyle="single" borderColor="gray">
            <Text bold>PR #{selected.prNumber}: {selected.title}</Text>
            <Text color="gray">State: {selected.state} · Comments: {selected.comments}{selected.reviewedAt ? ` · ${selected.reviewedAt.split("T")[0]}` : ""}</Text>
            <Box marginTop={1}>
              <Text>{selected.body.slice(0, 500)}{selected.body.length > 500 ? "..." : ""}</Text>
            </Box>
          </Box>
        )}
      </Box>
    );
  }

  // ─── List View ────────────────────────────────────────────────────────
  if (sessions.length === 0) {
    return (
      <Box flexDirection="column" paddingY={1}>
        <Text color="gray">No review sessions yet.</Text>
        <Text color="gray">Complete a review to see history here.</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      <Box marginBottom={1}>
        <Text bold>Review History ({sessions.length} sessions)</Text>
      </Box>

      {sessions.map((s, i) => {
        const isSelected = i === selectedIdx;
        return (
          <Box key={s.date}>
            <Text inverse={isSelected} bold={isSelected}>
              {isSelected ? "❯ " : "  "}
              {s.date}{"  "}
              {s.prsReviewed} PR(s){"  "}
              <Text color="green">{s.approved} ✓</Text>{"  "}
              <Text color="red">{s.flagged} ✗</Text>
            </Text>
          </Box>
        );
      })}

      <Box marginTop={1}>
        <Text color="gray">Press Enter to view session details</Text>
      </Box>
    </Box>
  );
}

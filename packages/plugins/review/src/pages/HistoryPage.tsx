/**
 * History Page — browse past review sessions.
 */

import React, { useState, useEffect } from "react";
import { Box, Text, useInput, useApp } from "ink";

interface SessionSummary {
  date: string;
  prsReviewed: number;
  approved: number;
  flagged: number;
}

interface HistoryPageProps {
  onStatusHint: (hint: string) => void;
}

export function HistoryPage({ onStatusHint }: HistoryPageProps) {
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [selectedIdx, setSelectedIdx] = useState(0);
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
      const { loadBootstrap, resolveYakDir } = await import("@lgtm/core/config/loader.js");
      const fs = await import("fs");
      const path = await import("path");

      const repoRoot = findGitRoot();
      const bootstrap = loadBootstrap();
      const lgtmDir = resolveYakDir(bootstrap, repoRoot);
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

      for (const date of dirs.slice(0, 20)) { // last 20 sessions
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

  useInput((input, key) => {
    if (key.downArrow || input === "j") {
      setSelectedIdx((prev) => Math.min(prev + 1, sessions.length - 1));
    }
    if (key.upArrow || input === "k") {
      setSelectedIdx((prev) => Math.max(prev - 1, 0));
    }
    if (input === "q") {
      exit();
    }
  });

  if (loading) return <Text color="gray">Loading history...</Text>;

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
    </Box>
  );
}

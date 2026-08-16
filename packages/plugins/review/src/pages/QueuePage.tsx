/**
 * Queue Page — TUI page showing the review queue.
 *
 * Lists all PRs with states, feature groups, and navigation.
 * Arrow keys to select, Enter to open review (future Task 9).
 */

import React, { useState, useEffect } from "react";
import { Box, Text, useInput } from "ink";

interface QueuePageProps {
  onStatusHint: (hint: string) => void;
}

interface DisplayPR {
  number: number;
  title: string;
  state: string;
  filesChanged: number;
  featureGroup?: string;
  flagReason?: string;
}

export function QueuePage({ onStatusHint }: QueuePageProps) {
  const [prs, setPrs] = useState<DisplayPR[]>([]);
  const [selectedIdx, setSelectedIdx] = useState(0);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    onStatusHint("↑↓ navigate  enter review  a approve  f flag  q quit");
    loadQueue();
  }, []);

  async function loadQueue() {
    try {
      // Dynamic import to avoid circular deps
      const { createOKFStore } = await import("@yak/core/store/okf.js");
      const { findGitRoot } = await import("@yak/core/store/paths.js");
      const { loadBootstrap, resolveYakDir } = await import("@yak/core/config/loader.js");

      const repoRoot = findGitRoot();
      const bootstrap = loadBootstrap();
      const yakDir = resolveYakDir(bootstrap, repoRoot);
      const store = createOKFStore(yakDir);

      const date = new Date().toISOString().split("T")[0];
      const doc = await store.read(`sessions/${date}/index.md`);

      if (doc && Array.isArray(doc.data.prs)) {
        setPrs(
          (doc.data.prs as any[]).map((pr) => ({
            number: pr.number,
            title: pr.title,
            state: pr.state,
            filesChanged: Array.isArray(pr.filesChanged) ? pr.filesChanged.length : 0,
            featureGroup: pr.featureGroup,
            flagReason: pr.flagReason,
          }))
        );
      }
    } catch {
      // No session yet
    }
    setLoading(false);
  }

  useInput((input, key) => {
    if (prs.length === 0) return;

    if (key.downArrow || input === "j") {
      setSelectedIdx((prev) => Math.min(prev + 1, prs.length - 1));
    }
    if (key.upArrow || input === "k") {
      setSelectedIdx((prev) => Math.max(prev - 1, 0));
    }
    // Enter: will open review in Task 9
    if (key.return) {
      // placeholder — Task 9 will navigate to ReviewPage
    }
  });

  if (loading) {
    return (
      <Box>
        <Text color="gray">Loading queue...</Text>
      </Box>
    );
  }

  if (prs.length === 0) {
    return (
      <Box flexDirection="column" paddingY={1}>
        <Text color="gray">
          No PRs in queue. Add some with: yak review add {"<numbers...>"}
        </Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      <Box marginBottom={1}>
        <Text bold>Review Queue</Text>
        <Text color="gray"> — {prs.length} PR(s)</Text>
      </Box>

      {/* Table header */}
      <Box>
        <Text color="gray">
          {"  "}#{"    "}State{"      "}Title{"                         "}Files{"  "}Group
        </Text>
      </Box>

      {/* PR rows */}
      {prs.map((pr, i) => (
        <Box key={pr.number}>
          <Text>
            {i === selectedIdx ? "❯ " : "  "}
            {stateIcon(pr.state)} {String(pr.number).padEnd(4)}{" "}
            {stateLabel(pr.state)}{"  "}
            {pr.title.length > 28 ? pr.title.slice(0, 25) + "..." : pr.title.padEnd(28)}{"  "}
            {String(pr.filesChanged).padStart(3)}{"  "}
            {pr.featureGroup ?? ""}
            {pr.flagReason ? ` — ${pr.flagReason}` : ""}
          </Text>
        </Box>
      ))}

      {/* Summary */}
      <Box marginTop={1}>
        <Text color="green">{prs.filter((p) => p.state === "approved").length} approved</Text>
        <Text>{"  "}</Text>
        <Text color="red">{prs.filter((p) => p.state === "flagged").length} flagged</Text>
        <Text>{"  "}</Text>
        <Text color="yellow">{prs.filter((p) => p.state === "queued" || p.state === "reviewing").length} pending</Text>
      </Box>
    </Box>
  );
}

function stateIcon(state: string): string {
  switch (state) {
    case "approved": return "✓";
    case "flagged": return "✗";
    case "reviewing": return "◉";
    default: return "○";
  }
}

function stateLabel(state: string): string {
  switch (state) {
    case "approved": return "approved ";
    case "flagged": return "flagged  ";
    case "reviewing": return "reviewing";
    default: return "queued   ";
  }
}

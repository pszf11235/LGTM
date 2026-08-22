/**
 * Dashboard TUI Page — shows what needs your attention.
 *
 * Sections: PRs to review, Activity on your work, Replies awaiting
 * Navigate with arrows, Enter to open link, d to dismiss.
 */

import React, { useState, useEffect } from "react";
import { Box, Text, useInput, useApp } from "ink";
import type { AttentionItem } from "../domain/attention.js";

interface DashboardPageProps {
  onStatusHint: (hint: string) => void;
}

export function DashboardPage({ onStatusHint }: DashboardPageProps) {
  const [items, setItems] = useState<AttentionItem[]>([]);
  const [selectedIdx, setSelectedIdx] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const { exit } = useApp();

  useEffect(() => {
    onStatusHint("↑↓ navigate  enter open  d dismiss  r refresh  q quit");
    loadItems();
  }, []);

  async function loadItems() {
    setLoading(true);
    setError(null);
    try {
      const { collectAttentionItems, loadDismissed, filterDismissed } = await import("../domain/attention.js");
      const { createOKFStore } = await import("@lgtm/core/store/okf.js");
      const { findGitRoot } = await import("@lgtm/core/store/paths.js");
      const { loadBootstrap, resolveLgtmDir } = await import("@lgtm/core/config/loader.js");

      const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
      if (!token) {
        setError("Set GITHUB_TOKEN to use the dashboard");
        setLoading(false);
        return;
      }

      const repoRoot = findGitRoot();
      const bootstrap = loadBootstrap();
      const lgtmDir = resolveLgtmDir(bootstrap, repoRoot);
      const store = createOKFStore(lgtmDir);

      const allItems = await collectAttentionItems(store, token);
      const dismissed = await loadDismissed(store);
      const filtered = filterDismissed(allItems, dismissed);

      setItems(filtered);
    } catch (err) {
      setError((err as Error).message);
    }
    setLoading(false);
  }

  useInput((input, key) => {
    if (key.downArrow || input === "j") {
      setSelectedIdx((prev) => Math.min(prev + 1, items.length - 1));
    }
    if (key.upArrow || input === "k") {
      setSelectedIdx((prev) => Math.max(prev - 1, 0));
    }
    if (input === "q") {
      exit();
    }
    if (input === "r") {
      loadItems();
    }
    if (input === "d" && items[selectedIdx]) {
      // Dismiss selected item
      dismissSelected();
    }
  });

  async function dismissSelected() {
    const item = items[selectedIdx];
    if (!item) return;

    try {
      const { dismissItem } = await import("../domain/attention.js");
      const { createOKFStore } = await import("@lgtm/core/store/okf.js");
      const { findGitRoot } = await import("@lgtm/core/store/paths.js");
      const { loadBootstrap, resolveLgtmDir } = await import("@lgtm/core/config/loader.js");

      const repoRoot = findGitRoot();
      const bootstrap = loadBootstrap();
      const lgtmDir = resolveLgtmDir(bootstrap, repoRoot);
      const store = createOKFStore(lgtmDir);

      await dismissItem(store, item.id);
      setItems((prev) => prev.filter((i) => i.id !== item.id));
      if (selectedIdx >= items.length - 1) {
        setSelectedIdx(Math.max(0, selectedIdx - 1));
      }
    } catch { /* silent */ }
  }

  if (loading) {
    return (
      <Box paddingY={1}>
        <Text color="gray">Fetching attention items from watched repos...</Text>
      </Box>
    );
  }

  if (error) {
    return (
      <Box paddingY={1} flexDirection="column">
        <Text color="red">Error: {error}</Text>
        <Text color="gray">Set GITHUB_TOKEN and add repos: lgtm review watch add owner/repo</Text>
      </Box>
    );
  }

  if (items.length === 0) {
    return (
      <Box paddingY={1} flexDirection="column">
        <Text color="green">✓ All clear! Nothing needs your attention.</Text>
        <Text color="gray">Watch repos: lgtm review watch add owner/repo</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      <Box marginBottom={1}>
        <Text bold>📬 {items.length} item(s) need attention</Text>
      </Box>

      {items.map((item, i) => {
        const isSelected = i === selectedIdx;
        const urgencyColor =
          item.urgency === "high" ? "red" :
          item.urgency === "medium" ? "yellow" : "green";

        return (
          <Box key={item.id} flexDirection="column" marginBottom={0}>
            <Text inverse={isSelected} bold={isSelected}>
              {isSelected ? "❯ " : "  "}
              <Text color={urgencyColor}>●</Text>
              {" "}#{item.prNumber} {item.title}
            </Text>
            <Text color="gray">
              {"    "}{item.repo}{item.author ? ` by @${item.author}` : ""} · {formatAge(item.age)}
            </Text>
            <Text color="gray">
              {"    "}{item.context}
            </Text>
            {isSelected && (
              <Text color="cyan">{"    "}{item.url}</Text>
            )}
          </Box>
        );
      })}

      <Box marginTop={1}>
        <Text color="gray">
          {items.filter((i) => i.urgency === "high").length} urgent · {items.filter((i) => i.urgency === "medium").length} medium · {items.filter((i) => i.urgency === "low").length} low
        </Text>
      </Box>
    </Box>
  );
}

function formatAge(hours: number): string {
  if (hours < 1) return "just now";
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

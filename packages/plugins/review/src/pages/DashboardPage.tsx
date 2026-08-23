/**
 * Dashboard TUI Page — shows what needs your attention.
 *
 * Sections: PRs to review, Activity on your work, Replies awaiting
 * Navigate with arrows, x to dismiss, r to refresh.
 */

import React, { useState, useEffect } from "react";
import { Box, Text, useInput } from "ink";
import type { AttentionItem } from "../domain/attention.js";
import { useScrollableList, useFlash } from "@lgtm/core/tui/hooks/index.js";

interface DashboardPageProps {
  onStatusHint: (hint: string) => void;
}

export function DashboardPage({ onStatusHint }: DashboardPageProps) {
  const [items, setItems] = useState<AttentionItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const { flash, showFlash } = useFlash();

  const {
    selectedIdx, visibleItems, moveDown, moveUp, pageDown, pageUp, goTop, goBottom, position,
  } = useScrollableList(items, { reservedLines: 9 });

  useEffect(() => {
    onStatusHint("↑↓ navigate  x dismiss  r refresh  d/u page");
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

      const { resolveGitHubToken } = await import("@lgtm/core/auth/github-oauth.js");
      const token = resolveGitHubToken();
      if (!token) {
        setError("No GitHub token. Run `gh auth login` or set GITHUB_TOKEN.");
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
    if (key.downArrow || input === "j") moveDown();
    if (key.upArrow || input === "k") moveUp();
    if (input === "d") pageDown();
    if (input === "u") pageUp();
    if (input === "g") goTop();
    if (input === "G") goBottom();
    if (input === "r") {
      showFlash("Refreshing...", "gray");
      loadItems();
    }
    if (input === "x" && items[selectedIdx]) {
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
      showFlash(`✓ Dismissed: ${item.title}`, "green");
    } catch {
      showFlash("✗ Failed to dismiss", "red");
    }
  }

  if (loading) {
    return (
      <Box paddingY={1}>
        <Text color="gray">  Fetching attention items from watched repos...</Text>
      </Box>
    );
  }

  if (error) {
    return (
      <Box paddingY={1} flexDirection="column">
        <Text color="red">  Error: {error}</Text>
        <Text color="gray">  Set GITHUB_TOKEN and add repos: lgtm review watch add owner/repo</Text>
      </Box>
    );
  }

  if (items.length === 0) {
    return (
      <Box paddingY={1} flexDirection="column">
        <Text color="green">  ✓ All clear! Nothing needs your attention.</Text>
        <Text color="gray">  Watch repos: lgtm review watch add owner/repo</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      <Box marginBottom={1}>
        <Text bold>  📬 {items.length} item(s) need attention</Text>
        <Text color="gray">  {position}</Text>
      </Box>

      {flash && <Text color={flash.color}>  {flash.text}</Text>}

      {visibleItems.map((item, i) => {
        const realIdx = i + (selectedIdx - visibleItems.indexOf(items[selectedIdx]) >= 0 ? 0 : 0);
        const isSelected = items.indexOf(item) === selectedIdx;
        const urgencyColor =
          item.urgency === "high" ? "red" :
          item.urgency === "medium" ? "yellow" : "green";

        return (
          <Box key={item.id} flexDirection="column" marginBottom={0}>
            <Text inverse={isSelected} bold={isSelected}>
              {isSelected ? "▸ " : "  "}
              <Text color={urgencyColor}>●</Text>
              {" "}#{item.prNumber} {item.title}
            </Text>
            <Text color="gray">
              {"    "}{item.repo}{item.author ? ` by @${item.author}` : ""} · {formatAge(item.age)}
            </Text>
            <Text color="gray">
              {"    "}{item.context}
            </Text>
          </Box>
        );
      })}
    </Box>
  );
}

function formatAge(hours: number): string {
  if (hours < 1) return "just now";
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

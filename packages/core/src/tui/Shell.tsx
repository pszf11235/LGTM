/**
 * TUI Shell — the top-level Ink component.
 *
 * Layout:
 * - Line 1: Tool name + version (👍 lgtm v0.1.0)
 * - Line 2: Tabs (left-aligned, active highlighted)
 * - Line 3: Context (repo name + path)
 * - Content: Active page (scrollable)
 * - Status: Left = page shortcuts/flash, Right = position + "←→ tabs"
 *
 * Navigation: Tab/Shift+Tab OR ←/→ arrows switch tabs.
 * Quit: Only Ctrl+C (pages handle q for back/no-op).
 */

import React, { useState } from "react";
import { Box, Text, useApp, useInput, useStdout } from "ink";
import { theme, borderLine } from "./theme.js";

export interface TabDefinition {
  name: string;
  label: string;
  enabled: boolean;
  component: React.ComponentType<any>;
}

interface ShellProps {
  tabs: TabDefinition[];
  initialTab?: string;
  repoName?: string;
  repoPath?: string;
  watchCount?: number;
  aiStatus?: { available: boolean; provider?: string };
  webappUrl?: string;
}

export function Shell({ tabs, initialTab, repoName, repoPath, watchCount, aiStatus, webappUrl }: ShellProps) {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const termWidth = stdout?.columns ?? 80;
  const termHeight = stdout?.rows ?? 24;

  const enabledTabs = tabs.filter((t) => t.enabled);
  const initialIdx = initialTab
    ? enabledTabs.findIndex((t) => t.name === initialTab)
    : 0;
  const [activeTabIdx, setActiveTabIdx] = useState(Math.max(0, initialIdx));
  const [statusHint, setStatusHint] = useState("←→ switch tabs  ctrl+c quit");

  useInput((input, key) => {
    // Tab / Shift+Tab: cycle through tabs
    if (key.tab && !key.shift) {
      setActiveTabIdx((prev) => (prev + 1) % enabledTabs.length);
      return;
    }
    if (key.tab && key.shift) {
      setActiveTabIdx((prev) => (prev - 1 + enabledTabs.length) % enabledTabs.length);
      return;
    }

    // Left/Right arrows: switch tabs
    if (key.leftArrow) {
      setActiveTabIdx((prev) => (prev - 1 + enabledTabs.length) % enabledTabs.length);
      return;
    }
    if (key.rightArrow) {
      setActiveTabIdx((prev) => (prev + 1) % enabledTabs.length);
      return;
    }
  });

  const ActivePage = enabledTabs[activeTabIdx]?.component;

  return (
    <Box flexDirection="column" height={termHeight}>
      {/* Title line */}
      <Box>
        <Text bold>{"  "}👍 {theme.bold("lgtm")} <Text color="gray">v0.1.0</Text></Text>
      </Box>

      {/* Tabs line (left-aligned) */}
      <Box>
        <Text>{"  "}{renderTabs(enabledTabs, activeTabIdx)}</Text>
      </Box>

      {/* Context line */}
      <Box>
        <Text color="gray">
          {"  "}reviewing: {repoName ?? "unknown"}  {repoPath ?? ""}
        </Text>
      </Box>

      {/* Separator */}
      <Box>
        <Text>{borderLine(termWidth)}</Text>
      </Box>

      {/* Page content */}
      <Box flexDirection="column" flexGrow={1} paddingX={1}>
        {ActivePage ? (
          <ActivePage onStatusHint={setStatusHint} />
        ) : (
          <Text color="gray">No plugins enabled.</Text>
        )}
      </Box>

      {/* Status bar */}
      <Box>
        <Text>{borderLine(termWidth)}</Text>
      </Box>
      <Box justifyContent="space-between" width={termWidth}>
        <Text color="gray">{"  "}{statusHint}</Text>
        <Text color="gray">
          {webappUrl ? theme.primary(`🌐 ${webappUrl}`) : ""}
          {"  "}
          {aiStatus ? (aiStatus.available ? theme.success(`AI: ✓ ${aiStatus.provider ?? ""}`) : theme.error("AI: ✗")) : ""}
          {"  "}
          {activeTabIdx + 1}/{enabledTabs.length}{"  "}←→ tabs{"  "}
        </Text>
      </Box>
    </Box>
  );
}

function renderTabs(tabs: TabDefinition[], activeIdx: number): string {
  return tabs
    .map((tab, i) => {
      if (i === activeIdx) return theme.tab.active(tab.label);
      return theme.tab.inactive(tab.label);
    })
    .join(" ");
}

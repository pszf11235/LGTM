/**
 * TUI Shell — the top-level Ink component.
 *
 * Renders:
 * - Header with lgtm logo + plugin tabs
 * - Active page content (from selected plugin tab)
 * - Status bar with context-sensitive keybindings
 *
 * OpenCode-style: full-screen, minimal chrome, keyboard-driven.
 */

import React, { useState, useEffect } from "react";
import { Box, Text, useApp, useInput, useStdout } from "ink";
import { theme, borderLine, headerBar } from "./theme.js";

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
}

export function Shell({ tabs, initialTab, repoName, repoPath }: ShellProps) {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const termWidth = stdout?.columns ?? 80;
  const termHeight = stdout?.rows ?? 24;

  const enabledTabs = tabs.filter((t) => t.enabled);
  const initialIdx = initialTab
    ? enabledTabs.findIndex((t) => t.name === initialTab)
    : 0;
  const [activeTabIdx, setActiveTabIdx] = useState(Math.max(0, initialIdx));
  const [statusHint, setStatusHint] = useState("ctrl+c quit  tab switch");

  useInput((input, key) => {
    // Tab key: cycle through tabs
    if (key.tab) {
      setActiveTabIdx((prev) => (prev + 1) % enabledTabs.length);
      return;
    }

    // Shift+Tab: cycle backwards
    if (key.shift && key.tab) {
      setActiveTabIdx(
        (prev) => (prev - 1 + enabledTabs.length) % enabledTabs.length
      );
      return;
    }

    // Ctrl+C: always quit (global escape hatch)
    // Note: 'q' is NOT handled here — pages handle their own q key.
    // Shell only exits via Ctrl+C. Pages use q for "back" navigation.
  });

  const ActivePage = enabledTabs[activeTabIdx]?.component;

  return (
    <Box flexDirection="column" height={termHeight}>
      {/* Header */}
      <Box>
        <Text>
          {headerBar(
            `👍 ${theme.bold("lgtm")}`,
            renderTabs(enabledTabs, activeTabIdx),
            termWidth
          )}
        </Text>
      </Box>
      <Box>
        <Text>{theme.muted(`reviewing: ${repoName ?? "unknown"}  ${repoPath ? theme.muted(repoPath) : ""}`)}</Text>
      </Box>
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
        <Text color="gray">{statusHint}</Text>
        <Text color="gray">
          {activeTabIdx + 1}/{enabledTabs.length}
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
    .join("");
}

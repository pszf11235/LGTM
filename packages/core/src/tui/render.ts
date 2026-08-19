/**
 * TUI Renderer — launches the Ink app.
 *
 * This is the entry point for `lgtm` (bare) and `lgtm tui [plugin]`.
 * Creates the Ink instance, renders the Shell with plugin tabs.
 */

import React from "react";
import { render } from "ink";
import { Shell, type TabDefinition } from "./Shell.js";

interface LaunchOptions {
  tabs: TabDefinition[];
  initialTab?: string;
  repoName?: string;
  repoPath?: string;
  watchCount?: number;
  aiStatus?: { available: boolean; provider?: string };
}

/**
 * Launch the TUI with the given tabs.
 */
export async function launchTUI(options: LaunchOptions): Promise<void> {
  const { waitUntilExit } = render(
    React.createElement(Shell, {
      tabs: options.tabs,
      initialTab: options.initialTab,
      repoName: options.repoName,
      repoPath: options.repoPath,
      watchCount: options.watchCount,
      aiStatus: options.aiStatus,
    })
  );
  await waitUntilExit();
}

/**
 * TUI Renderer — launches the Ink app.
 *
 * This is the entry point for `lgtm` (bare) and `lgtm tui [plugin]`.
 * Creates the Ink instance, renders the Shell with plugin tabs.
 * Also starts the embedded webapp server (accessible at http://localhost:4040).
 */

import React from "react";
import { render } from "ink";
import { Shell, type TabDefinition } from "./Shell.js";
import { startWebappServer } from "./webapp-server.js";

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
 * Also starts the webapp server on localhost:4040.
 */
export async function launchTUI(options: LaunchOptions): Promise<void> {
  // Start the embedded webapp server
  const projectRoot = options.repoPath ?? process.cwd();
  const webappServer = await startWebappServer(projectRoot);

  const { waitUntilExit } = render(
    React.createElement(Shell, {
      tabs: options.tabs,
      initialTab: options.initialTab,
      repoName: options.repoName,
      repoPath: options.repoPath,
      watchCount: options.watchCount,
      aiStatus: options.aiStatus,
      webappUrl: webappServer?.url,
    })
  );

  await waitUntilExit();

  // Stop the webapp server when TUI exits
  if (webappServer) {
    webappServer.stop();
  }
}

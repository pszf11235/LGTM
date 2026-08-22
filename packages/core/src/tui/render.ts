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
import { AITab } from "./AITab.js";
import { startWebappServer } from "./webapp-server.js";
import type { LGTMPlugin, LGTMContext } from "../plugin.js";

interface LaunchOptions {
  tabs: TabDefinition[];
  initialTab?: string;
  repoName?: string;
  repoPath?: string;
  watchCount?: number;
  aiStatus?: { available: boolean; provider?: string };
}

/**
 * Options for the high-level buildAndLaunchTUI helper.
 */
export interface BuildAndLaunchTUIOptions {
  ctx: LGTMContext;
  plugins: LGTMPlugin[];
  initialTab?: string;
}

/**
 * High-level helper that builds TUI tabs from discovered plugins,
 * determines AI status and watch count, then launches the TUI.
 *
 * Used by both the bare `lgtm` path and `lgtm init` to avoid duplication.
 */
export async function buildAndLaunchTUI(options: BuildAndLaunchTUIOptions): Promise<void> {
  const { ctx, plugins, initialTab } = options;
  const path = await import("path");

  const repoName = path.default.basename(ctx.repoRoot);
  const repoPath = ctx.repoRoot;

  // Build tabs dynamically from discovered plugins (all pages, flattened)
  const tabs: TabDefinition[] = plugins
    .filter((p) => ctx.config.plugins[p.name]?.enabled !== false)
    .flatMap((p) => {
      if (p.pages && p.pages.length > 0) {
        return p.pages.map((page) => ({
          name: `${p.name}-${page.label.toLowerCase()}`,
          label: page.label,
          enabled: true,
          component: page.component,
        }));
      }
      // Plugin with no pages: show as placeholder tab
      return [{
        name: p.name,
        label: p.name.charAt(0).toUpperCase() + p.name.slice(1),
        enabled: true,
        component: (() => null) as any,
      }];
    });

  // Add the AI management tab (always available)
  tabs.push({
    name: "ai",
    label: "AI",
    enabled: true,
    component: AITab,
  });

  // Check AI availability and watch count for TUI indicators
  let aiStatus: { available: boolean; provider?: string } | undefined;
  let watchCount = 0;

  if (ctx.config.ai.enabled) {
    try {
      const { createLLMProvider } = await import("../llm/provider.js");
      const llm = createLLMProvider(ctx.config.ai as any);
      const available = await llm.isAvailable();
      aiStatus = { available, provider: ctx.config.ai.provider };
    } catch {
      aiStatus = { available: false, provider: ctx.config.ai.provider };
    }
  }

  try {
    const watchDoc = await ctx.store.read("watch.md");
    if (watchDoc?.data?.repos && Array.isArray(watchDoc.data.repos)) {
      watchCount = (watchDoc.data.repos as any[]).length > 0 ? -1 : 0;
    }
  } catch { /* no watch config */ }

  await launchTUI({
    tabs,
    initialTab,
    repoName,
    repoPath,
    watchCount: watchCount === -1 ? undefined : watchCount,
    aiStatus,
  });
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

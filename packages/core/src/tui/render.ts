/**
 * TUI Renderer — launches the Ink app.
 *
 * This is the entry point for `yak` (bare) and `yak tui [plugin]`.
 * Creates the Ink instance, renders the Shell with plugin tabs.
 */

import React from "react";
import { render } from "ink";
import { Shell, type TabDefinition } from "./Shell.js";

/**
 * Launch the TUI with the given tabs.
 *
 * @param tabs - Plugin tabs to show
 * @param initialTab - Optional tab name to start on
 */
export async function launchTUI(
  tabs: TabDefinition[],
  initialTab?: string
): Promise<void> {
  const { waitUntilExit } = render(
    React.createElement(Shell, { tabs, initialTab })
  );
  await waitUntilExit();
}

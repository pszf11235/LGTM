/**
 * TUI Theme — OpenCode-inspired colors and styling.
 *
 * Minimal chrome, content-focused, clean typography.
 */

import chalk from "chalk";

export const theme = {
  // Accents
  primary: chalk.cyan,
  success: chalk.green,
  warning: chalk.yellow,
  error: chalk.red,
  muted: chalk.gray,
  bold: chalk.bold,

  // States
  approved: chalk.green,
  flagged: chalk.red,
  reviewing: chalk.yellow,
  queued: chalk.gray,

  // UI elements
  border: chalk.gray("─"),
  tab: {
    active: (s: string) => chalk.bgCyan.black(` ${s} `),
    inactive: (s: string) => chalk.gray(` ${s} `),
    disabled: (s: string) => chalk.dim.gray(` ${s} `),
  },

  // Diff colors
  diff: {
    added: chalk.green,
    removed: chalk.red,
    context: chalk.gray,
    hunkHeader: chalk.cyan,
    fileHeader: chalk.bold.white,
    lineNumber: chalk.gray,
  },

  // Icons
  icon: {
    approved: chalk.green("✓"),
    flagged: chalk.red("✗"),
    reviewing: chalk.yellow("◉"),
    queued: chalk.gray("○"),
    group: chalk.cyan("⚡"),
    warning: chalk.yellow("⚠"),
    arrow: chalk.green("❯"),
  },
};

/**
 * Create a horizontal border line spanning terminal width.
 */
export function borderLine(width?: number): string {
  const w = width ?? process.stdout.columns ?? 80;
  return chalk.gray("─".repeat(w));
}

/**
 * Create a header bar with title and right-aligned info.
 */
export function headerBar(left: string, right: string, width?: number): string {
  const w = width ?? process.stdout.columns ?? 80;
  const leftClean = stripAnsi(left);
  const rightClean = stripAnsi(right);
  const padding = Math.max(0, w - leftClean.length - rightClean.length);
  return left + " ".repeat(padding) + right;
}

/**
 * Strip ANSI escape codes for length calculation.
 */
function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

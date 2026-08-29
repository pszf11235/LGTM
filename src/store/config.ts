/**
 * Configuration management for the daemon.
 *
 * Stores interval_minutes, pause/resume thresholds, daily cap, concurrency,
 * and optional binary path overrides (claude_path, gh_path) in config.md.
 *
 * Reads and writes through the okf layer. Idempotent. Defaults gracefully
 * when fields are missing or malformed.
 */

import { createOKFStore } from "./okf.js";
import { getConfigPath, getStorePath } from "./paths.js";

export interface Config {
  interval_minutes: number;
  pause_above_pct: number;
  resume_below_pct: number;
  daily_cap: number;
  concurrency: number;
  claude_path?: string;
  gh_path?: string;
}

export const DEFAULTS: Config = {
  interval_minutes: 15,
  pause_above_pct: 70,
  resume_below_pct: 60,
  daily_cap: 20,
  concurrency: 2,
};

/**
 * Load config from config.md.
 * Falls back to defaults for any missing or malformed fields.
 */
export async function loadConfig(): Promise<Config> {
  const store = createOKFStore(getStorePath());
  const doc = await store.read("config.md");

  if (!doc) {
    return { ...DEFAULTS };
  }

  const data = doc.data;
  return {
    interval_minutes: parseNumber(data.interval_minutes, DEFAULTS.interval_minutes),
    pause_above_pct: parseNumber(data.pause_above_pct, DEFAULTS.pause_above_pct),
    resume_below_pct: parseNumber(data.resume_below_pct, DEFAULTS.resume_below_pct),
    daily_cap: parseNumber(data.daily_cap, DEFAULTS.daily_cap),
    concurrency: parseNumber(data.concurrency, DEFAULTS.concurrency),
    claude_path: parseOptionalString(data.claude_path),
    gh_path: parseOptionalString(data.gh_path),
  };
}

/**
 * Write config to config.md.
 * Idempotent; safe to call repeatedly.
 */
export async function saveConfig(config: Config): Promise<void> {
  const store = createOKFStore(getStorePath());

  const data = {
    interval_minutes: config.interval_minutes,
    pause_above_pct: config.pause_above_pct,
    resume_below_pct: config.resume_below_pct,
    daily_cap: config.daily_cap,
    concurrency: config.concurrency,
    ...(config.claude_path && { claude_path: config.claude_path }),
    ...(config.gh_path && { gh_path: config.gh_path }),
  };

  const body = [
    "# LGTM Configuration",
    "",
    `Polling interval: ${config.interval_minutes} minutes`,
    `Quota pause threshold: ${config.pause_above_pct}%`,
    `Quota resume threshold: ${config.resume_below_pct}%`,
    `Daily review cap: ${config.daily_cap}`,
    `Concurrent reviews: ${config.concurrency}`,
    ...(config.claude_path ? [`Claude binary: ${config.claude_path}`] : []),
    ...(config.gh_path ? [`GitHub CLI binary: ${config.gh_path}`] : []),
    "",
  ].join("\n");

  await store.write("config.md", data, body);
}

/**
 * Update a subset of config fields.
 * Preserves other fields and is idempotent.
 */
export async function updateConfig(updates: Partial<Config>): Promise<void> {
  const current = await loadConfig();
  const merged = { ...current, ...updates };
  await saveConfig(merged);
}

/**
 * Parse a value as a number, falling back to a default.
 */
function parseNumber(value: unknown, fallback: number): number {
  if (typeof value === "number") return value;
  if (typeof value === "string") {
    const parsed = parseInt(value, 10);
    if (!isNaN(parsed)) return parsed;
  }
  return fallback;
}

/**
 * Parse a value as an optional string.
 */
function parseOptionalString(value: unknown): string | undefined {
  if (typeof value === "string" && value.length > 0) {
    return value;
  }
  return undefined;
}

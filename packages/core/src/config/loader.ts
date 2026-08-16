/**
 * Configuration loader — layered config resolution.
 *
 * Resolution order (last wins):
 * 1. Built-in defaults
 * 2. Storage config from bootstrap (.yak/ or yak-farm)
 * 3. Plugin-specific config
 * 4. Repo override (.yakrc.yaml in repo root — always checked)
 * 5. CLI flags (handled by Commander, not here)
 *
 * On first `yak init`, user chooses storage mode:
 * - "farm": All yak data in one place (the "yak-farm", default: ~/.yak-farm/)
 * - "repo": Each repo has its own .yak/ (committed to git, team-shareable)
 *
 * Either way, ~/.yakrc stores the choice + a registry of known repos (Task 21).
 */

import fs from "fs";
import path from "path";
import os from "os";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import type { YakConfig, ProjectProfile } from "../plugin.js";
import { findGitRoot, getProfilePath } from "../store/paths.js";

/**
 * Bootstrap config stored in ~/.yakrc.
 * This is the ONLY central file — determines where everything else lives.
 */
export interface BootstrapConfig {
  /**
   * Storage mode:
   * - "farm": All yak data in one central location (the "yak-farm")
   *           Default: ~/.yak-farm/
   *           Good for: keeping everything in one place, cross-repo queries, personal use
   * - "repo": Each repo has its own .yak/ directory (committed to git)
   *           Good for: sharing config/rules with team, per-repo reviews tracked in git
   */
  storageMode: "farm" | "repo";

  /** Custom path for yak-farm (default: ~/.yak-farm/) — only used in farm mode */
  farmPath?: string;
}

/**
 * Default yak-farm location.
 */
export function getDefaultFarmPath(): string {
  return path.join(os.homedir(), ".yak-farm");
}

/**
 * Load the bootstrap config from ~/.yakrc.
 * Returns defaults if file doesn't exist (first run).
 */
export function loadBootstrap(): BootstrapConfig {
  const bootstrapPath = path.join(os.homedir(), ".yakrc");

  try {
    const raw = fs.readFileSync(bootstrapPath, "utf-8");
    const parsed = parseYaml(raw) as Partial<BootstrapConfig>;
    return {
      storageMode: parsed.storageMode ?? "repo",
      farmPath: parsed.farmPath,
    };
  } catch {
    // First run — default to repo mode
    return { storageMode: "repo" };
  }
}

/**
 * Save bootstrap config to ~/.yakrc.
 */
export function saveBootstrap(config: BootstrapConfig): void {
  const bootstrapPath = path.join(os.homedir(), ".yakrc");

  const lines = [
    "# Yak bootstrap config",
    "# Created by `yak init`",
    "#",
    "# storageMode:",
    '#   "farm" = all yak data in one place (the yak-farm)',
    '#   "repo" = .yak/ per repo (committed to git)',
    "",
    `storageMode: ${config.storageMode}`,
  ];

  if (config.farmPath) {
    lines.push(`farmPath: ${config.farmPath}`);
  }

  lines.push("");
  fs.writeFileSync(bootstrapPath, lines.join("\n"), "utf-8");
}

/**
 * Resolve the yak data directory based on storage mode.
 *
 * - Farm mode: ~/.yak-farm/<repo-name>/ (or custom farmPath)
 * - Repo mode: <repoRoot>/.yak/
 */
export function resolveYakDir(
  config: BootstrapConfig,
  repoRoot: string
): string {
  if (config.storageMode === "farm") {
    const farmBase = config.farmPath ?? getDefaultFarmPath();
    const repoName = path.basename(repoRoot);
    return path.join(farmBase, repoName);
  }
  return path.join(repoRoot, ".yak");
}

/**
 * Load the repo-level override (.yakrc.yaml in repo root).
 * Always checked regardless of storage mode — teams can commit shared config.
 */
function loadRepoOverride(repoRoot: string): Partial<YakConfig> {
  const candidates = [
    path.join(repoRoot, ".yakrc.yaml"),
    path.join(repoRoot, ".yakrc.yml"),
    path.join(repoRoot, ".yak", "config.yaml"),
  ];

  for (const filePath of candidates) {
    try {
      const raw = fs.readFileSync(filePath, "utf-8");
      return (parseYaml(raw) as Partial<YakConfig>) ?? {};
    } catch {
      continue;
    }
  }

  return {};
}

/**
 * Get the default config (built-in).
 */
export function getDefaultConfig(): YakConfig {
  return {
    storageMode: "repo",
    plugins: {
      review: { enabled: true },
      specify: { enabled: false },
      learn: { enabled: false },
    },
    ai: {
      enabled: false,
    },
  };
}

/**
 * Load and resolve the full Yak configuration.
 * Merges all layers in order.
 */
export function loadConfig(): YakConfig {
  const defaults = getDefaultConfig();
  const bootstrap = loadBootstrap();
  const repoRoot = findGitRoot();
  const repoOverride = loadRepoOverride(repoRoot);

  // Merge: defaults ← bootstrap ← repo override
  const config: YakConfig = {
    ...defaults,
    storageMode: bootstrap.storageMode,
    plugins: {
      ...defaults.plugins,
      ...(repoOverride.plugins ?? {}),
    },
    ai: {
      ...defaults.ai,
      ...(repoOverride.ai ?? {}),
    },
  };

  return config;
}

/**
 * Load the project profile from the yak data dir.
 * Returns null if no profile exists (not yet initialized).
 */
export function loadProfile(yakDir: string): ProjectProfile | null {
  const profilePath = getProfilePath(yakDir);

  try {
    const raw = fs.readFileSync(profilePath, "utf-8");
    const match = raw.match(/^---\n([\s\S]*?)\n---/);
    if (!match) return null;

    const parsed = parseYaml(match[1]) as Partial<ProjectProfile>;
    if (!parsed.project) return null;

    return {
      project: parsed.project ?? "unknown",
      goal: parsed.goal ?? "production",
      qualityReferences: parsed.qualityReferences ?? [],
      feedbackStyle: parsed.feedbackStyle ?? "direct",
      techStack: parsed.techStack ?? [],
      teamSize: parsed.teamSize ?? "solo",
      ai: parsed.ai ?? { enabled: false },
      createdAt: parsed.createdAt ?? new Date().toISOString(),
    };
  } catch {
    return null;
  }
}

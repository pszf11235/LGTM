/**
 * Configuration loader — layered config resolution.
 *
 * Resolution order (last wins):
 * 1. Built-in defaults
 * 2. Storage config from bootstrap (.lgtm/ or lgtm-farm)
 * 3. Plugin-specific config
 * 4. Repo override (.lgtmrc.yaml in repo root — always checked)
 * 5. CLI flags (handled by Commander, not here)
 *
 * On first `lgtm init`, user chooses storage mode:
 * - "farm": All lgtm data in one place (the "lgtm-farm", default: ~/.lgtm-farm/)
 * - "repo": Each repo has its own .lgtm/ (committed to git, team-shareable)
 *
 * Either way, ~/.lgtmrc stores the choice + a registry of known repos (Task 21).
 */

import fs from "fs";
import path from "path";
import os from "os";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import type { LGTMConfig, ProjectProfile } from "../plugin.js";
import { findGitRoot, getProfilePath } from "../store/paths.js";

/**
 * Bootstrap config stored in ~/.lgtmrc.
 * This is the ONLY central file — determines where everything else lives.
 */
export interface BootstrapConfig {
  /**
   * Storage mode:
   * - "farm": All lgtm data in one central location (the "lgtm-farm")
   *           Default: ~/.lgtm-farm/
   *           Good for: keeping everything in one place, cross-repo queries, personal use
   * - "repo": Each repo has its own .lgtm/ directory (committed to git)
   *           Good for: sharing config/rules with team, per-repo reviews tracked in git
   */
  storageMode: "farm" | "repo";

  /** Custom path for lgtm-farm (default: ~/.lgtm-farm/) — only used in farm mode */
  farmPath?: string;
}

/**
 * Default lgtm-farm location.
 */
export function getDefaultFarmPath(): string {
  return path.join(os.homedir(), ".lgtm-farm");
}

/**
 * Load the bootstrap config from ~/.lgtmrc.
 * Returns defaults if file doesn't exist (first run).
 */
export function loadBootstrap(): BootstrapConfig {
  const bootstrapPath = path.join(os.homedir(), ".lgtmrc");

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
 * Save bootstrap config to ~/.lgtmrc.
 */
export function saveBootstrap(config: BootstrapConfig): void {
  const bootstrapPath = path.join(os.homedir(), ".lgtmrc");

  const lines = [
    "# LGTM bootstrap config",
    "# Created by `lgtm init`",
    "#",
    "# storageMode:",
    '#   "farm" = all lgtm data in one place (the lgtm-farm)',
    '#   "repo" = .lgtm/ per repo (committed to git)',
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
 * Resolve the lgtm data directory based on storage mode.
 *
 * - Farm mode: ~/.lgtm-farm/<repo-name>/ (or custom farmPath)
 * - Repo mode: <repoRoot>/.lgtm/
 */
export function resolveLgtmDir(
  config: BootstrapConfig,
  repoRoot: string
): string {
  if (config.storageMode === "farm") {
    const farmBase = config.farmPath ?? getDefaultFarmPath();
    const repoName = path.basename(repoRoot);
    return path.join(farmBase, repoName);
  }
  return path.join(repoRoot, ".lgtm");
}

/**
 * Load the repo-level override (.lgtmrc.yaml in repo root).
 * Always checked regardless of storage mode — teams can commit shared config.
 */
function loadRepoOverride(repoRoot: string): Partial<LGTMConfig> {
  const candidates = [
    path.join(repoRoot, ".lgtmrc.yaml"),
    path.join(repoRoot, ".lgtmrc.yml"),
    path.join(repoRoot, ".lgtm", "config.yaml"),
  ];

  for (const filePath of candidates) {
    try {
      const raw = fs.readFileSync(filePath, "utf-8");
      return (parseYaml(raw) as Partial<LGTMConfig>) ?? {};
    } catch {
      continue;
    }
  }

  return {};
}

/**
 * Get the default config (built-in).
 */
export function getDefaultConfig(): LGTMConfig {
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
 * Load and resolve the full LGTM configuration.
 * Merges all layers in order.
 */
export function loadConfig(): LGTMConfig {
  const defaults = getDefaultConfig();
  const bootstrap = loadBootstrap();
  const repoRoot = findGitRoot();
  const repoOverride = loadRepoOverride(repoRoot);

  // Load profile (has AI preference from onboarding)
  const lgtmDir = resolveLgtmDir(bootstrap, repoRoot);
  const profile = loadProfile(lgtmDir);

  // Merge: defaults ← profile ← repo override
  const config: LGTMConfig = {
    ...defaults,
    storageMode: bootstrap.storageMode,
    plugins: {
      ...defaults.plugins,
      ...(repoOverride.plugins ?? {}),
    },
    ai: {
      ...defaults.ai,
      ...(profile?.ai ?? {}),
      ...(repoOverride.ai ?? {}),
    },
  };

  return config;
}

/**
 * Load the project profile from the lgtm data dir.
 * Returns null if no profile exists (not yet initialized).
 */
export function loadProfile(lgtmDir: string): ProjectProfile | null {
  const profilePath = getProfilePath(lgtmDir);

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

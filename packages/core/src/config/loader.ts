/**
 * Configuration loader — layered config resolution.
 *
 * Resolution order (last wins):
 * 1. Built-in defaults
 * 2. Central/repo config (.yak/config.md or ~/.yak/config.md)
 * 3. Plugin-specific config (.yak/plugins/<name>/config.md)
 * 4. Repo override (.yakrc.yaml in repo root — always checked)
 * 5. CLI flags (handled by Commander, not here)
 *
 * On first `yak init`, user chooses storage mode (central vs repo).
 * This choice is stored in ~/.yakrc (bootstrap file).
 */

import fs from "fs";
import path from "path";
import { parse as parseYaml } from "yaml";
import type { YakConfig, ProjectProfile } from "../plugin.js";
import { findGitRoot, resolveYakDir, getProfilePath } from "../store/paths.js";

/** Bootstrap config stored in ~/.yakrc — just the storage mode choice */
interface BootstrapConfig {
  storageMode: "central" | "repo";
}

/**
 * Load the bootstrap config from ~/.yakrc.
 * Returns defaults if file doesn't exist (first run).
 */
export function loadBootstrap(): BootstrapConfig {
  const bootstrapPath = path.join(
    process.env.HOME ?? process.env.USERPROFILE ?? "~",
    ".yakrc"
  );

  try {
    const raw = fs.readFileSync(bootstrapPath, "utf-8");
    const parsed = parseYaml(raw) as Partial<BootstrapConfig>;
    return {
      storageMode: parsed.storageMode ?? "repo",
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
  const bootstrapPath = path.join(
    process.env.HOME ?? process.env.USERPROFILE ?? "~",
    ".yakrc"
  );

  const content = `# Yak bootstrap config\n# Created by \`yak init\`\nstorageMode: ${config.storageMode}\n`;
  fs.writeFileSync(bootstrapPath, content, "utf-8");
}

/**
 * Load the repo-level override (.yakrc.yaml in repo root).
 * Returns empty object if not found.
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
 * Load the project profile from .yak/profile.md.
 * Returns null if no profile exists (not yet initialized).
 */
export function loadProfile(yakDir: string): ProjectProfile | null {
  const profilePath = getProfilePath(yakDir);

  try {
    const raw = fs.readFileSync(profilePath, "utf-8");
    // gray-matter would be better here but we avoid the dep in this module
    // Parse frontmatter manually (simple YAML between --- delimiters)
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

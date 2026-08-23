/**
 * Configuration loader — layered config resolution.
 *
 * Storage is always central: ~/.lgtm-farm/ (flat, no per-repo subdirectory).
 * Review artefacts are namespaced by repo inside it, e.g.
 *   ~/.lgtm-farm/reviews/<owner>-<repo>-<pr>/
 *
 * Resolution order (last wins):
 * 1. Built-in defaults
 * 2. Profile (~/.lgtm-farm/profile.md)
 * 3. Repo override (.lgtmrc.yaml in repo root — always checked)
 * 4. CLI flags (handled by Commander, not here)
 */

import fs from "fs";
import path from "path";
import os from "os";
import { parse as parseYaml } from "yaml";
import type { LGTMConfig, ProjectProfile } from "../plugin.js";
import { findGitRoot, getProfilePath } from "../store/paths.js";

/**
 * Bootstrap config stored in ~/.lgtmrc.
 * Kept as an extension point — the store location is no longer configurable,
 * but future global settings belong here.
 */
export interface BootstrapConfig {
  /** Override the central store location (default: ~/.lgtm-farm/) */
  storePath?: string;
}

/**
 * Resolve the user's home directory.
 *
 * `HOME` is honoured ahead of `os.homedir()` so the store can be relocated by
 * the environment. Bun resolves `os.homedir()` from the passwd entry, which
 * ignores a reassigned `process.env.HOME`, so tests could not otherwise
 * redirect the store to a temp dir.
 */
function homeDir(): string {
  return process.env.HOME || os.homedir();
}

/**
 * The central LGTM store location.
 * One store for every repo — reviews are namespaced by owner-repo-pr inside it.
 */
export function getDefaultStorePath(): string {
  return path.join(homeDir(), ".lgtm-farm");
}

/**
 * Load the bootstrap config from ~/.lgtmrc.
 * Returns an empty object if the file doesn't exist (the common case).
 */
export function loadBootstrap(): BootstrapConfig {
  const bootstrapPath = path.join(homeDir(), ".lgtmrc");

  try {
    const raw = fs.readFileSync(bootstrapPath, "utf-8");
    const parsed = parseYaml(raw) as Partial<BootstrapConfig>;
    return { storePath: parsed?.storePath };
  } catch {
    return {};
  }
}

/**
 * Save bootstrap config to ~/.lgtmrc.
 * Only written when a non-default store path is set.
 */
export function saveBootstrap(config: BootstrapConfig): void {
  const bootstrapPath = path.join(homeDir(), ".lgtmrc");

  const lines = [
    "# LGTM bootstrap config",
    "#",
    "# storePath: override the central store location",
    "#            (default: ~/.lgtm-farm/)",
    "",
  ];

  if (config.storePath) {
    lines.push(`storePath: ${config.storePath}`);
  }

  lines.push("");
  fs.writeFileSync(bootstrapPath, lines.join("\n"), "utf-8");
}

/**
 * Resolve the LGTM data directory.
 *
 * Always the central store — flat, shared across every repo.
 * `repoRoot` is accepted for signature compatibility but not used to build
 * the path; repo identity lives in the review directory names instead.
 */
export function resolveLgtmDir(
  config: BootstrapConfig = {},
  _repoRoot?: string
): string {
  return config.storePath ?? getDefaultStorePath();
}

/**
 * Load the repo-level override (.lgtmrc.yaml in repo root).
 * Teams can commit shared plugin/AI config even though the store is central.
 */
function loadRepoOverride(repoRoot: string): Partial<LGTMConfig> {
  const candidates = [
    path.join(repoRoot, ".lgtmrc.yaml"),
    path.join(repoRoot, ".lgtmrc.yml"),
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
    plugins: {
      review: { enabled: true },
    },
    ai: {
      enabled: false,
    },
  };
}

/**
 * Load and resolve the full LGTM configuration.
 */
export function loadConfig(): LGTMConfig {
  const defaults = getDefaultConfig();
  const bootstrap = loadBootstrap();
  const repoRoot = findGitRoot();
  const repoOverride = loadRepoOverride(repoRoot);

  const lgtmDir = resolveLgtmDir(bootstrap);
  const profile = loadProfile(lgtmDir);

  return {
    ...defaults,
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
}

/**
 * Load the project profile from the central store.
 * Returns null if the store has not been initialised.
 */
export function loadProfile(lgtmDir: string): ProjectProfile | null {
  const profilePath = getProfilePath(lgtmDir);

  try {
    const raw = fs.readFileSync(profilePath, "utf-8");
    const match = raw.match(/^---\n([\s\S]*?)\n---/);
    if (!match) return null;

    const parsed = parseYaml(match[1]) as Partial<ProjectProfile>;

    return {
      ai: parsed.ai ?? { enabled: false },
      createdAt: parsed.createdAt ?? new Date().toISOString(),
    };
  } catch {
    return null;
  }
}

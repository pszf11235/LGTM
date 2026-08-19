/**
 * Configuration schema and validation.
 *
 * Provides type-safe defaults and validation for LGTMConfig.
 * Types are defined in plugin.ts — this file provides runtime validation.
 */

import type { LGTMConfig, ProjectProfile } from "../plugin.js";

/**
 * Validate a config object, filling in missing fields with defaults.
 */
export function validateConfig(raw: Partial<LGTMConfig>): LGTMConfig {
  return {
    storageMode: raw.storageMode ?? "repo",
    plugins: {
      review: { enabled: true },
      specify: { enabled: false },
      learn: { enabled: false },
      ...(raw.plugins ?? {}),
    },
    ai: {
      enabled: raw.ai?.enabled ?? false,
      provider: raw.ai?.provider,
      model: raw.ai?.model,
      baseUrl: raw.ai?.baseUrl,
      apiKey: raw.ai?.apiKey,
    },
  };
}

/**
 * Validate a profile object.
 * Returns null if the input is clearly invalid.
 */
export function validateProfile(
  raw: Partial<ProjectProfile>
): ProjectProfile | null {
  if (!raw.project) return null;

  return {
    project: raw.project,
    goal: raw.goal ?? "production",
    qualityReferences: raw.qualityReferences ?? [],
    feedbackStyle: raw.feedbackStyle ?? "direct",
    techStack: raw.techStack ?? [],
    teamSize: raw.teamSize ?? "solo",
    ai: raw.ai ?? { enabled: false },
    createdAt: raw.createdAt ?? new Date().toISOString(),
  };
}

/**
 * Valid project goals.
 */
export const PROJECT_GOALS = [
  "vibed",
  "production",
  "enterprise",
  "learning",
] as const;

/**
 * Valid feedback styles.
 */
export const FEEDBACK_STYLES = [
  "direct",
  "gentle",
  "socratic",
  "minimal",
] as const;

/**
 * Valid team sizes.
 */
export const TEAM_SIZES = ["solo", "small", "large"] as const;

/**
 * Valid AI providers.
 */
export const AI_PROVIDERS = ["openai", "anthropic", "ollama"] as const;

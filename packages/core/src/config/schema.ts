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
    plugins: {
      review: { enabled: true },
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
  return {
    ai: raw.ai ?? { enabled: false },
    createdAt: raw.createdAt ?? new Date().toISOString(),
  };
}

/**
 * Valid AI providers.
 */
export const AI_PROVIDERS = ["openai", "anthropic", "ollama"] as const;

/**
 * Valid severity thresholds for AI auto-review.
 */
export const REVIEW_SEVERITIES = ["low", "medium", "high", "critical"] as const;

/**
 * AI review configuration schema.
 * Used by `lgtm review auto` to control behavior.
 */
export interface AIReviewConfig {
  /** Minimum severity to post: low | medium | high | critical (default: high) */
  severity_threshold: (typeof REVIEW_SEVERITIES)[number];

  /** Random delay range between individual comment posts in seconds (default: [20, 90]) */
  comment_delay: [number, number];

  /** Pause posting when rate limit remaining drops below this (default: 10) */
  rate_limit_threshold: number;

  /** Formatting rules for AI-generated comments */
  formatting: {
    /** Replace em dashes (—) with hyphens (default: true) */
    no_em_dashes: boolean;
    /** Replace semicolons with periods (default: true) */
    no_semicolons: boolean;
    /** Strip severity labels like [HIGH] from comment text (default: true) */
    no_severity_labels: boolean;
  };
}

/**
 * Default AI review configuration.
 */
export const DEFAULT_AI_REVIEW_CONFIG: AIReviewConfig = {
  severity_threshold: "high",
  comment_delay: [20, 90],
  rate_limit_threshold: 10,
  formatting: {
    no_em_dashes: true,
    no_semicolons: true,
    no_severity_labels: true,
  },
};

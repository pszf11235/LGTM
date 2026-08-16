/**
 * Re-export all public types from @yak/core.
 *
 * Plugins should import types from here:
 *   import type { YakPlugin, YakContext } from "@yak/core/plugin.js";
 *
 * Or from the package root:
 *   import type { YakPlugin } from "@yak/core";
 */

export type {
  YakPlugin,
  YakContext,
  YakConfig,
  ProjectProfile,
  TUIPage,
  OnboardingStep,
  OKFStore,
  LLMProvider,
  Logger,
} from "./plugin.js";

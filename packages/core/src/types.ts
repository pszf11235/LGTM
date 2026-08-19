/**
 * Re-export all public types from @lgtm/core.
 *
 * Plugins should import types from here:
 *   import type { LGTMPlugin, LGTMContext } from "@lgtm/core/plugin.js";
 *
 * Or from the package root:
 *   import type { LGTMPlugin } from "@lgtm/core";
 */

export type {
  LGTMPlugin,
  LGTMContext,
  LGTMConfig,
  ProjectProfile,
  TUIPage,
  OnboardingStep,
  OKFStore,
  LLMProvider,
  Logger,
} from "./plugin.js";

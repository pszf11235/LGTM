/**
 * Config module — loading, validation, and schema.
 */

export {
  loadConfig,
  loadBootstrap,
  saveBootstrap,
  getDefaultConfig,
  loadProfile,
} from "./loader.js";

export {
  validateConfig,
  validateProfile,
  PROJECT_GOALS,
  FEEDBACK_STYLES,
  TEAM_SIZES,
  AI_PROVIDERS,
} from "./schema.js";

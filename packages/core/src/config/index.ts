/**
 * Config module — loading, validation, and schema.
 */

export {
  loadConfig,
  loadBootstrap,
  saveBootstrap,
  getDefaultConfig,
  loadProfile,
  resolveYakDir,
  getDefaultFarmPath,
} from "./loader.js";
export type { BootstrapConfig } from "./loader.js";

export {
  validateConfig,
  validateProfile,
  PROJECT_GOALS,
  FEEDBACK_STYLES,
  TEAM_SIZES,
  AI_PROVIDERS,
} from "./schema.js";

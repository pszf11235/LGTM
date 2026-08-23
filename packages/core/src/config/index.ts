/**
 * Config module — loading, validation, and schema.
 */

export {
  loadConfig,
  loadBootstrap,
  saveBootstrap,
  getDefaultConfig,
  loadProfile,
  resolveLgtmDir,
  getDefaultStorePath,
} from "./loader.js";
export type { BootstrapConfig } from "./loader.js";

export {
  validateConfig,
  validateProfile,
  AI_PROVIDERS,
} from "./schema.js";

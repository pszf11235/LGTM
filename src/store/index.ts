/**
 * The on-disk store: markdown files with YAML frontmatter under
 * ~/.lgtm-farm/ (design.md, "Store layout"). okf.ts (gray-matter behind a
 * structuredClone guard) and reviews.ts (meta.md and r<N>-<agent>.md
 * read/write) land here, ported from packages/core/src/store/okf.ts and
 * packages/plugins/review/src/domain/review-store.ts on the old `main`
 * branch, adapted to the new directory layout and finding-key rules.
 */

export { createOKFStore, stringifyOKF, parseOKF, type OKFDocument } from "./okf.js";
export {
  getStorePath,
  getConfigPath,
  getWatchListPath,
  getReviewDir,
  getPRMetaPath,
  getRoundPath,
  getDiffPath,
} from "./paths.js";
export {
  loadConfig,
  saveConfig,
  updateConfig,
  type Config,
} from "./config.js";
export {
  loadWatchList,
  saveWatchList,
  addToWatchList,
  removeFromWatchList,
  updateLastPolledAt,
  updateETag,
  getWatchedRepoKeys,
  type WatchEntry,
} from "./watch-list.js";
export {
  DEFAULT_TEMPLATE,
  loadTemplate,
  renderTemplate,
  ensureTemplatesDir,
  initDefaultTemplate,
  type TemplateContext,
} from "./templates.js";

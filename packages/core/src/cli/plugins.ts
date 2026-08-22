/**
 * Static Plugin Registry
 *
 * For compiled binaries, plugins must be statically imported so the bundler
 * includes them and their dependencies (chalk, commander, etc.) in the bundle.
 *
 * Dynamic discovery (fs.readdirSync + dynamic import) still works in development
 * but fails in compiled binaries because there's no filesystem to scan.
 */

import type { LGTMPlugin } from "../plugin.js";

/**
 * Import all known plugins statically.
 * The bundler will trace these imports and include all transitive deps.
 */
export async function loadStaticPlugins(): Promise<LGTMPlugin[]> {
  const plugins: LGTMPlugin[] = [];

  try {
    // Use a static path the bundler can trace (includes all transitive deps)
    // @ts-ignore — Bun resolves .ts imports directly, TypeScript complains about extensions
    const reviewMod = await import("../../../plugins/review/src/index.js");
    const plugin = reviewMod.plugin ?? reviewMod.default;
    if (plugin) plugins.push(plugin);
  } catch (err) {
    // Plugin not available — skip silently in production
    if (process.env.LGTM_DEBUG) {
      console.error(`  ⚠️  Failed to load review plugin: ${(err as Error).message}`);
    }
  }

  return plugins;
}

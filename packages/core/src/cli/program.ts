/**
 * CLI Program Setup & Plugin Loader
 *
 * Discovers plugins from packages/plugins/, validates them against
 * the LGTMPlugin interface, and registers their commands under
 * the appropriate namespace.
 */

import { Command } from "commander";
import path from "path";
import fs from "fs";
import type { LGTMPlugin, LGTMContext, LGTMConfig, Logger } from "../plugin.js";
import { loadConfig, loadBootstrap, loadProfile, resolveYakDir } from "../config/loader.js";
import { createOKFStore } from "../store/okf.js";
import { findGitRoot } from "../store/paths.js";

/**
 * Discover plugins by scanning the packages/plugins/ directory.
 * Each plugin must export a `plugin` object or a `register` function
 * that returns a LGTMPlugin.
 *
 * In compiled binaries, uses static imports (see plugins.ts).
 * In development, falls back to dynamic filesystem scanning.
 */
export async function discoverPlugins(
  pluginsDir: string
): Promise<LGTMPlugin[]> {
  // First try static plugin registry (works in compiled binaries)
  try {
    const { loadStaticPlugins } = await import("./plugins.js");
    const staticPlugins = await loadStaticPlugins();
    if (staticPlugins.length > 0) {
      return staticPlugins;
    }
  } catch {
    // Static registry not available — fall through to dynamic discovery
  }

  // Fallback: dynamic filesystem discovery (development mode)
  const plugins: LGTMPlugin[] = [];

  if (!fs.existsSync(pluginsDir)) {
    return plugins;
  }

  const entries = fs.readdirSync(pluginsDir, { withFileTypes: true });

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    const pluginEntry = path.join(pluginsDir, entry.name, "src", "index.ts");
    if (!fs.existsSync(pluginEntry)) continue;

    try {
      const mod = await import(pluginEntry);

      // Plugin can export either a `plugin` object or a `register()` function
      const plugin: LGTMPlugin | undefined =
        mod.register?.() ?? mod.plugin ?? mod.default;

      if (plugin && isValidPlugin(plugin)) {
        plugins.push(plugin);
      }
    } catch (err) {
      // Silently skip plugins that fail to load
      // (they might have unmet dependencies during development)
      console.error(
        `  ⚠️  Failed to load plugin from ${entry.name}: ${(err as Error).message}`
      );
    }
  }

  return plugins;
}

/**
 * Type guard: validates that an object satisfies LGTMPlugin minimum contract.
 */
function isValidPlugin(obj: unknown): obj is LGTMPlugin {
  if (typeof obj !== "object" || obj === null) return false;
  const p = obj as Record<string, unknown>;
  return (
    typeof p.name === "string" &&
    typeof p.description === "string" &&
    typeof p.version === "string"
  );
}

/**
 * Register a plugin's commands into the Commander program.
 * Creates a subcommand namespace: `lgtm <plugin.name> <command>`
 */
export function registerPlugin(
  program: Command,
  plugin: LGTMPlugin,
  ctx: LGTMContext
): void {
  const sub = program
    .command(plugin.name)
    .description(plugin.description);

  // Let the plugin register its own subcommands
  if (typeof plugin.registerCommands === "function") {
    plugin.registerCommands(sub, ctx);
  }
}

/**
 * Build a minimal LGTMContext for bootstrapping.
 * Uses real config loader and OKF store when available.
 */
export function buildBootstrapContext(): LGTMContext {
  const repoRoot = findGitRoot();
  const config = loadConfig();
  const bootstrap = loadBootstrap();
  const lgtmDir = resolveYakDir(bootstrap, repoRoot);
  const store = createOKFStore(lgtmDir);
  const profile = loadProfile(lgtmDir);

  const logger: Logger = {
    info: (msg) => console.log(`  ${msg}`),
    warn: (msg) => console.log(`  ⚠️  ${msg}`),
    error: (msg) => console.error(`  ❌ ${msg}`),
    debug: (msg) => {
      if (process.env.LGTM_DEBUG) console.log(`  🐛 ${msg}`);
    },
  };

  return {
    profile,
    store,
    llm: null,
    config,
    logger,
    lgtmDir,
    repoRoot,
  };
}

/**
 * Resolve the plugins directory relative to the package root.
 * Handles both development (monorepo) and installed (node_modules) cases.
 */
export function resolvePluginsDir(): string {
  // In development: plugins are sibling to core in the monorepo
  const currentDir = import.meta.dir;
  const devPath = path.resolve(
    currentDir,
    "..",
    "..",
    "..",
    "plugins"
  );
  if (fs.existsSync(devPath)) return devPath;

  // Fallback: look relative to cwd
  const cwdPath = path.join(process.cwd(), "packages", "plugins");
  if (fs.existsSync(cwdPath)) return cwdPath;

  // No plugins found
  return devPath;
}

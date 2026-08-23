/**
 * Plugin interface and context types.
 *
 * Every LGTM plugin implements LGTMPlugin. The core discovers plugins,
 * calls registerCommands() to wire CLI, and provides LGTMContext for
 * access to shared services (LLM, store, config).
 */

import type { Command } from "commander";

/**
 * The contract every LGTM plugin must implement.
 */
export interface LGTMPlugin {
  /** Unique plugin name (used as CLI namespace: `lgtm <name> <command>`) */
  name: string;

  /** Human-readable description (shown in `lgtm plugins`) */
  description: string;

  /** Plugin version (semver) */
  version: string;

  /**
   * Register CLI commands under this plugin's namespace.
   * Called by the core during bootstrap.
   *
   * @param program - The Commander subcommand for this plugin (already namespaced)
   * @param ctx - Access to core services (store, config, llm, etc.)
   */
  registerCommands(program: Command, ctx: LGTMContext): void;

  /**
   * TUI pages this plugin provides (optional).
   * Each page becomes a tab in the TUI shell.
   */
  pages?: TUIPage[];

  /**
   * Plugin-specific onboarding questions (optional).
   * Pre-filled from global profile, always skippable.
   * Asked on first use of the plugin.
   */
  onboarding?: OnboardingStep[];

  /**
   * Called once when plugin is first enabled or on `lgtm init`.
   * Use for plugin-specific setup (creating directories, etc.)
   */
  initialize?(ctx: LGTMContext): Promise<void>;
}

/**
 * Context object passed to plugins — provides access to core services.
 * Plugins should NOT import core internals directly; use this context.
 */
export interface LGTMContext {
  /** Resolved project profile (from onboarding) — may be null if not yet initialized */
  profile: ProjectProfile | null;

  /** OKF store for reading/writing markdown files */
  store: OKFStore;

  /** LLM provider — null if AI is disabled */
  llm: LLMProvider | null;

  /** Resolved configuration */
  config: LGTMConfig;

  /** Logger */
  logger: Logger;

  /** Root directory of the .lgtm data store */
  lgtmDir: string;

  /** Git root directory of the current repo */
  repoRoot: string;
}

/**
 * A page that a plugin contributes to the TUI.
 * Each page becomes a tab in the shell.
 */
export interface TUIPage {
  /** Tab label shown in the TUI header */
  label: string;

  /** Short key to jump to this tab (e.g., "r" for review) */
  shortcut?: string;

  /**
   * React component to render for this page.
   * Receives the LGTMContext as props.
   */
  component: React.ComponentType<any>;
}

/**
 * A single onboarding question.
 */
export interface OnboardingStep {
  /** Unique ID for this question */
  id: string;

  /** Question text shown to the user */
  question: string;

  /** Input type */
  type: "select" | "multiselect" | "text" | "confirm";

  /** Options for select/multiselect types */
  options?: string[];

  /** Default value (can reference profile values) */
  default?: string;

  /** Skip this question if condition is met */
  skipIf?: (profile: ProjectProfile | null) => boolean;
}

// ─── Shared Types (will be fleshed out in Task 3) ────────────────────────

/**
 * Stored profile for the central LGTM store.
 *
 * Onboarding asks nothing, so this holds only what the tool discovers or the
 * user sets later. Review tone and focus live in the agent config
 * (~/.lgtm-farm/agents/*.md), not here.
 */
export interface ProjectProfile {
  ai: {
    enabled: boolean;
    provider?: "openai" | "anthropic" | "ollama";
    model?: string;
    baseUrl?: string;
  };
  createdAt: string;
}

/** LGTM configuration (resolved from all layers) */
export interface LGTMConfig {
  /** Enabled plugins */
  plugins: Record<string, { enabled: boolean }>;

  /** AI config — used by the openrouter/ollama HTTP paths */
  ai: {
    enabled: boolean;
    provider?: "openai" | "anthropic" | "ollama";
    model?: string;
    baseUrl?: string;
    apiKey?: string;
  };
}

/** OKF Store interface (implemented in Task 3) */
export interface OKFStore {
  read(path: string): Promise<{ data: Record<string, unknown>; content: string } | null>;
  write(path: string, data: Record<string, unknown>, content: string): Promise<void>;
  exists(path: string): Promise<boolean>;
  list(dir: string): Promise<string[]>;
}

/** LLM Provider interface (implemented in Task 12) */
export interface LLMProvider {
  /** Generate a completion */
  complete(prompt: string, options?: { maxTokens?: number; temperature?: number; systemPrompt?: string }): Promise<string>;

  /** Check if the provider is available */
  isAvailable(): Promise<boolean>;
}

/** Simple logger interface */
export interface Logger {
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
  debug(msg: string): void;
}

/**
 * AI Provider Auto-Discovery — zero-config detection of available LLM providers.
 *
 * Inspired by Vibe Island's zero-config approach: detected providers are set up
 * automatically on first launch without asking the user to choose or paste keys.
 *
 * Detection order (first available wins as default):
 * 1. Check environment variables (OPENAI_API_KEY, ANTHROPIC_API_KEY)
 * 2. Check saved credentials (~/.lgtm-credentials)
 * 3. Check for local Ollama (ping localhost:11434)
 * 4. Check for Claude CLI (`claude --version`)
 * 5. Check for common AI config files (~/.config/openai, etc.)
 *
 * Returns all detected providers, ranked by preference.
 */

import fs from "fs";
import path from "path";
import os from "os";

// ─── Types ──────────────────────────────────────────────────────────────────

export interface DetectedProvider {
  /** Provider identifier */
  id: "openai" | "anthropic" | "ollama";

  /** Human-readable name */
  name: string;

  /** How the provider was detected */
  source: "env" | "credentials" | "local" | "cli" | "config-file";

  /** Whether we can actually connect right now */
  available: boolean;

  /** The API key (masked for display) */
  keyHint?: string;

  /** Suggested default model */
  defaultModel: string;

  /** Extra info for display */
  detail?: string;
}

export interface AIDiscoveryResult {
  /** All detected providers (may be multiple) */
  providers: DetectedProvider[];

  /** The recommended default provider (first available) */
  recommended: DetectedProvider | null;

  /** Whether any AI provider is available */
  hasAI: boolean;

  /** Summary message for display */
  summary: string;
}

// ─── Main Discovery Function ────────────────────────────────────────────────

/**
 * Auto-discover all available AI/LLM providers.
 * Does NOT require user input — checks everything automatically.
 *
 * @returns Discovery result with all found providers
 */
export async function discoverAIProviders(): Promise<AIDiscoveryResult> {
  const providers: DetectedProvider[] = [];

  // ── 1. Check OpenAI ────────────────────────────────────────────────────
  const openai = await detectOpenAI();
  if (openai) providers.push(openai);

  // ── 2. Check Anthropic/Claude ──────────────────────────────────────────
  const anthropic = await detectAnthropic();
  if (anthropic) providers.push(anthropic);

  // ── 3. Check Ollama (local) ────────────────────────────────────────────
  const ollama = await detectOllama();
  if (ollama) providers.push(ollama);

  // ── Determine recommendation ───────────────────────────────────────────
  // Prefer providers that are actually available (key found + reachable)
  const available = providers.filter((p) => p.available);
  const recommended = available[0] ?? providers[0] ?? null;

  const hasAI = available.length > 0;

  // Build summary
  let summary: string;
  if (available.length === 0 && providers.length === 0) {
    summary = "No AI providers detected. AI features will be disabled.";
  } else if (available.length === 0) {
    summary = `Found ${providers.length} provider(s) but none are reachable. Check your API keys.`;
  } else if (available.length === 1) {
    summary = `Auto-detected: ${available[0].name} (${available[0].source})`;
  } else {
    summary = `Auto-detected ${available.length} providers: ${available.map((p) => p.name).join(", ")}`;
  }

  return { providers, recommended, hasAI, summary };
}

// ─── Provider Detection ─────────────────────────────────────────────────────

async function detectOpenAI(): Promise<DetectedProvider | null> {
  // Check env var
  const envKey = process.env.OPENAI_API_KEY;
  if (envKey) {
    return {
      id: "openai",
      name: "OpenAI",
      source: "env",
      available: true,
      keyHint: maskKey(envKey),
      defaultModel: "gpt-4o-mini",
      detail: "via OPENAI_API_KEY env var",
    };
  }

  // Check saved credentials
  const savedKey = loadCredential("openai");
  if (savedKey) {
    return {
      id: "openai",
      name: "OpenAI",
      source: "credentials",
      available: true,
      keyHint: maskKey(savedKey),
      defaultModel: "gpt-4o-mini",
      detail: "via ~/.lgtm-credentials",
    };
  }

  // Check common config locations
  const configPaths = [
    path.join(os.homedir(), ".config", "openai", "api_key"),
    path.join(os.homedir(), ".openai_api_key"),
  ];

  for (const configPath of configPaths) {
    try {
      const key = fs.readFileSync(configPath, "utf-8").trim();
      if (key && key.startsWith("sk-")) {
        return {
          id: "openai",
          name: "OpenAI",
          source: "config-file",
          available: true,
          keyHint: maskKey(key),
          defaultModel: "gpt-4o-mini",
          detail: `via ${configPath}`,
        };
      }
    } catch { /* not found */ }
  }

  return null;
}

async function detectAnthropic(): Promise<DetectedProvider | null> {
  // Check env var
  const envKey = process.env.ANTHROPIC_API_KEY;
  if (envKey) {
    return {
      id: "anthropic",
      name: "Anthropic (Claude)",
      source: "env",
      available: true,
      keyHint: maskKey(envKey),
      defaultModel: "claude-sonnet-4-20250514",
      detail: "via ANTHROPIC_API_KEY env var",
    };
  }

  // Check saved credentials (both "anthropic" and "claude" keys)
  const savedKey = loadCredential("anthropic") ?? loadCredential("claude");
  if (savedKey) {
    return {
      id: "anthropic",
      name: "Anthropic (Claude)",
      source: "credentials",
      available: true,
      keyHint: maskKey(savedKey),
      defaultModel: "claude-sonnet-4-20250514",
      detail: "via ~/.lgtm-credentials",
    };
  }

  // Check for Claude CLI
  try {
    const { execSync } = require("child_process");
    execSync("which claude", { stdio: "ignore" });
    // Claude CLI exists — check if it has credentials configured
    return {
      id: "anthropic",
      name: "Anthropic (Claude CLI)",
      source: "cli",
      available: true, // CLI manages its own auth
      defaultModel: "claude-sonnet-4-20250514",
      detail: "Claude CLI detected",
    };
  } catch { /* not installed */ }

  // Check common config locations
  const configPaths = [
    path.join(os.homedir(), ".config", "anthropic", "api_key"),
    path.join(os.homedir(), ".anthropic_api_key"),
  ];

  for (const configPath of configPaths) {
    try {
      const key = fs.readFileSync(configPath, "utf-8").trim();
      if (key && key.startsWith("sk-ant-")) {
        return {
          id: "anthropic",
          name: "Anthropic (Claude)",
          source: "config-file",
          available: true,
          keyHint: maskKey(key),
          defaultModel: "claude-sonnet-4-20250514",
          detail: `via ${configPath}`,
        };
      }
    } catch { /* not found */ }
  }

  return null;
}

async function detectOllama(): Promise<DetectedProvider | null> {
  // Check if Ollama is running (ping the API)
  try {
    const res = await fetch("http://localhost:11434/api/tags", {
      signal: AbortSignal.timeout(2000),
    });
    if (res.ok) {
      const data = await res.json() as { models?: Array<{ name: string }> };
      const models = data.models ?? [];
      const modelList = models.map((m) => m.name).slice(0, 5);
      const defaultModel = models.find((m) => m.name.includes("llama")) ?? models[0];

      return {
        id: "ollama",
        name: "Ollama (local)",
        source: "local",
        available: true,
        defaultModel: defaultModel?.name ?? "llama3.2",
        detail: models.length > 0
          ? `${models.length} model(s): ${modelList.join(", ")}`
          : "running but no models pulled",
      };
    }
  } catch { /* not running */ }

  // Check if ollama binary exists (could be started)
  try {
    const { execSync } = require("child_process");
    execSync("which ollama", { stdio: "ignore" });
    return {
      id: "ollama",
      name: "Ollama (local, not running)",
      source: "cli",
      available: false,
      defaultModel: "llama3.2",
      detail: "ollama installed but not running — start with: ollama serve",
    };
  } catch { /* not installed */ }

  return null;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Load a saved credential from ~/.lgtm-credentials.
 */
function loadCredential(provider: string): string | null {
  try {
    const credFile = path.join(os.homedir(), ".lgtm-credentials");
    const raw = fs.readFileSync(credFile, "utf-8");
    const creds = JSON.parse(raw);
    return creds[provider] ?? null;
  } catch {
    return null;
  }
}

/**
 * Mask an API key for display (show first 4 and last 4 chars).
 */
function maskKey(key: string): string {
  if (key.length <= 12) return "••••••••";
  return `${key.slice(0, 4)}${"•".repeat(Math.min(key.length - 8, 20))}${key.slice(-4)}`;
}

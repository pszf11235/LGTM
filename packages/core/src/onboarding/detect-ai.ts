/**
 * AI Provider Auto-Discovery — deep detection of available LLM providers.
 *
 * Zero-config approach inspired by Vibe Island: auto-detect AI tools and
 * borrow their credentials without asking the user to configure anything.
 *
 * Scans for 15+ AI tools and their credential storage locations:
 * - Environment variables (OPENAI_API_KEY, ANTHROPIC_API_KEY, GEMINI_API_KEY, etc.)
 * - Claude Code CLI (~/.claude/ credentials)
 * - Cursor IDE (stored in OS keychain, but config in ~/.cursor/)
 * - Continue.dev (~/.continue/config.json with API keys)
 * - Aider (~/.aider.conf.yml)
 * - OpenRouter (OPENROUTER_API_KEY)
 * - GitHub Copilot (gh copilot token)
 * - Codex CLI (OPENAI_API_KEY)
 * - Gemini CLI (GEMINI_API_KEY, ~/.config/gemini/)
 * - Local Ollama (ping localhost:11434)
 * - Local LM Studio (ping localhost:1234)
 * - Saved LGTM credentials (~/.lgtm-credentials)
 * - Common config file locations
 *
 * Returns all detected providers ranked by reliability.
 */

import fs from "fs";
import path from "path";
import os from "os";

// ─── Types ──────────────────────────────────────────────────────────────────

export interface DetectedProvider {
  /** Provider identifier (maps to LLM provider backend) */
  id: "openai" | "anthropic" | "ollama" | "gemini" | "openrouter";

  /** Human-readable name */
  name: string;

  /** The tool or source that provided the credential */
  detectedVia: string;

  /** How it was found */
  source: "env" | "credentials" | "local" | "cli-config" | "tool-config" | "config-file";

  /** Whether we're confident the provider is reachable */
  available: boolean;

  /** The API key (never exposed in full — masked for display) */
  keyHint?: string;

  /** The actual key (for saving to credentials) */
  apiKey?: string;

  /** Suggested default model */
  defaultModel: string;

  /** Extra info for display */
  detail?: string;

  /** Base URL if non-standard (e.g., OpenRouter uses openai-compatible endpoint) */
  baseUrl?: string;
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

  /** Tools detected (for informational display) */
  toolsDetected: string[];
}

// ─── Main Discovery Function ────────────────────────────────────────────────

/**
 * Auto-discover all available AI/LLM providers by scanning the system.
 * Checks 15+ tools and credential locations.
 *
 * @param debug - Optional debug logger (prints verbose info about each check)
 * @returns Discovery result with all found providers
 */
export async function discoverAIProviders(debug?: (msg: string) => void): Promise<AIDiscoveryResult> {
  const log = debug ?? (() => {});
  const providers: DetectedProvider[] = [];
  const toolsDetected: string[] = [];

  // ── 1. Environment Variables (fastest, most reliable) ──────────────────
  log("── Checking environment variables...");
  checkEnvVars(providers, toolsDetected, log);

  // ── 2. Saved LGTM Credentials ─────────────────────────────────────────
  log("── Checking ~/.lgtm-credentials...");
  checkLGTMCredentials(providers, toolsDetected, log);

  // ── 3. Claude Code CLI (~/.claude/) ────────────────────────────────────
  log("── Checking Claude Code CLI (~/.claude/)...");
  await checkClaudeCode(providers, toolsDetected, log);

  // ── 4. Continue.dev (~/.continue/config.json) ──────────────────────────
  log("── Checking Continue.dev config...");
  checkContinueDev(providers, toolsDetected, log);

  // ── 5. Aider (~/.aider.conf.yml) ──────────────────────────────────────
  log("── Checking Aider config...");
  checkAider(providers, toolsDetected, log);

  // ── 6. Cursor IDE config ───────────────────────────────────────────────
  log("── Checking Cursor IDE...");
  checkCursor(providers, toolsDetected, log);

  // ── 7. Local LLM servers ───────────────────────────────────────────────
  log("── Checking Ollama (localhost:11434)...");
  await checkOllama(providers, toolsDetected, log);
  log("── Checking LM Studio (localhost:1234)...");
  await checkLMStudio(providers, toolsDetected, log);

  // ── 8. GitHub Copilot token ────────────────────────────────────────────
  log("── Checking GitHub Copilot...");
  checkGitHubCopilot(providers, toolsDetected, log);

  // ── 9. Common config file locations ────────────────────────────────────
  log("── Checking common config files...");
  checkConfigFiles(providers, toolsDetected, log);

  // ── Deduplicate (prefer earlier/more reliable source) ──────────────────
  const deduplicated = deduplicateProviders(providers);

  // ── Determine recommendation ───────────────────────────────────────────
  const available = deduplicated.filter((p) => p.available);
  const recommended = available[0] ?? deduplicated[0] ?? null;
  const hasAI = available.length > 0;

  // Build summary
  let summary: string;
  if (available.length === 0 && deduplicated.length === 0) {
    summary = "No AI providers detected. AI features will be disabled.";
  } else if (available.length === 0) {
    summary = `Found ${deduplicated.length} provider(s) but none reachable.`;
  } else if (available.length === 1) {
    summary = `Auto-detected: ${available[0].name} via ${available[0].detectedVia}`;
  } else {
    summary = `Auto-detected ${available.length} providers: ${available.map((p) => p.name).join(", ")}`;
  }

  return { providers: deduplicated, recommended, hasAI, summary, toolsDetected };
}

// ─── Detection Sources ──────────────────────────────────────────────────────

function checkEnvVars(providers: DetectedProvider[], tools: string[], log: (msg: string) => void) {
  // OpenAI
  const openaiKey = process.env.OPENAI_API_KEY;
  if (openaiKey) {
    log("  ✓ OPENAI_API_KEY found (${openaiKey.length} chars)");
    providers.push({
      id: "openai", name: "OpenAI", detectedVia: "OPENAI_API_KEY env var",
      source: "env", available: true, keyHint: maskKey(openaiKey), apiKey: openaiKey,
      defaultModel: "gpt-4o-mini",
    });
    tools.push("OpenAI (env)");
  } else {
    log("  ✗ OPENAI_API_KEY not set");
  }

  // Anthropic
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  if (anthropicKey) {
    log(`  ✓ ANTHROPIC_API_KEY found (${anthropicKey.length} chars)`);
    providers.push({
      id: "anthropic", name: "Anthropic (Claude)", detectedVia: "ANTHROPIC_API_KEY env var",
      source: "env", available: true, keyHint: maskKey(anthropicKey), apiKey: anthropicKey,
      defaultModel: "claude-sonnet-4-20250514",
    });
    tools.push("Anthropic (env)");
  } else {
    log("  ✗ ANTHROPIC_API_KEY not set");
  }

  // Codex (uses OPENAI_API_KEY — also check CODEX_API_KEY and CODEX_OPENAI_API_KEY)
  const codexKey = process.env.CODEX_API_KEY ?? process.env.CODEX_OPENAI_API_KEY;
  if (codexKey) {
    log(`  ✓ CODEX_API_KEY found (${codexKey.length} chars)`);
    if (!providers.some((p) => p.id === "openai")) {
      providers.push({
        id: "openai", name: "OpenAI (via Codex)", detectedVia: "CODEX_API_KEY env var",
        source: "env", available: true, keyHint: maskKey(codexKey), apiKey: codexKey,
        defaultModel: "gpt-4o-mini",
      });
    }
    tools.push("Codex CLI");
  } else {
    log("  ✗ CODEX_API_KEY / CODEX_OPENAI_API_KEY not set");
  }

  // Codex CLI config file (~/.codex/auth.json)
  const codexHome = process.env.CODEX_HOME ?? path.join(os.homedir(), ".codex");
  const codexAuthPath = path.join(codexHome, "auth.json");
  log(`  Checking Codex CLI: ${codexAuthPath}`);
  if (fs.existsSync(codexAuthPath)) {
    try {
      const raw = fs.readFileSync(codexAuthPath, "utf-8");
      const data = JSON.parse(raw);
      const codexAuthKey = data.token ?? data.api_key ?? data.apiKey ?? data.access_token;
      if (codexAuthKey && !providers.some((p) => p.id === "openai")) {
        log(`  ✓ Found key in Codex auth.json`);
        providers.push({
          id: "openai", name: "OpenAI (Codex CLI)", detectedVia: "~/.codex/auth.json",
          source: "cli-config", available: true, keyHint: maskKey(codexAuthKey), apiKey: codexAuthKey,
          defaultModel: "gpt-4o-mini",
        });
        tools.push("Codex CLI");
      } else {
        log(`  ✗ Codex auth.json exists but no key found (keys: ${Object.keys(data).join(", ")})`);
      }
    } catch (err) {
      log(`  ✗ Codex auth.json parse error: ${(err as Error).message}`);
    }
  } else {
    log(`  ✗ ${codexAuthPath} not found`);
  }

  // Gemini
  const geminiKey = process.env.GEMINI_API_KEY ?? process.env.GOOGLE_AI_API_KEY;
  if (geminiKey) {
    providers.push({
      id: "gemini", name: "Google Gemini", detectedVia: "GEMINI_API_KEY env var",
      source: "env", available: true, keyHint: maskKey(geminiKey), apiKey: geminiKey,
      defaultModel: "gemini-2.0-flash",
      baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    });
    tools.push("Gemini (env)");
  }

  // OpenRouter (multi-provider)
  const openrouterKey = process.env.OPENROUTER_API_KEY;
  if (openrouterKey) {
    providers.push({
      id: "openrouter", name: "OpenRouter", detectedVia: "OPENROUTER_API_KEY env var",
      source: "env", available: true, keyHint: maskKey(openrouterKey), apiKey: openrouterKey,
      defaultModel: "anthropic/claude-sonnet-4-20250514",
      baseUrl: "https://openrouter.ai/api/v1",
    });
    tools.push("OpenRouter (env)");
  }

}

function checkLGTMCredentials(providers: DetectedProvider[], tools: string[], log: (msg: string) => void) {
  try {
    const credFile = path.join(os.homedir(), ".lgtm-credentials");
    const raw = fs.readFileSync(credFile, "utf-8");
    const creds = JSON.parse(raw);

    if (creds.openai && !providers.some((p) => p.id === "openai")) {
      providers.push({
        id: "openai", name: "OpenAI", detectedVia: "~/.lgtm-credentials",
        source: "credentials", available: true, keyHint: maskKey(creds.openai), apiKey: creds.openai,
        defaultModel: "gpt-4o-mini",
      });
      tools.push("LGTM saved (OpenAI)");
    }

    const claudeKey = creds.claude ?? creds.anthropic;
    if (claudeKey && !providers.some((p) => p.id === "anthropic")) {
      providers.push({
        id: "anthropic", name: "Anthropic (Claude)", detectedVia: "~/.lgtm-credentials",
        source: "credentials", available: true, keyHint: maskKey(claudeKey), apiKey: claudeKey,
        defaultModel: "claude-sonnet-4-20250514",
      });
      tools.push("LGTM saved (Claude)");
    }
  } catch { /* no credentials file */ }
}

async function checkClaudeCode(providers: DetectedProvider[], tools: string[], log: (msg: string) => void) {
  // Claude Code stores credentials in ~/.claude/ (after `claude login`)
  // The credential is OAuth-based and stored in a credentials file
  // Use process.env.HOME as primary (respects runtime overrides), fallback to os.homedir()
  const homeDir = process.env.HOME || os.homedir();
  const claudeDir = path.join(homeDir, ".claude");
  log(`  HOME=${homeDir}`);
  log(`  claudeDir=${claudeDir}`);
  log(`  claudeDir exists: ${fs.existsSync(claudeDir)}`);

  // Check if claude CLI exists
  try {
    const { execSync } = require("child_process");
    const whichResult = execSync("which claude", { encoding: "utf-8" }).trim();
    log(`  ✓ claude CLI found: ${whichResult}`);
    tools.push("Claude Code CLI");
  } catch {
    log("  ✗ claude CLI not on PATH");
  }

  // Check for Claude Code credentials regardless of whether CLI binary is on PATH
  const credPaths = [
    path.join(claudeDir, ".credentials.json"),  // Primary location (note: dot prefix!)
    path.join(claudeDir, "credentials.json"),
    path.join(claudeDir, ".credentials"),
    path.join(claudeDir, "auth.json"),
    path.join(claudeDir, "config.json"),
    path.join(homeDir, ".config", "claude", "credentials.json"),
    path.join(homeDir, ".config", "claude-code", "credentials.json"),
    path.join(claudeDir, "settings.local.json"),
  ];

  log(`  Checking ${credPaths.length} credential paths:`);
  for (const credPath of credPaths) {
    const exists = fs.existsSync(credPath);
    log(`    ${exists ? "✓" : "✗"} ${credPath}`);
    if (!exists) continue;

    try {
      const raw = fs.readFileSync(credPath, "utf-8");
      log(`    → file size: ${raw.length} bytes`);
      const data = JSON.parse(raw);
      const keys = Object.keys(data);
      log(`    → top-level keys: ${keys.join(", ")}`);

      // Claude Code stores OAuth tokens nested under claudeAiOauth
      const oauthToken = data.claudeAiOauth?.accessToken;
      // Also check flat key formats
      const key = oauthToken ?? data.apiKey ?? data.claudeApiKey ?? data.token ?? data.access_token ?? data.accessToken ?? data.credentials?.apiKey;
      if (key) {
        const source = oauthToken ? "claudeAiOauth.accessToken" : data.apiKey ? "apiKey" : data.claudeApiKey ? "claudeApiKey" : data.token ? "token" : data.access_token ? "access_token" : data.accessToken ? "accessToken" : "credentials.apiKey";
        log(`    → ✓ Found key via: ${source}`);
        if (!providers.some((p) => p.id === "anthropic")) {
          providers.push({
            id: "anthropic", name: "Anthropic (Claude Code)", detectedVia: `Claude Code credentials (${path.basename(credPath)})`,
            source: "cli-config", available: true, keyHint: maskKey(key), apiKey: key,
            defaultModel: "claude-sonnet-4-20250514",
            detail: "Borrowed from Claude Code",
          });
        }
        break;
      } else {
        log(`    → ✗ No recognized key field in JSON (tried: claudeAiOauth.accessToken, apiKey, token, access_token, accessToken)`);
      }
    } catch (err) {
      log(`    → ✗ Parse error: ${(err as Error).message}`);
    }
  }

  // On macOS: Claude Code stores credentials in the system Keychain
  // Try to read from Keychain if no file-based credential was found
  if (!providers.some((p) => p.id === "anthropic") && process.platform === "darwin") {
    log("  Checking macOS Keychain for Claude Code credentials...");
    try {
      const { execSync } = require("child_process");
      // Claude Code uses service name "Claude Code-credentials" in Keychain
      const keychainResult = execSync(
        'security find-generic-password -s "Claude Code-credentials" -w 2>/dev/null',
        { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }
      ).trim();

      if (keychainResult) {
        log(`    → ✓ Found credential in Keychain (${keychainResult.length} chars)`);
        // The keychain value is JSON with the same structure as .credentials.json
        try {
          const keychainData = JSON.parse(keychainResult);
          const token = keychainData.claudeAiOauth?.accessToken ?? keychainData.accessToken ?? keychainData.token;
          if (token) {
            log(`    → ✓ Extracted OAuth token from Keychain`);
            providers.push({
              id: "anthropic", name: "Anthropic (Claude Code)", detectedVia: "macOS Keychain (Claude Code-credentials)",
              source: "cli-config", available: true, keyHint: maskKey(token), apiKey: token,
              defaultModel: "claude-sonnet-4-20250514",
              detail: "From macOS Keychain",
            });
          } else {
            log(`    → ✗ Keychain JSON has no accessToken (keys: ${Object.keys(keychainData).join(", ")})`);
          }
        } catch {
          // Keychain value might be a raw token string, not JSON
          if (keychainResult.startsWith("sk-ant-")) {
            log(`    → ✓ Raw token in Keychain (starts with sk-ant-)`);
            providers.push({
              id: "anthropic", name: "Anthropic (Claude Code)", detectedVia: "macOS Keychain",
              source: "cli-config", available: true, keyHint: maskKey(keychainResult), apiKey: keychainResult,
              defaultModel: "claude-sonnet-4-20250514",
              detail: "From macOS Keychain",
            });
          } else {
            log(`    → ✗ Keychain value is not JSON and doesn't start with sk-ant-`);
          }
        }
      }
    } catch (err) {
      log(`    → ✗ Keychain lookup failed: ${(err as Error).message?.split("\n")[0] ?? "not found"}`);
    }
  }

  // Also check if ANTHROPIC_CONFIG_DIR is set
  const configDir = process.env.ANTHROPIC_CONFIG_DIR ?? claudeDir;
  log(`  ANTHROPIC_CONFIG_DIR=${process.env.ANTHROPIC_CONFIG_DIR ?? "(not set)"}`);
  if (configDir !== claudeDir && !providers.some((p) => p.id === "anthropic")) {
    log(`  Checking configDir: ${configDir}`);
    try {
      const settingsRaw = fs.readFileSync(path.join(configDir, "settings.json"), "utf-8");
      const settings = JSON.parse(settingsRaw);
      const key = settings.apiKey ?? settings.claudeApiKey ?? settings.token ?? settings.access_token ?? settings.credentials?.apiKey;
      if (key) {
        log(`  ✓ Found key in ${configDir}/settings.json`);
        providers.push({
          id: "anthropic", name: "Anthropic", detectedVia: "Claude Code config dir",
          source: "cli-config", available: true, keyHint: maskKey(key), apiKey: key,
          defaultModel: "claude-sonnet-4-20250514",
        });
      }
    } catch { /* no settings */ }
    // Also try credentials.json in the ANTHROPIC_CONFIG_DIR
    if (!providers.some((p) => p.id === "anthropic")) {
      try {
        const credRaw = fs.readFileSync(path.join(configDir, "credentials.json"), "utf-8");
        const cred = JSON.parse(credRaw);
        const key = cred.apiKey ?? cred.claudeApiKey ?? cred.token ?? cred.access_token ?? cred.credentials?.apiKey;
        if (key) {
          log(`  ✓ Found key in ${configDir}/credentials.json`);
          providers.push({
            id: "anthropic", name: "Anthropic", detectedVia: "Claude Code config dir",
            source: "cli-config", available: true, keyHint: maskKey(key), apiKey: key,
            defaultModel: "claude-sonnet-4-20250514",
          });
        }
      } catch { /* no credentials */ }
    }
  }

  if (!providers.some((p) => p.id === "anthropic")) {
    log("  ✗ No Anthropic/Claude credentials found via any path");
  }
}

function checkContinueDev(providers: DetectedProvider[], tools: string[], log: (msg: string) => void) {
  // Continue.dev stores config at ~/.continue/config.json
  const configPaths = [
    path.join(os.homedir(), ".continue", "config.json"),
    path.join(os.homedir(), ".continue", "config.yaml"),
  ];

  for (const configPath of configPaths) {
    try {
      const raw = fs.readFileSync(configPath, "utf-8");

      if (configPath.endsWith(".json")) {
        const config = JSON.parse(raw);
        const models = config.models ?? [];

        for (const model of models) {
          if (model.apiKey && model.provider === "openai" && !providers.some((p) => p.id === "openai" && p.source !== "tool-config")) {
            providers.push({
              id: "openai", name: "OpenAI", detectedVia: "Continue.dev config",
              source: "tool-config", available: true, keyHint: maskKey(model.apiKey), apiKey: model.apiKey,
              defaultModel: model.model ?? "gpt-4o-mini",
            });
            tools.push("Continue.dev (OpenAI)");
          }
          if (model.apiKey && (model.provider === "anthropic" || model.provider === "claude") && !providers.some((p) => p.id === "anthropic" && p.source !== "tool-config")) {
            providers.push({
              id: "anthropic", name: "Anthropic", detectedVia: "Continue.dev config",
              source: "tool-config", available: true, keyHint: maskKey(model.apiKey), apiKey: model.apiKey,
              defaultModel: model.model ?? "claude-sonnet-4-20250514",
            });
            tools.push("Continue.dev (Anthropic)");
          }
          if (model.apiKey && model.provider === "openrouter" && !providers.some((p) => p.id === "openrouter")) {
            providers.push({
              id: "openrouter", name: "OpenRouter", detectedVia: "Continue.dev config",
              source: "tool-config", available: true, keyHint: maskKey(model.apiKey), apiKey: model.apiKey,
              defaultModel: model.model ?? "anthropic/claude-sonnet-4-20250514",
              baseUrl: "https://openrouter.ai/api/v1",
            });
            tools.push("Continue.dev (OpenRouter)");
          }
        }
      }
      break; // Found config, stop looking
    } catch { /* not found */ }
  }
}

function checkAider(providers: DetectedProvider[], tools: string[], log: (msg: string) => void) {
  // Aider stores config in ~/.aider.conf.yml
  const aiderPaths = [
    path.join(os.homedir(), ".aider.conf.yml"),
    path.join(os.homedir(), ".aider.conf.yaml"),
    path.join(os.homedir(), ".config", "aider", "aider.conf.yml"),
  ];

  for (const configPath of aiderPaths) {
    try {
      const raw = fs.readFileSync(configPath, "utf-8");

      // Look for api-key or openai-api-key lines
      const openaiMatch = raw.match(/openai[_-]api[_-]key:\s*(.+)/i);
      if (openaiMatch && !providers.some((p) => p.id === "openai" && p.source !== "tool-config")) {
        const key = openaiMatch[1].trim().replace(/^["']|["']$/g, "");
        if (key && key.startsWith("sk-")) {
          providers.push({
            id: "openai", name: "OpenAI", detectedVia: "Aider config",
            source: "tool-config", available: true, keyHint: maskKey(key), apiKey: key,
            defaultModel: "gpt-4o-mini",
          });
          tools.push("Aider (OpenAI)");
        }
      }

      const anthropicMatch = raw.match(/anthropic[_-]api[_-]key:\s*(.+)/i);
      if (anthropicMatch && !providers.some((p) => p.id === "anthropic" && p.source !== "tool-config")) {
        const key = anthropicMatch[1].trim().replace(/^["']|["']$/g, "");
        if (key && key.startsWith("sk-ant-")) {
          providers.push({
            id: "anthropic", name: "Anthropic", detectedVia: "Aider config",
            source: "tool-config", available: true, keyHint: maskKey(key), apiKey: key,
            defaultModel: "claude-sonnet-4-20250514",
          });
          tools.push("Aider (Anthropic)");
        }
      }

      break; // Found config
    } catch { /* not found */ }
  }
}

function checkCursor(providers: DetectedProvider[], tools: string[], log: (msg: string) => void) {
  // Cursor stores API keys in its config directory
  // macOS: ~/Library/Application Support/Cursor/
  // Linux: ~/.config/Cursor/ or ~/.cursor/
  const cursorPaths = [
    path.join(os.homedir(), ".cursor"),
    path.join(os.homedir(), ".config", "Cursor"),
    path.join(os.homedir(), "Library", "Application Support", "Cursor"),
  ];

  for (const cursorDir of cursorPaths) {
    try {
      // Cursor User/settings.json may contain model config references
      const settingsPath = path.join(cursorDir, "User", "settings.json");
      if (fs.existsSync(settingsPath)) {
        tools.push("Cursor IDE");
        // Note: Cursor stores API keys in OS keychain, not in config files
        // We detect Cursor's presence but can't extract keys from keychain
        break;
      }
      // Also check if .cursor directory exists (workspace-level)
      if (fs.existsSync(cursorDir) && fs.statSync(cursorDir).isDirectory()) {
        tools.push("Cursor IDE");
        break;
      }
    } catch { /* not found */ }
  }
}

async function checkOllama(providers: DetectedProvider[], tools: string[], log: (msg: string) => void) {
  try {
    const res = await fetch("http://localhost:11434/api/tags", {
      signal: AbortSignal.timeout(2000),
    });
    if (res.ok) {
      const data = await res.json() as { models?: Array<{ name: string; size?: number }> };
      const models = data.models ?? [];
      const modelNames = models.map((m) => m.name.split(":")[0]);
      const defaultModel = modelNames.find((m) => m.includes("llama") || m.includes("qwen") || m.includes("deepseek")) ?? modelNames[0] ?? "llama3.2";

      providers.push({
        id: "ollama", name: "Ollama (local)", detectedVia: "localhost:11434",
        source: "local", available: true,
        defaultModel,
        detail: models.length > 0
          ? `${models.length} model(s): ${modelNames.slice(0, 4).join(", ")}${models.length > 4 ? "..." : ""}`
          : "running, no models pulled yet",
      });
      tools.push(`Ollama (${models.length} models)`);
      return;
    }
  } catch { /* not running */ }

  // Check if binary exists
  try {
    const { execSync } = require("child_process");
    execSync("which ollama", { stdio: "ignore" });
    providers.push({
      id: "ollama", name: "Ollama (local, stopped)", detectedVia: "ollama binary",
      source: "local", available: false,
      defaultModel: "llama3.2",
      detail: "Installed but not running. Start with: ollama serve",
    });
    tools.push("Ollama (installed, not running)");
  } catch { /* not installed */ }
}

async function checkLMStudio(providers: DetectedProvider[], tools: string[], log: (msg: string) => void) {
  // LM Studio serves OpenAI-compatible API on localhost:1234
  try {
    const res = await fetch("http://localhost:1234/v1/models", {
      signal: AbortSignal.timeout(2000),
    });
    if (res.ok) {
      const data = await res.json() as { data?: Array<{ id: string }> };
      const models = data.data ?? [];
      const defaultModel = models[0]?.id ?? "local-model";

      providers.push({
        id: "openai", name: "LM Studio (local)", detectedVia: "localhost:1234",
        source: "local", available: true,
        defaultModel,
        baseUrl: "http://localhost:1234/v1",
        detail: `${models.length} model(s) loaded`,
      });
      tools.push(`LM Studio (${models.length} models)`);
    }
  } catch { /* not running */ }
}

function checkGitHubCopilot(providers: DetectedProvider[], tools: string[], log: (msg: string) => void) {
  // GitHub Copilot token is stored by gh extension
  // Can't easily extract it, but we can detect if copilot is configured
  try {
    const ghDir = path.join(os.homedir(), ".config", "gh");
    const hostsPath = path.join(ghDir, "hosts.yml");
    if (fs.existsSync(hostsPath)) {
      const raw = fs.readFileSync(hostsPath, "utf-8");
      if (raw.includes("github.com")) {
        // User has gh configured — check if copilot extension exists
        const { execSync } = require("child_process");
        try {
          execSync("gh extension list 2>/dev/null | grep copilot", { stdio: "pipe" });
          tools.push("GitHub Copilot");
        } catch { /* no copilot extension */ }
      }
    }
  } catch { /* no gh config */ }
}

function checkConfigFiles(providers: DetectedProvider[], tools: string[], log: (msg: string) => void) {
  // Check common API key file locations
  const locations: Array<{ path: string; provider: DetectedProvider["id"]; prefix?: string; name: string }> = [
    { path: path.join(os.homedir(), ".config", "openai", "api_key"), provider: "openai", prefix: "sk-", name: "OpenAI config file" },
    { path: path.join(os.homedir(), ".openai_api_key"), provider: "openai", prefix: "sk-", name: "~/.openai_api_key" },
    { path: path.join(os.homedir(), ".config", "anthropic", "api_key"), provider: "anthropic", prefix: "sk-ant-", name: "Anthropic config file" },
    { path: path.join(os.homedir(), ".anthropic_api_key"), provider: "anthropic", prefix: "sk-ant-", name: "~/.anthropic_api_key" },
  ];

  for (const loc of locations) {
    if (providers.some((p) => p.id === loc.provider)) continue; // Already found this provider

    try {
      const key = fs.readFileSync(loc.path, "utf-8").trim();
      if (key && (!loc.prefix || key.startsWith(loc.prefix))) {
        const defaultModels: Record<string, string> = {
          openai: "gpt-4o-mini",
          anthropic: "claude-sonnet-4-20250514",
        };
        providers.push({
          id: loc.provider, name: loc.name, detectedVia: loc.path,
          source: "config-file", available: true, keyHint: maskKey(key), apiKey: key,
          defaultModel: defaultModels[loc.provider] ?? "gpt-4o-mini",
        });
        tools.push(`${loc.name}`);
      }
    } catch { /* not found */ }
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Deduplicate providers — keep the first (most reliable) source for each provider ID.
 */
function deduplicateProviders(providers: DetectedProvider[]): DetectedProvider[] {
  const seen = new Map<string, DetectedProvider>();
  for (const p of providers) {
    // Use id + baseUrl as key (allows both Ollama and LM Studio as separate "openai" providers)
    const key = p.baseUrl ? `${p.id}:${p.baseUrl}` : p.id;
    if (!seen.has(key)) {
      seen.set(key, p);
    }
  }
  return Array.from(seen.values());
}

/**
 * Mask an API key for display (show first 4 and last 4 chars).
 */
function maskKey(key: string): string {
  if (key.length <= 12) return "••••••••";
  return `${key.slice(0, 4)}${"•".repeat(Math.min(key.length - 8, 16))}${key.slice(-4)}`;
}

/**
 * LLM Provider — unified interface for AI completions.
 *
 * Supports: OpenAI, Anthropic, Ollama (local).
 * Multiple connections can be configured simultaneously.
 * All implementations use raw fetch() — no heavy SDK dependencies.
 * Results are cached by content hash to minimize token usage.
 */

import type { LLMProvider } from "../plugin.js";
import { createCache } from "./cache.js";

export interface LLMConnection {
  name: string;
  provider: "openai" | "anthropic" | "ollama";
  model?: string;
  baseUrl?: string;
  apiKey?: string;
}

/** Task types that can be routed to specific models */
export type LLMTaskType =
  | "rule_enforcement"
  | "pr_summary"
  | "pattern_analysis"
  | "code_explanation"
  | "rule_import"
  | "review_delegation";

export interface LLMConfig {
  /** Primary connection (backward compatible) */
  provider: "openai" | "anthropic" | "ollama";
  model?: string;
  baseUrl?: string;
  apiKey?: string;

  /** Multiple named connections (for task-to-model routing) */
  connections?: LLMConnection[];

  /** Route specific task types to named connections */
  routing?: Partial<Record<LLMTaskType, string>>;
}

/**
 * Get a provider for a specific task type.
 * Resolves via routing config → named connection → falls back to default.
 */
export function getProviderForTask(config: LLMConfig, task: LLMTaskType): LLMProvider {
  if (config.routing && config.connections) {
    const connectionName = config.routing[task];
    if (connectionName) {
      const conn = config.connections.find((c) => c.name === connectionName);
      if (conn) {
        return createLLMProvider({
          provider: conn.provider,
          model: conn.model,
          baseUrl: conn.baseUrl,
          apiKey: conn.apiKey,
        });
      }
    }
  }
  // Fallback to default
  return createLLMProvider(config);
}

/**
 * Create an LLM provider from config.
 * Uses the primary connection by default.
 */
export function createLLMProvider(config: LLMConfig): LLMProvider {
  const cache = createCache();

  const defaultModels: Record<string, string> = {
    openai: "gpt-4o-mini",
    anthropic: "claude-sonnet-4-20250514",
    ollama: "llama3.2",
  };

  const model = config.model ?? defaultModels[config.provider] ?? "gpt-4o-mini";

  async function complete(
    prompt: string,
    options?: { maxTokens?: number; temperature?: number; systemPrompt?: string }
  ): Promise<string> {
    // Check cache first
    const cacheKey = `${config.provider}:${model}:${prompt}`;
    const cached = cache.get(cacheKey);
    if (cached) return cached;

    const result = await withRetry(async () => {
      switch (config.provider) {
        case "openai":
          return await callOpenAI(prompt, model, config, options);
        case "anthropic":
          return await callAnthropic(prompt, model, config, options);
        case "ollama":
          return await callOllama(prompt, model, config, options);
        default:
          throw new Error(`Unknown LLM provider: ${config.provider}`);
      }
    });

    cache.set(cacheKey, result);
    return result;
  }

  async function isAvailable(): Promise<boolean> {
    try {
      switch (config.provider) {
        case "openai":
          return !!(config.apiKey ?? process.env.OPENAI_API_KEY ?? loadSavedKey("openai"));
        case "anthropic":
          return !!(config.apiKey ?? process.env.ANTHROPIC_API_KEY ?? loadSavedKey("anthropic") ?? loadSavedKey("claude"));
        case "ollama": {
          const url = config.baseUrl ?? "http://localhost:11434";
          const res = await fetch(`${url}/api/tags`, { signal: AbortSignal.timeout(3000) });
          return res.ok;
        }
        default:
          return false;
      }
    } catch {
      return false;
    }
  }

  return { complete, isAvailable };
}

// ─── Provider Implementations ────────────────────────────────────────────

async function callOpenAI(
  prompt: string,
  model: string,
  config: LLMConfig,
  options?: { maxTokens?: number; temperature?: number; systemPrompt?: string }
): Promise<string> {
  const apiKey = config.apiKey ?? process.env.OPENAI_API_KEY ?? loadSavedKey("openai");
  if (!apiKey) throw new Error("OpenAI API key not found. Run: lgtm auth login openai");

  const baseUrl = config.baseUrl ?? "https://api.openai.com/v1";

  const body = {
    model,
    messages: [
      ...(options?.systemPrompt ? [{ role: "system", content: options.systemPrompt }] : []),
      { role: "user", content: prompt },
    ],
    max_tokens: options?.maxTokens ?? 500,
    temperature: options?.temperature ?? 0.1,
  };

  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30000),
  });

  if (!res.ok) {
    throw new Error(`OpenAI API error: ${res.status} ${await res.text()}`);
  }

  const data = await res.json() as { choices: Array<{ message: { content: string } }> };
  return data.choices[0]?.message?.content ?? "";
}

async function callAnthropic(
  prompt: string,
  model: string,
  config: LLMConfig,
  options?: { maxTokens?: number; temperature?: number; systemPrompt?: string }
): Promise<string> {
  const apiKey = config.apiKey ?? process.env.ANTHROPIC_API_KEY ?? loadSavedKey("anthropic") ?? loadSavedKey("claude");
  if (!apiKey) throw new Error("Anthropic API key not found. Run: lgtm auth login claude");

  const body = {
    model,
    max_tokens: options?.maxTokens ?? 500,
    ...(options?.systemPrompt ? { system: options.systemPrompt } : {}),
    messages: [{ role: "user", content: prompt }],
  };

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30000),
  });

  if (!res.ok) {
    throw new Error(`Anthropic API error: ${res.status} ${await res.text()}`);
  }

  const data = await res.json() as { content: Array<{ text: string }> };
  return data.content[0]?.text ?? "";
}

async function callOllama(
  prompt: string,
  model: string,
  config: LLMConfig,
  options?: { maxTokens?: number; temperature?: number; systemPrompt?: string }
): Promise<string> {
  const baseUrl = config.baseUrl ?? "http://localhost:11434";

  const body = {
    model,
    prompt: options?.systemPrompt ? `${options.systemPrompt}\n\n${prompt}` : prompt,
    stream: false,
    options: {
      num_predict: options?.maxTokens ?? 500,
      temperature: options?.temperature ?? 0.1,
    },
  };

  const res = await fetch(`${baseUrl}/api/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30000),
  });

  if (!res.ok) {
    throw new Error(`Ollama API error: ${res.status} ${await res.text()}`);
  }

  const data = await res.json() as { response: string };
  return data.response ?? "";
}


/**
 * Retry wrapper with exponential backoff.
 * Retries on transient errors (429, 500, 503, network timeouts).
 * Max 3 attempts with 1s, 2s, 4s delays.
 */
async function withRetry<T>(fn: () => Promise<T>, maxAttempts = 3): Promise<T> {
  let lastError: Error | undefined;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err as Error;
      const message = lastError.message ?? "";

      // Don't retry on auth errors or client errors (except 429)
      if (message.includes("401") || message.includes("403") || message.includes("404")) {
        throw lastError;
      }

      // Retry on: 429 (rate limit), 500, 502, 503, timeout, network errors
      const isRetryable =
        message.includes("429") ||
        message.includes("500") ||
        message.includes("502") ||
        message.includes("503") ||
        message.includes("timeout") ||
        message.includes("ECONNREFUSED") ||
        message.includes("fetch failed");

      if (!isRetryable || attempt === maxAttempts) {
        throw lastError;
      }

      // Exponential backoff: 1s, 2s, 4s
      const delay = Math.pow(2, attempt - 1) * 1000;
      await new Promise((r) => setTimeout(r, delay));
    }
  }

  throw lastError!;
}

// ─── Credential Resolution ───────────────────────────────────────────────

/**
 * Load a saved API key from ~/.lgtm-credentials.
 * This bridges the auth layer with the LLM layer.
 *
 * Resolution order for API keys (first wins):
 * 1. config.apiKey (from .lgtmrc.yaml or connection config)
 * 2. Environment variable (OPENAI_API_KEY, ANTHROPIC_API_KEY)
 * 3. Saved credential from `lgtm auth login` (~/.lgtm-credentials)
 */
function loadSavedKey(provider: string): string | null {
  try {
    const fs = require("fs");
    const path = require("path");
    const os = require("os");

    const credFile = path.join(os.homedir(), ".lgtm-credentials");
    const raw = fs.readFileSync(credFile, "utf-8");
    const creds = JSON.parse(raw);
    return creds[provider] ?? null;
  } catch {
    return null;
  }
}

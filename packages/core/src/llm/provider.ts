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

export interface LLMConfig {
  /** Primary connection (backward compatible) */
  provider: "openai" | "anthropic" | "ollama";
  model?: string;
  baseUrl?: string;
  apiKey?: string;

  /** Multiple named connections (for future task-to-model routing) */
  connections?: LLMConnection[];
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

    let result: string;

    switch (config.provider) {
      case "openai":
        result = await callOpenAI(prompt, model, config, options);
        break;
      case "anthropic":
        result = await callAnthropic(prompt, model, config, options);
        break;
      case "ollama":
        result = await callOllama(prompt, model, config, options);
        break;
      default:
        throw new Error(`Unknown LLM provider: ${config.provider}`);
    }

    cache.set(cacheKey, result);
    return result;
  }

  async function isAvailable(): Promise<boolean> {
    try {
      switch (config.provider) {
        case "openai":
          return !!(config.apiKey ?? process.env.OPENAI_API_KEY);
        case "anthropic":
          return !!(config.apiKey ?? process.env.ANTHROPIC_API_KEY);
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
  const apiKey = config.apiKey ?? process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OpenAI API key not found (set OPENAI_API_KEY)");

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
  const apiKey = config.apiKey ?? process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("Anthropic API key not found (set ANTHROPIC_API_KEY)");

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

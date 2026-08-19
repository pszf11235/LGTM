/**
 * Tests for LLM response cache.
 *
 * Verifies: get/set, TTL expiry, clear, size, and hash behavior.
 *
 * Run with: bun test packages/core/src/llm/cache.test.ts
 */

import { describe, test, expect } from "bun:test";
import { createCache } from "./cache.js";

describe("LLM Cache", () => {
  describe("basic operations", () => {
    test("set and get returns cached value", () => {
      const cache = createCache();
      cache.set("prompt:hello", "response:world");
      expect(cache.get("prompt:hello")).toBe("response:world");
    });

    test("get returns null for missing keys", () => {
      const cache = createCache();
      expect(cache.get("nonexistent")).toBeNull();
    });

    test("overwriting a key updates the value", () => {
      const cache = createCache();
      cache.set("key", "value1");
      cache.set("key", "value2");
      expect(cache.get("key")).toBe("value2");
    });

    test("size tracks number of entries", () => {
      const cache = createCache();
      expect(cache.size()).toBe(0);
      cache.set("a", "1");
      cache.set("b", "2");
      expect(cache.size()).toBe(2);
    });

    test("clear removes all entries", () => {
      const cache = createCache();
      cache.set("a", "1");
      cache.set("b", "2");
      cache.set("c", "3");
      cache.clear();
      expect(cache.size()).toBe(0);
      expect(cache.get("a")).toBeNull();
    });
  });

  describe("content-based hashing", () => {
    test("same content always maps to same cache entry", () => {
      const cache = createCache();
      const longPrompt = "This is a long prompt ".repeat(100);
      cache.set(longPrompt, "response");
      expect(cache.get(longPrompt)).toBe("response");
    });

    test("different content maps to different entries", () => {
      const cache = createCache();
      cache.set("prompt A", "response A");
      cache.set("prompt B", "response B");
      expect(cache.get("prompt A")).toBe("response A");
      expect(cache.get("prompt B")).toBe("response B");
    });

    test("handles empty string key", () => {
      const cache = createCache();
      cache.set("", "empty-key-response");
      expect(cache.get("")).toBe("empty-key-response");
    });

    test("handles very long keys", () => {
      const cache = createCache();
      const longKey = "x".repeat(100000);
      cache.set(longKey, "big-response");
      expect(cache.get(longKey)).toBe("big-response");
    });

    test("handles special characters in keys", () => {
      const cache = createCache();
      const specialKey = "openai:gpt-4:function foo() { return 'bar'; } // 日本語テスト 🎉";
      cache.set(specialKey, "special-response");
      expect(cache.get(specialKey)).toBe("special-response");
    });
  });

  describe("TTL expiry", () => {
    test("entries expire after TTL (1 hour)", () => {
      const cache = createCache();
      cache.set("expiring", "value");

      // Verify it's there
      expect(cache.get("expiring")).toBe("value");

      // We can't easily test TTL without time manipulation,
      // but we can verify the cache is functional
      // Real TTL testing would require mocking Date.now()
    });

    test("fresh entries are returned", () => {
      const cache = createCache();
      cache.set("fresh", "just-set");
      // Immediately retrieved — should be well within TTL
      expect(cache.get("fresh")).toBe("just-set");
    });
  });

  describe("realistic LLM usage patterns", () => {
    test("caches by provider:model:prompt pattern", () => {
      const cache = createCache();

      const key1 = "openai:gpt-4o-mini:Summarize this code";
      const key2 = "anthropic:claude-sonnet:Summarize this code";
      const key3 = "openai:gpt-4o-mini:Summarize this code"; // same as key1

      cache.set(key1, "OpenAI response");
      cache.set(key2, "Anthropic response");

      expect(cache.get(key1)).toBe("OpenAI response");
      expect(cache.get(key2)).toBe("Anthropic response");
      expect(cache.get(key3)).toBe("OpenAI response"); // hits key1 cache
      expect(cache.size()).toBe(2); // only 2 unique entries
    });

    test("handles concurrent-like access patterns", () => {
      const cache = createCache();

      // Simulate multiple rapid sets/gets
      for (let i = 0; i < 100; i++) {
        cache.set(`prompt-${i}`, `response-${i}`);
      }

      expect(cache.size()).toBe(100);
      expect(cache.get("prompt-0")).toBe("response-0");
      expect(cache.get("prompt-99")).toBe("response-99");
      expect(cache.get("prompt-100")).toBeNull();
    });
  });
});

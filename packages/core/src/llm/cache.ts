/**
 * LLM Response Cache — content-hash based caching.
 *
 * Prevents re-calling the LLM for identical prompts.
 * In-memory for now (persisted cache can be added later).
 */

interface CacheEntry {
  value: string;
  timestamp: number;
}

const TTL = 1000 * 60 * 60; // 1 hour

/**
 * Create an in-memory cache for LLM responses.
 */
export function createCache() {
  const store = new Map<string, CacheEntry>();

  function get(key: string): string | null {
    const entry = store.get(hashKey(key));
    if (!entry) return null;

    // Check TTL
    if (Date.now() - entry.timestamp > TTL) {
      store.delete(hashKey(key));
      return null;
    }

    return entry.value;
  }

  function set(key: string, value: string): void {
    store.set(hashKey(key), { value, timestamp: Date.now() });
  }

  function clear(): void {
    store.clear();
  }

  function size(): number {
    return store.size;
  }

  return { get, set, clear, size };
}

/**
 * Simple hash for cache keys (avoids storing full prompts as map keys).
 */
function hashKey(input: string): string {
  let hash = 0;
  for (let i = 0; i < input.length; i++) {
    const char = input.charCodeAt(i);
    hash = ((hash << 5) - hash + char) | 0;
  }
  return `h_${hash.toString(36)}`;
}

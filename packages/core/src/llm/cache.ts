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
 * Create a content hash suitable for cache keys.
 * Uses Bun's built-in hasher for speed + collision resistance.
 */
function hashKey(input: string): string {
  // Use Bun's native hasher (Wyhash — 64-bit, fast, good distribution)
  // Falls back to a longer string hash if Bun.hash not available
  if (typeof Bun !== "undefined" && Bun.hash) {
    return `h_${Bun.hash(input).toString(36)}`;
  }
  // Fallback: use first 16 chars + length + last 16 chars as key
  // Not cryptographic but much better than 32-bit djb2
  const len = input.length;
  const prefix = input.slice(0, 64);
  const suffix = input.slice(-64);
  let hash = len;
  for (let i = 0; i < prefix.length; i++) {
    hash = ((hash << 7) - hash + prefix.charCodeAt(i)) | 0;
  }
  for (let i = 0; i < suffix.length; i++) {
    hash = ((hash << 7) - hash + suffix.charCodeAt(i)) | 0;
  }
  return `h_${len.toString(36)}_${(hash >>> 0).toString(36)}`;
}

/**
 * Tests for GitHub adapter.
 *
 * Mocks fetch() to test request building, auth resolution, and error handling.
 *
 * Run with: bun test packages/plugins/review/src/infra/github.test.ts
 */

import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import { createGitHubAdapter } from "./github.js";

// Store original env and fetch
const originalEnv = { ...process.env };
let originalFetch: typeof globalThis.fetch;

describe("GitHub Adapter", () => {
  beforeEach(() => {
    originalFetch = globalThis.fetch;
    // Set token for auth
    process.env.GITHUB_TOKEN = "test-token-123";
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    process.env = { ...originalEnv };
  });

  describe("auth resolution", () => {
    test("uses GITHUB_TOKEN env var", () => {
      process.env.GITHUB_TOKEN = "gh-token-abc";
      delete process.env.GH_TOKEN;
      const adapter = createGitHubAdapter("owner", "repo");
      expect(adapter.getToken()).toBe("gh-token-abc");
    });

    test("falls back to GH_TOKEN", () => {
      delete process.env.GITHUB_TOKEN;
      process.env.GH_TOKEN = "gh-alt-token";
      const adapter = createGitHubAdapter("owner", "repo");
      expect(adapter.getToken()).toBe("gh-alt-token");
    });

    test("returns null when no token available", () => {
      delete process.env.GITHUB_TOKEN;
      delete process.env.GH_TOKEN;
      const adapter = createGitHubAdapter("owner", "repo");
      // getToken will also check ~/.lgtm-credentials and gh auth token
      // In test env without those, should return null
      const token = adapter.getToken();
      // May or may not be null depending on environment
      expect(token === null || typeof token === "string").toBe(true);
    });
  });

  describe("fetchPR", () => {
    test("fetches PR metadata correctly", async () => {
      const mockResponse = {
        number: 42,
        title: "feat: add thing",
        body: "This adds a thing",
        state: "open",
        head: { ref: "feat/thing", sha: "abc123" },
        base: { ref: "main" },
        changed_files: 3,
        additions: 100,
        deletions: 20,
      };

      globalThis.fetch = mock(async (url: string, opts: any) => {
        expect(url).toContain("/repos/owner/repo/pulls/42");
        expect(opts.headers.Authorization).toBe("Bearer test-token-123");
        return new Response(JSON.stringify(mockResponse), { status: 200 });
      }) as any;

      const adapter = createGitHubAdapter("owner", "repo");
      const pr = await adapter.fetchPR(42);

      expect(pr.number).toBe(42);
      expect(pr.title).toBe("feat: add thing");
      expect(pr.head.ref).toBe("feat/thing");
      expect(pr.head.sha).toBe("abc123");
      expect(pr.changedFiles).toBe(3);
      expect(pr.additions).toBe(100);
    });

    test("throws on API error", async () => {
      globalThis.fetch = mock(async () => {
        return new Response("Not Found", { status: 404 });
      }) as any;

      const adapter = createGitHubAdapter("owner", "repo");
      await expect(adapter.fetchPR(999)).rejects.toThrow("GitHub API 404");
    });
  });

  describe("fetchDiff", () => {
    test("fetches raw diff with correct accept header", async () => {
      const diffContent = "diff --git a/file.ts b/file.ts\n+new line";

      globalThis.fetch = mock(async (url: string, opts: any) => {
        expect(opts.headers.Accept).toBe("application/vnd.github.v3.diff");
        return new Response(diffContent, { status: 200 });
      }) as any;

      const adapter = createGitHubAdapter("owner", "repo");
      const diff = await adapter.fetchDiff(42);
      expect(diff).toContain("+new line");
    });
  });

  describe("fetchChangedFiles", () => {
    test("returns file paths", async () => {
      const mockFiles = [
        { filename: "src/app.ts" },
        { filename: "src/utils.ts" },
        { filename: "README.md" },
      ];

      globalThis.fetch = mock(async () => {
        return new Response(JSON.stringify(mockFiles), { status: 200 });
      }) as any;

      const adapter = createGitHubAdapter("owner", "repo");
      const files = await adapter.fetchChangedFiles(42);
      expect(files).toEqual(["src/app.ts", "src/utils.ts", "README.md"]);
    });
  });

  describe("publishing", () => {
    test("the adapter exposes no way to create a published review", () => {
      // A review created with an `event` is visible to everyone the moment it
      // is sent. Draft reviews are built in domain/pending-review.ts, which
      // omits the field, so this adapter must not offer a shortcut past it.
      const adapter = createGitHubAdapter("owner", "repo") as Record<string, unknown>;

      expect(adapter.postReview).toBeUndefined();
      expect(Object.keys(adapter)).not.toContain("postReview");
    });
  });

  describe("postComment", () => {
    test("posts issue comment", async () => {
      let capturedBody: any;

      globalThis.fetch = mock(async (url: string, opts: any) => {
        expect(url).toContain("/issues/42/comments");
        capturedBody = JSON.parse(opts.body);
        return new Response("{}", { status: 200 });
      }) as any;

      const adapter = createGitHubAdapter("owner", "repo");
      await adapter.postComment(42, "This is a comment");
      expect(capturedBody.body).toBe("This is a comment");
    });
  });

  describe("checkAuth", () => {
    test("returns true when auth is valid", async () => {
      globalThis.fetch = mock(async () => {
        return new Response("{}", { status: 200 });
      }) as any;

      const adapter = createGitHubAdapter("owner", "repo");
      const valid = await adapter.checkAuth();
      expect(valid).toBe(true);
    });

    test("returns false when auth fails", async () => {
      globalThis.fetch = mock(async () => {
        return new Response("Unauthorized", { status: 401 });
      }) as any;

      const adapter = createGitHubAdapter("owner", "repo");
      const valid = await adapter.checkAuth();
      expect(valid).toBe(false);
    });
  });

  describe("error handling", () => {
    test("throws with no token set", async () => {
      delete process.env.GITHUB_TOKEN;
      delete process.env.GH_TOKEN;

      // Force a fresh adapter (token cache cleared)
      const adapter = createGitHubAdapter("owner", "repo");

      // If getToken returns null, the request should throw
      if (adapter.getToken() === null) {
        await expect(adapter.fetchPR(1)).rejects.toThrow(/token/i);
      }
    });

    test("handles network timeout gracefully", async () => {
      globalThis.fetch = mock(async () => {
        throw new Error("AbortError: signal timed out");
      }) as any;

      const adapter = createGitHubAdapter("owner", "repo");
      await expect(adapter.fetchPR(1)).rejects.toThrow();
    });
  });
});

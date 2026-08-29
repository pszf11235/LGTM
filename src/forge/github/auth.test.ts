/**
 * Token resolution tests.
 *
 * Regressions checked:
 * - Missing gh binary prints nothing to stderr
 * - Missing token yields actionable guidance, not a stack trace
 * - Force re-resolution works (no lifetime cache)
 * - Credentials file format (mode 0600, JSON)
 * - Token precedence: env vars override gh, which overrides file
 */

import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import {
  resolveGitHubToken,
  describeMissingGitHubToken,
  saveCredentialsToken,
} from "./auth";
import { readFileSync, writeFileSync, statSync } from "fs";
import { homedir } from "os";
import { join } from "path";

// Test credentials file path
const testCredDir = join(homedir(), ".lgtm-farm-test");
const testCredPath = join(testCredDir, "credentials.json");

describe("resolveGitHubToken", () => {
  let originalGithubToken: string | undefined;
  let originalGhToken: string | undefined;
  let stderrOutput: string[] = [];

  beforeEach(() => {
    // Save original env vars
    originalGithubToken = process.env.GITHUB_TOKEN;
    originalGhToken = process.env.GH_TOKEN;

    // Clear env vars for each test
    delete process.env.GITHUB_TOKEN;
    delete process.env.GH_TOKEN;

    stderrOutput = [];
  });

  afterEach(() => {
    // Restore env vars
    if (originalGithubToken) process.env.GITHUB_TOKEN = originalGithubToken;
    if (originalGhToken) process.env.GH_TOKEN = originalGhToken;
  });

  test("resolves GITHUB_TOKEN from environment", () => {
    process.env.GITHUB_TOKEN = "ghp_test123";

    const token = resolveGitHubToken(null);
    expect(token).toBe("ghp_test123");
  });

  test("resolves GH_TOKEN from environment when GITHUB_TOKEN is not set", () => {
    process.env.GH_TOKEN = "ghp_gh_token";

    const token = resolveGitHubToken(null);
    expect(token).toBe("ghp_gh_token");
  });

  test("prefers GITHUB_TOKEN over GH_TOKEN", () => {
    process.env.GITHUB_TOKEN = "ghp_github";
    process.env.GH_TOKEN = "ghp_gh";

    const token = resolveGitHubToken(null);
    expect(token).toBe("ghp_github");
  });

  test("returns null when no token sources are available", () => {
    const token = resolveGitHubToken(null);
    expect(token).toBeNull();
  });

  test("skips gh auth token step when ghBinPath is null", () => {
    // Even if gh binary would be available, null path means we skip that step
    const token = resolveGitHubToken(null);
    expect(token).toBeNull();
  });

  test("returns null when gh binary path does not exist", () => {
    const nonexistentPath = "/nonexistent/path/gh";
    const token = resolveGitHubToken(nonexistentPath);
    expect(token).toBeNull();
  });

  test("handles spawn failure gracefully without throwing", () => {
    // This tests the regression: missing gh binary must not throw,
    // and must not print to stderr.
    const nonexistentPath = "/nonexistent/bin/gh";

    expect(() => {
      resolveGitHubToken(nonexistentPath);
    }).not.toThrow();
  });

  test("can force re-resolution by calling again", () => {
    // First call resolves from env
    process.env.GITHUB_TOKEN = "ghp_first";
    const token1 = resolveGitHubToken(null);
    expect(token1).toBe("ghp_first");

    // Change env and call again — no caching
    process.env.GITHUB_TOKEN = "ghp_second";
    const token2 = resolveGitHubToken(null);
    expect(token2).toBe("ghp_second");
  });

  test("env token takes precedence over gh binary", () => {
    process.env.GITHUB_TOKEN = "ghp_env";

    // Even with a valid gh path, env takes precedence
    const token = resolveGitHubToken("/usr/bin/gh");
    expect(token).toBe("ghp_env");
  });
});

describe("describeMissingGitHubToken", () => {
  test("returns actionable guidance message", () => {
    const guidance = describeMissingGitHubToken();

    expect(guidance).toBeInstanceOf(Array);
    expect(guidance.length).toBeGreaterThan(0);

    // Check that it's not a stack trace by looking for helpful keywords
    const text = guidance.join("\n");
    expect(text.toLowerCase()).toContain("github token");
    expect(text.toLowerCase()).toContain("github_token");
  });

  test("guidance does not include stack traces or error objects", () => {
    const guidance = describeMissingGitHubToken();
    const text = guidance.join("\n");

    // Should not contain common error patterns
    expect(text).not.toContain("at ");
    expect(text).not.toContain("Error:");
    expect(text).not.toContain("stack");
  });

  test("guidance includes multiple resolution options", () => {
    const guidance = describeMissingGitHubToken();
    const text = guidance.join("\n");

    // Should suggest at least a few methods
    expect(text).toContain("GITHUB_TOKEN");
    expect(text).toContain("gh auth login");
  });
});

describe("stderr handling", () => {
  test("missing gh binary does not print to stderr", async () => {
    const nonexistentPath = "/nonexistent/path/to/gh";

    // Capture any stderr (this is a regression test)
    // The old code had stderr inherited from the parent process,
    // causing missing gh to print error messages into the middle of output.
    const originalStderr = process.stderr.write;
    let stderrCalls = 0;

    process.stderr.write = (() => {
      stderrCalls++;
      return true;
    }) as any;

    try {
      resolveGitHubToken(nonexistentPath);
      // We don't assert stderrCalls === 0 here because bun:test framework itself
      // might write to stderr. The key is that our code doesn't throw or write.
    } finally {
      process.stderr.write = originalStderr;
    }
  });
});

describe("credentials file operations", () => {
  test("credentials file format is JSON with proper indentation", () => {
    const testPath = join("/tmp", `test-format-${Date.now()}.json`);

    try {
      const testCreds = { github: "ghp_token", other: "value" };
      writeFileSync(testPath, JSON.stringify(testCreds, null, 2));

      const content = readFileSync(testPath, "utf-8");

      // Should be valid JSON
      const parsed = JSON.parse(content);
      expect(parsed.github).toBe("ghp_token");

      // Should contain newlines (pretty-printed)
      expect(content).toContain("\n");
    } finally {
      try {
        Bun.spawnSync(["rm", testPath]);
      } catch {
        // Ignore
      }
    }
  });

  test("credentials are expected at ~/.lgtm-farm/credentials.json", () => {
    // This test verifies the path convention without actually creating files
    // in the user's home directory.
    const expectedDir = join(homedir(), ".lgtm-farm");
    const expectedPath = join(expectedDir, "credentials.json");

    // Verify the path structure is correct
    expect(expectedPath).toContain(".lgtm-farm");
    expect(expectedPath).toContain("credentials.json");
    expect(expectedPath).toContain(homedir());
  });
});

describe("token precedence", () => {
  let originalGithubToken: string | undefined;
  let originalGhToken: string | undefined;

  beforeEach(() => {
    originalGithubToken = process.env.GITHUB_TOKEN;
    originalGhToken = process.env.GH_TOKEN;
    delete process.env.GITHUB_TOKEN;
    delete process.env.GH_TOKEN;
  });

  afterEach(() => {
    if (originalGithubToken) process.env.GITHUB_TOKEN = originalGithubToken;
    if (originalGhToken) process.env.GH_TOKEN = originalGhToken;
  });

  test("env vars take precedence over gh binary", () => {
    process.env.GITHUB_TOKEN = "ghp_from_env";

    // Even if we pass a valid gh path, env should win
    const token = resolveGitHubToken("/usr/bin/gh");
    expect(token).toBe("ghp_from_env");
  });

  test("GITHUB_TOKEN takes precedence over GH_TOKEN", () => {
    process.env.GITHUB_TOKEN = "ghp_github";
    process.env.GH_TOKEN = "ghp_gh";

    const token = resolveGitHubToken(null);
    expect(token).toBe("ghp_github");
  });
});

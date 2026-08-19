/**
 * Tests for git utilities (parseGitUrl only — git operations need a real repo).
 *
 * Run with: bun test packages/core/src/utils/git.test.ts
 */

import { describe, test, expect } from "bun:test";
import { parseGitUrl } from "./git.js";

describe("parseGitUrl", () => {
  test("parses HTTPS URL", () => {
    const result = parseGitUrl("https://github.com/pszf11235/lgtm.git");
    expect(result).not.toBeNull();
    expect(result!.owner).toBe("pszf11235");
    expect(result!.repo).toBe("lgtm");
  });

  test("parses HTTPS URL without .git suffix", () => {
    const result = parseGitUrl("https://github.com/vercel/next.js");
    expect(result).not.toBeNull();
    expect(result!.owner).toBe("vercel");
    expect(result!.repo).toBe("next.js");
  });

  test("parses SSH URL", () => {
    const result = parseGitUrl("git@github.com:pszf11235/lgtm.git");
    expect(result).not.toBeNull();
    expect(result!.owner).toBe("pszf11235");
    expect(result!.repo).toBe("lgtm");
  });

  test("parses SSH URL without .git suffix", () => {
    const result = parseGitUrl("git@github.com:owner/repo");
    expect(result).not.toBeNull();
    expect(result!.owner).toBe("owner");
    expect(result!.repo).toBe("repo");
  });

  test("parses GitLab HTTPS URL", () => {
    const result = parseGitUrl("https://gitlab.com/myorg/myrepo.git");
    expect(result).not.toBeNull();
    expect(result!.owner).toBe("myorg");
    expect(result!.repo).toBe("myrepo");
  });

  test("returns null for invalid URL", () => {
    expect(parseGitUrl("not-a-url")).toBeNull();
    expect(parseGitUrl("")).toBeNull();
    expect(parseGitUrl("/local/path")).toBeNull();
  });
});

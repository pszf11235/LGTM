/**
 * Tests for multi-repo PR addressing.
 *
 * Verifies: parsePRRef, resolvePRRef, formatPRRef, groupByRepo.
 *
 * Run with: bun test packages/plugins/review/src/domain/multi-repo.test.ts
 */

import { describe, test, expect } from "bun:test";
import { parsePRRef, resolvePRRef, formatPRRef, groupByRepo, type PRRef } from "./multi-repo.js";

describe("parsePRRef", () => {
  describe("full format: owner/repo#number", () => {
    test("parses standard format", () => {
      const ref = parsePRRef("pszf11235/LGTM#42");
      expect(ref).toEqual({
        number: 42,
        owner: "pszf11235",
        repo: "LGTM",
        raw: "pszf11235/LGTM#42",
      });
    });

    test("parses with hyphens in owner and repo", () => {
      const ref = parsePRRef("my-org/my-repo#101");
      expect(ref).toEqual({
        number: 101,
        owner: "my-org",
        repo: "my-repo",
        raw: "my-org/my-repo#101",
      });
    });

    test("parses with underscores", () => {
      const ref = parsePRRef("user_name/repo_name#7");
      expect(ref).toEqual({
        number: 7,
        owner: "user_name",
        repo: "repo_name",
        raw: "user_name/repo_name#7",
      });
    });

    test("parses large PR numbers", () => {
      const ref = parsePRRef("org/repo#99999");
      expect(ref!.number).toBe(99999);
    });
  });

  describe("short format: repo#number", () => {
    test("parses repo#number", () => {
      const ref = parsePRRef("LGTM#42");
      expect(ref).toEqual({
        number: 42,
        owner: undefined,
        repo: "LGTM",
        raw: "LGTM#42",
      });
    });

    test("parses with hyphenated repo name", () => {
      const ref = parsePRRef("my-project#7");
      expect(ref).toEqual({
        number: 7,
        owner: undefined,
        repo: "my-project",
        raw: "my-project#7",
      });
    });
  });

  describe("plain number format", () => {
    test("parses plain number", () => {
      const ref = parsePRRef("42");
      expect(ref).toEqual({
        number: 42,
        owner: undefined,
        repo: undefined,
        raw: "42",
      });
    });

    test("parses single digit", () => {
      const ref = parsePRRef("1");
      expect(ref!.number).toBe(1);
    });

    test("parses large number", () => {
      const ref = parsePRRef("12345");
      expect(ref!.number).toBe(12345);
    });
  });

  describe("invalid inputs", () => {
    test("returns null for empty string", () => {
      expect(parsePRRef("")).toBeNull();
    });

    test("returns null for non-numeric string", () => {
      expect(parsePRRef("abc")).toBeNull();
    });

    test("returns null for just a hash", () => {
      expect(parsePRRef("#")).toBeNull();
    });

    test("returns null for hash without number", () => {
      expect(parsePRRef("repo#")).toBeNull();
    });

    test("returns null for hash with non-number", () => {
      expect(parsePRRef("repo#abc")).toBeNull();
    });
  });
});

describe("resolvePRRef", () => {
  test("returns full ref when owner and repo present", () => {
    const ref: PRRef = { number: 42, owner: "org", repo: "repo", raw: "org/repo#42" };
    const resolved = resolvePRRef(ref, "default-owner", "default-repo");
    expect(resolved).toEqual({ owner: "org", repo: "repo", number: 42 });
  });

  test("uses current owner for short format", () => {
    const ref: PRRef = { number: 42, repo: "other-repo", raw: "other-repo#42" };
    const resolved = resolvePRRef(ref, "my-org", "my-repo");
    expect(resolved).toEqual({ owner: "my-org", repo: "other-repo", number: 42 });
  });

  test("uses current owner and repo for plain number", () => {
    const ref: PRRef = { number: 42, raw: "42" };
    const resolved = resolvePRRef(ref, "my-org", "my-repo");
    expect(resolved).toEqual({ owner: "my-org", repo: "my-repo", number: 42 });
  });

  test("returns null when cannot resolve", () => {
    const ref: PRRef = { number: 42, raw: "42" };
    expect(resolvePRRef(ref)).toBeNull();
  });

  test("returns null for short format without current owner", () => {
    const ref: PRRef = { number: 42, repo: "repo", raw: "repo#42" };
    expect(resolvePRRef(ref)).toBeNull();
  });
});

describe("formatPRRef", () => {
  test("formats full ref", () => {
    const ref: PRRef = { number: 42, owner: "org", repo: "repo", raw: "org/repo#42" };
    expect(formatPRRef(ref)).toBe("org/repo#42");
  });

  test("formats short ref", () => {
    const ref: PRRef = { number: 42, repo: "repo", raw: "repo#42" };
    expect(formatPRRef(ref)).toBe("repo#42");
  });

  test("formats plain number ref", () => {
    const ref: PRRef = { number: 42, raw: "42" };
    expect(formatPRRef(ref)).toBe("#42");
  });
});

describe("groupByRepo", () => {
  test("groups refs by repository", () => {
    const refs: PRRef[] = [
      { number: 1, owner: "org", repo: "frontend", raw: "org/frontend#1" },
      { number: 2, owner: "org", repo: "frontend", raw: "org/frontend#2" },
      { number: 3, owner: "org", repo: "backend", raw: "org/backend#3" },
      { number: 4, raw: "4" },
    ];

    const groups = groupByRepo(refs);
    expect(groups.get("org/frontend")).toHaveLength(2);
    expect(groups.get("org/backend")).toHaveLength(1);
    expect(groups.get("current")).toHaveLength(1);
  });

  test("returns empty map for empty input", () => {
    const groups = groupByRepo([]);
    expect(groups.size).toBe(0);
  });

  test("handles all same repo", () => {
    const refs: PRRef[] = [
      { number: 1, owner: "org", repo: "repo", raw: "org/repo#1" },
      { number: 2, owner: "org", repo: "repo", raw: "org/repo#2" },
    ];

    const groups = groupByRepo(refs);
    expect(groups.size).toBe(1);
    expect(groups.get("org/repo")).toHaveLength(2);
  });
});

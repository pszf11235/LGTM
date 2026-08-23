/**
 * A bare PR number is ambiguous when one store holds many repos. It is still
 * what people type, so it is resolved rather than rejected, and an ambiguous one
 * fails with the commands that would work.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import fs from "fs";
import os from "os";
import path from "path";
import { parsePrRef, resolvePrRef, formatRef, describeRefError } from "./pr-ref.js";
import { saveMeta } from "./review-store.js";
import { saveWatchList } from "@lgtm/core/registry/watch-list.js";

let store: string;

beforeEach(() => {
  store = fs.mkdtempSync(path.join(os.tmpdir(), "lgtm-pr-ref-"));
});

afterEach(() => {
  try { fs.rmSync(store, { recursive: true, force: true }); } catch { /* ignore */ }
});

function seedReview(owner: string, repo: string, pr: number) {
  saveMeta(store, {
    ref: { owner, repo, pr },
    title: "t",
    author: "a",
    sha: "s",
    round: 1,
    agents: ["reviewer"],
    findingCount: 0,
  });
}

// ─── Parsing ────────────────────────────────────────────────────────────────

describe("parsePrRef", () => {
  test("reads owner/repo#42", () => {
    expect(parsePrRef("acme/app#42")).toEqual({ owner: "acme", repo: "app", pr: 42 });
  });

  test("reads owner/repo/42", () => {
    expect(parsePrRef("acme/app/42")).toEqual({ owner: "acme", repo: "app", pr: 42 });
  });

  test("reads a pasted GitHub URL", () => {
    expect(parsePrRef("https://github.com/acme/app/pull/42")).toEqual({
      owner: "acme",
      repo: "app",
      pr: 42,
    });
  });

  test("reads a URL with extra path segments, as copied from the files tab", () => {
    expect(parsePrRef("https://github.com/acme/app/pull/42/files")).toEqual({
      owner: "acme",
      repo: "app",
      pr: 42,
    });
  });

  test("reads a bare number and a #-prefixed one", () => {
    expect(parsePrRef("42")).toEqual({ pr: 42 });
    expect(parsePrRef("#42")).toEqual({ pr: 42 });
  });

  test("tolerates surrounding whitespace", () => {
    expect(parsePrRef("  acme/app#42  ")).toEqual({ owner: "acme", repo: "app", pr: 42 });
  });

  test("handles a repo name with dots and hyphens", () => {
    expect(parsePrRef("acme/my-cool.repo#7")).toEqual({
      owner: "acme",
      repo: "my-cool.repo",
      pr: 7,
    });
  });

  test("rejects nonsense with something actionable", () => {
    const result = parsePrRef("not a pr");

    expect(result).toHaveProperty("error");
    expect((result as { error: string }).error).toContain("owner/repo#42");
  });

  test("rejects an empty argument", () => {
    expect(parsePrRef("   ")).toHaveProperty("error");
  });
});

// ─── Resolution ─────────────────────────────────────────────────────────────

describe("resolvePrRef", () => {
  test("passes a fully qualified reference straight through", () => {
    // No store lookup needed, so this works before anything is reviewed.
    expect(resolvePrRef(store, "acme/app#42")).toEqual({ owner: "acme", repo: "app", pr: 42 });
  });

  test("resolves a bare number against the one review on disk", () => {
    seedReview("acme", "app", 42);

    expect(resolvePrRef(store, "42")).toEqual({ owner: "acme", repo: "app", pr: 42 });
  });

  test("reports ambiguity when two repos have the same number", () => {
    seedReview("acme", "app", 42);
    seedReview("other", "svc", 42);

    const result = resolvePrRef(store, "42");

    expect(result).toHaveProperty("error");
    const err = result as { error: string; candidates?: Array<{ repo: string }> };
    expect(err.error).toContain("ambiguous");
    expect(err.candidates!.length).toBe(2);
  });

  test("an ambiguity error lists the exact commands that would work", () => {
    // Listing candidates without showing how to use them just makes the user
    // retype guesses.
    seedReview("acme", "app", 42);
    seedReview("other", "svc", 42);

    const lines = describeRefError(resolvePrRef(store, "42") as never, "lgtm review post");

    expect(lines).toContain("  lgtm review post acme/app#42");
    expect(lines).toContain("  lgtm review post other/svc#42");
  });

  test("falls back to the single watched repo when nothing is reviewed yet", () => {
    // The common case for `review add 42` before any review exists.
    saveWatchList(store, [{ owner: "acme", repo: "app", filter: "all" }]);

    expect(resolvePrRef(store, "42")).toEqual({ owner: "acme", repo: "app", pr: 42 });
  });

  test("a reviewed repo wins over the watch list", () => {
    // A number just reviewed is almost certainly the one meant, and it is the
    // only source that confirms the PR exists.
    seedReview("reviewed", "repo", 42);
    saveWatchList(store, [{ owner: "watched", repo: "repo", filter: "all" }]);

    expect(resolvePrRef(store, "42")).toEqual({ owner: "reviewed", repo: "repo", pr: 42 });
  });

  test("will not pick between several watched repos", () => {
    saveWatchList(store, [
      { owner: "acme", repo: "app", filter: "all" },
      { owner: "other", repo: "svc", filter: "all" },
    ]);

    const result = resolvePrRef(store, "42");

    expect(result).toHaveProperty("error");
    expect((result as { candidates?: unknown[] }).candidates!.length).toBe(2);
  });

  test("says what to type when there is nothing to resolve against", () => {
    const result = resolvePrRef(store, "42");

    expect((result as { error: string }).error).toContain("owner/repo#42");
  });

  test("propagates a parse failure unchanged", () => {
    expect(resolvePrRef(store, "garbage")).toHaveProperty("error");
  });
});

describe("formatRef", () => {
  test("renders the form the commands accept", () => {
    expect(formatRef({ owner: "acme", repo: "app", pr: 42 })).toBe("acme/app#42");
  });
});

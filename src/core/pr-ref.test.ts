/**
 * A bare PR number is ambiguous when one store holds many repos. It is still
 * what people type, so it is resolved rather than rejected, and an ambiguous one
 * fails with the commands that would work.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import fs from "fs";
import os from "os";
import path from "path";
import { parsePrRef, resolvePrRef, formatRef, describeRefError } from "./pr-ref";
import { saveMeta } from "../store/reviews";
import { saveWatchList } from "../store/watch-list";

let store: string;
const NOW = "2026-08-29T00:00:00.000Z";

beforeEach(() => {
  store = fs.mkdtempSync(path.join(os.tmpdir(), "lgtm-pr-ref-"));
});

afterEach(() => {
  try {
    fs.rmSync(store, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

async function seedReview(owner: string, repo: string, number: number) {
  await saveMeta(
    store,
    { owner, repo, number },
    {
      url: `https://github.com/${owner}/${repo}/pull/${number}`,
      title: "t",
      author: "a",
      state: "reviewed",
      classification: "own",
      draft: false,
      headSha: "s",
      lastReviewedSha: "s",
      failedAttempts: 0,
      rounds: 1,
      pendingReviewId: null,
      closedAt: null,
    },
  );
}

// ─── Parsing ────────────────────────────────────────────────────────────────

describe("parsePrRef", () => {
  test("reads owner/repo#42", async () => {
    expect(parsePrRef("acme/app#42")).toEqual({ owner: "acme", repo: "app", number: 42 });
  });

  test("reads owner/repo/42", async () => {
    expect(parsePrRef("acme/app/42")).toEqual({ owner: "acme", repo: "app", number: 42 });
  });

  test("reads a pasted GitHub URL", async () => {
    expect(parsePrRef("https://github.com/acme/app/pull/42")).toEqual({
      owner: "acme",
      repo: "app",
      number: 42,
    });
  });

  test("reads a URL with extra path segments, as copied from the files tab", async () => {
    expect(parsePrRef("https://github.com/acme/app/pull/42/files")).toEqual({
      owner: "acme",
      repo: "app",
      number: 42,
    });
  });

  test("reads a bare number and a #-prefixed one", async () => {
    expect(parsePrRef("42")).toEqual({ number: 42 });
    expect(parsePrRef("#42")).toEqual({ number: 42 });
  });

  test("tolerates surrounding whitespace", async () => {
    expect(parsePrRef("  acme/app#42  ")).toEqual({ owner: "acme", repo: "app", number: 42 });
  });

  test("handles a repo name with dots and hyphens", async () => {
    expect(parsePrRef("acme/my-cool.repo#7")).toEqual({
      owner: "acme",
      repo: "my-cool.repo",
      number: 7,
    });
  });

  test("rejects nonsense with something actionable", async () => {
    const result = parsePrRef("not a pr");

    expect(result).toHaveProperty("error");
    expect((result as { error: string }).error).toContain("owner/repo#42");
  });

  test("rejects an empty argument", async () => {
    expect(parsePrRef("   ")).toHaveProperty("error");
  });
});

// ─── Resolution ─────────────────────────────────────────────────────────────

describe("resolvePrRef", () => {
  test("passes a fully qualified reference straight through", async () => {
    // No store lookup needed, so this works before anything is reviewed.
    expect(await resolvePrRef(store, "acme/app#42")).toEqual({
      owner: "acme",
      repo: "app",
      number: 42,
    });
  });

  test("resolves a bare number against the one review on disk", async () => {
    await seedReview("acme", "app", 42);

    expect(await resolvePrRef(store, "42")).toEqual({ owner: "acme", repo: "app", number: 42 });
  });

  test("reports ambiguity when two repos have the same number", async () => {
    await seedReview("acme", "app", 42);
    await seedReview("other", "svc", 42);

    const result = await resolvePrRef(store, "42");

    expect(result).toHaveProperty("error");
    const err = result as { error: string; candidates?: Array<{ repo: string }> };
    expect(err.error).toContain("ambiguous");
    expect(err.candidates!.length).toBe(2);
  });

  test("an ambiguity error lists the exact commands that would work", async () => {
    // Listing candidates without showing how to use them just makes the user
    // retype guesses.
    await seedReview("acme", "app", 42);
    await seedReview("other", "svc", 42);

    const lines = describeRefError(await resolvePrRef(store, "42") as never, "lgtm review post");

    expect(lines).toContain("  lgtm review post acme/app#42");
    expect(lines).toContain("  lgtm review post other/svc#42");
  });

  test("falls back to the single watched repo when nothing is reviewed yet", async () => {
    // The common case for `review add 42` before any review exists.
    await saveWatchList([{ owner: "acme", repo: "app", addedAt: NOW }], store);

    expect(await resolvePrRef(store, "42")).toEqual({ owner: "acme", repo: "app", number: 42 });
  });

  test("a reviewed repo wins over the watch list", async () => {
    // A number just reviewed is almost certainly the one meant, and it is the
    // only source that confirms the PR exists.
    await seedReview("reviewed", "repo", 42);
    await saveWatchList([{ owner: "watched", repo: "repo", addedAt: NOW }], store);

    expect(await resolvePrRef(store, "42")).toEqual({ owner: "reviewed", repo: "repo", number: 42 });
  });

  test("will not pick between several watched repos", async () => {
    await saveWatchList([
      { owner: "acme", repo: "app", addedAt: NOW },
      { owner: "other", repo: "svc", addedAt: NOW },
    ], store);

    const result = await resolvePrRef(store, "42");

    expect(result).toHaveProperty("error");
    expect((result as { candidates?: unknown[] }).candidates!.length).toBe(2);
  });

  test("says what to type when there is nothing to resolve against", async () => {
    const result = await resolvePrRef(store, "42");

    expect((result as { error: string }).error).toContain("owner/repo#42");
  });

  test("propagates a parse failure unchanged", async () => {
    expect(await resolvePrRef(store, "garbage")).toHaveProperty("error");
  });
});

describe("formatRef", () => {
  test("renders the form the commands accept", async () => {
    expect(formatRef({ owner: "acme", repo: "app", number: 42 })).toBe("acme/app#42");
  });
});

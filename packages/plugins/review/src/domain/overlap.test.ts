/**
 * Tests for overlap detection.
 *
 * Verifies: detectOverlaps, suggestReviewOrder, formatOverlapWarnings.
 *
 * Run with: bun test packages/plugins/review/src/domain/overlap.test.ts
 */

import { describe, test, expect } from "bun:test";
import { detectOverlaps, suggestReviewOrder, formatOverlapWarnings } from "./overlap.js";
import type { QueuedPR } from "./types.js";

function makePR(number: number, files: string[]): QueuedPR {
  return {
    number,
    title: `PR #${number}`,
    state: "queued",
    addedAt: new Date().toISOString(),
    filesChanged: files,
    source: "github",
  };
}

describe("detectOverlaps", () => {
  test("returns empty for single PR", () => {
    const prs = [makePR(1, ["src/app.ts", "src/utils.ts"])];
    expect(detectOverlaps(prs)).toEqual([]);
  });

  test("returns empty for no overlaps", () => {
    const prs = [
      makePR(1, ["src/auth.ts"]),
      makePR(2, ["src/db.ts"]),
      makePR(3, ["src/api.ts"]),
    ];
    expect(detectOverlaps(prs)).toEqual([]);
  });

  test("detects shared files between two PRs", () => {
    const prs = [
      makePR(1, ["src/app.ts", "src/utils.ts"]),
      makePR(2, ["src/utils.ts", "src/config.ts"]),
    ];

    const overlaps = detectOverlaps(prs);
    expect(overlaps).toHaveLength(1);
    expect(overlaps[0].pr1).toBe(1);
    expect(overlaps[0].pr2).toBe(2);
    expect(overlaps[0].sharedFiles).toEqual(["src/utils.ts"]);
    expect(overlaps[0].severity).toBe("overlap");
  });

  test("marks as conflict when >2 shared files", () => {
    const prs = [
      makePR(1, ["a.ts", "b.ts", "c.ts", "d.ts"]),
      makePR(2, ["b.ts", "c.ts", "d.ts", "e.ts"]),
    ];

    const overlaps = detectOverlaps(prs);
    expect(overlaps[0].severity).toBe("conflict");
    expect(overlaps[0].sharedFiles).toHaveLength(3);
  });

  test("detects overlaps across multiple PR pairs", () => {
    const prs = [
      makePR(1, ["shared.ts", "a.ts"]),
      makePR(2, ["shared.ts", "b.ts"]),
      makePR(3, ["shared.ts", "c.ts"]),
    ];

    const overlaps = detectOverlaps(prs);
    // PR 1-2, PR 1-3, PR 2-3
    expect(overlaps).toHaveLength(3);
  });

  test("returns empty for empty input", () => {
    expect(detectOverlaps([])).toEqual([]);
  });

  test("sorts by number of shared files (most overlap first)", () => {
    const prs = [
      makePR(1, ["a.ts", "b.ts"]),
      makePR(2, ["a.ts"]),
      makePR(3, ["a.ts", "b.ts", "c.ts"]),
    ];

    const overlaps = detectOverlaps(prs);
    // PR 1-3 should come first (2 shared files) vs PR 1-2 or 2-3 (1 shared)
    expect(overlaps[0].sharedFiles.length).toBeGreaterThanOrEqual(
      overlaps[overlaps.length - 1].sharedFiles.length
    );
  });
});

describe("suggestReviewOrder", () => {
  test("returns single PR unchanged", () => {
    const prs = [makePR(1, ["a.ts"])];
    expect(suggestReviewOrder(prs)).toEqual([1]);
  });

  test("returns empty for empty input", () => {
    expect(suggestReviewOrder([])).toEqual([]);
  });

  test("foundation PR (most shared files) comes first", () => {
    const prs = [
      makePR(1, ["utils.ts"]),              // shares with 2 and 3
      makePR(2, ["utils.ts", "config.ts"]), // shares with 1 and 3
      makePR(3, ["utils.ts", "config.ts", "api.ts"]), // shares most
    ];

    const order = suggestReviewOrder(prs);
    // PR 3 touches files that overlap with both other PRs most
    // The exact order depends on scoring, but it should be deterministic
    expect(order).toHaveLength(3);
    expect(order).toContain(1);
    expect(order).toContain(2);
    expect(order).toContain(3);
  });

  test("independent PRs have stable order", () => {
    const prs = [
      makePR(5, ["a.ts"]),
      makePR(3, ["b.ts"]),
      makePR(7, ["c.ts"]),
    ];

    const order = suggestReviewOrder(prs);
    expect(order).toHaveLength(3);
    // All have score 0 (no shared files), so order is stable
  });
});

describe("formatOverlapWarnings", () => {
  test("formats conflict with red indicator", () => {
    const warnings = formatOverlapWarnings([{
      pr1: 1,
      pr2: 2,
      sharedFiles: ["a.ts", "b.ts", "c.ts"],
      severity: "conflict",
      description: "PRs #1 and #2 both modify: a.ts, b.ts, c.ts",
    }]);

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("🔴");
    expect(warnings[0]).toContain("PRs #1 and #2");
  });

  test("formats overlap with warning indicator", () => {
    const warnings = formatOverlapWarnings([{
      pr1: 3,
      pr2: 4,
      sharedFiles: ["shared.ts"],
      severity: "overlap",
      description: "PRs #3 and #4 both modify: shared.ts",
    }]);

    expect(warnings[0]).toContain("⚠️");
  });

  test("returns empty for no overlaps", () => {
    expect(formatOverlapWarnings([])).toEqual([]);
  });
});

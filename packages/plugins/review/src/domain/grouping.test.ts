/**
 * Tests for Feature Grouping.
 *
 * Run with: bun test packages/plugins/review/src/domain/grouping.test.ts
 */

import { describe, test, expect } from "bun:test";
import { analyzeGroups } from "./grouping.js";
import type { QueuedPR } from "./types.js";

function makePR(number: number, files: string[]): QueuedPR {
  return {
    number,
    title: `PR #${number}`,
    state: "queued",
    addedAt: new Date().toISOString(),
    filesChanged: files,
    source: "local",
  };
}

describe("analyzeGroups", () => {
  test("returns empty for single PR", () => {
    const groups = analyzeGroups([makePR(101, ["src/auth/login.ts"])]);
    expect(groups).toEqual([]);
  });

  test("returns empty for unrelated PRs", () => {
    const groups = analyzeGroups([
      makePR(101, ["src/auth/login.ts"]),
      makePR(102, ["src/billing/invoice.ts"]),
    ]);
    expect(groups).toEqual([]);
  });

  test("groups PRs sharing a directory", () => {
    const groups = analyzeGroups([
      makePR(101, ["src/auth/login.ts", "src/auth/register.ts"]),
      makePR(102, ["src/auth/oauth.ts"]),
    ]);

    expect(groups.length).toBeGreaterThan(0);
    const authGroup = groups.find((g) => g.prs.includes(101) && g.prs.includes(102));
    expect(authGroup).toBeTruthy();
    expect(authGroup!.reviewTogether).toBe(true);
  });

  test("groups PRs modifying the same file", () => {
    const groups = analyzeGroups([
      makePR(101, ["src/config/app.ts", "src/auth/login.ts"]),
      makePR(102, ["src/config/app.ts", "src/billing/pay.ts"]),
    ]);

    expect(groups.length).toBeGreaterThan(0);
    // Should be grouped because both touch src/config/app.ts
    const hasOverlap = groups.some(
      (g) => g.prs.includes(101) && g.prs.includes(102)
    );
    expect(hasOverlap).toBe(true);
  });

  test("group reason explains why", () => {
    const groups = analyzeGroups([
      makePR(101, ["src/auth/login.ts"]),
      makePR(102, ["src/auth/oauth.ts"]),
    ]);

    expect(groups[0].reason).toContain("src/auth");
  });

  test("group has sharedPaths", () => {
    const groups = analyzeGroups([
      makePR(101, ["src/auth/login.ts"]),
      makePR(102, ["src/auth/oauth.ts"]),
    ]);

    expect(groups[0].sharedPaths.length).toBeGreaterThan(0);
  });

  test("handles 3+ PRs in a group", () => {
    const groups = analyzeGroups([
      makePR(101, ["src/auth/login.ts"]),
      makePR(102, ["src/auth/register.ts"]),
      makePR(103, ["src/auth/forgot-password.ts"]),
    ]);

    const authGroup = groups.find((g) => g.prs.length === 3);
    expect(authGroup).toBeTruthy();
  });

  test("does not group by trivial directories (src/ alone)", () => {
    const groups = analyzeGroups([
      makePR(101, ["src/auth/login.ts"]),
      makePR(102, ["src/billing/invoice.ts"]),
    ]);

    // Should NOT be grouped just because both are in src/
    const srcOnlyGroup = groups.find(
      (g) => g.sharedPaths.includes("src") && g.prs.includes(101) && g.prs.includes(102)
    );
    expect(srcOnlyGroup).toBeUndefined();
  });

  test("returns empty array for empty input", () => {
    expect(analyzeGroups([])).toEqual([]);
  });
});

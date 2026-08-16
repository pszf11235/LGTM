/**
 * Tests for the diff parser.
 *
 * Run with: bun test packages/plugins/review/src/domain/diff-parser.test.ts
 */

import { describe, test, expect } from "bun:test";
import fs from "fs";
import path from "path";
import { parseDiff, getChangedPaths, getDiffStats } from "./diff-parser.js";

const fixturesDir = path.resolve(
  import.meta.dir,
  "../../../../../tests/fixtures/sample-diffs"
);

function loadFixture(name: string): string {
  return fs.readFileSync(path.join(fixturesDir, name), "utf-8");
}

describe("parseDiff — simple single-file diff", () => {
  const diff = parseDiff(loadFixture("simple.diff"));

  test("parses one file", () => {
    expect(diff.files).toHaveLength(1);
  });

  test("extracts correct file path", () => {
    expect(diff.files[0].path).toBe("src/auth/login.ts");
  });

  test("file status is modified", () => {
    expect(diff.files[0].status).toBe("modified");
  });

  test("has one hunk", () => {
    expect(diff.files[0].hunks).toHaveLength(1);
  });

  test("hunk has context from @@ line", () => {
    expect(diff.files[0].hunks[0].context).toBe("export function login");
  });

  test("hunk contains added lines", () => {
    const added = diff.files[0].hunks[0].lines.filter((l) => l.type === "added");
    expect(added.length).toBeGreaterThan(0);
  });

  test("hunk contains removed lines", () => {
    const removed = diff.files[0].hunks[0].lines.filter((l) => l.type === "removed");
    expect(removed.length).toBeGreaterThan(0);
  });

  test("added lines have newLine numbers", () => {
    const added = diff.files[0].hunks[0].lines.filter((l) => l.type === "added");
    for (const line of added) {
      expect(line.newLine).not.toBeNull();
      expect(line.oldLine).toBeNull();
    }
  });

  test("removed lines have oldLine numbers", () => {
    const removed = diff.files[0].hunks[0].lines.filter((l) => l.type === "removed");
    for (const line of removed) {
      expect(line.oldLine).not.toBeNull();
      expect(line.newLine).toBeNull();
    }
  });

  test("context lines have both line numbers", () => {
    const context = diff.files[0].hunks[0].lines.filter((l) => l.type === "context");
    for (const line of context) {
      expect(line.oldLine).not.toBeNull();
      expect(line.newLine).not.toBeNull();
    }
  });
});

describe("parseDiff — multi-file diff", () => {
  const diff = parseDiff(loadFixture("multi-file.diff"));

  test("parses three files", () => {
    expect(diff.files).toHaveLength(3);
  });

  test("first file is new (added)", () => {
    expect(diff.files[0].path).toBe("src/routes/auth.ts");
    expect(diff.files[0].status).toBe("added");
  });

  test("second file is deleted", () => {
    expect(diff.files[1].path).toBe("src/utils/helpers.ts");
    expect(diff.files[1].status).toBe("deleted");
  });

  test("third file is modified", () => {
    expect(diff.files[2].path).toBe("README.md");
    expect(diff.files[2].status).toBe("modified");
  });

  test("new file has all added lines", () => {
    const lines = diff.files[0].hunks[0].lines;
    expect(lines.every((l) => l.type === "added")).toBe(true);
  });

  test("deleted file has all removed lines", () => {
    const lines = diff.files[1].hunks[0].lines;
    expect(lines.every((l) => l.type === "removed")).toBe(true);
  });
});

describe("parseDiff — renamed file", () => {
  const diff = parseDiff(loadFixture("rename.diff"));

  test("detects rename status", () => {
    expect(diff.files[0].status).toBe("renamed");
  });

  test("new path is correct", () => {
    expect(diff.files[0].path).toBe("src/new-name.ts");
  });

  test("old path is preserved", () => {
    expect(diff.files[0].oldPath).toBe("src/old-name.ts");
  });

  test("has diff content (not empty)", () => {
    expect(diff.files[0].hunks.length).toBeGreaterThan(0);
  });
});

describe("parseDiff — binary file", () => {
  const diff = parseDiff(loadFixture("binary.diff"));

  test("detects binary status", () => {
    expect(diff.files[0].status).toBe("binary");
  });

  test("binary file has no hunks", () => {
    expect(diff.files[0].hunks).toHaveLength(0);
  });

  test("path is correct", () => {
    expect(diff.files[0].path).toBe("assets/logo.png");
  });
});

describe("getChangedPaths", () => {
  test("extracts all file paths", () => {
    const diff = parseDiff(loadFixture("multi-file.diff"));
    const paths = getChangedPaths(diff);
    expect(paths).toEqual([
      "src/routes/auth.ts",
      "src/utils/helpers.ts",
      "README.md",
    ]);
  });
});

describe("getDiffStats", () => {
  test("counts additions and deletions", () => {
    const diff = parseDiff(loadFixture("simple.diff"));
    const stats = getDiffStats(diff);
    expect(stats.filesChanged).toBe(1);
    expect(stats.additions).toBeGreaterThan(0);
    expect(stats.deletions).toBeGreaterThan(0);
  });

  test("multi-file stats", () => {
    const diff = parseDiff(loadFixture("multi-file.diff"));
    const stats = getDiffStats(diff);
    expect(stats.filesChanged).toBe(3);
    expect(stats.additions).toBeGreaterThan(0);
    expect(stats.deletions).toBeGreaterThan(0);
  });
});

describe("parseDiff — edge cases", () => {
  test("empty diff returns empty files array", () => {
    const diff = parseDiff("");
    expect(diff.files).toEqual([]);
  });

  test("garbage input returns empty files array", () => {
    const diff = parseDiff("not a diff at all\nrandom text\n");
    expect(diff.files).toEqual([]);
  });
});

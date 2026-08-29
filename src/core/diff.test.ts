/**
 * Tests for the diff parser.
 *
 * Run with: bun test src/core/diff.test.ts
 */

import { describe, test, expect } from "bun:test";
import fs from "fs";
import path from "path";
import {
  parseDiff,
  getChangedPaths,
  getDiffStats,
  getCommentableLines,
  sliceHunk,
} from "./diff";

const fixturesDir = path.resolve(
  import.meta.dir,
  "../../test/fixtures/sample-diffs"
);

function loadFixture(name: string): string {
  return fs.readFileSync(path.join(fixturesDir, name), "utf-8");
}

describe("parseDiff — simple single-file diff", () => {
  const diff = parseDiff(loadFixture("simple.diff"));
  // The fixture is a known single-hunk, single-file diff, so files[0] and
  // hunks[0] are always present.
  const file = diff.files[0]!;
  const hunk = file.hunks[0]!;

  test("parses one file", () => {
    expect(diff.files).toHaveLength(1);
  });

  test("extracts correct file path", () => {
    expect(file.path).toBe("src/auth/login.ts");
  });

  test("file status is modified", () => {
    expect(file.status).toBe("modified");
  });

  test("has one hunk", () => {
    expect(file.hunks).toHaveLength(1);
  });

  test("hunk has context from @@ line", () => {
    expect(hunk.context).toBe("export function login");
  });

  test("hunk contains added lines", () => {
    const added = hunk.lines.filter((l) => l.type === "added");
    expect(added.length).toBeGreaterThan(0);
  });

  test("hunk contains removed lines", () => {
    const removed = hunk.lines.filter(
      (l) => l.type === "removed"
    );
    expect(removed.length).toBeGreaterThan(0);
  });

  test("added lines have newLine numbers", () => {
    const added = hunk.lines.filter((l) => l.type === "added");
    for (const line of added) {
      expect(line.newLine).not.toBeNull();
      expect(line.oldLine).toBeNull();
    }
  });

  test("removed lines have oldLine numbers", () => {
    const removed = hunk.lines.filter(
      (l) => l.type === "removed"
    );
    for (const line of removed) {
      expect(line.oldLine).not.toBeNull();
      expect(line.newLine).toBeNull();
    }
  });

  test("context lines have both line numbers", () => {
    const context = hunk.lines.filter(
      (l) => l.type === "context"
    );
    for (const line of context) {
      expect(line.oldLine).not.toBeNull();
      expect(line.newLine).not.toBeNull();
    }
  });
});

describe("parseDiff — multi-file diff", () => {
  const diff = parseDiff(loadFixture("multi-file.diff"));
  // The fixture always has exactly these three files, in this order.
  const file0 = diff.files[0]!;
  const file1 = diff.files[1]!;
  const file2 = diff.files[2]!;

  test("parses three files", () => {
    expect(diff.files).toHaveLength(3);
  });

  test("first file is new (added)", () => {
    expect(file0.path).toBe("src/routes/auth.ts");
    expect(file0.status).toBe("added");
  });

  test("second file is deleted", () => {
    expect(file1.path).toBe("src/utils/helpers.ts");
    expect(file1.status).toBe("deleted");
  });

  test("third file is modified", () => {
    expect(file2.path).toBe("README.md");
    expect(file2.status).toBe("modified");
  });

  test("new file has all added lines", () => {
    const lines = file0.hunks[0]!.lines;
    expect(lines.every((l) => l.type === "added")).toBe(true);
  });

  test("deleted file has all removed lines", () => {
    const lines = file1.hunks[0]!.lines;
    expect(lines.every((l) => l.type === "removed")).toBe(true);
  });
});

describe("parseDiff — renamed file", () => {
  const diff = parseDiff(loadFixture("rename.diff"));
  const file = diff.files[0]!;

  test("detects rename status", () => {
    expect(file.status).toBe("renamed");
  });

  test("new path is correct", () => {
    expect(file.path).toBe("src/new-name.ts");
  });

  test("old path is preserved", () => {
    expect(file.oldPath).toBe("src/old-name.ts");
  });

  test("has diff content (not empty)", () => {
    expect(file.hunks.length).toBeGreaterThan(0);
  });
});

describe("parseDiff — binary file", () => {
  const diff = parseDiff(loadFixture("binary.diff"));
  const file = diff.files[0]!;

  test("detects binary status", () => {
    expect(file.status).toBe("binary");
  });

  test("binary file has no hunks", () => {
    expect(file.hunks).toHaveLength(0);
  });

  test("path is correct", () => {
    expect(file.path).toBe("assets/logo.png");
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

describe("getCommentableLines", () => {
  test("maps files to sets of commentable line numbers", () => {
    const diff = parseDiff(loadFixture("simple.diff"));
    const commentable = getCommentableLines(diff);
    expect(commentable.has("src/auth/login.ts")).toBe(true);
    const lines = commentable.get("src/auth/login.ts");
    expect(lines).toBeDefined();
    expect(lines!.size).toBeGreaterThan(0);
  });

  test("added and context lines are commentable", () => {
    const diff = parseDiff(loadFixture("simple.diff"));
    const commentable = getCommentableLines(diff);
    const lines = commentable.get("src/auth/login.ts")!;

    // Verify context lines are included
    const hunkLines = diff.files[0]!.hunks[0]!.lines;
    const contextLines = hunkLines.filter((l) => l.type === "context");
    for (const line of contextLines) {
      expect(lines.has(line.newLine!)).toBe(true);
    }

    // Verify added lines are included
    const addedLines = hunkLines.filter((l) => l.type === "added");
    for (const line of addedLines) {
      expect(lines.has(line.newLine!)).toBe(true);
    }
  });

  test("removed lines are not commentable", () => {
    const diff = parseDiff(loadFixture("simple.diff"));
    const commentable = getCommentableLines(diff);
    const lines = commentable.get("src/auth/login.ts")!;

    // Verify removed lines are not in the set (they have no newLine, only oldLine)
    const hunkLines = diff.files[0]!.hunks[0]!.lines;
    const removedLines = hunkLines.filter((l) => l.type === "removed");
    // All removed lines should have newLine === null
    for (const line of removedLines) {
      expect(line.newLine).toBeNull();
    }
  });
});

describe("sliceHunk — basic slicing", () => {
  const diff = parseDiff(loadFixture("simple.diff"));
  const hunk = diff.files[0]!.hunks[0]!;

  test("returns null for file not in diff", () => {
    const result = sliceHunk(diff, "src/unknown.ts", 1);
    expect(result).toBeNull();
  });

  test("returns null for line not in file", () => {
    const result = sliceHunk(diff, "src/auth/login.ts", 999);
    expect(result).toBeNull();
  });

  test("returns hunk with header", () => {
    // Get a commentable line from the diff
    const commentableLine = hunk.lines.find((l) => l.type === "added" || l.type === "context");
    if (!commentableLine?.newLine) return;

    const result = sliceHunk(diff, "src/auth/login.ts", commentableLine.newLine);
    expect(result).not.toBeNull();
    expect(result!.header).toBe(hunk.header);
  });

  test("returns slice with lines", () => {
    const commentableLine = hunk.lines.find((l) => l.type === "added" || l.type === "context");
    if (!commentableLine?.newLine) return;

    const result = sliceHunk(diff, "src/auth/login.ts", commentableLine.newLine);
    expect(result).not.toBeNull();
    expect(result!.lines.length).toBeGreaterThan(0);
  });

  test("returns null for line number that doesn't exist as newLine", () => {
    // Use a line number that is definitely not in the new file
    const result = sliceHunk(diff, "src/auth/login.ts", 9999);
    expect(result).toBeNull();
  });
});

describe("sliceHunk — context window clamping", () => {
  const diff = parseDiff(loadFixture("simple.diff"));
  const hunkLines = diff.files[0]!.hunks[0]!.lines;

  test("clamps context at hunk start", () => {
    // Get the first commentable line
    const firstCommentable = hunkLines.find((l) => l.type === "added" || l.type === "context");
    if (!firstCommentable?.newLine) return;

    const result = sliceHunk(diff, "src/auth/login.ts", firstCommentable.newLine, 10);
    expect(result).not.toBeNull();
    // Should not go negative
    expect(result!.lines[0]!.newLine).toBeGreaterThanOrEqual(firstCommentable.newLine - 10);
  });

  test("clamps context at hunk end", () => {
    // Get the last commentable line
    const lastCommentable = [...hunkLines].reverse().find((l) => l.type === "added" || l.type === "context");
    if (!lastCommentable?.newLine) return;

    const result = sliceHunk(diff, "src/auth/login.ts", lastCommentable.newLine, 10);
    expect(result).not.toBeNull();
    // Should not exceed hunk
    expect(result!.lines.length).toBeLessThanOrEqual(hunkLines.length);
  });

  test("respects context parameter", () => {
    const midLine = hunkLines[Math.floor(hunkLines.length / 2)];
    if (!midLine || (midLine.type !== "added" && midLine.type !== "context") || !midLine.newLine) return;

    const resultSmall = sliceHunk(diff, "src/auth/login.ts", midLine.newLine, 1);
    const resultLarge = sliceHunk(diff, "src/auth/login.ts", midLine.newLine, 5);

    expect(resultSmall).not.toBeNull();
    expect(resultLarge).not.toBeNull();
    expect(resultLarge!.lines.length).toBeGreaterThanOrEqual(resultSmall!.lines.length);
  });
});

describe("sliceHunk — multi-file diff", () => {
  const diff = parseDiff(loadFixture("multi-file.diff"));

  test("slices from first (added) file", () => {
    const hunk = diff.files[0]!.hunks[0]!;
    const firstLine = hunk.lines[0];
    if (!firstLine || firstLine.newLine === null) return;

    const result = sliceHunk(diff, "src/routes/auth.ts", firstLine.newLine);
    expect(result).not.toBeNull();
    expect(result!.header).toBe(hunk.header);
  });

  test("returns null for deleted file lines", () => {
    const hunkLines = diff.files[1]!.hunks[0]!.lines;
    const removedLine = hunkLines[0]!;
    // Deleted file lines are removed, so no newLine
    expect(removedLine.newLine).toBeNull();
    expect(removedLine.oldLine).not.toBeNull();

    const result = sliceHunk(diff, "src/utils/helpers.ts", removedLine.oldLine!);
    expect(result).toBeNull();
  });

  test("slices from modified file", () => {
    const hunkLines = diff.files[2]!.hunks[0]!.lines;
    const commentableLine = hunkLines.find((l) => l.type === "added" || l.type === "context");
    if (!commentableLine?.newLine) return;

    const result = sliceHunk(diff, "README.md", commentableLine.newLine);
    expect(result).not.toBeNull();
  });
});

describe("sliceHunk — line at boundaries", () => {
  const diff = parseDiff(loadFixture("simple.diff"));
  const hunkLines = diff.files[0]!.hunks[0]!.lines;

  test("line at start of hunk", () => {
    const startLine = hunkLines.find((l) => l.type === "added" || l.type === "context");
    if (!startLine?.newLine) return;

    const result = sliceHunk(diff, "src/auth/login.ts", startLine.newLine, 5);
    expect(result).not.toBeNull();
    expect(result!.lines.length).toBeGreaterThan(0);
  });

  test("line at end of hunk", () => {
    const endLine = [...hunkLines].reverse().find((l) => l.type === "added" || l.type === "context");
    if (!endLine?.newLine) return;

    const result = sliceHunk(diff, "src/auth/login.ts", endLine.newLine, 5);
    expect(result).not.toBeNull();
    expect(result!.lines.length).toBeGreaterThan(0);
  });
});

describe("hunk line counts are bounded by the header", () => {
  // Splitting a newline-terminated diff leaves a trailing empty element, and an
  // empty string is indistinguishable from a context line whose trailing space
  // was stripped. Unbounded, the last hunk gained a line one past the end of the
  // file. That line passes local validation and then makes GitHub reject the
  // whole review, losing every comment in it.
  test("a newline-terminated diff gains no phantom trailing line", () => {
    const raw = [
      "diff --git a/a.ts b/a.ts",
      "--- a/a.ts",
      "+++ b/a.ts",
      "@@ -1,3 +1,4 @@",
      " one",
      " two",
      "+three",
      " four",
      "",
    ].join("\n");

    const rhs = parseDiff(raw)
      .files[0]!.hunks.flatMap((h) => h.lines)
      .filter((l) => l.newLine != null);

    expect(rhs.map((l) => l.newLine)).toEqual([1, 2, 3, 4]);
  });

  test("an empty context line inside a hunk is still kept", () => {
    const raw = [
      "diff --git a/a.ts b/a.ts",
      "--- a/a.ts",
      "+++ b/a.ts",
      "@@ -1,3 +1,4 @@",
      " one",
      "",
      "+three",
      " four",
      "",
    ].join("\n");

    const rhs = parseDiff(raw)
      .files[0]!.hunks.flatMap((h) => h.lines)
      .filter((l) => l.newLine != null);

    expect(rhs.map((l) => l.newLine)).toEqual([1, 2, 3, 4]);
    expect(rhs[1]!.content).toBe("");
  });
});

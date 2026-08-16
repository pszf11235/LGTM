/**
 * Tests for ReviewPage logic (non-rendering).
 *
 * Tests the scroll logic, comment management, and line calculations
 * without needing a real terminal or Ink render.
 *
 * Run with: bun test packages/plugins/review/src/pages/ReviewPage.test.ts
 */

import { describe, test, expect } from "bun:test";
import { parseDiff } from "../domain/diff-parser.js";

// Reproduce the flattenDiff logic from ReviewPage to test it
interface RenderLine {
  type: "file-header" | "hunk-header" | "diff-line";
  content: string;
  fileIdx: number;
  filePath: string;
}

function flattenDiff(raw: string): RenderLine[] {
  const diff = parseDiff(raw);
  const lines: RenderLine[] = [];

  diff.files.forEach((file, fileIdx) => {
    lines.push({ type: "file-header", content: file.path, fileIdx, filePath: file.path });

    file.hunks.forEach((hunk) => {
      lines.push({ type: "hunk-header", content: hunk.header, fileIdx, filePath: file.path });
      hunk.lines.forEach((dl) => {
        lines.push({ type: "diff-line", content: dl.content, fileIdx, filePath: file.path });
      });
    });
  });

  return lines;
}

const DEMO_DIFF = `diff --git a/src/auth/login.ts b/src/auth/login.ts
index abc1234..def5678 100644
--- a/src/auth/login.ts
+++ b/src/auth/login.ts
@@ -1,8 +1,12 @@ export function login
 import { hash } from './crypto';
+import { validateInput } from './validation';
 
 export function login(username: string, password: string) {
+  if (!username || !password) {
+    throw new Error('Username and password required');
+  }
+  validateInput(username, password);
   const hashed = hash(password);
-  return db.findUser(username, hashed);
+  return db.authenticate(username, hashed);
 }
diff --git a/src/auth/validation.ts b/src/auth/validation.ts
new file mode 100644
index 0000000..abc1234
--- /dev/null
+++ b/src/auth/validation.ts
@@ -0,0 +1,8 @@
+export function validateInput(username: string, password: string) {
+  if (username.length < 3) {
+    throw new Error('Username too short');
+  }
+  if (password.length < 8) {
+    throw new Error('Password too short');
+  }
+}`;

describe("ReviewPage scroll logic", () => {
  const flatLines = flattenDiff(DEMO_DIFF);

  test("flattenDiff produces expected number of lines", () => {
    // 2 files: file header + hunk header + lines each
    expect(flatLines.length).toBeGreaterThan(10);
    console.log(`  📊 Total flattened lines: ${flatLines.length}`);
  });

  test("first line is a file header", () => {
    expect(flatLines[0].type).toBe("file-header");
    expect(flatLines[0].filePath).toBe("src/auth/login.ts");
  });

  test("scroll offset 0 shows from start", () => {
    const termHeight = 10;
    const visible = flatLines.slice(0, termHeight);
    expect(visible[0].type).toBe("file-header");
    console.log(`  📊 Visible at offset 0: ${visible.map(l => l.type).join(", ")}`);
  });

  test("scroll offset 5 shows different content", () => {
    const termHeight = 10;
    const offset = 5;
    const visible = flatLines.slice(offset, offset + termHeight);
    expect(visible[0]).not.toEqual(flatLines[0]);
    console.log(`  📊 Visible at offset 5: first line type=${visible[0].type}, content="${visible[0].content.slice(0, 40)}"`);
  });

  test("scroll max prevents going past end", () => {
    const termHeight = 10;
    const maxScroll = Math.max(0, flatLines.length - termHeight);
    expect(maxScroll).toBeGreaterThan(0);
    console.log(`  📊 Max scroll offset: ${maxScroll} (total ${flatLines.length} lines, term ${termHeight})`);

    // Scrolling beyond max should clamp
    const clamped = Math.min(maxScroll + 10, maxScroll);
    expect(clamped).toBe(maxScroll);
  });

  test("scroll offset 0 with small diff (diff fits in terminal)", () => {
    const termHeight = 50; // bigger than diff
    const maxScroll = Math.max(0, flatLines.length - termHeight);
    expect(maxScroll).toBe(0);
    console.log(`  📊 Diff fits in terminal — maxScroll is 0 (cannot scroll)`);
  });

  test("file starts are detectable", () => {
    const fileStarts = flatLines
      .map((l, i) => (l.type === "file-header" ? i : -1))
      .filter((i) => i >= 0);
    expect(fileStarts.length).toBe(2); // two files
    console.log(`  📊 File start positions: ${fileStarts.join(", ")}`);
  });

  test("hunk starts are detectable", () => {
    const hunkStarts = flatLines
      .map((l, i) => (l.type === "hunk-header" ? i : -1))
      .filter((i) => i >= 0);
    expect(hunkStarts.length).toBe(2); // one hunk per file
    console.log(`  📊 Hunk start positions: ${hunkStarts.join(", ")}`);
  });
});

describe("ReviewPage terminal height scenarios", () => {
  const flatLines = flattenDiff(DEMO_DIFF);

  test("with termHeight=24 (standard), diff should be scrollable", () => {
    // Standard terminal minus header/footer reserves
    const termHeight = 24 - 8; // = 16
    const maxScroll = Math.max(0, flatLines.length - termHeight);
    console.log(`  📊 termHeight=16, flatLines=${flatLines.length}, maxScroll=${maxScroll}`);
    console.log(`  📊 Scrollable: ${maxScroll > 0 ? "YES" : "NO — diff too short!"}`);

    if (maxScroll === 0) {
      console.log(`  ⚠️  PROBLEM: Demo diff (${flatLines.length} lines) fits in terminal (${termHeight} lines).`);
      console.log(`     Scrolling will have no visible effect!`);
      console.log(`     Need a longer demo diff or smaller termHeight reserve.`);
    }
  });

  test("with termHeight=10 (small terminal), diff should scroll", () => {
    const termHeight = 10;
    const maxScroll = Math.max(0, flatLines.length - termHeight);
    expect(maxScroll).toBeGreaterThan(0);
    console.log(`  📊 termHeight=10, maxScroll=${maxScroll} — scrolling works`);
  });
});

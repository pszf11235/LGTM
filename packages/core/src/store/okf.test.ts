/**
 * Tests for OKF Store — verifies read/write round-tripping.
 *
 * Run with: bun test packages/core/src/store/okf.test.ts
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import fs from "fs/promises";
import path from "path";
import os from "os";
import { createOKFStore, stringifyOKF, parseOKF } from "./okf.js";

describe("OKF Store", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = path.join(os.tmpdir(), `lgtm-test-${Date.now()}`);
    await fs.mkdir(tmpDir, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  test("write and read round-trips frontmatter + content", async () => {
    const store = createOKFStore(tmpDir);

    const data = {
      type: "prr/review",
      pr: 101,
      title: "Add OAuth2 PKCE flow",
      state: "approved",
    };
    const content = `# PR #101: Add OAuth2 PKCE flow\n\nThis PR adds OAuth support.`;

    await store.write("reviews/pr-101.md", data, content);
    const result = await store.read("reviews/pr-101.md");

    expect(result).not.toBeNull();
    expect(result!.data.type).toBe("prr/review");
    expect(result!.data.pr).toBe(101);
    expect(result!.data.title).toBe("Add OAuth2 PKCE flow");
    expect(result!.data.state).toBe("approved");
    expect(result!.content).toContain("# PR #101: Add OAuth2 PKCE flow");
    expect(result!.content).toContain("This PR adds OAuth support.");
  });

  test("read returns null for non-existent file", async () => {
    const store = createOKFStore(tmpDir);
    const result = await store.read("does-not-exist.md");
    expect(result).toBeNull();
  });

  test("write creates parent directories", async () => {
    const store = createOKFStore(tmpDir);
    await store.write("deep/nested/dir/file.md", { title: "test" }, "body");

    const result = await store.read("deep/nested/dir/file.md");
    expect(result).not.toBeNull();
    expect(result!.data.title).toBe("test");
  });

  test("exists returns true for existing files", async () => {
    const store = createOKFStore(tmpDir);
    await store.write("exists.md", { ok: true }, "content");

    expect(await store.exists("exists.md")).toBe(true);
    expect(await store.exists("nope.md")).toBe(false);
  });

  test("list returns .md files in directory", async () => {
    const store = createOKFStore(tmpDir);
    await store.write("rules/r-001.md", { id: "r-001" }, "rule 1");
    await store.write("rules/r-002.md", { id: "r-002" }, "rule 2");

    const files = await store.list("rules");
    expect(files).toHaveLength(2);
    expect(files).toContain("rules/r-001.md");
    expect(files).toContain("rules/r-002.md");
  });

  test("list returns empty array for non-existent directory", async () => {
    const store = createOKFStore(tmpDir);
    const files = await store.list("nope");
    expect(files).toEqual([]);
  });
});

describe("OKF Utilities", () => {
  test("stringifyOKF produces valid frontmatter + body", () => {
    const result = stringifyOKF({ type: "test", count: 42 }, "# Hello\n\nWorld");
    expect(result).toContain("---");
    expect(result).toContain("type: test");
    expect(result).toContain("count: 42");
    expect(result).toContain("# Hello");
    expect(result).toContain("World");
  });

  test("parseOKF extracts frontmatter and content", () => {
    const raw = `---\ntype: test\ncount: 42\n---\n# Hello\n\nWorld`;
    const { data, content } = parseOKF(raw);
    expect(data.type).toBe("test");
    expect(data.count).toBe(42);
    expect(content).toContain("# Hello");
  });
});

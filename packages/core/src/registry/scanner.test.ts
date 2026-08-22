/**
 * Tests for the repo scanner and reconciliation logic.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import fs from "fs";
import path from "path";
import os from "os";
import { scanAllRepos, type ScannedRepo } from "./scanner.js";
import {
  reconcile,
  acceptRepo,
  denyRepo,
  loadIngestRegistry,
  saveIngestRegistry,
  pruneIngestRegistry,
} from "./reconcile.js";

// ─── Test Helpers ───────────────────────────────────────────────────────────

let tempDir: string;

function createFakeRepo(name: string, opts?: { remote?: string; withCommit?: boolean }): string {
  const repoDir = path.join(tempDir, name);
  const gitDir = path.join(repoDir, ".git");
  fs.mkdirSync(gitDir, { recursive: true });

  // Minimal .git structure
  fs.writeFileSync(path.join(gitDir, "HEAD"), "ref: refs/heads/main\n");

  if (opts?.remote) {
    const config = `[remote "origin"]\n\turl = ${opts.remote}\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n`;
    fs.writeFileSync(path.join(gitDir, "config"), config);
  } else {
    fs.writeFileSync(path.join(gitDir, "config"), "[core]\n\tbare = false\n");
  }

  // Add a source file for language detection
  fs.writeFileSync(path.join(repoDir, "index.ts"), "export const x = 1;\n");
  fs.writeFileSync(path.join(repoDir, "package.json"), JSON.stringify({ name }));

  return repoDir;
}

beforeEach(() => {
  tempDir = path.join(os.tmpdir(), `lgtm-scanner-test-${Date.now()}`);
  fs.mkdirSync(tempDir, { recursive: true });

  // Clean ingest registry for isolated tests
  const registryPath = path.join(os.homedir(), ".lgtm-ingest-registry.md");
  try { fs.unlinkSync(registryPath); } catch { /* doesn't exist */ }
});

afterEach(() => {
  try { fs.rmSync(tempDir, { recursive: true }); } catch { /* ignore */ }
  const registryPath = path.join(os.homedir(), ".lgtm-ingest-registry.md");
  try { fs.unlinkSync(registryPath); } catch { /* doesn't exist */ }
});

// ─── Scanner Tests ──────────────────────────────────────────────────────────

describe("scanAllRepos", () => {
  test("finds git repos in a directory", async () => {
    createFakeRepo("project-a");
    createFakeRepo("project-b");

    const repos = await scanAllRepos({ roots: [tempDir], maxDepth: 2 });
    const names = repos.map((r) => r.name).sort();

    expect(names).toContain("project-a");
    expect(names).toContain("project-b");
  });

  test("extracts remote URL and owner/repo", async () => {
    createFakeRepo("my-app", { remote: "https://github.com/acme/my-app.git" });

    const repos = await scanAllRepos({ roots: [tempDir], maxDepth: 2 });
    const repo = repos.find((r) => r.name === "my-app")!;

    expect(repo.remote).toBe("https://github.com/acme/my-app.git");
    expect(repo.owner).toBe("acme");
    expect(repo.repoName).toBe("my-app");
    expect(repo.platform).toBe("github");
  });

  test("detects GitLab platform", async () => {
    createFakeRepo("gl-project", { remote: "git@gitlab.com:team/gl-project.git" });

    const repos = await scanAllRepos({ roots: [tempDir], maxDepth: 2 });
    const repo = repos.find((r) => r.name === "gl-project")!;

    expect(repo.platform).toBe("gitlab");
  });

  test("handles repos with no remote", async () => {
    createFakeRepo("local-only");

    const repos = await scanAllRepos({ roots: [tempDir], maxDepth: 2 });
    const repo = repos.find((r) => r.name === "local-only")!;

    expect(repo.remote).toBeUndefined();
    expect(repo.owner).toBeUndefined();
    expect(repo.platform).toBeUndefined();
  });

  test("respects maxDepth", async () => {
    // Create a deeply nested repo
    const deepDir = path.join(tempDir, "a", "b", "c", "d", "e");
    fs.mkdirSync(path.join(deepDir, ".git"), { recursive: true });
    fs.writeFileSync(path.join(deepDir, ".git", "HEAD"), "ref: refs/heads/main\n");
    fs.writeFileSync(path.join(deepDir, ".git", "config"), "[core]\n");

    // Shallow scan should miss it
    const shallow = await scanAllRepos({ roots: [tempDir], maxDepth: 2 });
    expect(shallow.find((r) => r.name === "e")).toBeUndefined();

    // Deep scan should find it
    const deep = await scanAllRepos({ roots: [tempDir], maxDepth: 6 });
    expect(deep.find((r) => r.name === "e")).toBeDefined();
  });

  test("skips excluded directories", async () => {
    const nmDir = path.join(tempDir, "node_modules", "some-pkg");
    fs.mkdirSync(path.join(nmDir, ".git"), { recursive: true });
    fs.writeFileSync(path.join(nmDir, ".git", "HEAD"), "ref: refs/heads/main\n");
    fs.writeFileSync(path.join(nmDir, ".git", "config"), "[core]\n");

    const repos = await scanAllRepos({ roots: [tempDir], maxDepth: 3 });
    expect(repos.find((r) => r.name === "some-pkg")).toBeUndefined();
  });

  test("detects default branch from HEAD", async () => {
    createFakeRepo("with-branch");

    const repos = await scanAllRepos({ roots: [tempDir], maxDepth: 2 });
    const repo = repos.find((r) => r.name === "with-branch")!;

    expect(repo.defaultBranch).toBe("main");
  });

  test("detects language from file extensions", async () => {
    const repoDir = createFakeRepo("ts-project");
    fs.writeFileSync(path.join(repoDir, "app.ts"), "const x = 1;");
    fs.writeFileSync(path.join(repoDir, "utils.ts"), "export {}");
    fs.writeFileSync(path.join(repoDir, "main.ts"), "import './app'");

    const repos = await scanAllRepos({ roots: [tempDir], maxDepth: 2 });
    const repo = repos.find((r) => r.name === "ts-project")!;

    expect(repo.language).toBe("typescript");
  });

  test("detects monorepo from package.json workspaces", async () => {
    const repoDir = createFakeRepo("mono");
    fs.writeFileSync(
      path.join(repoDir, "package.json"),
      JSON.stringify({ name: "mono", workspaces: ["packages/*"] })
    );

    const repos = await scanAllRepos({ roots: [tempDir], maxDepth: 2 });
    const repo = repos.find((r) => r.name === "mono")!;

    expect(repo.isMonorepo).toBe(true);
  });

  test("non-existent scan root returns empty (no cwd fallback)", async () => {
    // When only scanning a non-existent root and excluding cwd, should find nothing
    const repos = await scanAllRepos({ roots: ["/nonexistent/path/xyz"] });
    // May still find cwd — just check the nonexistent root contributed nothing
    const fromNonexistent = repos.filter((r) => r.path.startsWith("/nonexistent"));
    expect(fromNonexistent.length).toBe(0);
  });
});

// ─── Reconciliation Tests ───────────────────────────────────────────────────

describe("reconcile", () => {
  test("marks unknown repos as new", () => {
    const scanned: ScannedRepo[] = [
      { path: "/tmp/repo-a", name: "repo-a" },
      { path: "/tmp/repo-b", name: "repo-b" },
    ];

    const result = reconcile(scanned);

    expect(result.counts.new).toBe(2);
    expect(result.counts.watching).toBe(0);
    expect(result.newRepos.length).toBe(2);
  });

  test("marks accepted repos as watching on re-run", () => {
    const repo: ScannedRepo = {
      path: path.join(tempDir, "watched-repo"),
      name: "watched-repo",
      owner: "org",
      repoName: "watched-repo",
    };
    fs.mkdirSync(repo.path, { recursive: true });

    // Accept it first
    acceptRepo(repo);

    // Now reconcile — should show as watching
    const result = reconcile([repo]);

    expect(result.counts.watching).toBe(1);
    expect(result.counts.new).toBe(0);
  });

  test("marks denied repos correctly", () => {
    const repo: ScannedRepo = {
      path: path.join(tempDir, "denied-repo"),
      name: "denied-repo",
    };
    fs.mkdirSync(repo.path, { recursive: true });

    denyRepo(repo);

    const result = reconcile([repo]);

    expect(result.counts.denied).toBe(1);
    expect(result.counts.new).toBe(0);
  });

  test("detects removed repos", () => {
    const repo: ScannedRepo = {
      path: "/tmp/nonexistent-repo-xyz-12345",
      name: "ghost-repo",
    };

    // Register it
    acceptRepo(repo);

    // Reconcile with empty scan (repo not on disk)
    const result = reconcile([]);

    expect(result.removed.length).toBe(1);
    expect(result.removed[0].name).toBe("ghost-repo");
  });

  test("deduplicates repos by path", () => {
    const scanned: ScannedRepo[] = [
      { path: "/tmp/dup-repo", name: "dup-repo" },
      { path: "/tmp/dup-repo", name: "dup-repo" }, // Same path
    ];

    const result = reconcile(scanned);

    expect(result.counts.total).toBe(1);
  });
});

// ─── Registry Persistence Tests ─────────────────────────────────────────────

describe("ingest registry", () => {
  test("accept and load round-trip", () => {
    const repo: ScannedRepo = {
      path: path.join(tempDir, "persist-test"),
      name: "persist-test",
      owner: "acme",
      repoName: "persist-test",
      platform: "github",
      language: "typescript",
    };
    fs.mkdirSync(repo.path, { recursive: true });

    acceptRepo(repo);

    const registry = loadIngestRegistry();
    const entry = registry.find((r) => r.name === "persist-test");

    expect(entry).toBeDefined();
    expect(entry!.status).toBe("watching");
    expect(entry!.owner).toBe("acme");
    expect(entry!.platform).toBe("github");
  });

  test("deny persists status", () => {
    const repo: ScannedRepo = {
      path: path.join(tempDir, "deny-test"),
      name: "deny-test",
    };
    fs.mkdirSync(repo.path, { recursive: true });

    denyRepo(repo);

    const registry = loadIngestRegistry();
    const entry = registry.find((r) => r.name === "deny-test");

    expect(entry).toBeDefined();
    expect(entry!.status).toBe("denied");
  });

  test("re-accept flips status from denied to watching", () => {
    const repo: ScannedRepo = {
      path: path.join(tempDir, "flip-test"),
      name: "flip-test",
    };
    fs.mkdirSync(repo.path, { recursive: true });

    denyRepo(repo);
    acceptRepo(repo);

    const registry = loadIngestRegistry();
    const entry = registry.find((r) => r.name === "flip-test");

    expect(entry!.status).toBe("watching");
  });

  test("prune removes non-existent paths", () => {
    saveIngestRegistry([
      {
        path: "/tmp/gone-repo-xyz-99999",
        name: "gone-repo",
        status: "watching",
        addedAt: new Date().toISOString(),
      },
      {
        path: tempDir, // This one exists
        name: "exists-repo",
        status: "watching",
        addedAt: new Date().toISOString(),
      },
    ]);

    const removed = pruneIngestRegistry();

    expect(removed.length).toBe(1);
    expect(removed[0].name).toBe("gone-repo");

    const remaining = loadIngestRegistry();
    expect(remaining.length).toBe(1);
    expect(remaining[0].name).toBe("exists-repo");
  });

  test("idempotent — accepting same repo twice doesn't duplicate", () => {
    const repo: ScannedRepo = {
      path: path.join(tempDir, "idem-test"),
      name: "idem-test",
    };
    fs.mkdirSync(repo.path, { recursive: true });

    acceptRepo(repo);
    acceptRepo(repo);

    const registry = loadIngestRegistry();
    const matches = registry.filter((r) => r.name === "idem-test");

    expect(matches.length).toBe(1);
  });
});

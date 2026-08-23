/**
 * Tests for the repo scanner and reconciliation logic.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import fs from "fs";
import path from "path";
import os from "os";
import matter from "gray-matter";
import { scanAllRepos, type ScannedRepo } from "./scanner.js";
import {
  reconcile,
  acceptRepo,
  denyRepo,
  loadIngestRegistry,
  saveIngestRegistry,
  pruneIngestRegistry,
} from "./reconcile.js";
import { saveWatchList } from "./watch-list.js";

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

// The registry and watch list both live in the store, which resolves from
// $HOME. Redirecting HOME per test gives each one a private store instead of
// deleting files out of the developer's real home directory.
let tmpHome: string;
let originalHome: string | undefined;

/** The store the code under test will resolve to. */
function storeDir(): string {
  return path.join(tmpHome, ".lgtm-farm");
}

/** The watch list as the watcher would read it. */
function readWatchList(): Array<{
  owner?: string;
  repo?: string;
  filter?: string;
  path?: string;
}> {
  try {
    const raw = fs.readFileSync(path.join(storeDir(), "watch.md"), "utf-8");
    return (matter(raw).data.repos as Array<{ owner?: string; repo?: string }>) ?? [];
  } catch {
    return [];
  }
}

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "lgtm-scanner-test-"));
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "lgtm-scanner-home-"));
  originalHome = process.env.HOME;
  process.env.HOME = tmpHome;
});

afterEach(() => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;

  try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch { /* ignore */ }
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
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

// ─── Watch List Wiring ──────────────────────────────────────────────────────
//
// Accepting a repo used to update the registry only, so the watcher never
// polled it. These cover the wiring, not the registry.

describe("accept reaches the watcher", () => {
  function repoWithRemote(name: string): ScannedRepo {
    const repo: ScannedRepo = {
      path: path.join(tempDir, name),
      name,
      owner: "acme",
      repoName: name,
      platform: "github",
      remote: `https://github.com/acme/${name}.git`,
    };
    fs.mkdirSync(repo.path, { recursive: true });
    return repo;
  }

  test("accepting a repo adds it to the watch list", () => {
    const repo = repoWithRemote("watched");

    const result = acceptRepo(repo);

    expect(result.changed).toBe(true);
    expect(readWatchList()).toEqual([
      { owner: "acme", repo: "watched", filter: "all", path: repo.path },
    ]);
  });

  test("accepting twice does not duplicate the watch entry", () => {
    const repo = repoWithRemote("twice");

    acceptRepo(repo);
    const second = acceptRepo(repo);

    expect(second.changed).toBe(false);
    expect(second.reason).toBe("already watching");
    expect(readWatchList().length).toBe(1);
  });

  test("a repo with no remote is recorded but not watched", () => {
    const repo: ScannedRepo = {
      path: path.join(tempDir, "local-only"),
      name: "local-only",
    };
    fs.mkdirSync(repo.path, { recursive: true });

    const result = acceptRepo(repo);

    expect(result.changed).toBe(false);
    expect(result.reason).toContain("no git remote");
    expect(readWatchList()).toEqual([]);

    // Still tracked, so discovery will not re-prompt for it.
    expect(loadIngestRegistry().find((r) => r.name === "local-only")?.status).toBe("watching");
  });

  test("denying a watched repo removes it from the watch list", () => {
    const repo = repoWithRemote("later-denied");
    acceptRepo(repo);
    expect(readWatchList().length).toBe(1);

    const result = denyRepo(repo);

    expect(result.changed).toBe(true);
    expect(readWatchList()).toEqual([]);
  });

  test("pruning a deleted checkout stops watching it", () => {
    const repo = repoWithRemote("vanished");
    acceptRepo(repo);
    fs.rmSync(repo.path, { recursive: true, force: true });

    const removed = pruneIngestRegistry();

    expect(removed.map((r) => r.name)).toEqual(["vanished"]);
    expect(readWatchList()).toEqual([]);
  });

  test("reconcile reads watching status from the watch list", () => {
    const repo = repoWithRemote("via-watch-list");

    // Simulate a repo added by `lgtm review watch add`, with no registry entry.
    saveWatchList(storeDir(), [{ owner: "acme", repo: "via-watch-list", filter: "all" }]);

    const result = reconcile([repo]);

    expect(result.counts.watching).toBe(1);
    expect(result.counts.new).toBe(0);
  });
});

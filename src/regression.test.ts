/**
 * The regression checklist from design.md's "Testing" section, as tests.
 *
 * Every item below is a bug that shipped in the old codebase and was found
 * again during the removals audit or the pre-submission review. They are
 * gathered in one file, away from the module tests, because each one crosses
 * a seam: an API write that has to reach the poll cycle, a default that has
 * to match the sentence documenting it, a store key that has to survive two
 * repos with the same PR number. A module test that passes in isolation is
 * exactly how each of these got through the first time.
 *
 * Fakes stop at the process boundary and nowhere else: `globalThis.fetch`, a
 * fake login shell on disk, a fake Provider run, and temp directories for the
 * store. The store writes, the route table, the classifier, the scheduler
 * arithmetic and the GitHub adapter's own pagination code all run for real,
 * because a regression test whose subject is a stub protects a stub.
 *
 * Run with: bun test src/regression.test.ts
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "fs/promises";
import fsSync from "fs";
import os from "os";
import path from "path";

import type {
  CheckStatus,
  ForgeAdapter,
  PRDetail,
  PRRef,
  PRSummary,
  RepoRef,
} from "@/core";
import { postHandler } from "@/api/post";
import { createApiHandler } from "@/api/server";
import type { ApiDeps } from "@/api/server";
import { createBinaryResolver } from "@/daemon/binaries";
import { dispatchReview, runCycle } from "@/daemon/cycle";
import type { EtagCache } from "@/daemon/cycle";
import type { QueueEntry } from "@/daemon/queue";
import {
  createScheduler,
  DEFAULT_INTERVAL_MINUTES,
  type Clock,
  type CycleTrigger,
  type Ticker,
} from "@/daemon/scheduler";
import { createGitHubAdapter, isNotModified } from "@/forge/github/adapter";
import type { EtagStore } from "@/forge/github/adapter";
import type { ReviewInput, ReviewOutcome } from "@/provider";
import { DEFAULTS, loadConfig } from "@/store/config";
import {
  listReviewedPRs,
  loadAllRounds,
  loadMeta,
  reviewDir,
  saveMeta,
  saveRound,
} from "@/store/reviews";
import { addToWatchList, loadWatchList } from "@/store/watch-list";

// ─── Shared fixture ─────────────────────────────────────────────────────────

const LOGIN = "octocat";
const NOW = "2026-08-29T12:00:00.000Z";
const TOKEN = "f".repeat(64);
const PORT = 4747;
const HOST = `127.0.0.1:${PORT}`;
const ORIGIN = `http://${HOST}`;
const SHA = "a".repeat(40);
const REPO_ROOT = path.resolve(import.meta.dir, "..");

let store: string;
let home: string;
let originalHome: string | undefined;
let originalFetch: typeof globalThis.fetch;
const cleanups: Array<() => void> = [];

beforeEach(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), "lgtm-regression-"));
  store = path.join(home, ".lgtm-farm");
  await fs.mkdir(store, { recursive: true });

  // config.ts resolves the store from HOME, so no test here can read or write
  // the developer's own ~/.lgtm-farm.
  originalHome = process.env.HOME;
  process.env.HOME = home;

  // Nothing in this file may reach the network. Anything that tries says so.
  originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: unknown): Promise<Response> => {
    throw new Error(`unplanned network request: ${String(input)}`);
  }) as unknown as typeof globalThis.fetch;
});

afterEach(async () => {
  globalThis.fetch = originalFetch;
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  while (cleanups.length > 0) cleanups.pop()?.();
  await fs.rm(home, { recursive: true, force: true }).catch(() => {});
});

function ref(number: number, owner = "acme", repo = "api"): PRRef {
  return { owner, repo, number };
}

function summary(overrides: Partial<PRSummary> & { number?: number } = {}): PRSummary {
  const number = overrides.number ?? 1;
  return {
    number,
    title: "Add rate limiter",
    body: "",
    url: `https://github.com/acme/api/pull/${number}`,
    author: LOGIN,
    draft: false,
    headSha: SHA,
    createdAt: "2026-08-01T00:00:00Z",
    updatedAt: "2026-08-02T00:00:00Z",
    requestedReviewers: [],
    assignees: [],
    ...overrides,
  };
}

function detail(overrides: Partial<PRDetail> = {}): PRDetail {
  return { ...summary(overrides), additions: 3, deletions: 1, changedFiles: 1, mergeable: true };
}

const NO_CHECKS: CheckStatus = { state: "none", runs: [] };

/** Every Forge method not overridden throws, so an unplanned call fails loudly. */
function fakeForge(overrides: Partial<ForgeAdapter> = {}): ForgeAdapter {
  const refuse =
    (name: string) =>
    (): never => {
      throw new Error(`forge.${name} should not have been called`);
    };

  return {
    listOpenPRs: refuse("listOpenPRs"),
    getPR: refuse("getPR"),
    getDiff: refuse("getDiff"),
    getCheckStatus: refuse("getCheckStatus"),
    createDraftReview: refuse("createDraftReview"),
    deleteDraftReview: refuse("deleteDraftReview"),
    getReview: refuse("getReview"),
    authenticatedUser: async () => LOGIN,
    ...overrides,
  };
}

function recordingQueue() {
  const enqueued: Array<{ ref: PRRef; headSha: string }> = [];
  const removed: PRRef[] = [];
  return {
    enqueued,
    removed,
    enqueue(target: PRRef, headSha: string) {
      enqueued.push({ ref: target, headSha });
      return "queued" as const;
    },
    remove(target: PRRef) {
      removed.push(target);
      return true;
    },
  };
}

function apiRequest(pathAndQuery: string, init: { method?: string; body?: unknown } = {}): Request {
  const headers: Record<string, string> = {
    host: HOST,
    origin: ORIGIN,
    authorization: `Bearer ${TOKEN}`,
  };
  const requestInit: RequestInit = { method: init.method ?? "GET", headers };
  if (init.body !== undefined) {
    headers["content-type"] = "application/json";
    requestInit.body = JSON.stringify(init.body);
  }
  return new Request(`http://${HOST}${pathAndQuery}`, requestInit);
}

function baseDeps(overrides: Partial<ApiDeps> = {}): ApiDeps {
  return {
    lgtmDir: store,
    token: TOKEN,
    port: PORT,
    version: "0.1.0",
    heartbeatMs: 0,
    ...overrides,
  };
}

/**
 * Every file under `root`, relative path to bytes, directories included as
 * empty entries so a newly created but empty directory is a difference too.
 */
async function snapshotTree(root: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};

  async function walk(dir: string, prefix: string): Promise<void> {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(dir, entry.name);
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        out[`${rel}/`] = "";
        await walk(full, rel);
      } else {
        out[rel] = await fs.readFile(full, "utf-8");
      }
    }
  }

  await walk(root, "");
  return out;
}

/** Capture everything a block writes to stderr, by either route. */
async function captureStderr(run: () => Promise<void>): Promise<string[]> {
  const written: string[] = [];
  const originalWrite = process.stderr.write.bind(process.stderr);
  const originalConsoleError = console.error;
  const originalConsoleWarn = console.warn;

  process.stderr.write = ((chunk: unknown) => {
    written.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  console.error = (...args: unknown[]) => void written.push(args.map(String).join(" "));
  console.warn = (...args: unknown[]) => void written.push(args.map(String).join(" "));

  try {
    await run();
  } finally {
    process.stderr.write = originalWrite;
    console.error = originalConsoleError;
    console.warn = originalConsoleWarn;
  }

  return written;
}

// ─── 1. A watch add through the API is polled on the next cycle ─────────────
//
// The original wiring bug: `POST /api/watchlist` answered 201, the confirm
// pane rendered, and the repo never reached `watch.md`, so the watcher polled
// nothing. The two halves have to be asserted together, because the response
// alone is what looked healthy the first time.

describe("1. a watch add through the API lands in watch.md and is polled next cycle", () => {
  test("the repo reaches watch.md and the next cycle asks the Forge for its open PRs", async () => {
    const backfilled = summary({ number: 7 });
    const handler = createApiHandler(
      baseDeps({
        forge: fakeForge({
          listOpenPRs: async () => [backfilled],
          getPR: async () => detail({ number: 7 }),
          getCheckStatus: async () => NO_CHECKS,
        }),
      })
    );

    const res = await handler(apiRequest("/api/watchlist", { method: "POST", body: { repo: "acme/api" } }));
    expect(res.status).toBe(201);
    expect(((await res.json()) as { added: boolean }).added).toBe(true);

    // Half one: it is on disk, in the file the daemon reads at boot.
    expect((await loadWatchList(store)).map((entry) => `${entry.owner}/${entry.repo}`)).toEqual([
      "acme/api",
    ]);

    // Half two: a cycle that knows nothing but the store polls it.
    const polled: RepoRef[] = [];
    const queue = recordingQueue();
    const result = await runCycle({
      lgtmDir: store,
      forge: fakeForge({
        listOpenPRs: async (repo) => {
          polled.push(repo);
          return [backfilled];
        },
      }),
      queue,
      now: () => NOW,
    });

    expect(polled).toEqual([{ owner: "acme", repo: "api" }]);
    expect(result.repos.map((repo) => repo.repoKey)).toEqual(["acme/api"]);
    expect(result.repos[0]?.status).toBe("ok");
    expect(result.repos[0]?.seen).toBe(1);
  });

  test("a repo the API refused is never polled", async () => {
    // The mirror image, so the test above cannot pass by polling everything.
    const handler = createApiHandler(baseDeps({ forge: fakeForge() }));

    const res = await handler(apiRequest("/api/watchlist", { method: "POST", body: { repo: "not a repo" } }));
    expect(res.status).toBe(400);
    expect(await loadWatchList(store)).toEqual([]);

    const polled: RepoRef[] = [];
    await runCycle({
      lgtmDir: store,
      forge: fakeForge({
        listOpenPRs: async (repo) => {
          polled.push(repo);
          return [];
        },
      }),
      queue: recordingQueue(),
      now: () => NOW,
    });

    expect(polled).toEqual([]);
  });
});

// ─── 2. The interval default matches its documentation ──────────────────────
//
// The old help text promised 15 minutes while the code defaulted to 0, so the
// watcher polled as fast as the loop would turn. Asserting the constant
// against itself would have passed then too, so the documented number is read
// out of the docs and the delay is observed on a fake clock.

describe("2. the poll interval default is the 15 minutes its documentation promises", () => {
  test("requirements.md and design.md name the same interval the code defaults to", async () => {
    const requirements = await fs.readFile(path.join(REPO_ROOT, "docs/spec/requirements.md"), "utf-8");
    const design = await fs.readFile(path.join(REPO_ROOT, "docs/spec/design.md"), "utf-8");

    const documented = /every (\d+) minutes by default/.exec(requirements)?.[1];
    const diagrammed = /(\d+)-minute timer/.exec(design)?.[1];

    expect(documented).toBeDefined();
    expect(diagrammed).toBeDefined();
    expect(Number(documented)).toBe(DEFAULT_INTERVAL_MINUTES);
    expect(Number(diagrammed)).toBe(DEFAULT_INTERVAL_MINUTES);
    expect(DEFAULTS.interval_minutes).toBe(DEFAULT_INTERVAL_MINUTES);
  });

  test("a store with no config.md answers the documented interval, not zero", async () => {
    expect(await fs.exists(path.join(store, "config.md"))).toBe(false);
    const config = await loadConfig();
    expect(config.interval_minutes).toBe(DEFAULT_INTERVAL_MINUTES);
    expect(config.interval_minutes).toBeGreaterThan(0);
  });

  test("a scheduler built with no interval waits the documented interval before its second cycle", async () => {
    const env = fakeTime();
    const triggers: CycleTrigger[] = [];

    const scheduler = createScheduler({
      cycle: (trigger) => void triggers.push(trigger),
      clock: env.clock,
      ticker: env.ticker,
      // Zero jitter, so the due time is exactly the interval rather than a
      // window this test would have to be sloppy about.
      random: () => 0.5,
      tickMs: 30_000,
    });

    scheduler.start();
    await env.flush();
    expect(triggers).toEqual(["boot"]);
    expect(scheduler.status().intervalMinutes).toBe(DEFAULT_INTERVAL_MINUTES);

    // One minute short of the documented interval: still nothing. A default of
    // 0 (the shipped bug) fires on the very first heartbeat instead.
    await env.advance((DEFAULT_INTERVAL_MINUTES - 1) * 60_000);
    expect(triggers).toEqual(["boot"]);

    await env.advance(2 * 60_000);
    expect(triggers).toEqual(["boot", "interval"]);

    await scheduler.stop();
  });
});

/**
 * A wall clock, a monotonic clock and a ticker that only move when a test says
 * so. No real timer, so fifteen simulated minutes cost microseconds.
 */
function fakeTime(origin = Date.UTC(2026, 7, 29, 12, 0, 0)) {
  let wall = origin;
  let mono = 10_000;
  const ticks: Array<{ period: number; fn: () => void; nextAt: number; alive: boolean }> = [];

  const clock: Clock = { now: () => wall, monotonic: () => mono };

  const ticker: Ticker = (period, fn) => {
    const entry = { period, fn, nextAt: mono + period, alive: true };
    ticks.push(entry);
    return () => {
      entry.alive = false;
    };
  };

  async function flush(): Promise<void> {
    for (let i = 0; i < 8; i++) await Promise.resolve();
  }

  async function advance(ms: number): Promise<void> {
    const target = mono + ms;
    for (let steps = 0; steps < 100_000; steps++) {
      let due: number | null = null;
      for (const entry of ticks) {
        if (entry.alive && (due === null || entry.nextAt < due)) due = entry.nextAt;
      }
      if (due === null || due > target) break;

      const step = Math.max(0, due - mono);
      mono += step;
      wall += step;
      for (const entry of [...ticks]) {
        if (!entry.alive || entry.nextAt > mono) continue;
        entry.nextAt = mono + entry.period;
        entry.fn();
        await flush();
      }
    }
    const rest = target - mono;
    if (rest > 0) {
      mono += rest;
      wall += rest;
    }
    await flush();
  }

  return { clock, ticker, advance, flush };
}

// ─── 3. Missing binaries print nothing during detection ─────────────────────
//
// A missing `gh` used to leak a line of shell noise on every invocation, which
// is what a CLI that prints nothing on success looks like when it is broken.

describe("3. detecting a missing binary prints nothing to stderr", () => {
  test("probing a shell where nothing resolves stays silent", async () => {
    const shell = fakeLoginShell([]); // no stubs at all: every binary missing
    const resolver = createBinaryResolver({ shell });

    const noise = await captureStderr(async () => {
      await resolver.probe();
      // The ENOENT re-probe is the other half of detection and runs per spawn
      // failure, so it is the one most likely to become chatty.
      await resolver.reportSpawnFailure("gh");
    });

    expect(noise).toEqual([]);
    for (const status of resolver.status()) {
      expect(status.source).toBe("missing");
      expect(status.path).toBeNull();
    }
  });

  test("a shell that cannot be spawned at all stays silent too", async () => {
    const resolver = createBinaryResolver({ shell: path.join(home, "no-such-shell") });

    const noise = await captureStderr(async () => {
      await resolver.probe();
    });

    expect(noise).toEqual([]);
    expect(resolver.resolve("claude")).toBeNull();
  });
});

/**
 * A POSIX script taking the same `-l -c "<script>"` argv shape as a login
 * shell, with PATH scoped to a throwaway bin directory. The real `command -v`
 * parsing in binaries.ts runs against it; the machine's own rc files do not.
 */
function fakeLoginShell(present: readonly string[]): string {
  const root = fsSync.mkdtempSync(path.join(os.tmpdir(), "lgtm-regression-shell-"));
  cleanups.push(() => fsSync.rmSync(root, { recursive: true, force: true }));

  const binDir = path.join(root, "bin");
  fsSync.mkdirSync(binDir);
  for (const name of present) {
    const stub = path.join(binDir, name);
    fsSync.writeFileSync(stub, "#!/bin/sh\nexit 0\n");
    fsSync.chmodSync(stub, 0o755);
  }

  const shellPath = path.join(root, "fake-shell.sh");
  fsSync.writeFileSync(
    shellPath,
    ["#!/bin/sh", `PATH="${binDir}"`, "export PATH", "shift 2", 'eval "$1"', ""].join("\n")
  );
  fsSync.chmodSync(shellPath, 0o755);

  return shellPath;
}

// ─── 4. PR listing respects pagination ──────────────────────────────────────
//
// The old adapter asked for ten results, ignored the state filter, and dropped
// whatever GitHub put on page two. A repo with more open PRs than a page held
// simply had the rest disappear.

describe("4. listing open PRs follows pagination instead of returning the first page", () => {
  const REPO: RepoRef = { owner: "acme", repo: "api" };
  const PAGE_TWO = "https://api.github.com/repos/acme/api/pulls?state=open&per_page=100&page=2";

  function pull(number: number) {
    return {
      number,
      title: `PR ${number}`,
      body: "",
      html_url: `https://github.com/acme/api/pull/${number}`,
      user: { login: "someone" },
      draft: false,
      head: { sha: `sha-${number}` },
      created_at: "2026-08-01T00:00:00Z",
      updated_at: "2026-08-02T00:00:00Z",
      requested_reviewers: [],
      assignees: [],
    };
  }

  test("every page is fetched, and the request asks for open PRs a full page at a time", async () => {
    const urls: string[] = [];
    globalThis.fetch = (async (input: unknown) => {
      const url = String(input);
      urls.push(url);

      if (url === PAGE_TWO) {
        return new Response(JSON.stringify([pull(3)]), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }

      return new Response(JSON.stringify([pull(1), pull(2)]), {
        status: 200,
        headers: {
          "content-type": "application/json",
          etag: 'W/"page-one"',
          link: `<${PAGE_TWO}>; rel="next"`,
        },
      });
    }) as typeof globalThis.fetch;

    const etags = recordingEtags();
    const result = await createGitHubAdapter({ resolveToken: () => "t", etags }).listOpenPRs(REPO);

    expect(isNotModified(result)).toBe(false);
    if (isNotModified(result)) throw new Error("unreachable");

    // Page two's PR is the one the old adapter lost.
    expect(result.map((pr) => pr.number)).toEqual([1, 2, 3]);

    expect(urls).toHaveLength(2);
    expect(urls[0]).toContain("state=open");
    expect(urls[0]).toContain("per_page=100");
    expect(urls[1]).toBe(PAGE_TWO);

    // An If-None-Match covers page one alone, so a multi-page repo must drop
    // out of conditional polling rather than risk a 304 that hides page two.
    expect(etags.get("acme/api")).toBeNull();
  });

  test("a single-page listing stops after one request and keeps its validator", async () => {
    const urls: string[] = [];
    globalThis.fetch = (async (input: unknown) => {
      urls.push(String(input));
      return new Response(JSON.stringify([pull(1)]), {
        status: 200,
        headers: { "content-type": "application/json", etag: 'W/"only-page"' },
      });
    }) as typeof globalThis.fetch;

    const etags = recordingEtags();
    const result = await createGitHubAdapter({ resolveToken: () => "t", etags }).listOpenPRs(REPO);

    expect(isNotModified(result)).toBe(false);
    expect(urls).toHaveLength(1);
    expect(etags.get("acme/api")).toBe('W/"only-page"');
  });
});

function recordingEtags(): EtagStore & EtagCache {
  const entries = new Map<string, string>();
  return {
    get: (key) => entries.get(key) ?? null,
    set: (key, etag) => {
      if (etag === null) entries.delete(key);
      else entries.set(key, etag);
    },
  };
}

// ─── 5. A dry run writes nothing ────────────────────────────────────────────
//
// The old dry run wrote to the store: it marked findings held while claiming
// to be a preview, so opening the confirm pane changed the gate.

describe("5. a dry-run post writes nothing, to GitHub or to the store", () => {
  /** New-file lines 1 to 9 of src/limiter.ts are commentable; nothing else is. */
  const DIFF = `diff --git a/src/limiter.ts b/src/limiter.ts
index 1111111..2222222 100644
--- a/src/limiter.ts
+++ b/src/limiter.ts
@@ -1,6 +1,9 @@
 const a = 1;
 const b = 2;
+const c = 3;
+const d = 4;
+const e = 5;
 const f = 6;
 const g = 7;
 const h = 8;
 const i = 9;
`;

  const PR = ref(42);

  async function seed(): Promise<void> {
    await saveMeta(store, PR, {
      url: "https://github.com/acme/api/pull/42",
      title: "Add rate limiter",
      author: LOGIN,
      state: "reviewed",
      classification: "own",
      headSha: SHA,
      lastReviewedSha: SHA,
      rounds: 1,
      // A recorded draft, so step 1 of the posting flow has something it would
      // reach GitHub about. A dry run must skip it entirely.
      pendingReviewId: 4242,
    });

    await saveRound(store, {
      ref: PR,
      round: 1,
      agent: "reviewer",
      provider: "claude-cli",
      headSha: SHA,
      status: "ok",
      startedAt: NOW,
      durationMs: 1000,
      findings: [
        { file: "src/limiter.ts", line: 4, severity: "high", comment: "off by one" },
        // Not in the diff: the real post would mark this one held, which is
        // precisely the store write the dry run must not make.
        { file: "src/limiter.ts", line: 99, severity: "low", comment: "line is gone" },
      ],
    });
  }

  test("the store is byte-identical afterwards and no request leaves the process", async () => {
    await seed();

    const forgeCalls: string[] = [];
    const deps = baseDeps({
      githubToken: () => "gh-token",
      forge: fakeForge({
        getDiff: async () => {
          forgeCalls.push("getDiff");
          return DIFF;
        },
      }),
    });

    const before = await snapshotTree(store);

    const res = await postHandler({
      req: apiRequest(`/api/prs/acme/api/42/post`, { method: "POST", body: { dryRun: true } }),
      url: new URL(`http://${HOST}/api/prs/acme/api/42/post`),
      params: { owner: "acme", repo: "api", number: "42" },
      deps,
    });

    expect(res.status).toBe(200);
    const report = (await res.json()) as {
      dryRun: boolean;
      counts: { checked: number; postable: number; held: number };
      request: { body: Record<string, unknown> };
    };

    // The preview really was produced, so "wrote nothing" is not "did nothing".
    expect(report.dryRun).toBe(true);
    expect(report.counts).toEqual({ checked: 2, postable: 1, held: 1 });
    expect(report.request.body).not.toHaveProperty("event");

    // Nothing reached GitHub: `getDiff` is a read, and the flow's three write
    // calls are the ones fakeForge refuses. globalThis.fetch throws.
    expect(forgeCalls).toEqual(["getDiff"]);

    expect(await snapshotTree(store)).toEqual(before);

    // Stated separately, because a whole-tree diff is easy to read as noise:
    // the finding whose line vanished is still `open`, not `held`.
    const rounds = await loadAllRounds(store, PR);
    expect(rounds[0]?.findings.map((finding) => finding.state)).toEqual(["open", "open"]);
    expect((await loadMeta(store, PR))?.pendingReviewId).toBe(4242);
  });
});

// ─── 6. Cache and store keys are repo-qualified ─────────────────────────────
//
// PR 42 exists in every repository anyone watches. A key that is just the
// number, or just the repo name, silently serves one repo's data for another.

describe("6. cache and store keys are repo-qualified", () => {
  test("the same PR number in three repos keeps three separate reviews", async () => {
    const a = ref(42, "acme", "api");
    const b = ref(42, "other", "api"); // same repo name, different owner
    const c = ref(42, "acme", "web"); // same owner, different repo

    for (const [target, title] of [
      [a, "acme/api's PR"],
      [b, "other/api's PR"],
      [c, "acme/web's PR"],
    ] as const) {
      await saveMeta(store, target, { title, state: "reviewed", classification: "own", headSha: SHA });
      await saveRound(store, {
        ref: target,
        round: 1,
        agent: "reviewer",
        provider: "claude-cli",
        headSha: SHA,
        status: "ok",
        startedAt: NOW,
        durationMs: 10,
        findings: [{ file: "src/x.ts", line: 1, severity: "low", comment: `finding for ${title}` }],
      });
    }

    expect((await loadMeta(store, a))?.title).toBe("acme/api's PR");
    expect((await loadMeta(store, b))?.title).toBe("other/api's PR");
    expect((await loadMeta(store, c))?.title).toBe("acme/web's PR");

    expect((await loadAllRounds(store, a))[0]?.findings[0]?.comment).toBe("finding for acme/api's PR");
    expect((await loadAllRounds(store, b))[0]?.findings[0]?.comment).toBe("finding for other/api's PR");
    expect((await loadAllRounds(store, c))[0]?.findings[0]?.comment).toBe("finding for acme/web's PR");

    expect(new Set([reviewDir(store, a), reviewDir(store, b), reviewDir(store, c)]).size).toBe(3);

    const listed = (await listReviewedPRs(store))
      .map((entry) => `${entry.owner}/${entry.repo}#${entry.number}`)
      .sort();
    expect(listed).toEqual(["acme/api#42", "acme/web#42", "other/api#42"]);
  });

  test("one repo's ETag is never sent as another's conditional request", async () => {
    // Three repos chosen so that a key made of the repo name alone collides on
    // `api`, and a key made of the owner alone collides on `acme`. Only the
    // full `owner/repo` keeps all three apart.
    const validators: Record<string, string> = {
      "/repos/acme/api/pulls": 'W/"acme-api"',
      "/repos/other/api/pulls": 'W/"other-api"',
      "/repos/acme/web/pulls": 'W/"acme-web"',
    };
    const sent: Array<{ url: string; ifNoneMatch: string | undefined }> = [];

    globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      const headers = (init?.headers ?? {}) as Record<string, string>;
      sent.push({ url, ifNoneMatch: headers["If-None-Match"] });

      const key = Object.keys(validators).find((prefix) => url.includes(prefix));
      return new Response(JSON.stringify([]), {
        status: 200,
        headers: {
          "content-type": "application/json",
          ...(key ? { etag: validators[key] as string } : {}),
        },
      });
    }) as typeof globalThis.fetch;

    const adapter = createGitHubAdapter({ resolveToken: () => "t", etags: recordingEtags() });
    const repos: RepoRef[] = [
      { owner: "acme", repo: "api" },
      { owner: "other", repo: "api" },
      { owner: "acme", repo: "web" },
    ];

    // First pass: nothing is cached, so none of the three may carry a validator.
    for (const repo of repos) await adapter.listOpenPRs(repo);
    // Second pass: each carries its own, and only its own.
    for (const repo of repos) await adapter.listOpenPRs(repo);

    expect(sent.map((call) => call.ifNoneMatch)).toEqual([
      undefined,
      undefined,
      undefined,
      'W/"acme-api"',
      'W/"other-api"',
      'W/"acme-web"',
    ]);
  });

  test("a 304 for one repo does not answer another repo's listing", async () => {
    // The consequence of the bug above, spelled out: a shared key turns one
    // repo's "nothing changed" into another repo's empty list, and an empty
    // list is what closes every PR in it.
    globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      if (headers["If-None-Match"] === 'W/"shared"') return new Response(null, { status: 304 });

      return new Response(JSON.stringify([]), {
        status: 200,
        headers: { "content-type": "application/json", etag: 'W/"shared"' },
      });
    }) as typeof globalThis.fetch;

    const adapter = createGitHubAdapter({ resolveToken: () => "t", etags: recordingEtags() });

    expect(isNotModified(await adapter.listOpenPRs({ owner: "acme", repo: "api" }))).toBe(false);
    expect(isNotModified(await adapter.listOpenPRs({ owner: "other", repo: "api" }))).toBe(false);
    expect(isNotModified(await adapter.listOpenPRs({ owner: "acme", repo: "api" }))).toBe(true);
  });
});

// ─── 7. A failed round does not mark the PR reviewed ────────────────────────
//
// The old code recorded the round and marked the PR reviewed whatever the
// Provider did, so a PR whose review crashed was never looked at again.

describe("7. a round the provider failed does not mark the PR reviewed", () => {
  const PR = ref(42);

  const failed: ReviewOutcome = {
    provider: "claude-cli",
    status: "failed",
    findings: [],
    raw: "",
    error: "claude exited with code 1",
    durationMs: 1200,
    dropped: 0,
  };

  const entry: QueueEntry = { ref: PR, headSha: SHA, queuedAt: 0 };

  async function seedQueued(): Promise<void> {
    await saveMeta(store, PR, {
      url: "https://github.com/acme/api/pull/42",
      title: "Add rate limiter",
      author: LOGIN,
      state: "queued",
      classification: "own",
      headSha: SHA,
    });
  }

  test("meta records the failure and keeps lastReviewedSha where it was", async () => {
    await seedQueued();

    const result = await dispatchReview(entry, {
      lgtmDir: store,
      // A failed round takes no snapshot, so any Forge call here is a bug.
      forge: { getPR: fakeForge().getPR, getDiff: fakeForge().getDiff },
      review: async (_input: ReviewInput) => failed,
      now: () => NOW,
    });

    expect(result.status).toBe("failed");

    const meta = await loadMeta(store, PR);
    expect(meta?.state).toBe("failed");
    expect(meta?.lastReviewedSha).toBeNull();
    expect(meta?.failedAttempts).toBe(1);
    // The round file is still written, transcript and all (R3.4).
    expect(meta?.rounds).toBe(1);
    expect((await loadAllRounds(store, PR))[0]?.status).toBe("failed");
  });

  test("the next cycle queues the same SHA again instead of leaving it alone", async () => {
    await seedQueued();
    await addToWatchList(PR.owner, PR.repo, store);

    await dispatchReview(entry, {
      lgtmDir: store,
      forge: { getPR: fakeForge().getPR, getDiff: fakeForge().getDiff },
      review: async () => failed,
      now: () => NOW,
    });

    const queue = recordingQueue();
    await runCycle({
      lgtmDir: store,
      forge: fakeForge({ listOpenPRs: async () => [summary({ number: 42, headSha: SHA })] }),
      queue,
      now: () => NOW,
    });

    expect(queue.enqueued).toEqual([{ ref: PR, headSha: SHA }]);
    expect((await loadMeta(store, PR))?.state).toBe("queued");
  });

  test("a successful round does mark the PR reviewed, so the retry above is a real retry", async () => {
    await seedQueued();

    await dispatchReview(entry, {
      lgtmDir: store,
      forge: {
        getPR: async () => detail({ number: 42, headSha: SHA }),
        getDiff: async () => "diff --git a/x b/x\n",
      },
      review: async () => ({
        provider: "claude-cli",
        status: "ok",
        findings: [],
        raw: "",
        error: null,
        durationMs: 500,
        dropped: 0,
      }),
      now: () => NOW,
    });

    const meta = await loadMeta(store, PR);
    expect(meta?.state).toBe("reviewed");
    expect(meta?.lastReviewedSha).toBe(SHA);
    expect(meta?.failedAttempts).toBe(0);

    const queue = recordingQueue();
    await addToWatchList(PR.owner, PR.repo, store);
    await runCycle({
      lgtmDir: store,
      forge: fakeForge({ listOpenPRs: async () => [summary({ number: 42, headSha: SHA })] }),
      queue,
      now: () => NOW,
    });

    expect(queue.enqueued).toEqual([]);
  });
});

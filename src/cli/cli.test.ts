/**
 * Offline coverage for the CLI's HTTP half: `lgtm status`, `lgtm open`, and
 * `lgtm watch add|rm|ls` against a fake daemon (design.md, "Architecture";
 * requirements R7.4, R7.2, R1.4).
 *
 * The fake daemon is a real `Bun.serve` on an ephemeral port, backed by a
 * temp store dir carrying real `daemon.json` and `token` files — the same
 * two files rendezvous.ts's `writeDaemonInfo`/`ensureToken` write for a real
 * daemon. `client.ts`'s job is finding and talking to *some* process at
 * that port with that token, so the realism that matters is in those two
 * files and in checking the bearer token on every authenticated route, not
 * in reimplementing src/api.
 *
 * Every test asserts on the exit code first (§ "the one thing a shell
 * prompt reads", per status.ts's doc comment) and then on what the command
 * printed, via injected `write`/`writeErr` rather than console spies.
 */
import { afterEach, describe, expect, test } from "bun:test";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { ensureToken, writeDaemonInfo } from "../daemon/rendezvous";
import type { WatchEntry } from "./client";
import { buildOpenUrl, type OpenCommandOptions, runOpen } from "./open";
import { type StatusCommandOptions, runStatus } from "./status";
import { runWatchAdd, runWatchList, runWatchRemove, type WatchCommandOptions } from "./watch";

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!();
});

// ─── Harness ────────────────────────────────────────────────────────────────

async function tempStore(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lgtm-cli-test-"));
  cleanups.push(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

/** A pid that used to be valid and, by the time this resolves, no longer is (mirrors rendezvous.test.ts). */
async function deadPid(): Promise<number> {
  const proc = Bun.spawn(["true"], { stdout: "ignore", stderr: "ignore" });
  const pid = proc.pid;
  await proc.exited;
  return pid;
}

interface RecordedRequest {
  method: string;
  path: string;
  search: string;
  authorization: string | null;
  body: unknown;
}

interface FakeDaemonOptions {
  statusPayload?: unknown;
  watchEntries?: WatchEntry[];
  /** Backfill rows to hand back from a POST, keyed by `owner/repo`. */
  backfillFor?: Record<string, unknown[]>;
}

interface FakeDaemon {
  port: number;
  token: string;
  requests: RecordedRequest[];
  stop(): void;
}

/**
 * Mirrors src/api/routes.ts's real `status` handler shape (scheduler is a
 * `SchedulerStatus`, queue a `QueueSnapshot`, quota a `QuotaState`) rather
 * than a shape invented for this test file — see client.ts's "/api/status"
 * section doc for why that distinction matters.
 */
function defaultStatusPayload(): unknown {
  return {
    app: "lgtm",
    version: "0.1.0",
    pid: process.pid,
    port: 4747,
    startedAt: new Date(Date.now() - (3600_000 + 61_000)).toISOString(), // 1h 1m ago
    uptimeMs: 3600_000 + 61_000,
    scheduler: {
      running: true,
      cycleInFlight: false,
      startedAt: new Date(Date.now() - (3600_000 + 61_000)).toISOString(),
      lastCycleAt: new Date().toISOString(),
      lastCycleOutcome: { status: "ok", trigger: "interval", startedAt: new Date().toISOString(), durationMs: 1200, error: null },
      nextCycleAt: new Date(Date.now() + 900_000).toISOString(),
      cycles: 4,
      overlapSkips: 0,
      wakes: 0,
      intervalMinutes: 15,
    },
    lastCycle: { startedAt: new Date().toISOString(), error: null },
    repos: [],
    queue: { queued: 2, inFlight: 1, pausedByGate: false, queuedEntries: [], inFlightRounds: [] },
    quota: {
      mode: "ok",
      maxPercent: 42,
      windows: [],
      readAt: Date.now(),
      resetAt: null,
      consecutiveParseFailures: 0,
      runsToday: 1,
      dailyCap: 20,
      lastError: null,
    },
    binaries: [],
    github: { tokenPresent: true },
    counts: {
      watchedRepos: 1,
      triage: 5,
      skipped: 0,
      queued: 2,
      reviewing: 1,
      failed: 0,
      awaitingGate: 3,
      pendingFindings: 3,
    },
  };
}

/**
 * Starts a fake daemon and writes `daemon.json` to point at it — but does
 * NOT touch `token`; call `ensureToken(dir)` (or let this do it) so the
 * token exists before the client tries to read it. Every authenticated
 * route 401s on any Authorization header other than `Bearer <token>`, which
 * is what makes the "stale local token" test possible.
 */
async function startFakeDaemon(dir: string, options: FakeDaemonOptions = {}): Promise<FakeDaemon> {
  const token = await ensureToken(dir);
  const requests: RecordedRequest[] = [];
  let watchEntries = options.watchEntries ?? [];

  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const url = new URL(req.url);
      const authorization = req.headers.get("authorization");
      const text = await req.text();
      const body: unknown = text.length > 0 ? JSON.parse(text) : null;
      requests.push({ method: req.method, path: url.pathname, search: url.search, authorization, body });

      if (url.pathname === "/api/health") {
        return Response.json({ app: "lgtm", version: "0.1.0", pid: process.pid });
      }

      if (authorization !== `Bearer ${token}`) {
        return new Response("unauthorized", { status: 401 });
      }

      if (url.pathname === "/api/status" && req.method === "GET") {
        return Response.json(options.statusPayload ?? defaultStatusPayload());
      }

      if (url.pathname === "/api/watchlist" && req.method === "GET") {
        return Response.json({ repos: watchEntries });
      }

      if (url.pathname === "/api/watchlist" && req.method === "POST") {
        const { owner, repo } = body as { owner: string; repo: string };
        const already = watchEntries.some((e) => e.owner === owner && e.repo === repo);
        if (!already) {
          watchEntries = [...watchEntries, { owner, repo, addedAt: new Date().toISOString() }];
        }
        const entries = options.backfillFor?.[`${owner}/${repo}`] ?? [];
        // src/api/routes.ts's real `addWatchlist` shape: {repo, key, added, entries}.
        return Response.json({ repo: { owner, repo }, key: `${owner}/${repo}`, added: !already, entries });
      }

      if (url.pathname === "/api/watchlist" && req.method === "DELETE") {
        const { owner, repo } = body as { owner: string; repo: string };
        const before = watchEntries.length;
        watchEntries = watchEntries.filter((e) => !(e.owner === owner && e.repo === repo));
        const removed = watchEntries.length < before;
        return Response.json({ repo: { owner, repo }, key: `${owner}/${repo}`, removed });
      }

      return new Response("not found", { status: 404 });
    },
  });

  // `server.port` is typed optional (it only reflects what actually got
  // bound once listening starts); mirrors the same fallback boot.ts's
  // `bunBind` uses.
  const port = server.port ?? 0;
  await writeDaemonInfo(dir, { port, pid: process.pid, startedAt: new Date().toISOString() });
  cleanups.push(() => server.stop(true));

  return {
    port,
    token,
    requests,
    stop() {
      server.stop(true);
    },
  };
}

function capture(): {
  write: (line: string) => void;
  writeErr: (line: string) => void;
  lines: string[];
  errLines: string[];
} {
  const lines: string[] = [];
  const errLines: string[] = [];
  return {
    write: (line) => lines.push(line),
    writeErr: (line) => errLines.push(line),
    lines,
    errLines,
  };
}

function noQueryStringLeaksToken(requests: RecordedRequest[], token: string): void {
  for (const req of requests) {
    expect(req.search).toBe("");
    expect(req.path).not.toContain(token);
  }
}

// ─── lgtm status ────────────────────────────────────────────────────────────

describe("lgtm status", () => {
  test("reports a running daemon and exits 0", async () => {
    const dir = await tempStore();
    const daemon = await startFakeDaemon(dir, { statusPayload: defaultStatusPayload() });
    const out = capture();

    const code = await runStatus({
      lgtmDir: dir,
      fetchImpl: fetch,
      write: out.write,
      writeErr: out.writeErr,
    } satisfies StatusCommandOptions);

    expect(code).toBe(0);
    expect(out.errLines).toEqual([]);
    expect(out.lines.some((l) => l.includes(`pid ${process.pid}`))).toBe(true);
    expect(out.lines.some((l) => l.includes("1h") && l.includes("m"))).toBe(true);
    expect(out.lines.some((l) => l.includes("2 queued, 1 in flight"))).toBe(true);
    expect(out.lines.some((l) => l.includes("ok (max 42% used)"))).toBe(true);
    expect(out.lines.some((l) => l.includes("awaiting gate: 3"))).toBe(true);
    expect(out.lines.some((l) => l.includes("triage: 5"))).toBe(true);
    noQueryStringLeaksToken(daemon.requests, daemon.token);
  });

  test("exits 1 with a clear message, not a raw connection error, when no daemon has ever run", async () => {
    const dir = await tempStore();
    const out = capture();

    const code = await runStatus({ lgtmDir: dir, write: out.write, writeErr: out.writeErr });

    expect(code).toBe(1);
    expect(out.lines).toEqual([]);
    expect(out.errLines).toHaveLength(1);
    expect(out.errLines[0]!).toMatch(/not running/i);
    expect(out.errLines[0]!).not.toMatch(/ECONNREFUSED/);
  });

  test("exits 1 when daemon.json names a dead pid", async () => {
    const dir = await tempStore();
    const pid = await deadPid();
    await writeDaemonInfo(dir, { port: 4747, pid, startedAt: new Date().toISOString() });
    const out = capture();

    const code = await runStatus({ lgtmDir: dir, write: out.write, writeErr: out.writeErr });

    expect(code).toBe(1);
    expect(out.errLines[0]!).toMatch(/not running/i);
  });

  test("exits 1 with a clear message when daemon.json is stale — pid alive, nothing listening on its port", async () => {
    const dir = await tempStore();
    const daemon = await startFakeDaemon(dir);
    daemon.stop(); // daemon.json still names this port; the process (this test) is very much alive.
    const out = capture();

    const code = await runStatus({ lgtmDir: dir, fetchImpl: fetch, write: out.write, writeErr: out.writeErr });

    expect(code).toBe(1);
    expect(out.errLines[0]!).toMatch(/not reach|not running|not respond/i);
    expect(out.errLines[0]!).not.toMatch(/ECONNREFUSED/);
  });

  test("exits 1 with a reauth hint when the local token file doesn't match what the daemon accepts", async () => {
    const dir = await tempStore();
    await startFakeDaemon(dir);
    // Simulate a token minted by a *different* daemon lifetime than the one
    // this store's token file now names — e.g. a hand-edited or corrupted
    // token file, the scenario design.md's "run lgtm open to reauthenticate"
    // messaging exists for.
    await fs.writeFile(path.join(dir, "token"), "0".repeat(64), { mode: 0o600 });
    const out = capture();

    const code = await runStatus({ lgtmDir: dir, fetchImpl: fetch, write: out.write, writeErr: out.writeErr });

    expect(code).toBe(1);
    expect(out.errLines[0]!).toMatch(/lgtm open/);
  });
});

// ─── lgtm open ──────────────────────────────────────────────────────────────

describe("lgtm open", () => {
  test("launches the browser with the token in the URL fragment, never a query string, and exits 0", async () => {
    const dir = await tempStore();
    const daemon = await startFakeDaemon(dir);
    const out = capture();
    const launched: string[] = [];

    const code = await runOpen({
      lgtmDir: dir,
      fetchImpl: fetch,
      launch: async (url) => {
        launched.push(url);
      },
      write: out.write,
      writeErr: out.writeErr,
    } satisfies OpenCommandOptions);

    expect(code).toBe(0);
    expect(launched).toHaveLength(1);

    const url = new URL(launched[0]!);
    expect(url.origin).toBe(`http://127.0.0.1:${daemon.port}`);
    // The whole point (design.md, "HTTP API"): the token rides the fragment,
    // and the fragment is not part of the query string at all.
    expect(url.search).toBe("");
    expect(url.hash).toBe(`#t=${daemon.token}`);
    expect(launched[0]!).not.toContain(`?token=`);
    expect(launched[0]!).not.toContain(`&token=`);

    // Nothing printed to the terminal carries the token either.
    for (const line of [...out.lines, ...out.errLines]) {
      expect(line).not.toContain(daemon.token);
    }
    noQueryStringLeaksToken(daemon.requests, daemon.token);
  });

  test("buildOpenUrl puts the token after '#t=' and nowhere in the query string", () => {
    const url = buildOpenUrl({ port: 4747, pid: 1, startedAt: "2026-08-29T00:00:00.000Z", token: "deadbeef" });
    const parsed = new URL(url);
    expect(parsed.search).toBe("");
    expect(parsed.hash).toBe("#t=deadbeef");
  });

  test("exits 1 without launching a browser when the daemon isn't running", async () => {
    const dir = await tempStore();
    const out = capture();
    const launched: string[] = [];

    const code = await runOpen({
      lgtmDir: dir,
      launch: async (url) => {
        launched.push(url);
      },
      write: out.write,
      writeErr: out.writeErr,
    });

    expect(code).toBe(1);
    expect(launched).toEqual([]);
    expect(out.errLines[0]!).toMatch(/not running/i);
  });

  test("exits 1 without launching a browser when daemon.json is stale", async () => {
    const dir = await tempStore();
    const daemon = await startFakeDaemon(dir);
    daemon.stop();
    const out = capture();
    const launched: string[] = [];

    const code = await runOpen({
      lgtmDir: dir,
      fetchImpl: fetch,
      launch: async (url) => {
        launched.push(url);
      },
      write: out.write,
      writeErr: out.writeErr,
    });

    expect(code).toBe(1);
    expect(launched).toEqual([]);
    expect(out.errLines[0]!).toMatch(/not respond/i);
  });
});

// ─── lgtm watch ─────────────────────────────────────────────────────────────

describe("lgtm watch add", () => {
  test("adds a repo through the API and reports the backfill summary, exit 0", async () => {
    const dir = await tempStore();
    const daemon = await startFakeDaemon(dir, {
      backfillFor: {
        "acme/api": [
          {
            key: "acme/api#1",
            title: "own PR",
            url: "https://github.com/acme/api/pull/1",
            author: "pszf11235",
            classification: "own",
            autoClass: true,
            preSelected: true,
          },
          {
            key: "acme/api#2",
            title: "someone else's",
            url: "https://github.com/acme/api/pull/2",
            author: "other",
            classification: "none",
            autoClass: false,
            preSelected: false,
          },
        ],
      },
    });
    const out = capture();

    const code = await runWatchAdd("acme/api", {
      lgtmDir: dir,
      fetchImpl: fetch,
      write: out.write,
      writeErr: out.writeErr,
    } satisfies WatchCommandOptions);

    expect(code).toBe(0);
    expect(out.lines.some((l) => l.includes("Added acme/api"))).toBe(true);
    expect(out.lines.some((l) => l.includes("Backfilled 2 open PRs (1 pre-selected"))).toBe(true);

    const posted = daemon.requests.find((r) => r.method === "POST" && r.path === "/api/watchlist");
    expect(posted).toBeDefined();
    expect(posted!.body).toEqual({ owner: "acme", repo: "api" });
    expect(posted!.authorization).toBe(`Bearer ${daemon.token}`);
    noQueryStringLeaksToken(daemon.requests, daemon.token);
  });

  test("reports no PRs to backfill when the repo has none open", async () => {
    const dir = await tempStore();
    await startFakeDaemon(dir);
    const out = capture();

    const code = await runWatchAdd("acme/empty", { lgtmDir: dir, fetchImpl: fetch, write: out.write, writeErr: out.writeErr });

    expect(code).toBe(0);
    expect(out.lines.some((l) => l.includes("No open PRs to backfill"))).toBe(true);
  });

  test("rejects a malformed repo locally, exits 1, and never calls the daemon", async () => {
    const dir = await tempStore();
    const daemon = await startFakeDaemon(dir);
    const out = capture();

    const code = await runWatchAdd("not-a-repo", { lgtmDir: dir, fetchImpl: fetch, write: out.write, writeErr: out.writeErr });

    expect(code).toBe(1);
    expect(out.errLines[0]!).toMatch(/not a repository/i);
    expect(daemon.requests.filter((r) => r.path === "/api/watchlist")).toEqual([]);
  });

  test("exits 1 when the daemon isn't running", async () => {
    const dir = await tempStore();
    const out = capture();

    const code = await runWatchAdd("acme/api", { lgtmDir: dir, write: out.write, writeErr: out.writeErr });

    expect(code).toBe(1);
    expect(out.errLines[0]!).toMatch(/not running/i);
  });
});

describe("lgtm watch rm", () => {
  test("removes an existing entry through the API, exit 0", async () => {
    const dir = await tempStore();
    const daemon = await startFakeDaemon(dir, {
      watchEntries: [{ owner: "acme", repo: "api", addedAt: "2026-08-01T00:00:00.000Z" }],
    });
    const out = capture();

    const code = await runWatchRemove("acme/api", { lgtmDir: dir, fetchImpl: fetch, write: out.write, writeErr: out.writeErr });

    expect(code).toBe(0);
    expect(out.lines.some((l) => l.includes("Removed acme/api"))).toBe(true);

    const deleted = daemon.requests.find((r) => r.method === "DELETE" && r.path === "/api/watchlist");
    expect(deleted).toBeDefined();
    expect(deleted!.body).toEqual({ owner: "acme", repo: "api" });
  });

  test("is idempotent: removing an absent entry still exits 0", async () => {
    const dir = await tempStore();
    await startFakeDaemon(dir, { watchEntries: [] });
    const out = capture();

    const code = await runWatchRemove("acme/api", { lgtmDir: dir, fetchImpl: fetch, write: out.write, writeErr: out.writeErr });

    expect(code).toBe(0);
    expect(out.lines.some((l) => l.includes("was not on the watch list"))).toBe(true);
  });
});

describe("lgtm watch ls", () => {
  test("prints each watched repo with its last-polled time", async () => {
    const dir = await tempStore();
    await startFakeDaemon(dir, {
      watchEntries: [
        { owner: "acme", repo: "api", addedAt: "2026-08-01T00:00:00.000Z", lastPolledAt: "2026-08-29T10:00:00.000Z" },
        { owner: "acme", repo: "web", addedAt: "2026-08-02T00:00:00.000Z" },
      ],
    });
    const out = capture();

    const code = await runWatchList({ lgtmDir: dir, fetchImpl: fetch, write: out.write, writeErr: out.writeErr });

    expect(code).toBe(0);
    expect(out.lines.some((l) => l.includes("acme/api") && l.includes("2026-08-29T10:00:00.000Z"))).toBe(true);
    expect(out.lines.some((l) => l.includes("acme/web") && l.includes("never polled"))).toBe(true);
  });

  test("prints a friendly empty state when nothing is watched", async () => {
    const dir = await tempStore();
    await startFakeDaemon(dir, { watchEntries: [] });
    const out = capture();

    const code = await runWatchList({ lgtmDir: dir, fetchImpl: fetch, write: out.write, writeErr: out.writeErr });

    expect(code).toBe(0);
    expect(out.lines).toEqual(["No repositories are being watched."]);
  });

  test("exits 1 when the daemon isn't running", async () => {
    const dir = await tempStore();
    const out = capture();

    const code = await runWatchList({ lgtmDir: dir, write: out.write, writeErr: out.writeErr });

    expect(code).toBe(1);
    expect(out.errLines[0]!).toMatch(/not running/i);
  });
});

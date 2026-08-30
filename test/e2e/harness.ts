/**
 * One running LGTM, wired to a fake GitHub and a fake Claude, with handles a
 * journey can drive.
 *
 * Everything under src/ runs for real. `createDaemon` builds the same eleven
 * modules `lgtm up` does, `apiBind()` mounts the same route table, the poll
 * cycle writes the same markdown store, and the Provider layer spawns a real
 * subprocess. Three things are swapped, and only three:
 *
 *  1. **The network.** `globalThis.fetch` is rewritten so anything addressed
 *     to `https://api.github.com` lands on the fake's loopback port instead,
 *     and anything addressed anywhere else throws. This is the seam, rather
 *     than `DaemonOptions.forge`, for two reasons. Injecting a Forge would
 *     skip `createGitHubAdapter`, and with it the ETag handling, the
 *     pagination, the media types and the 401 retry. That is a third of what
 *     these journeys exercise. It would also miss `postPendingReview`, which
 *     builds its own absolute `api.github.com` URL and never sees the
 *     adapter's `baseUrl` at all; a harness that injected a Forge would
 *     "pass" while the real post flow talked to the internet.
 *
 *  2. **The Provider binary**, pinned to test/fixtures/fake-claude.ts through
 *     an injected `BinaryResolver`. The resolver is stubbed rather than
 *     pinned through `config.md` because the real one probes with
 *     `$SHELL -l -c 'command -v ...'` for whatever is not pinned, which
 *     spawns the developer's own login shell and its rc files inside a test.
 *     Binary resolution has its own unit tests; see ./README.md.
 *
 *  3. **The notifier's spawn**, so a test run does not fire real macOS
 *     notifications. Calls are recorded instead.
 *
 * Nothing waits on a real interval. The scheduler gets a ticker that never
 * ticks, so a cycle happens when, and only when, a journey asks for one, and
 * `settle()` waits on the queue's own bookkeeping rather than on a sleep.
 */

import fs from "fs/promises";
import os from "os";
import path from "path";

import { createDaemon, type Daemon } from "@/daemon/boot";
import type { PollCycleResult } from "@/daemon/cycle";
import { createEventBus, type DaemonEvent } from "@/daemon/events";
import { apiBind } from "@/daemon/serve";
import type { BinaryName, BinaryResolver, BinaryStatus } from "@/daemon/binaries";
import type { UsageProbe } from "@/daemon/quota";
import type { CycleOutcome, CycleTrigger } from "@/daemon/scheduler";
import type { Severity } from "@/core";
import { stringifyFrontmatter } from "@/store/okf";
import { saveConfig, type Config } from "@/store/config";
import { initDefaultTemplate } from "@/store/templates";

import { createFakeGitHub, type FakeGitHub, type FakeRepo } from "./fake-github";

// ─── Constants ──────────────────────────────────────────────────────────────

const REPO_ROOT = path.resolve(import.meta.dir, "..", "..");

/** The shim the Provider layer spawns in place of the real CLI. */
export const FAKE_CLAUDE_PATH = path.join(REPO_ROOT, "test", "fixtures", "fake-claude.ts");

/** What the fake CLI does with a `/review` prompt. See test/fixtures/README.md. */
export type FakeClaudeMode = "json" | "prose" | "garbage" | "empty" | "timeout" | "crash";

/** Resolved by the real token chain out of the environment, and sent by the real adapter. */
export const E2E_GITHUB_TOKEN = "ghp_e2e_fixture_token";

const GITHUB_API_ORIGIN = "https://api.github.com";

// ─── The authenticated API client ───────────────────────────────────────────

export interface ApiResponse<T = unknown> {
  status: number;
  ok: boolean;
  /** Parsed JSON when the response was JSON, the raw text otherwise. */
  body: T;
  text: string;
  headers: Headers;
}

/**
 * A client against the daemon's own HTTP API, carrying the bearer token and,
 * on writes, the Origin the daemon demands. Deliberately thin. Journeys read
 * the wire shapes the browser reads (`{ prs, total }`, not a bare array), so
 * a client-side convenience that unwrapped envelopes here would hide exactly
 * the class of defect this harness exists to find.
 */
export interface ApiClient {
  readonly origin: string;
  get<T = unknown>(path: string): Promise<ApiResponse<T>>;
  post<T = unknown>(path: string, body?: unknown): Promise<ApiResponse<T>>;
  patch<T = unknown>(path: string, body?: unknown): Promise<ApiResponse<T>>;
  del<T = unknown>(path: string, body?: unknown): Promise<ApiResponse<T>>;
  /** Full control, for auth-negative cases and hand-built headers. */
  request<T = unknown>(method: string, path: string, init?: RequestInit): Promise<ApiResponse<T>>;
}

// ─── The harness ────────────────────────────────────────────────────────────

export interface PollResult {
  /** Null when the scheduler's overlap guard refused the cycle. */
  outcome: CycleOutcome | null;
  /** Per-repo detail, as `/api/status` reports it. */
  cycle: PollCycleResult | null;
}

export interface Harness {
  readonly daemon: Daemon;
  /** The temp HOME. `~/.lgtm-farm` resolves inside it, so no test touches the real store. */
  readonly home: string;
  readonly lgtmDir: string;
  readonly github: FakeGitHub;
  /** The repo created at startup, `acme/api` unless overridden. */
  readonly repo: FakeRepo;
  readonly api: ApiClient;
  /** Everything the daemon's event bus emitted, in order. */
  readonly events: DaemonEvent[];
  /** Every daemon log line, for a readable failure message. */
  readonly logs: string[];
  /** Notification commands the notifier would have spawned. */
  readonly notifications: string[][];

  /** Change what the fake CLI returns for the next Round. */
  setClaudeMode(mode: FakeClaudeMode): void;
  /** Run exactly one poll cycle and wait for everything it started to finish. */
  poll(trigger?: CycleTrigger): Promise<PollResult>;
  /** Wait until no cycle is running and the review queue is empty. */
  settle(timeoutMs?: number): Promise<void>;
  /** Stop the daemon, the fake, and restore the process environment. */
  stop(): Promise<void>;
}

export interface HarnessOptions {
  /** The login `GET /user` answers with, and therefore what "own" means. */
  viewer?: string;
  owner?: string;
  repo?: string;
  /**
   * The agent file's `severity_floor`. Defaults to `low` so both of the fake
   * CLI's findings survive; the shipped default is `high`, which would drop
   * the medium one before it ever reached the store.
   */
  severityFloor?: Severity;
  /** The fake CLI's starting mode. Defaults to `json`. */
  claudeMode?: FakeClaudeMode;
  /** Overrides merged into the config.md the harness writes. */
  config?: Partial<Config>;
  /**
   * Replaces the quota probe. By default the daemon really spawns the fake
   * CLI with `-p /usage`, which reports 61% and leaves the gate open.
   */
  usageProbe?: UsageProbe;
  /**
   * The queue's hold-retry timer. A gated queue re-drains itself on a real
   * interval, which is right in production and a race in a test: a journey
   * that closes the quota gate wants the queue to stay held until it says
   * otherwise. Pass `() => () => {}` to take the retry out of the picture.
   */
  setTimer?: (fn: () => void, ms: number) => () => void;
  /** Echo daemon log lines to stdout. Useful while writing a journey. */
  verbose?: boolean;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * A resolver that answers from a fixed table and never spawns anything.
 * `terminal-notifier` is reported missing, which is the state the notifier
 * falls back to `osascript` from. That spawn is stubbed too.
 */
function stubBinaries(claudePath: string): BinaryResolver {
  const table: Record<BinaryName, BinaryStatus> = {
    claude: { name: "claude", source: "pinned", path: claudePath },
    gh: { name: "gh", source: "pinned", path: "/usr/bin/false" },
    "terminal-notifier": { name: "terminal-notifier", source: "missing", path: null },
  };

  return {
    probe: async () => {},
    resolve: (name) => table[name].path,
    reportSpawnFailure: async () => {},
    status: () => [table.claude, table.gh, table["terminal-notifier"]],
  };
}

/** Bind port 0, read what the OS gave us, hand it back. Close enough to free. */
async function borrowPort(): Promise<number> {
  const probe = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("") });
  const port = probe.port ?? 0;
  await probe.stop(true);
  return port;
}

function urlOf(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

/**
 * Point every GitHub call at the fake, and turn every other outbound request
 * into a loud failure.
 *
 * The allowance for loopback is what lets the harness's own API client, and
 * the daemon's port-scan health probe, keep working.
 */
function installNetworkBoundary(fakeUrl: string): () => void {
  const real = globalThis.fetch;

  const patched = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const original = urlOf(input);

    if (original.startsWith(GITHUB_API_ORIGIN)) {
      const rewritten = fakeUrl + original.slice(GITHUB_API_ORIGIN.length);
      if (typeof input === "string" || input instanceof URL) return real(rewritten, init);
      return real(new Request(rewritten, input), init);
    }

    let host: string;
    try {
      host = new URL(original).hostname;
    } catch {
      host = "";
    }

    if (host === "127.0.0.1" || host === "localhost" || host === "::1") {
      return real(input as RequestInfo, init);
    }

    throw new Error(
      `e2e: blocked a request to ${original}. The harness allows loopback and ${GITHUB_API_ORIGIN} only.`
    );
  };

  globalThis.fetch = patched as unknown as typeof globalThis.fetch;
  return () => {
    globalThis.fetch = real;
  };
}

function createApiClient(origin: string, token: string): ApiClient {
  async function request<T>(method: string, target: string, init: RequestInit = {}): Promise<ApiResponse<T>> {
    const headers = new Headers(init.headers);
    if (!headers.has("authorization")) headers.set("authorization", `Bearer ${token}`);
    // Every mutating route checks Origin; setting it unconditionally costs
    // nothing on reads and keeps the client from having a second code path.
    if (!headers.has("origin")) headers.set("origin", origin);

    const response = await fetch(`${origin}${target}`, { ...init, method, headers });
    const text = await response.text();

    let body: unknown = text;
    if (text.length > 0) {
      try {
        body = JSON.parse(text);
      } catch {
        body = text;
      }
    }

    return {
      status: response.status,
      ok: response.ok,
      body: body as T,
      text,
      headers: response.headers,
    };
  }

  function withJson<T>(method: string, target: string, body?: unknown): Promise<ApiResponse<T>> {
    return request<T>(method, target, {
      headers: { "content-type": "application/json" },
      body: body === undefined ? "{}" : JSON.stringify(body),
    });
  }

  return {
    origin,
    get: (target) => request("GET", target),
    post: (target, body) => withJson("POST", target, body),
    patch: (target, body) => withJson("PATCH", target, body),
    del: (target, body) => withJson("DELETE", target, body),
    request: (method, target, init) => request(method, target, init),
  };
}

// ─── Startup ────────────────────────────────────────────────────────────────

/**
 * Bring one whole LGTM up.
 *
 * Always pair with `await harness.stop()`; the harness mutates process-wide
 * state (`HOME`, `GITHUB_TOKEN`, `FAKE_CLAUDE_MODE`, `globalThis.fetch`) and
 * `stop` is what puts it back.
 */
export async function startHarness(options: HarnessOptions = {}): Promise<Harness> {
  const owner = options.owner ?? "acme";
  const repoName = options.repo ?? "api";
  const viewer = options.viewer ?? "octocat";

  // ── The store, in a temp HOME ────────────────────────────────────────────
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "lgtm-e2e-"));
  const lgtmDir = path.join(home, ".lgtm-farm");
  await fs.mkdir(lgtmDir, { recursive: true });

  const savedEnv = {
    HOME: process.env.HOME,
    GITHUB_TOKEN: process.env.GITHUB_TOKEN,
    GH_TOKEN: process.env.GH_TOKEN,
    FAKE_CLAUDE_MODE: process.env.FAKE_CLAUDE_MODE,
  };

  // config.ts and the credentials fallback both resolve the store from HOME.
  process.env.HOME = home;
  // Resolved by the real chain in @/forge/github/auth, so no `resolveToken`
  // seam is used and the adapter really reads a token out of the environment.
  process.env.GITHUB_TOKEN = E2E_GITHUB_TOKEN;
  delete process.env.GH_TOKEN;
  process.env.FAKE_CLAUDE_MODE = options.claudeMode ?? "json";

  await saveConfig({
    interval_minutes: 15,
    pause_above_pct: 70,
    resume_below_pct: 60,
    daily_cap: 20,
    concurrency: 2,
    ...options.config,
  });

  await fs.mkdir(path.join(lgtmDir, "agents"), { recursive: true });
  await fs.writeFile(
    path.join(lgtmDir, "agents", "reviewer.md"),
    stringifyFrontmatter(
      {
        provider: "claude-cli",
        model: "sonnet",
        timeout_minutes: 1,
        severity_floor: options.severityFloor ?? "low",
        enabled: true,
      },
      "Flag anything that would break in production."
    ),
    "utf-8"
  );

  // Written rather than left missing, so the post flow renders the real
  // template instead of silently exercising its fallback.
  await initDefaultTemplate(lgtmDir);

  // ── The fakes ────────────────────────────────────────────────────────────
  const github = createFakeGitHub({ viewer, repos: [{ owner, repo: repoName }] });
  const repo = github.repo(owner, repoName);
  const restoreFetch = installNetworkBoundary(github.url);

  function restoreEnv(): void {
    for (const [name, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }

  /**
   * Undo everything a half-built harness already changed. `startHarness` has
   * mutated `HOME`, three other variables and `globalThis.fetch` by this
   * point, and a throw between here and the return would leak all of it into
   * whatever test runs next, which is a very confusing way to fail.
   */
  async function rollback(): Promise<void> {
    restoreFetch();
    restoreEnv();
    await github.stop().catch(() => {});
    await fs.rm(home, { recursive: true, force: true }).catch(() => {});
  }

  // ── The daemon ───────────────────────────────────────────────────────────
  const events: DaemonEvent[] = [];
  const logs: string[] = [];
  const notifications: string[][] = [];

  const bus = createEventBus();
  bus.on((event) => {
    events.push(event);
  });

  const log = (line: string): void => {
    logs.push(line);
    if (options.verbose) console.log(`[lgtm] ${line}`);
  };

  const port = await borrowPort();

  let boot: Awaited<ReturnType<typeof createDaemon>>;
  try {
    boot = await createDaemon({
      lgtmDir,
      events: bus,
      binaries: stubBinaries(FAKE_CLAUDE_PATH),
      // The production bind: the same route table, auth choke point and SPA
      // shell `lgtm up` serves. Mounting a hand-rolled handler here would have
      // hidden the missing-route class of defect entirely.
      bind: apiBind(),
      port,
      // A small window past the borrowed port, in case something claimed it in
      // the gap. `apiBind` binds each candidate explicitly, so the port the
      // daemon reports is always the port it is serving.
      portScanCount: 4,
      probeOccupant: async () => false,
      // Never ticks. Cycles happen when a journey calls `poll()`, so nothing
      // here waits on the 15-minute schedule or on wake detection.
      ticker: () => () => {},
      // The test runner owns SIGINT and SIGTERM; the daemon must not.
      signals: null,
      notifySpawn: async (cmd) => {
        notifications.push([...cmd]);
        return { exitCode: 0 };
      },
      ...(options.usageProbe ? { usageProbe: options.usageProbe } : {}),
      ...(options.setTimer ? { setTimer: options.setTimer } : {}),
      log,
    });
  } catch (error) {
    await rollback();
    throw error;
  }

  if (boot.status === "refused") {
    await rollback();
    throw new Error(
      `e2e: the daemon refused to start; pid ${boot.existing.pid} holds the lock on ${lgtmDir}`
    );
  }

  const daemon = boot.daemon;
  const api = createApiClient(`http://127.0.0.1:${daemon.port}`, daemon.token);

  // ── Driving it ───────────────────────────────────────────────────────────

  async function settle(timeoutMs = 60_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    let quiet = 0;

    while (Date.now() < deadline) {
      await daemon.scheduler.whenIdle();

      const queue = daemon.queue.status();
      // A queue the quota gate is holding is idle in every sense that matters
      // here: nothing is running and nothing will start until the gate
      // reopens. Waiting for `queued === 0` instead would turn "LGTM correctly
      // refused to spend the user's quota" into a 60-second timeout, which is
      // the wrong way to learn that the gate works.
      const settled = queue.queued === 0 || (queue.pausedByGate && queue.inFlight === 0);
      const idle = settled && queue.inFlight === 0 && !daemon.scheduler.status().cycleInFlight;

      // Three consecutive quiet readings, not one. A Round releases its slot
      // and immediately kicks another drain pass, so a single idle sample can
      // land inside a gap rather than at the end.
      quiet = idle ? quiet + 1 : 0;
      if (quiet >= 3) return;

      await sleep(5);
    }

    throw new Error(
      `e2e: the daemon did not settle within ${timeoutMs}ms. queue=${JSON.stringify(
        daemon.queue.status()
      )} quota=${JSON.stringify(daemon.quota.state().mode)}`
    );
  }

  // The boot cycle the scheduler starts is not awaited by `createDaemon`.
  try {
    await settle();
  } catch (error) {
    await daemon.stop();
    await rollback();
    throw error;
  }

  async function poll(trigger: CycleTrigger = "manual"): Promise<PollResult> {
    const outcome = await daemon.scheduler.runNow(trigger);
    await settle();
    return { outcome, cycle: daemon.status().lastCycle };
  }

  let stopped = false;

  return {
    daemon,
    home,
    lgtmDir,
    github,
    repo,
    api,
    events,
    logs,
    notifications,

    setClaudeMode(mode) {
      process.env.FAKE_CLAUDE_MODE = mode;
    },

    poll,
    settle,

    async stop() {
      if (stopped) return;
      stopped = true;

      await daemon.stop();
      await rollback();
    },
  };
}

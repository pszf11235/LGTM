/**
 * Tests for the SPA's data layer (api.ts, hooks.ts) plus smoke-level
 * rendering for its two reading views and the finding card.
 *
 * api.ts and hooks.ts get real behavioral coverage: every browser global
 * they touch (fetch, localStorage, location, history, EventSource, timers)
 * is an injectable seam, stubbed here exactly as the daemon's own tests
 * stub Clock/Ticker/setTimer. The views get smoke tests only, on purpose —
 * `renderToStaticMarkup` never runs effects (bun test has no DOM at all;
 * see the "no DOM globals" note below), so a component's *initial* render
 * is all any harness here can exercise. FindingCard is the one exception:
 * it is pure and props-in, so it is tested with real content, not just a
 * loading placeholder.
 */
import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import {
  ApiError,
  createApiClient,
  emptyFindingCounts,
  githubLineUrl,
  resolveToken,
  totalFindings,
  type FetchLike,
  type HistoryLike,
  type LocationLike,
  type StorageLike,
} from "./api";
import {
  createEventStream,
  type ConnectionStatus,
  type EventSourceLike,
  type InvalidationHint,
} from "./hooks";
import { FindingCard, type FindingCardProps } from "./components/FindingCard";
import { Inbox } from "./views/Inbox";
import { PRDetail } from "./views/PRDetail";

// ─── Stubs ──────────────────────────────────────────────────────────────────

function memoryStorage(): StorageLike {
  const mem = new Map<string, string>();
  return {
    getItem: (key) => mem.get(key) ?? null,
    setItem: (key, value) => void mem.set(key, value),
    removeItem: (key) => void mem.delete(key),
  };
}

function stubLocation(hash: string): LocationLike {
  return { hash, pathname: "/", search: "" };
}

function stubHistory(): HistoryLike & { calls: Array<{ url: string | URL | null | undefined }> } {
  const calls: Array<{ url: string | URL | null | undefined }> = [];
  return {
    calls,
    replaceState(_data, _unused, url) {
      calls.push({ url });
    },
  };
}

interface FetchCall {
  input: string;
  init: RequestInit | undefined;
}

function stubFetch(handler: (call: FetchCall) => Response | Promise<Response>): { fetch: FetchLike; calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  const fetch: FetchLike = async (input, init) => {
    const call = { input, init };
    calls.push(call);
    return handler(call);
  };
  return { fetch, calls };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

// ─── api.ts: resolveToken ───────────────────────────────────────────────────

describe("resolveToken", () => {
  test("reads the fragment, stores it, and strips the URL", () => {
    const storage = memoryStorage();
    const hist = stubHistory();
    const loc = stubLocation("#t=abc123");

    const token = resolveToken(loc, storage, hist);

    expect(token).toBe("abc123");
    expect(storage.getItem("lgtm.token")).toBe("abc123");
    expect(hist.calls).toEqual([{ url: "/" }]);
  });

  test("falls back to the stored token when the fragment is empty", () => {
    const storage = memoryStorage();
    storage.setItem("lgtm.token", "stored-token");
    const hist = stubHistory();

    const token = resolveToken(stubLocation(""), storage, hist);

    expect(token).toBe("stored-token");
    expect(hist.calls).toEqual([]); // nothing to strip
  });

  test("returns null with no fragment and nothing stored", () => {
    expect(resolveToken(stubLocation(""), memoryStorage(), stubHistory())).toBeNull();
  });

  test("a fresh fragment token overrides a stale stored one", () => {
    const storage = memoryStorage();
    storage.setItem("lgtm.token", "old-token");
    const token = resolveToken(stubLocation("#t=new-token"), storage, stubHistory());

    expect(token).toBe("new-token");
    expect(storage.getItem("lgtm.token")).toBe("new-token");
  });

  test("decodes a percent-encoded token", () => {
    const token = resolveToken(stubLocation("#t=ab%2Bcd"), memoryStorage(), stubHistory());
    expect(token).toBe("ab+cd");
  });
});

// ─── api.ts: createApiClient ────────────────────────────────────────────────

describe("createApiClient", () => {
  test("authState is unauthenticated with no token anywhere", () => {
    const client = createApiClient({
      fetchImpl: stubFetch(() => json({})).fetch,
      storage: memoryStorage(),
      location: stubLocation(""),
      history: stubHistory(),
    });
    expect(client.getAuthState()).toBe("unauthenticated");
    expect(client.getToken()).toBeNull();
  });

  test("a request with no token rejects without ever calling fetch", async () => {
    const { fetch, calls } = stubFetch(() => json([]));
    const client = createApiClient({
      fetchImpl: fetch,
      storage: memoryStorage(),
      location: stubLocation(""),
      history: stubHistory(),
    });

    await expect(client.listPRs()).rejects.toThrow();
    expect(calls).toHaveLength(0);
  });

  test("sends the resolved token as a Bearer header", async () => {
    const { fetch, calls } = stubFetch(() => json([]));
    const client = createApiClient({
      fetchImpl: fetch,
      storage: memoryStorage(),
      location: stubLocation("#t=my-token"),
      history: stubHistory(),
    });

    await client.listPRs();

    expect(calls).toHaveLength(1);
    const headers = new Headers(calls[0]?.init?.headers);
    expect(headers.get("Authorization")).toBe("Bearer my-token");
  });

  test("health() never sends a token, even when one is available", async () => {
    const { fetch, calls } = stubFetch(() => json({ app: "lgtm", version: "1.0.0", pid: 42 }));
    const client = createApiClient({
      fetchImpl: fetch,
      storage: memoryStorage(),
      location: stubLocation("#t=my-token"),
      history: stubHistory(),
    });

    const health = await client.health();

    expect(health).toEqual({ app: "lgtm", version: "1.0.0", pid: 42 });
    const headers = new Headers(calls[0]?.init?.headers);
    expect(headers.has("Authorization")).toBe(false);
  });

  test("a 401 flips authState and throws an unauthenticated ApiError", async () => {
    const { fetch } = stubFetch(() => new Response("nope", { status: 401 }));
    const client = createApiClient({
      fetchImpl: fetch,
      storage: memoryStorage(),
      location: stubLocation("#t=stale-token"),
      history: stubHistory(),
    });

    const seen: string[] = [];
    client.onAuthStateChange((state) => seen.push(state));

    let error: unknown;
    try {
      await client.listPRs();
    } catch (err) {
      error = err;
    }

    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).kind).toBe("unauthenticated");
    expect(client.getAuthState()).toBe("unauthenticated");
    expect(seen).toEqual(["unauthenticated"]);
  });

  test("onAuthStateChange returns an unsubscribe function", async () => {
    const { fetch } = stubFetch(() => new Response("nope", { status: 401 }));
    const client = createApiClient({
      fetchImpl: fetch,
      storage: memoryStorage(),
      location: stubLocation("#t=stale-token"),
      history: stubHistory(),
    });

    const seen: string[] = [];
    const unsubscribe = client.onAuthStateChange((state) => seen.push(state));
    unsubscribe();

    await client.listPRs().catch(() => {});
    expect(seen).toEqual([]);
  });

  test("a network failure surfaces as a network ApiError", async () => {
    const client = createApiClient({
      fetchImpl: async () => {
        throw new Error("connection refused");
      },
      storage: memoryStorage(),
      location: stubLocation("#t=tok"),
      history: stubHistory(),
    });

    let error: unknown;
    try {
      await client.status();
    } catch (err) {
      error = err;
    }

    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).kind).toBe("network");
  });

  test("a non-401 error status surfaces as an http ApiError with the status code", async () => {
    const client = createApiClient({
      fetchImpl: async () => new Response("boom", { status: 500 }),
      storage: memoryStorage(),
      location: stubLocation("#t=tok"),
      history: stubHistory(),
    });

    let error: unknown;
    try {
      await client.status();
    } catch (err) {
      error = err;
    }

    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).kind).toBe("http");
    expect((error as ApiError).status).toBe(500);
  });

  test("listPRs tolerantly coerces a sparse response into full PRListItem rows", async () => {
    const client = createApiClient({
      fetchImpl: async () =>
        json([
          { owner: "acme", repo: "api", number: 42, state: "triage", title: "Add rate limiter" },
          { owner: "acme", repo: "api", number: 43, state: "bogus-state" },
        ]),
      storage: memoryStorage(),
      location: stubLocation("#t=tok"),
      history: stubHistory(),
    });

    const prs = await client.listPRs();

    expect(prs).toHaveLength(2);
    expect(prs[0]).toMatchObject({
      owner: "acme",
      repo: "api",
      number: 42,
      state: "triage",
      title: "Add rate limiter",
      mergeable: null,
      checkStatus: null,
      classification: "none",
    });
    expect(prs[0]?.findingCounts).toEqual(emptyFindingCounts());
    // An unrecognised state string falls back to "triage" rather than throwing.
    expect(prs[1]?.state).toBe("triage");
  });

  test("listPRs sends the state filter as a query param", async () => {
    const { fetch, calls } = stubFetch(() => json([]));
    const client = createApiClient({
      fetchImpl: fetch,
      storage: memoryStorage(),
      location: stubLocation("#t=tok"),
      history: stubHistory(),
    });

    await client.listPRs({ state: ["triage", "skipped"] });

    expect(calls[0]?.input).toBe("/api/prs?state=triage%2Cskipped");
  });

  test("eventsUrl carries the token as a query param", () => {
    const client = createApiClient({
      fetchImpl: stubFetch(() => json({})).fetch,
      storage: memoryStorage(),
      location: stubLocation("#t=my-token"),
      history: stubHistory(),
    });

    expect(client.eventsUrl()).toBe("/api/events?token=my-token");
  });

  test("eventsUrl carries no token param when unauthenticated", () => {
    const client = createApiClient({
      fetchImpl: stubFetch(() => json({})).fetch,
      storage: memoryStorage(),
      location: stubLocation(""),
      history: stubHistory(),
    });

    expect(client.eventsUrl()).toBe("/api/events");
  });
});

// ─── api.ts: small pure helpers ─────────────────────────────────────────────

describe("githubLineUrl", () => {
  test("builds a blob permalink at the reviewed SHA", () => {
    expect(githubLineUrl("acme", "api", "abc123", "src/limiter.ts", 118)).toBe(
      "https://github.com/acme/api/blob/abc123/src/limiter.ts#L118",
    );
  });
});

describe("totalFindings", () => {
  test("sums every severity", () => {
    expect(totalFindings({ critical: 1, high: 2, medium: 0, low: 3 })).toBe(6);
  });

  test("is zero for an empty count", () => {
    expect(totalFindings(emptyFindingCounts())).toBe(0);
  });
});

// ─── hooks.ts: createEventStream ────────────────────────────────────────────

/** A minimal EventTarget-shaped stub: enough surface for createEventStream, nothing else. */
class StubEventSource implements EventSourceLike {
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  readonly listeners = new Map<string, Array<(ev: { data: string }) => void>>();
  closed = false;

  constructor(readonly url: string) {}

  addEventListener(type: string, listener: (ev: { data: string }) => void): void {
    const list = this.listeners.get(type) ?? [];
    list.push(listener);
    this.listeners.set(type, list);
  }

  close(): void {
    this.closed = true;
  }

  emit(type: string, data: string): void {
    for (const listener of this.listeners.get(type) ?? []) listener({ data });
  }
}

function fakeTimers() {
  const scheduled: Array<{ fn: () => void; ms: number; cancelled: boolean }> = [];
  return {
    scheduled,
    setTimer(fn: () => void, ms: number): () => void {
      const entry = { fn, ms, cancelled: false };
      scheduled.push(entry);
      return () => {
        entry.cancelled = true;
      };
    },
    /** Runs the most recently scheduled, non-cancelled timer, as if it fired. */
    fireLatest(): void {
      const entry = [...scheduled].reverse().find((e) => !e.cancelled);
      entry?.fn();
    },
  };
}

describe("createEventStream", () => {
  test("connects to the given URL and listens for every daemon event plus a generic fallback", () => {
    let created: StubEventSource | null = null;
    createEventStream({
      url: "/api/events?token=abc",
      createEventSource: (url) => (created = new StubEventSource(url)),
      onInvalidate: () => {},
    });

    expect(created).not.toBeNull();
    expect(created!.url).toBe("/api/events?token=abc");
    for (const type of ["cycle-finished", "pr-changed", "findings-ready", "quota-changed", "error"]) {
      expect(created!.listeners.has(type)).toBe(true);
    }
    expect(created!.onmessage).not.toBeNull();
  });

  test("onopen reports status open", () => {
    let source: StubEventSource | null = null;
    const statuses: ConnectionStatus[] = [];
    createEventStream({
      url: "/x",
      createEventSource: (url) => (source = new StubEventSource(url)),
      onInvalidate: () => {},
      onStatusChange: (s) => statuses.push(s),
    });

    source!.onopen?.();

    expect(statuses).toEqual(["open"]);
  });

  test("a named event with valid JSON invalidates with the parsed DaemonEvent", () => {
    let source: StubEventSource | null = null;
    const hints: InvalidationHint[] = [];
    createEventStream({
      url: "/x",
      createEventSource: (url) => (source = new StubEventSource(url)),
      onInvalidate: (hint) => hints.push(hint),
    });

    source!.emit("pr-changed", JSON.stringify({ type: "pr-changed", ref: { owner: "a", repo: "b", number: 1 } }));

    expect(hints).toEqual([{ type: "pr-changed", ref: { owner: "a", repo: "b", number: 1 } }]);
  });

  test("unparseable event data still invalidates, as type unknown", () => {
    let source: StubEventSource | null = null;
    const hints: InvalidationHint[] = [];
    createEventStream({
      url: "/x",
      createEventSource: (url) => (source = new StubEventSource(url)),
      onInvalidate: (hint) => hints.push(hint),
    });

    source!.emit("pr-changed", "not json at all");

    expect(hints).toEqual([{ type: "unknown" }]);
  });

  test("a generic message with an unrecognised type still invalidates", () => {
    let source: StubEventSource | null = null;
    const hints: InvalidationHint[] = [];
    createEventStream({
      url: "/x",
      createEventSource: (url) => (source = new StubEventSource(url)),
      onInvalidate: (hint) => hints.push(hint),
    });

    source!.onmessage?.({ data: JSON.stringify({ type: "some-future-event" }) });

    expect(hints).toEqual([{ type: "unknown" }]);
  });

  test("onerror closes the source and schedules a reconnect with the initial backoff", () => {
    let source: StubEventSource | null = null;
    const statuses: ConnectionStatus[] = [];
    const timers = fakeTimers();

    createEventStream({
      url: "/x",
      createEventSource: (url) => (source = new StubEventSource(url)),
      onInvalidate: () => {},
      onStatusChange: (s) => statuses.push(s),
      backoff: { initialMs: 1000, maxMs: 30_000, factor: 2 },
      setTimer: timers.setTimer,
      random: () => 0, // zero jitter, so the scheduled delay is exactly initialMs
    });

    source!.onerror?.();

    expect(source!.closed).toBe(true);
    expect(statuses).toEqual(["reconnecting"]);
    expect(timers.scheduled).toHaveLength(1);
    expect(timers.scheduled[0]?.ms).toBe(1000);
  });

  test("backoff grows exponentially across consecutive failures, capped at maxMs", () => {
    const timers = fakeTimers();
    const factories: StubEventSource[] = [];

    createEventStream({
      url: "/x",
      createEventSource: (url) => {
        const es = new StubEventSource(url);
        factories.push(es);
        return es;
      },
      onInvalidate: () => {},
      backoff: { initialMs: 1000, maxMs: 5000, factor: 2 },
      setTimer: timers.setTimer,
      random: () => 0,
    });

    factories[0]?.onerror?.(); // 1000ms
    timers.fireLatest(); // opens a second source
    factories[1]?.onerror?.(); // 2000ms
    timers.fireLatest(); // opens a third source
    factories[2]?.onerror?.(); // 4000ms, still under the 5000ms cap
    timers.fireLatest();
    factories[3]?.onerror?.(); // would be 8000ms, capped to 5000ms

    expect(timers.scheduled.map((t) => t.ms)).toEqual([1000, 2000, 4000, 5000]);
  });

  test("a successful open resets the backoff attempt counter", () => {
    const timers = fakeTimers();
    const factories: StubEventSource[] = [];

    createEventStream({
      url: "/x",
      createEventSource: (url) => {
        const es = new StubEventSource(url);
        factories.push(es);
        return es;
      },
      onInvalidate: () => {},
      backoff: { initialMs: 1000, maxMs: 30_000, factor: 2 },
      setTimer: timers.setTimer,
      random: () => 0,
    });

    factories[0]?.onerror?.(); // attempt -> 1, schedules 1000ms
    timers.fireLatest(); // opens factories[1]
    factories[1]?.onopen?.(); // resets attempt to 0
    factories[1]?.onerror?.(); // should schedule the *initial* delay again, not 2000ms

    expect(timers.scheduled.map((t) => t.ms)).toEqual([1000, 1000]);
  });

  test("stop() cancels a pending reconnect and closes the live source", () => {
    const timers = fakeTimers();
    let source: StubEventSource | null = null;
    const statuses: ConnectionStatus[] = [];

    const handle = createEventStream({
      url: "/x",
      createEventSource: (url) => (source = new StubEventSource(url)),
      onInvalidate: () => {},
      onStatusChange: (s) => statuses.push(s),
      setTimer: timers.setTimer,
      random: () => 0,
    });

    source!.onerror?.(); // schedules a reconnect
    handle.stop();

    expect(timers.scheduled[0]?.cancelled).toBe(true);
    expect(source!.closed).toBe(true);
    expect(handle.status()).toBe("closed");
    expect(statuses.at(-1)).toBe("closed");
  });

  test("with no EventSource available anywhere, it degrades to closed instead of throwing", () => {
    const statuses: ConnectionStatus[] = [];
    expect(() =>
      createEventStream({
        url: "/x",
        onInvalidate: () => {},
        onStatusChange: (s) => statuses.push(s),
        // No createEventSource override, and bun test has no global
        // EventSource either — this is the real "unsupported environment"
        // path, not a simulation of it.
      }),
    ).not.toThrow();
    expect(statuses).toEqual(["closed"]);
  });
});

// ─── Views: smoke rendering ──────────────────────────────────────────────────
//
// bun test provides no DOM (no window, document, localStorage, EventSource —
// confirmed empirically, not assumed) and renderToStaticMarkup never runs
// effects, so these assert only that mounting each view produces the
// expected *initial* markup without throwing. api.ts/hooks.ts above are
// where the actual data-flow logic is covered.

describe("Inbox (smoke)", () => {
  test("renders its initial loading state without throwing", () => {
    const html = renderToStaticMarkup(createElement(Inbox));
    expect(html).toContain("Loading");
  });
});

describe("PRDetail (smoke)", () => {
  test("renders its initial loading state without throwing", () => {
    const html = renderToStaticMarkup(
      createElement(PRDetail, { prRef: { owner: "acme", repo: "api", number: 42 } }),
    );
    expect(html).toContain("Loading");
  });
});

describe("FindingCard (smoke)", () => {
  const baseFinding: FindingCardProps["finding"] = {
    key: "r2:reviewer:f1",
    round: 2,
    agent: "reviewer",
    headSha: "abc123def456",
    severity: "high",
    file: "src/limiter.ts",
    line: 118,
    comment: "This bucket refill can go negative under bursty load.",
    suggestion: "Clamp the refill to zero before comparing.",
    state: "open",
    heldReason: null,
    hunk: {
      header: "@@ -110,7 +110,9 @@",
      lines: [
        { type: "context", content: "  function refill() {", oldLine: 110, newLine: 110 },
        { type: "added", content: "    tokens += rate;", oldLine: null, newLine: 111 },
        { type: "removed", content: "    tokens = rate;", oldLine: 111, newLine: null },
      ],
    },
  };

  test("renders severity, location, comment, suggestion, hunk lines, and the GitHub deep link", () => {
    const html = renderToStaticMarkup(
      createElement(FindingCard, { owner: "acme", repo: "api", finding: baseFinding }),
    );

    expect(html).toContain("high");
    expect(html).toContain("src/limiter.ts:118");
    expect(html).toContain("This bucket refill can go negative under bursty load.");
    expect(html).toContain("Clamp the refill to zero before comparing.");
    expect(html).toContain("tokens += rate;");
    expect(html).toContain(githubLineUrl("acme", "api", "abc123def456", "src/limiter.ts", 118));
  });

  test("falls back to a note, not a crash, when the diff snapshot is missing", () => {
    const html = renderToStaticMarkup(
      createElement(FindingCard, { owner: "acme", repo: "api", finding: { ...baseFinding, hunk: null } }),
    );
    expect(html).toContain("Diff snapshot unavailable");
  });

  test("the discard action renders disabled — this task does not wire gate mutations", () => {
    const html = renderToStaticMarkup(
      createElement(FindingCard, { owner: "acme", repo: "api", finding: baseFinding }),
    );
    expect(html).toMatch(/disabled[\s\S]*Discard/);
  });
});

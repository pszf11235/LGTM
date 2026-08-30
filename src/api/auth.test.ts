/**
 * The security boundary's own tests.
 *
 * These check four things in isolation: Host, Origin, token extraction, and
 * constant-time comparison. They also check the order `authorize` runs them
 * in. The other half is server.test.ts's route-by-route matrix, which proves
 * every route actually goes through this file. Neither test is enough alone.
 * A perfect `authorize` that one route forgets to call is an open daemon, and
 * a matrix over a permissive `authorize` proves nothing.
 */

import { describe, expect, test } from "bun:test";
import {
  allowedHosts,
  allowedOrigins,
  authorize,
  denialMessage,
  denialResponse,
  isAllowedHost,
  isAllowedOrigin,
  presentedToken,
  secretsMatch,
  type AuthPolicy,
  type AuthRequirement,
} from "./auth";

const PORT = 4747;
const TOKEN = "a".repeat(64);
const POLICY: AuthPolicy = { token: TOKEN, port: PORT };

const PUBLIC: AuthRequirement = { bearer: false, mutating: false, queryToken: false };
const READ: AuthRequirement = { bearer: true, mutating: false, queryToken: false };
const WRITE: AuthRequirement = { bearer: true, mutating: true, queryToken: false };
const STREAM: AuthRequirement = { bearer: true, mutating: false, queryToken: true };

function request(
  path: string,
  init: { method?: string; headers?: Record<string, string> } = {}
): { req: Request; url: URL } {
  const url = new URL(`http://127.0.0.1:${PORT}${path}`);
  const headers: Record<string, string> = { host: `127.0.0.1:${PORT}`, ...init.headers };
  return { req: new Request(url, { method: init.method ?? "GET", headers }), url };
}

// ─── Host ───────────────────────────────────────────────────────────────────

describe("Host", () => {
  test("accepts only 127.0.0.1 and localhost at the bound port", () => {
    expect(allowedHosts(PORT)).toEqual(["127.0.0.1:4747", "localhost:4747"]);
    expect(isAllowedHost("127.0.0.1:4747", PORT)).toBe(true);
    expect(isAllowedHost("localhost:4747", PORT)).toBe(true);
  });

  /**
   * The DNS rebinding case, and the reason this check exists at all. The
   * attacker's domain resolves to 127.0.0.1, so the request really does
   * arrive on loopback and binding to loopback does not stop it. What the
   * browser will not do is rewrite the Host header.
   */
  test("rejects a rebound hostname that resolves to loopback", () => {
    expect(isAllowedHost("rebind.evil.example:4747", PORT)).toBe(false);
    expect(isAllowedHost("evil.example", PORT)).toBe(false);
  });

  test("rejects a right host on the wrong port", () => {
    expect(isAllowedHost("127.0.0.1:4748", PORT)).toBe(false);
    expect(isAllowedHost("localhost:80", PORT)).toBe(false);
  });

  /** The daemon never binds 80, so a portless Host was addressed elsewhere. */
  test("rejects a portless host", () => {
    expect(isAllowedHost("127.0.0.1", PORT)).toBe(false);
    expect(isAllowedHost("localhost", PORT)).toBe(false);
  });

  test("rejects a missing host", () => {
    expect(isAllowedHost(null, PORT)).toBe(false);
    expect(isAllowedHost("", PORT)).toBe(false);
  });

  test("tolerates case and surrounding whitespace", () => {
    expect(isAllowedHost(" LOCALHOST:4747 ", PORT)).toBe(true);
  });

  test("tracks the port it was actually bound to, not a default", () => {
    expect(isAllowedHost("127.0.0.1:4747", 51234)).toBe(false);
    expect(isAllowedHost("127.0.0.1:51234", 51234)).toBe(true);
  });
});

// ─── Origin ─────────────────────────────────────────────────────────────────

describe("Origin", () => {
  test("accepts only the daemon's own two origins", () => {
    expect(allowedOrigins(PORT)).toEqual(["http://127.0.0.1:4747", "http://localhost:4747"]);
    expect(isAllowedOrigin("http://127.0.0.1:4747", PORT)).toBe(true);
    expect(isAllowedOrigin("http://localhost:4747", PORT)).toBe(true);
  });

  test("rejects a cross-site origin", () => {
    expect(isAllowedOrigin("https://evil.example", PORT)).toBe(false);
    expect(isAllowedOrigin("http://127.0.0.1:4748", PORT)).toBe(false);
  });

  /**
   * `null` is what a sandboxed iframe and some redirects send. It is an
   * origin the daemon does not serve, so it is refused like any other.
   */
  test("rejects a null or missing origin", () => {
    expect(isAllowedOrigin("null", PORT)).toBe(false);
    expect(isAllowedOrigin(null, PORT)).toBe(false);
  });

  test("tolerates a trailing slash a hand-written client might add", () => {
    expect(isAllowedOrigin("http://127.0.0.1:4747/", PORT)).toBe(true);
  });
});

// ─── Token extraction ───────────────────────────────────────────────────────

describe("presented token", () => {
  test("reads a Bearer credential, whatever the scheme's case", () => {
    const a = request("/api/status", { headers: { authorization: `Bearer ${TOKEN}` } });
    expect(presentedToken(a.req, a.url, READ)).toBe(TOKEN);

    const b = request("/api/status", { headers: { authorization: `bearer ${TOKEN}` } });
    expect(presentedToken(b.req, b.url, READ)).toBe(TOKEN);
  });

  test("reports no header at all as null, not as an empty token", () => {
    const { req, url } = request("/api/status");
    expect(presentedToken(req, url, READ)).toBeNull();
  });

  /** A Basic credential is a token of the wrong kind, not an absent one. */
  test("treats a non-Bearer scheme as a presented token that will not match", () => {
    const { req, url } = request("/api/status", { headers: { authorization: "Basic Zm9vOmJhcg==" } });
    expect(presentedToken(req, url, READ)).toBe("");
  });

  test("reads ?token= only where the route allows it", () => {
    const stream = request(`/api/events?token=${TOKEN}`);
    expect(presentedToken(stream.req, stream.url, STREAM)).toBe(TOKEN);

    const read = request(`/api/status?token=${TOKEN}`);
    expect(presentedToken(read.req, read.url, READ)).toBeNull();
  });

  /**
   * A page holding a real token in memory must never fall back to whatever a
   * link left in the URL, which is the half of the token that ends up in
   * history and referrers.
   */
  test("prefers the header over the query parameter", () => {
    const { req, url } = request(`/api/events?token=stale`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(presentedToken(req, url, STREAM)).toBe(TOKEN);
  });
});

// ─── Comparison ─────────────────────────────────────────────────────────────

describe("secretsMatch", () => {
  test("matches an identical token", () => {
    expect(secretsMatch(TOKEN, TOKEN)).toBe(true);
  });

  test("rejects a different token of the same length", () => {
    expect(secretsMatch("b".repeat(64), TOKEN)).toBe(false);
  });

  /**
   * `timingSafeEqual` throws on a length mismatch. Hashing both sides first
   * is what keeps this from becoming a branch an attacker can time to learn
   * the token's length.
   */
  test("rejects tokens of different lengths without throwing", () => {
    expect(secretsMatch("short", TOKEN)).toBe(false);
    expect(secretsMatch("", TOKEN)).toBe(false);
    expect(secretsMatch(`${TOKEN}extra`, TOKEN)).toBe(false);
  });

  test("rejects a prefix of the real token", () => {
    expect(secretsMatch(TOKEN.slice(0, 63), TOKEN)).toBe(false);
  });
});

// ─── authorize ──────────────────────────────────────────────────────────────

describe("authorize", () => {
  test("lets a correct request through", () => {
    const { req, url } = request("/api/status", { headers: { authorization: `Bearer ${TOKEN}` } });
    expect(authorize(req, url, READ, POLICY)).toBeNull();
  });

  test("lets the public route through with no token", () => {
    const { req, url } = request("/api/health");
    expect(authorize(req, url, PUBLIC, POLICY)).toBeNull();
  });

  /** Even the unauthenticated route answers only to its own two hostnames. */
  test("checks Host on the public route too", () => {
    const { req, url } = request("/api/health", { headers: { host: "evil.example" } });
    expect(authorize(req, url, PUBLIC, POLICY)?.reason).toBe("bad-host");
  });

  test("names the missing token and the wrong token apart", () => {
    const missing = request("/api/status");
    expect(authorize(missing.req, missing.url, READ, POLICY)?.reason).toBe("missing-token");

    const wrong = request("/api/status", { headers: { authorization: "Bearer nope" } });
    expect(authorize(wrong.req, wrong.url, READ, POLICY)?.reason).toBe("bad-token");
  });

  test("requires an Origin on a write, and refuses a foreign one", () => {
    const none = request("/api/watchlist", {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(authorize(none.req, none.url, WRITE, POLICY)?.reason).toBe("bad-origin");

    const foreign = request("/api/watchlist", {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, origin: "https://evil.example" },
    });
    expect(authorize(foreign.req, foreign.url, WRITE, POLICY)?.reason).toBe("bad-origin");

    const own = request("/api/watchlist", {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, origin: `http://127.0.0.1:${PORT}` },
    });
    expect(authorize(own.req, own.url, WRITE, POLICY)).toBeNull();
  });

  /** A read is not a write. Requiring Origin here would break every CLI GET. */
  test("does not require an Origin on a read", () => {
    const { req, url } = request("/api/status", {
      headers: { authorization: `Bearer ${TOKEN}`, origin: "https://evil.example" },
    });
    expect(authorize(req, url, READ, POLICY)).toBeNull();
  });

  /**
   * Order matters for the message the user sees, and for how much work a
   * cross-site request gets out of the daemon: Host, then Origin, then the
   * token, which is never examined for a request that had no business
   * arriving.
   */
  test("reports the first failure, Host before Origin before token", () => {
    const everything = request("/api/watchlist", {
      method: "POST",
      headers: { host: "evil.example", origin: "https://evil.example", authorization: "Bearer nope" },
    });
    expect(authorize(everything.req, everything.url, WRITE, POLICY)?.reason).toBe("bad-host");

    const originAndToken = request("/api/watchlist", {
      method: "POST",
      headers: { origin: "https://evil.example", authorization: "Bearer nope" },
    });
    expect(authorize(originAndToken.req, originAndToken.url, WRITE, POLICY)?.reason).toBe("bad-origin");
  });

  test("accepts the SSE query token on the streaming route only", () => {
    const stream = request(`/api/events?token=${TOKEN}`);
    expect(authorize(stream.req, stream.url, STREAM, POLICY)).toBeNull();

    const read = request(`/api/status?token=${TOKEN}`);
    expect(authorize(read.req, read.url, READ, POLICY)?.reason).toBe("missing-token");
  });
});

// ─── Responses ──────────────────────────────────────────────────────────────

describe("denial responses", () => {
  test("a browser with a stale token gets a page naming the fix", async () => {
    const { req, url } = request("/api/status", {
      headers: { authorization: "Bearer nope", accept: "text/html,application/xhtml+xml" },
    });
    const denial = authorize(req, url, READ, POLICY);
    expect(denial).not.toBeNull();

    const res = denialResponse(denial!, req);
    expect(res.status).toBe(401);
    expect(res.headers.get("content-type")).toContain("text/html");

    const body = await res.text();
    expect(body).toContain("lgtm open");
    // Self-contained. A daemon the browser was just told it may not talk to
    // cannot then serve it a stylesheet, so nothing here needs a second request.
    expect(body).not.toContain("<link");
    expect(body).not.toContain("<script");
  });

  test("a fetching client gets the same words as JSON", async () => {
    const { req, url } = request("/api/status", { headers: { accept: "application/json" } });
    const denial = authorize(req, url, READ, POLICY)!;

    const res = denialResponse(denial, req);
    expect(res.status).toBe(401);
    expect(res.headers.get("content-type")).toContain("application/json");

    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe("missing-token");
    expect(body.message).toContain("lgtm open");
  });

  test("a Host or Origin refusal is a 403 and does not suggest reauthenticating", async () => {
    const { req, url } = request("/api/status", { headers: { host: "evil.example" } });
    const denial = authorize(req, url, READ, POLICY)!;

    const res = denialResponse(denial, req);
    expect(res.status).toBe(403);
    expect(denialMessage(denial)).not.toContain("lgtm open");
  });

  /**
   * The one header that must never appear. A missing
   * Access-Control-Allow-Origin is what keeps a cross-site fetch unreadable
   * even if it somehow gets through, so "just for the dev server" would
   * quietly undo the Host and Origin checks above.
   */
  test("sets no CORS headers on any denial", () => {
    const cases = [
      request("/api/status", { headers: { host: "evil.example" } }),
      request("/api/status", { headers: { authorization: "Bearer nope" } }),
      request("/api/watchlist", {
        method: "POST",
        headers: { authorization: `Bearer ${TOKEN}`, origin: "https://evil.example" },
      }),
    ];

    for (const { req, url } of cases) {
      const requirement = req.method === "POST" ? WRITE : READ;
      const res = denialResponse(authorize(req, url, requirement, POLICY)!, req);
      expect(res.headers.get("access-control-allow-origin")).toBeNull();
      expect(res.headers.get("access-control-allow-credentials")).toBeNull();
      expect(res.headers.get("access-control-allow-headers")).toBeNull();
    }
  });

  test("names Bearer without a realm, so no browser dialog covers the page", () => {
    const { req, url } = request("/api/status");
    const res = denialResponse(authorize(req, url, READ, POLICY)!, req);
    expect(res.headers.get("www-authenticate")).toBe("Bearer");
  });

  test("never echoes the presented token back", async () => {
    const { req, url } = request("/api/status", { headers: { authorization: "Bearer hunter2" } });
    const res = denialResponse(authorize(req, url, READ, POLICY)!, req);
    expect(await res.text()).not.toContain("hunter2");
  });
});

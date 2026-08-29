/**
 * The security boundary of the daemon.
 *
 * The API holds a GitHub token and owns the only write path to the Forge, so
 * everything in this file exists to keep a web page the user happens to have
 * open from reaching it. Four checks, in this order (design.md, "HTTP API";
 * R7.2):
 *
 *  1. **Host** must be `127.0.0.1:<port>` or `localhost:<port>`. This is what
 *     stops DNS rebinding. An attacker who controls a domain can point it at
 *     127.0.0.1 and make the browser send same-origin requests to the daemon;
 *     what the browser cannot forge is the Host header, which still carries
 *     the attacker's hostname. Binding to loopback alone does not help there,
 *     because the request really does originate on the loopback interface.
 *  2. **Origin**, on any request that writes. A cross-site form or fetch
 *     carries the attacker's origin, and a browser will not let a page lie
 *     about it. A missing Origin counts as a failure rather than a pass.
 *     Browsers always send Origin on non-GET requests, so the only clients
 *     that omit it are local ones we control, and they can set it.
 *  3. **Bearer token**, on every `/api/*` route but `/api/health`. Compared
 *     over SHA-256 digests through `timingSafeEqual`, so neither the value
 *     nor its length is readable from how long the comparison took.
 *  4. Nothing else. No CORS headers are ever set, anywhere. A missing
 *     `Access-Control-Allow-Origin` is what makes a cross-site fetch
 *     unreadable even when it is somehow allowed through, so adding one
 *     "for convenience" would quietly undo checks 1 and 2.
 *
 * The checks live here, as data-driven functions over an `AuthRequirement`,
 * because `src/api/server.ts` applies them at exactly one choke point for
 * every route in `src/api/routes.ts`. Per-route auth is how one forgotten
 * route becomes an open daemon, and a spot check would not find it. See the
 * route-by-route matrix in server.test.ts.
 *
 * A rejected token gets a readable page telling the user to run `lgtm open`,
 * not a bare 401 (design.md, "HTTP API"). The token lives in the SPA's
 * localStorage and the usual way to hold a stale one is to have restarted
 * something; the fix is one command and the response should say so.
 */

import { createHash, timingSafeEqual } from "crypto";

/** The SSE query parameter. `EventSource` cannot set headers, so `/api/events` takes the token here. */
export const TOKEN_QUERY_PARAM = "token";

export interface AuthPolicy {
  /** The bearer token from `<lgtmDir>/token`, minted once at first run. */
  token: string;
  /** The port `Bun.serve` actually bound. The Host and Origin checks compare against it, not a default. */
  port: number;
}

/**
 * What one route demands. Declared per route in the route table and applied
 * here, so the table stays the single readable answer to "what is protected".
 */
export interface AuthRequirement {
  /** Requires a bearer token. False for `/api/health` alone. */
  bearer: boolean;
  /** Requires a matching Origin. True for every method that writes. */
  mutating: boolean;
  /** Also accepts `?token=`. True for the SSE route alone (EventSource cannot set headers). */
  queryToken: boolean;
}

export type DenialReason = "bad-host" | "bad-origin" | "missing-token" | "bad-token";

export interface Denial {
  reason: DenialReason;
  /** One line, safe to show a user and safe to log. Never echoes the presented token. */
  detail: string;
  status: number;
}

// ─── Host and Origin ────────────────────────────────────────────────────────

/** The only two authorities this daemon answers to. */
export function allowedHosts(port: number): string[] {
  return [`127.0.0.1:${port}`, `localhost:${port}`];
}

/** The same two, as origins. `lgtm open` launches the first one. */
export function allowedOrigins(port: number): string[] {
  return allowedHosts(port).map((host) => `http://${host}`);
}

/**
 * An exact match, port included. A bare `127.0.0.1` with no port is rejected
 * too. The daemon never binds 80, so a portless Host means the request was
 * addressed to something else and arrived here by a rewrite.
 */
export function isAllowedHost(host: string | null, port: number): boolean {
  if (!host) return false;
  return allowedHosts(port).includes(host.trim().toLowerCase());
}

export function isAllowedOrigin(origin: string | null, port: number): boolean {
  if (!origin) return false;
  // Strip a trailing slash. `new URL(...).origin` never produces one, but a
  // hand-written client header sometimes does, and it changes nothing.
  const normalised = origin.trim().toLowerCase().replace(/\/$/, "");
  return allowedOrigins(port).includes(normalised);
}

// ─── Token ──────────────────────────────────────────────────────────────────

/**
 * The token the request presents, or null.
 *
 * The `Authorization` header wins over the query parameter, so a page that
 * has a real token in memory never falls back to whatever a link put in the
 * URL. The query form is accepted only where the requirement says so.
 */
export function presentedToken(req: Request, url: URL, requirement: AuthRequirement): string | null {
  const header = req.headers.get("authorization");
  if (header) {
    const match = /^bearer\s+(.+)$/i.exec(header.trim());
    if (match?.[1]) return match[1].trim();
    // An Authorization header that is present but not a Bearer credential is
    // a presented token of the wrong kind, not a missing one.
    return "";
  }

  if (requirement.queryToken) {
    const fromQuery = url.searchParams.get(TOKEN_QUERY_PARAM);
    if (fromQuery) return fromQuery;
  }

  return null;
}

/**
 * Constant-time string comparison.
 *
 * Hashing both sides first makes the comparison always run over 32 bytes.
 * `timingSafeEqual` throws on a length mismatch, and branching on that throw
 * would leak the token's length. Small, but free to avoid.
 */
export function secretsMatch(presented: string, expected: string): boolean {
  const a = createHash("sha256").update(presented, "utf8").digest();
  const b = createHash("sha256").update(expected, "utf8").digest();
  return timingSafeEqual(a, b);
}

// ─── The check ──────────────────────────────────────────────────────────────

/**
 * Run every check this route requires. Returns null when the request may
 * proceed, or the first `Denial` otherwise.
 *
 * Host is checked before anything else, on every route including
 * `/api/health`. Rebinding gives an attacker's page a same-origin channel to
 * the daemon, and an unauthenticated endpoint that answers over that channel
 * tells them which port the daemon is on. Origin is checked before
 * the token so a cross-site write is refused without the token ever being
 * examined.
 */
export function authorize(
  req: Request,
  url: URL,
  requirement: AuthRequirement,
  policy: AuthPolicy
): Denial | null {
  const host = req.headers.get("host");
  if (!isAllowedHost(host, policy.port)) {
    return {
      reason: "bad-host",
      detail: `Host must be one of ${allowedHosts(policy.port).join(" or ")}`,
      status: 403,
    };
  }

  if (requirement.mutating) {
    const origin = req.headers.get("origin");
    if (!isAllowedOrigin(origin, policy.port)) {
      return {
        reason: "bad-origin",
        detail: origin
          ? `Origin ${origin} may not write to this daemon`
          : `a write needs an Origin header of ${allowedOrigins(policy.port).join(" or ")}`,
        status: 403,
      };
    }
  }

  if (!requirement.bearer) return null;

  const presented = presentedToken(req, url, requirement);
  if (presented === null) {
    return {
      reason: "missing-token",
      detail: "this route needs an Authorization: Bearer <token> header",
      status: 401,
    };
  }

  if (!secretsMatch(presented, policy.token)) {
    return { reason: "bad-token", detail: "that token is not this daemon's token", status: 401 };
  }

  return null;
}

// ─── Responses ──────────────────────────────────────────────────────────────

/** Whether the caller is a browser navigating, rather than the SPA or the CLI fetching. */
function wantsHtml(req: Request): boolean {
  const accept = req.headers.get("accept") ?? "";
  return accept.includes("text/html");
}

/**
 * Status text a human can act on. Token problems name the command that fixes
 * them; the Host and Origin ones do not, because the fix is not something the
 * person reading it should be doing.
 */
export function denialMessage(denial: Denial): string {
  switch (denial.reason) {
    case "missing-token":
    case "bad-token":
      return "Run `lgtm open` to reauthenticate.";
    case "bad-host":
      return "This daemon only answers requests addressed to 127.0.0.1 or localhost.";
    case "bad-origin":
      return "This daemon only accepts writes from its own web UI.";
  }
}

/**
 * The reauthentication page. Self-contained on purpose. A daemon the browser
 * was just told it may not talk to cannot then ask it to load a stylesheet or
 * a script, so everything the page needs is inline.
 */
function reauthPage(denial: Denial): string {
  const title = denial.reason === "missing-token" ? "No token" : "Token not accepted";

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>LGTM: ${title}</title>
<style>
  :root { color-scheme: light dark; }
  body {
    font: 15px/1.6 ui-sans-serif, system-ui, -apple-system, sans-serif;
    margin: 0; min-height: 100vh;
    display: grid; place-items: center;
    background: Canvas; color: CanvasText;
  }
  main { max-width: 34rem; padding: 2rem; }
  h1 { font-size: 1.35rem; margin: 0 0 .75rem; }
  p { margin: 0 0 1rem; }
  code {
    font: 0.9em ui-monospace, SFMono-Regular, Menlo, monospace;
    padding: .15em .4em; border-radius: .3em;
    background: color-mix(in srgb, CanvasText 10%, transparent);
  }
  .detail { opacity: .7; font-size: .9em; }
</style>
</head>
<body>
<main>
  <h1>${title}</h1>
  <p>Run <code>lgtm open</code> in a terminal. It launches this UI with a fresh token and the tab picks it up automatically.</p>
  <p class="detail">${escapeHtml(denial.detail)}</p>
</main>
</body>
</html>
`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Turn a denial into a response.
 *
 * Token denials keep their 401 so the CLI can still branch on the status
 * code, but carry a body that says what to do. A browser navigating gets the
 * page; everything else gets the same words as JSON. No CORS header is set on
 * any of them, which is the point.
 */
export function denialResponse(denial: Denial, req: Request): Response {
  const headers = new Headers({
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });

  const tokenProblem = denial.reason === "missing-token" || denial.reason === "bad-token";

  if (tokenProblem) {
    // Names the scheme without a `realm`, so browsers do not raise their own
    // basic-auth dialog over a page that already explains the fix.
    headers.set("www-authenticate", "Bearer");
  }

  if (tokenProblem && wantsHtml(req)) {
    headers.set("content-type", "text/html; charset=utf-8");
    return new Response(reauthPage(denial), { status: denial.status, headers });
  }

  headers.set("content-type", "application/json; charset=utf-8");
  return new Response(
    JSON.stringify({ error: denial.reason, message: denialMessage(denial), detail: denial.detail }) + "\n",
    { status: denial.status, headers }
  );
}

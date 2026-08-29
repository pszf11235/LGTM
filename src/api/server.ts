/**
 * The daemon's HTTP server. One `Bun.serve` instance, one auth choke point,
 * and the route table from `./routes.ts` behind it.
 *
 * Two things here are load-bearing.
 *
 * **The bind address is explicit.** `Bun.serve`'s default hostname is
 * `0.0.0.0`, which would put a daemon holding a GitHub token and the only
 * write path to the Forge on every interface the machine has, reachable from
 * the coffee shop's wifi. R7.2 says loopback only, so `API_HOSTNAME` is
 * passed on every bind and asserted in the tests. Do not remove it to "let
 * the OS decide".
 *
 * **Auth happens once, here.** Every `/api/*` request goes through
 * `authorize` from `./auth.ts` with the matched route's declared
 * requirements, before its handler is called. Per-route checks are how one
 * forgotten route becomes an open daemon, and nothing about a route that
 * skips its check looks wrong in review. It just works, for everyone. So
 * there is exactly one place the check can be forgotten, and
 * server.test.ts's matrix walks `apiRoutes()` and proves it was not.
 *
 * The SPA shell at `/` is served unauthenticated through Bun's HTML import,
 * which is also what makes `build.ts` embed the bundled React app into the
 * compiled binary. It is a shell with no data in it; everything it renders
 * arrives over the authenticated API afterwards, using the token `lgtm open`
 * hands it in the URL fragment.
 */

import uiIndex from "../ui/index.html";
import { authorize, denialResponse } from "./auth";
import type { AuthPolicy } from "./auth";
import { allowedMethods, apiRoutes, matchRoute } from "./routes";
import type { ApiDeps, RouteDef } from "./routes";

export type { ApiDeps, RouteDef } from "./routes";
export { apiRoutes, matchRoute } from "./routes";

/** Loopback only. See the module comment; this is a requirement, not a default. */
export const API_HOSTNAME = "127.0.0.1";

/**
 * The bundled SPA entry. Typed off the import so no Bun internal type is
 * named here. A plain `Response` is allowed too, which is what a test that
 * only cares about the route's wiring passes instead of waiting on a React
 * build.
 */
type SpaBundle = typeof uiIndex | Response;

// ─── The handler ────────────────────────────────────────────────────────────

function plain(status: number, body: string): Response {
  return new Response(body + "\n", {
    status,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
}

function jsonError(status: number, error: string, message: string, extra?: HeadersInit): Response {
  const headers = new Headers(extra);
  headers.set("content-type", "application/json; charset=utf-8");
  headers.set("cache-control", "no-store");
  headers.set("x-content-type-options", "nosniff");
  return new Response(JSON.stringify({ error, message }) + "\n", { status, headers });
}

/**
 * Host is checked before the path is even looked up, so an unknown `/api/*`
 * path cannot be used to probe the daemon from a rebound origin. It is a
 * string comparison; running it twice (here and inside `authorize`) costs
 * nothing and keeps the ordering obvious.
 */
const HOST_ONLY: Pick<RouteDef, "bearer" | "mutating" | "queryToken"> = {
  bearer: false,
  mutating: false,
  queryToken: false,
};

/**
 * The whole API as one function, so tests can drive every route without
 * binding a socket and the daemon can mount it under `Bun.serve`.
 *
 * `deps.port` is read per request rather than captured, because
 * `startApiServer` may bind port 0 and only learn the real port afterwards,
 * and the Host and Origin checks compare against that port.
 */
export function createApiHandler(deps: ApiDeps): (req: Request) => Promise<Response> {
  const routes = apiRoutes();

  return async function handle(req: Request): Promise<Response> {
    let url: URL;
    try {
      url = new URL(req.url);
    } catch {
      return plain(400, "bad request URL");
    }

    const pathname = url.pathname;

    if (!pathname.startsWith("/api/")) {
      // `/` and the SPA's own assets are served by Bun's route table, which
      // runs before this handler. Anything else is genuinely not here.
      return plain(404, "not found");
    }

    const policy: AuthPolicy = { token: deps.token, port: deps.port };

    const hostDenial = authorize(req, url, HOST_ONLY, policy);
    if (hostDenial) return denialResponse(hostDenial, req);

    const match = matchRoute(routes, req.method, pathname);
    if (match === null) {
      return jsonError(404, "unknown-route", `${req.method} ${pathname} is not a route`);
    }
    if (match === "method-not-allowed") {
      const allow = allowedMethods(routes, pathname);
      return jsonError(405, "method-not-allowed", `${pathname} accepts ${allow.join(", ")}`, {
        allow: allow.join(", "),
      });
    }

    // The choke point. Every route, every request, one call.
    const denial = authorize(req, url, match.route, policy);
    if (denial) return denialResponse(denial, req);

    try {
      return await match.route.handler({ req, url, params: match.params, deps });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      try {
        deps.events?.emit({ type: "error", cause: `api ${match.route.name}: ${message}` });
      } catch {
        // The bus is not the request's problem.
      }
      // The message, not the stack. This reaches a browser tab.
      return jsonError(500, "handler-failed", message);
    }
  };
}

// ─── The server ─────────────────────────────────────────────────────────────

export interface ApiServerOptions extends ApiDeps {
  /**
   * The SPA shell. Defaults to the embedded `src/ui/index.html`, whose import
   * is what puts the bundled React app inside the compiled binary. Overridable
   * so a test can bind a server without dragging the front end in.
   */
  spa?: SpaBundle;
}

export interface ApiServer {
  hostname: string;
  /** The port actually bound, which is what the Host and Origin checks now use. */
  port: number;
  /** `http://127.0.0.1:<port>`, the origin the UI and `lgtm open` use. */
  url: string;
  /** The live deps object, with `port` filled in. `daemon.json` is written from this. */
  deps: ApiDeps;
  stop(): Promise<void>;
}

/**
 * Bind the API on loopback.
 *
 * Pass `port: 0` to let the OS choose one (tests do); the daemon passes the
 * port `selectPort` picked. Either way the bound port is written back into the
 * deps the handler reads, so Host and Origin are validated against the port
 * that is actually serving.
 *
 * Streaming responses keep `/api/events` open, so the idle timeout is set
 * above the SSE keepalive rather than left at Bun's default, which would drop
 * every event stream a few seconds after it went quiet.
 */
export function startApiServer(options: ApiServerOptions): ApiServer {
  const { spa, ...rest } = options;
  const deps: ApiDeps = { ...rest, startedAt: rest.startedAt ?? (rest.now ?? Date.now)() };
  const handle = createApiHandler(deps);
  const shell = spa ?? uiIndex;

  const server = Bun.serve({
    hostname: API_HOSTNAME,
    port: deps.port,
    idleTimeout: 120,
    routes: {
      // Unauthenticated on purpose. A shell with no data in it; everything it
      // shows arrives over the authenticated API afterwards.
      "/": shell,
    },
    fetch: handle,
    error(error: Error) {
      return jsonError(500, "server-error", error.message);
    },
  });

  // `Bun.serve` types this as optional because a unix-socket server has no
  // port. This one always binds TCP on loopback, so the fallback never fires.
  const boundPort = server.port ?? deps.port;
  deps.port = boundPort;

  return {
    hostname: API_HOSTNAME,
    port: boundPort,
    url: `http://${API_HOSTNAME}:${boundPort}`,
    deps,
    async stop() {
      // `true` closes live connections; without it an open `/api/events`
      // stream would keep the daemon's shutdown waiting forever.
      await server.stop(true);
    },
  };
}

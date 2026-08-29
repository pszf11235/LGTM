/**
 * The HTTP API the daemon exposes: the routes in design.md's "HTTP API"
 * table (health, status, SSE, PR list and decisions, findings, post,
 * watchlist, config), bearer auth, and the Host/Origin checks that close off
 * DNS rebinding. Wired into Bun.serve from src/daemon.
 */
export {};

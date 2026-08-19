/**
 * Embedded Webapp Server — serves the LGTM daily checker webapp.
 *
 * Started automatically when the TUI launches.
 * Stopped when the TUI exits.
 *
 * Serves webapp/index.html on a local port (default: 4040).
 * Falls back to the next available port if 4040 is taken.
 */

import fs from "fs";
import path from "path";

interface WebappServer {
  /** The URL the webapp is accessible at */
  url: string;
  /** The port the server is listening on */
  port: number;
  /** Stop the server */
  stop(): void;
}

/**
 * Start the embedded webapp server.
 *
 * Looks for webapp/index.html relative to the project root.
 * If the file doesn't exist, returns null (graceful — TUI still works).
 *
 * @param projectRoot - Path to the LGTM project root (where webapp/ lives)
 * @param preferredPort - Port to try first (default: 4040)
 * @returns Server info or null if couldn't start
 */
export async function startWebappServer(
  projectRoot: string,
  preferredPort: number = 4040
): Promise<WebappServer | null> {
  // Find the webapp index.html
  const webappDir = findWebappDir(projectRoot);
  if (!webappDir) return null;

  const indexPath = path.join(webappDir, "index.html");
  if (!fs.existsSync(indexPath)) return null;

  // Read the HTML content (single file — just keep it in memory)
  const htmlContent = fs.readFileSync(indexPath, "utf-8");

  // Try to start server on preferred port, fall back to next ports
  let server: ReturnType<typeof Bun.serve> | null = null;
  let port = preferredPort;

  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      server = Bun.serve({
        port,
        fetch(req) {
          const url = new URL(req.url);

          // Serve index.html for root and any HTML request
          if (url.pathname === "/" || url.pathname === "/index.html") {
            return new Response(htmlContent, {
              headers: { "Content-Type": "text/html; charset=utf-8" },
            });
          }

          // Serve webapp README
          if (url.pathname === "/README.md") {
            const readmePath = path.join(webappDir, "README.md");
            if (fs.existsSync(readmePath)) {
              return new Response(fs.readFileSync(readmePath, "utf-8"), {
                headers: { "Content-Type": "text/markdown; charset=utf-8" },
              });
            }
          }

          // Health check endpoint
          if (url.pathname === "/health") {
            return new Response(JSON.stringify({ status: "ok", tui: true }), {
              headers: { "Content-Type": "application/json" },
            });
          }

          // 404 for everything else
          return new Response("Not Found", { status: 404 });
        },
      });

      // Success — server started
      break;
    } catch (err) {
      // Port in use — try next
      port++;
      server = null;
    }
  }

  if (!server) return null;

  return {
    url: `http://localhost:${port}`,
    port,
    stop() {
      try {
        server?.stop();
      } catch {
        // Already stopped
      }
    },
  };
}

/**
 * Find the webapp directory.
 * Checks multiple possible locations relative to project root.
 */
function findWebappDir(projectRoot: string): string | null {
  const candidates = [
    path.join(projectRoot, "webapp"),
    path.join(projectRoot, "..", "webapp"), // if running from packages/core
    path.resolve(projectRoot, "../../webapp"), // if running deep in packages
  ];

  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, "index.html"))) {
      return dir;
    }
  }

  // Also check relative to this file's location (for binary builds)
  const thisDir = path.dirname(new URL(import.meta.url).pathname);
  const fromHere = path.resolve(thisDir, "../../../../webapp");
  if (fs.existsSync(path.join(fromHere, "index.html"))) {
    return fromHere;
  }

  return null;
}

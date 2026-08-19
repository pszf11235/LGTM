/**
 * PKCE OAuth Flow — Authorization Code + PKCE for CLI apps.
 *
 * Used by: Claude, GitLab, Bitbucket, Linear, Slack, ClickUp, Google
 *
 * Flow:
 * 1. Generate PKCE code verifier + challenge
 * 2. Open browser to authorize URL with challenge
 * 3. Start local HTTP server to receive callback
 * 4. User authorizes in browser → redirected to localhost
 * 5. Extract auth code from callback
 * 6. Exchange code + verifier for access token
 */

import { execSync } from "child_process";
import http from "http";
import crypto from "crypto";

interface PKCEConfig {
  authorizeUrl: string;
  tokenUrl: string;
  clientId: string;
  scopes: string;
  callbackPort?: number;    // default: 8742
  extraParams?: Record<string, string>;
}

interface PKCEResult {
  accessToken: string;
  refreshToken?: string;
  expiresIn?: number;
  tokenType?: string;
  scope?: string;
}

/**
 * Run the PKCE OAuth flow.
 * Opens browser, starts localhost callback, waits for authorization.
 */
export async function loginWithPKCE(config: PKCEConfig): Promise<PKCEResult | null> {
  const port = config.callbackPort ?? 8742;
  const redirectUri = `http://localhost:${port}/callback`;

  // Generate PKCE pair
  const codeVerifier = generateCodeVerifier();
  const codeChallenge = generateCodeChallenge(codeVerifier);

  // Build authorize URL
  const params = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: config.scopes,
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
    state: crypto.randomUUID(),
    ...(config.extraParams ?? {}),
  });

  const authorizeFullUrl = `${config.authorizeUrl}?${params.toString()}`;

  // Start local server BEFORE opening browser
  const codePromise = startCallbackServer(port);

  // Open browser
  console.log(`\n  Opening browser for authorization...\n`);
  console.log(`  If browser doesn't open, visit:`);
  console.log(`  ${authorizeFullUrl.slice(0, 80)}...\n`);
  openBrowser(authorizeFullUrl);

  console.log(`  Waiting for authorization...`);

  // Wait for callback (timeout: 5 minutes)
  const code = await Promise.race([
    codePromise,
    new Promise<null>((resolve) => setTimeout(() => resolve(null), 300000)),
  ]);

  if (!code) {
    console.log(`\n  ✗ Timed out waiting for authorization.`);
    return null;
  }

  // Exchange code for token
  console.log(`\n  Exchanging code for token...`);

  try {
    const tokenRes = await fetch(config.tokenUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: config.clientId,
        code,
        redirect_uri: redirectUri,
        code_verifier: codeVerifier,
      }).toString(),
    });

    if (!tokenRes.ok) {
      const err = await tokenRes.text();
      console.log(`\n  ✗ Token exchange failed: ${err.slice(0, 100)}`);
      return null;
    }

    const data = await tokenRes.json() as Record<string, any>;
    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresIn: data.expires_in,
      tokenType: data.token_type,
      scope: data.scope,
    };
  } catch (err) {
    console.log(`\n  ✗ Error: ${(err as Error).message}`);
    return null;
  }
}

/**
 * Start a local HTTP server to receive the OAuth callback.
 * Returns the authorization code from the callback URL.
 */
function startCallbackServer(port: number): Promise<string | null> {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url ?? "/", `http://localhost:${port}`);

      if (url.pathname === "/callback") {
        const code = url.searchParams.get("code");
        const error = url.searchParams.get("error");

        // Send response to browser
        res.writeHead(200, { "Content-Type": "text/html" });
        if (code) {
          res.end(`
            <html><body style="font-family:sans-serif;text-align:center;padding:50px">
              <h1>👍 Authorization successful!</h1>
              <p>You can close this tab and return to the terminal.</p>
            </body></html>
          `);
        } else {
          res.end(`
            <html><body style="font-family:sans-serif;text-align:center;padding:50px">
              <h1>✗ Authorization failed</h1>
              <p>Error: ${error ?? "unknown"}</p>
            </body></html>
          `);
        }

        // Close server and resolve
        server.close();
        resolve(code ?? null);
      } else {
        res.writeHead(404);
        res.end();
      }
    });

    server.listen(port, () => {
      // Server ready
    });

    // Timeout: auto-close after 5 minutes
    setTimeout(() => {
      server.close();
      resolve(null);
    }, 300000);
  });
}

// ─── PKCE Helpers ────────────────────────────────────────────────────────

function generateCodeVerifier(): string {
  return crypto.randomBytes(32).toString("base64url");
}

function generateCodeChallenge(verifier: string): string {
  return crypto.createHash("sha256").update(verifier).digest("base64url");
}

function openBrowser(url: string): void {
  try {
    const platform = process.platform;
    if (platform === "darwin") {
      execSync(`open "${url}"`, { stdio: "ignore" });
    } else if (platform === "linux") {
      execSync(`xdg-open "${url}" 2>/dev/null || sensible-browser "${url}" 2>/dev/null`, { stdio: "ignore" });
    } else if (platform === "win32") {
      execSync(`start "" "${url}"`, { stdio: "ignore" });
    }
  } catch {
    // User will manually navigate
  }
}

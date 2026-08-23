/**
 * GitHub OAuth Device Flow — browser-based login for CLI apps.
 *
 * Flow:
 * 1. Request a device code from GitHub
 * 2. Show the user a URL + one-time code
 * 3. Open their browser to the authorization page
 * 4. Poll GitHub until the user authorizes
 * 5. Receive an access token
 *
 * This is the same flow `gh auth login` uses.
 *
 * Note: requires a GitHub OAuth App with Device Flow enabled.
 * For development/personal use, we use GitHub's built-in device flow
 * with a client_id. For production, register your own OAuth App.
 */

import { execSync } from "child_process";

/** GitHub's device flow endpoints */
const DEVICE_CODE_URL = "https://github.com/login/device/code";
const TOKEN_URL = "https://github.com/login/oauth/access_token";

/** Default scopes for LGTM — read/write PRs, read repos */
const DEFAULT_SCOPES = "repo read:user";

interface DeviceCodeResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  expires_in: number;
  interval: number;
}

interface TokenResponse {
  access_token?: string;
  token_type?: string;
  scope?: string;
  error?: string;
  error_description?: string;
}

export interface OAuthConfig {
  /** GitHub OAuth App client ID. Required for device flow. */
  clientId: string;
  /** Scopes to request (default: repo read:user) */
  scopes?: string;
}

/**
 * Perform GitHub OAuth Device Flow login.
 *
 * Opens the user's browser, they authorize, we get a token.
 * Returns the access token on success, null on failure/timeout.
 */
export async function loginWithGitHub(config: OAuthConfig): Promise<string | null> {
  const scopes = config.scopes ?? DEFAULT_SCOPES;

  // Step 1: Request device code
  const deviceCode = await requestDeviceCode(config.clientId, scopes);
  if (!deviceCode) return null;

  // Step 2: Show user the code + open browser
  console.log(`\n  Open this URL in your browser:\n`);
  console.log(`    ${deviceCode.verification_uri}\n`);
  console.log(`  And enter this code:\n`);
  console.log(`    📋 ${deviceCode.user_code}\n`);

  // Try to open browser automatically
  openBrowser(deviceCode.verification_uri);

  console.log(`  Waiting for authorization...`);

  // Step 3: Poll for token
  const token = await pollForToken(
    config.clientId,
    deviceCode.device_code,
    deviceCode.interval,
    deviceCode.expires_in
  );

  return token;
}

/**
 * Request a device code from GitHub.
 */
async function requestDeviceCode(
  clientId: string,
  scopes: string
): Promise<DeviceCodeResponse | null> {
  try {
    const res = await fetch(DEVICE_CODE_URL, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        client_id: clientId,
        scope: scopes,
      }),
    });

    if (!res.ok) return null;
    return await res.json() as DeviceCodeResponse;
  } catch {
    return null;
  }
}

/**
 * Poll GitHub for the access token (user is authorizing in browser).
 */
async function pollForToken(
  clientId: string,
  deviceCode: string,
  interval: number,
  expiresIn: number
): Promise<string | null> {
  const deadline = Date.now() + expiresIn * 1000;
  const pollInterval = Math.max(interval, 5) * 1000; // GitHub requires minimum 5s

  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, pollInterval));

    try {
      const res = await fetch(TOKEN_URL, {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          client_id: clientId,
          device_code: deviceCode,
          grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        }),
      });

      const data = await res.json() as TokenResponse;

      if (data.access_token) {
        return data.access_token;
      }

      if (data.error === "authorization_pending") {
        // User hasn't authorized yet — keep polling
        process.stdout.write(".");
        continue;
      }

      if (data.error === "slow_down") {
        // We're polling too fast — increase interval
        await new Promise((r) => setTimeout(r, 5000));
        continue;
      }

      if (data.error === "expired_token") {
        console.log("\n  ✗ Authorization expired. Please try again.");
        return null;
      }

      if (data.error === "access_denied") {
        console.log("\n  ✗ Authorization denied by user.");
        return null;
      }

      // Unknown error
      console.log(`\n  ✗ Error: ${data.error_description ?? data.error}`);
      return null;
    } catch {
      // Network error — retry
      continue;
    }
  }

  console.log("\n  ✗ Timed out waiting for authorization.");
  return null;
}

/**
 * Try to open the user's browser.
 */
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
    // Can't open browser — user will manually navigate
  }
}

/**
 * Save a token securely.
 * For now: writes to ~/.lgtm-credentials (chmod 600).
 * Future: use system keychain (keytar, macOS Keychain, etc.)
 */
export function saveToken(provider: string, token: string): void {
  const fs = require("fs");
  const path = require("path");
  const os = require("os");

  const credFile = path.join(os.homedir(), ".lgtm-credentials");

  // Load existing
  let creds: Record<string, string> = {};
  try {
    const raw = fs.readFileSync(credFile, "utf-8");
    creds = JSON.parse(raw);
  } catch { /* new file */ }

  creds[provider] = token;

  fs.writeFileSync(credFile, JSON.stringify(creds, null, 2), { mode: 0o600 });
}

/**
 * Load a saved token.
 */
export function loadToken(provider: string): string | null {
  const fs = require("fs");
  const path = require("path");
  const os = require("os");

  const credFile = path.join(os.homedir(), ".lgtm-credentials");

  try {
    const raw = fs.readFileSync(credFile, "utf-8");
    const creds = JSON.parse(raw);
    return creds[provider] ?? null;
  } catch {
    return null;
  }
}

// ─── Token Resolution ───────────────────────────────────────────────────────

/**
 * Resolve a GitHub token without requiring any OAuth app registration.
 *
 * Order:
 *   1. GITHUB_TOKEN / GH_TOKEN — an explicitly set variable wins, which is also
 *      what `gh` itself does, and is how CI supplies a scoped token
 *   2. `gh auth token` — zero setup for anyone with the GitHub CLI logged in
 *   3. ~/.lgtm-credentials
 *
 * Returns null when nothing resolves. Callers should surface
 * `describeMissingGitHubToken()` in that case.
 */
export function resolveGitHubToken(): string | null {
  // 1. Environment. Deliberate beats ambient.
  const envToken = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
  if (envToken) return envToken;

  // 2. gh CLI. stderr must be discarded: without it, a missing or broken `gh`
  //    prints its own error into the middle of our output.
  try {
    const proc = Bun.spawnSync(["gh", "auth", "token"], {
      stdio: ["ignore", "pipe", "ignore"],
    });
    if (proc.exitCode === 0) {
      const token = proc.stdout.toString().trim();
      if (token) return token;
    }
  } catch {
    // gh not installed
  }

  // 3. Saved credentials
  return loadToken("github");
}

/**
 * Human-readable guidance for when no token could be resolved.
 */
export function describeMissingGitHubToken(): string[] {
  return [
    "No GitHub token found. Any one of these works:",
    "",
    "  export GITHUB_TOKEN=ghp_...        takes precedence over everything else",
    "  gh auth login                      easiest, nothing else to configure",
    "  lgtm auth login github             saves to ~/.lgtm-credentials",
  ];
}

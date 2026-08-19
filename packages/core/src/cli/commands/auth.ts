/**
 * `lgtm auth` — manage authentication for all connected services.
 *
 * Commands:
 *   lgtm auth login [service]   — browser-based OAuth or API key setup
 *   lgtm auth status            — show auth status for all services
 *   lgtm auth logout [service]  — remove saved credentials
 *   lgtm auth list              — show all supported services
 */

import type { Command } from "commander";
import chalk from "chalk";
import { loginWithGitHub, saveToken, loadToken } from "../../auth/github-oauth.js";
import { AUTH_PROVIDERS, getProviderIds, getProvider, type AuthProvider } from "../../auth/providers.js";

export function registerAuthCommands(program: Command) {
  const auth = program
    .command("auth")
    .description("Manage authentication for connected services");

  auth
    .command("login [service]")
    .description("Login to a service (github, claude, openai, gitlab, slack, clickup, google)")
    .option("--scopes <scopes>", "Override OAuth scopes")
    .option("--key <apiKey>", "Set API key directly (for api-key flow providers)")
    .action(async (service: string | undefined, opts: { scopes?: string; key?: string }) => {
      if (!service) {
        console.log(chalk.bold("\n👍 Available services:\n"));
        for (const id of getProviderIds()) {
          const p = AUTH_PROVIDERS[id];
          const token = loadToken(id) ?? (process.env[p.envVar] ? "(env)" : null);
          const status = token ? chalk.green("●") : chalk.gray("○");
          console.log(`  ${status} ${chalk.bold(id.padEnd(12))} — ${p.purpose}`);
        }
        console.log(chalk.gray(`\n  Login: ${chalk.cyan("lgtm auth login <service>")}\n`));
        return;
      }

      const provider = getProvider(service);
      if (!provider) {
        console.log(chalk.red(`\n  Unknown service: ${service}`));
        console.log(chalk.gray(`  Available: ${getProviderIds().join(", ")}\n`));
        return;
      }

      console.log(chalk.bold(`\n👍 Login: ${provider.name}\n`));
      console.log(chalk.gray(`  Purpose: ${provider.purpose}\n`));

      // Handle different flow types
      switch (provider.flow) {
        case "device":
          await handleDeviceFlow(provider, opts.scopes);
          break;

        case "pkce":
          await handlePKCEFlow(provider, opts.scopes);
          break;

        case "api-key":
          await handleApiKeyFlow(provider, opts.key);
          break;
      }
    });

  auth
    .command("status")
    .description("Show authentication status for all services")
    .action(async () => {
      console.log(chalk.bold("\n👍 Auth Status\n"));

      for (const id of getProviderIds()) {
        const provider = AUTH_PROVIDERS[id];
        const savedToken = loadToken(id);
        const envToken = process.env[provider.envVar];
        const token = savedToken ?? envToken;

        if (token) {
          const source = savedToken ? "OAuth" : "env";
          let userInfo = "";

          // Quick validation (with timeout)
          if (provider.validateUrl) {
            try {
              const headers: Record<string, string> = { "User-Agent": "lgtm-cli" };

              if (id === "claude") {
                headers["x-api-key"] = token;
                headers["anthropic-version"] = "2023-06-01";
              } else {
                headers["Authorization"] = `Bearer ${token}`;
              }

              const res = await fetch(provider.validateUrl, {
                headers,
                signal: AbortSignal.timeout(5000),
              });

              if (res.ok && provider.extractUser) {
                const data = await res.json();
                userInfo = ` — ${provider.extractUser(data)}`;
              } else if (!res.ok) {
                console.log(`  ${chalk.yellow("●")} ${provider.name}: token invalid (${source})`);
                continue;
              }
            } catch {
              userInfo = " (can't verify)";
            }
          }

          console.log(`  ${chalk.green("●")} ${provider.name}${userInfo} (${source})`);
        } else {
          console.log(`  ${chalk.gray("○")} ${provider.name}`);
        }
      }

      console.log(chalk.gray(`\n  Login: ${chalk.cyan("lgtm auth login <service>")}\n`));
    });

  auth
    .command("logout [service]")
    .description("Remove saved credentials for a service")
    .action((service: string = "github") => {
      const fs = require("fs");
      const path = require("path");
      const os = require("os");

      const credFile = path.join(os.homedir(), ".lgtm-credentials");
      try {
        const raw = fs.readFileSync(credFile, "utf-8");
        const creds = JSON.parse(raw);
        if (creds[service]) {
          delete creds[service];
          fs.writeFileSync(credFile, JSON.stringify(creds, null, 2), { mode: 0o600 });
          console.log(chalk.gray(`\n  ○ Logged out of ${service}\n`));
        } else {
          console.log(chalk.gray(`\n  No credentials found for ${service}\n`));
        }
      } catch {
        console.log(chalk.gray(`\n  No credentials file found\n`));
      }
    });
}

// ─── Flow Handlers ──────────────────────────────────────────────────────

async function handleDeviceFlow(provider: AuthProvider, scopeOverride?: string) {
  const clientId = process.env[provider.oauth!.clientIdEnvVar];
  if (!clientId) {
    console.log(chalk.yellow("  ⚠ No OAuth App configured for this service."));
    console.log(chalk.gray(`  Set ${provider.oauth!.clientIdEnvVar} env var.`));
    console.log(chalk.gray(`  Or use ${provider.envVar} env var for API key auth.\n`));
    offerApiKeyFallback(provider);
    return;
  }

  const token = await loginWithGitHub({
    clientId,
    scopes: scopeOverride ?? provider.oauth!.defaultScopes,
  });

  if (token) {
    saveToken(provider.id, token);
    console.log(chalk.green(`\n  ✓ Login successful! Token saved.\n`));
    await showUserInfo(provider, token);
  } else {
    console.log(chalk.red(`\n  ✗ Login failed.\n`));
    offerApiKeyFallback(provider);
  }
}

async function handlePKCEFlow(provider: AuthProvider, scopeOverride?: string) {
  const clientId = process.env[provider.oauth!.clientIdEnvVar];
  if (!clientId) {
    console.log(chalk.yellow("  ⚠ OAuth not configured for this service (needs client ID)."));
    console.log(chalk.gray(`  Set ${provider.oauth!.clientIdEnvVar} to enable browser login.`));
    console.log();
    offerApiKeyFallback(provider);
    return;
  }

  // Use PKCE flow with localhost callback
  const { loginWithPKCE } = await import("../../auth/pkce-flow.js");

  const result = await loginWithPKCE({
    authorizeUrl: provider.oauth!.authorizeUrl,
    tokenUrl: provider.oauth!.tokenUrl,
    clientId,
    scopes: scopeOverride ?? provider.oauth!.defaultScopes,
  });

  if (result) {
    saveToken(provider.id, result.accessToken);
    console.log(chalk.green(`\n  ✓ Login successful! Token saved.\n`));
    await showUserInfo(provider, result.accessToken);
  } else {
    console.log(chalk.red(`\n  ✗ Login failed.\n`));
    offerApiKeyFallback(provider);
  }
}

async function handleApiKeyFlow(provider: AuthProvider, keyFromFlag?: string) {
  if (keyFromFlag) {
    saveToken(provider.id, keyFromFlag);
    console.log(chalk.green(`\n  ✓ API key saved!\n`));
    await showUserInfo(provider, keyFromFlag);
    return;
  }

  offerApiKeyFallback(provider);
}

function offerApiKeyFallback(provider: AuthProvider) {
  console.log(`  Get your API key from:`);
  console.log(chalk.cyan(`    ${provider.keyUrl}\n`));
  console.log(`  Then either:`);
  console.log(chalk.gray(`    • Set env var: export ${provider.envVar}=your-key`));
  console.log(chalk.gray(`    • Or save directly: ${chalk.cyan(`lgtm auth login ${provider.id} --key your-key`)}`));
  console.log();
}

async function showUserInfo(provider: AuthProvider, token: string) {
  if (!provider.validateUrl || !provider.extractUser) return;

  try {
    const headers: Record<string, string> = { "User-Agent": "lgtm-cli" };
    if (provider.id === "claude") {
      headers["x-api-key"] = token;
      headers["anthropic-version"] = "2023-06-01";
    } else {
      headers["Authorization"] = `Bearer ${token}`;
    }

    const res = await fetch(provider.validateUrl, {
      headers,
      signal: AbortSignal.timeout(5000),
    });
    if (res.ok) {
      const data = await res.json();
      console.log(chalk.gray(`  Logged in as: ${provider.extractUser(data)}`));
    }
  } catch { /* non-critical */ }
}

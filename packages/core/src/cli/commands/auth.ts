/**
 * `lgtm auth` — manage authentication for connected services.
 *
 * Commands:
 *   lgtm auth login github   — browser-based GitHub OAuth login
 *   lgtm auth status         — show auth status for all services
 *   lgtm auth logout github  — remove saved credentials
 */

import type { Command } from "commander";
import chalk from "chalk";
import { loginWithGitHub, saveToken, loadToken } from "../../auth/github-oauth.js";

/**
 * Default OAuth App client ID.
 *
 * NOTE: For production use, register your own OAuth App at:
 * https://github.com/settings/applications/new
 * Enable "Device Flow" in the app settings.
 *
 * This placeholder will need to be replaced with a real client_id.
 */
const GITHUB_CLIENT_ID = process.env.LGTM_GITHUB_CLIENT_ID ?? "YOUR_CLIENT_ID_HERE";

export function registerAuthCommands(program: Command) {
  const auth = program
    .command("auth")
    .description("Manage authentication for connected services");

  auth
    .command("login [service]")
    .description("Login to a service (default: github)")
    .option("--scopes <scopes>", "OAuth scopes to request", "repo read:user")
    .action(async (service: string = "github", opts: { scopes: string }) => {
      if (service !== "github") {
        console.log(chalk.gray(`\n  Only GitHub supported currently. More coming soon.\n`));
        return;
      }

      if (GITHUB_CLIENT_ID === "YOUR_CLIENT_ID_HERE") {
        console.log(chalk.yellow("\n  ⚠ No OAuth App configured."));
        console.log(chalk.gray("  Set LGTM_GITHUB_CLIENT_ID env var with your GitHub OAuth App client ID."));
        console.log(chalk.gray("  Or use GITHUB_TOKEN env var for personal access token auth.\n"));
        console.log(chalk.gray("  Create an OAuth App: https://github.com/settings/applications/new"));
        console.log(chalk.gray("  Enable 'Device Flow' in the app settings.\n"));
        return;
      }

      console.log(chalk.bold("\n👍 GitHub Login\n"));

      const token = await loginWithGitHub({
        clientId: GITHUB_CLIENT_ID,
        scopes: opts.scopes,
      });

      if (token) {
        saveToken("github", token);
        console.log(chalk.green("\n  ✓ Login successful! Token saved to ~/.lgtm-credentials\n"));

        // Verify by fetching user info
        try {
          const res = await fetch("https://api.github.com/user", {
            headers: { Authorization: `Bearer ${token}`, "User-Agent": "lgtm-cli" },
          });
          if (res.ok) {
            const user = await res.json() as { login: string };
            console.log(chalk.gray(`  Logged in as: @${user.login}\n`));
          }
        } catch { /* non-critical */ }
      } else {
        console.log(chalk.red("\n  ✗ Login failed. Try again or use GITHUB_TOKEN env var.\n"));
      }
    });

  auth
    .command("status")
    .description("Show authentication status")
    .action(async () => {
      console.log(chalk.bold("\n👍 Auth Status\n"));

      // Check GitHub
      const ghToken = loadToken("github") ?? process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
      if (ghToken) {
        try {
          const res = await fetch("https://api.github.com/user", {
            headers: { Authorization: `Bearer ${ghToken}`, "User-Agent": "lgtm-cli" },
            signal: AbortSignal.timeout(5000),
          });
          if (res.ok) {
            const user = await res.json() as { login: string };
            const source = loadToken("github") ? "OAuth" : "env var";
            console.log(`  ${chalk.green("●")} GitHub: @${user.login} (${source})`);
          } else {
            console.log(`  ${chalk.red("●")} GitHub: token invalid (${res.status})`);
          }
        } catch {
          console.log(`  ${chalk.yellow("●")} GitHub: token present but can't verify (network issue)`);
        }
      } else {
        console.log(`  ${chalk.gray("○")} GitHub: not authenticated`);
        console.log(chalk.gray(`    Login: ${chalk.cyan("lgtm auth login github")}`));
        console.log(chalk.gray(`    Or set: GITHUB_TOKEN env var`));
      }

      console.log();
    });

  auth
    .command("logout [service]")
    .description("Remove saved credentials")
    .action((service: string = "github") => {
      const fs = require("fs");
      const path = require("path");
      const os = require("os");

      const credFile = path.join(os.homedir(), ".lgtm-credentials");
      try {
        const raw = fs.readFileSync(credFile, "utf-8");
        const creds = JSON.parse(raw);
        delete creds[service];
        fs.writeFileSync(credFile, JSON.stringify(creds, null, 2), { mode: 0o600 });
        console.log(chalk.gray(`\n  ○ Logged out of ${service}\n`));
      } catch {
        console.log(chalk.gray(`\n  No credentials found for ${service}\n`));
      }
    });
}

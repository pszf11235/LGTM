/**
 * `lgtm ai` — AI connection management and testing.
 *
 * Commands:
 *   lgtm ai test     — test the configured AI connection
 *   lgtm ai status   — show current AI config and availability
 */

import type { Command } from "commander";
import chalk from "chalk";
import type { LGTMContext } from "../../plugin.js";
import { createLLMProvider, type LLMConfig } from "../../llm/provider.js";

export function registerAICommands(program: Command, ctx: LGTMContext) {
  const ai = program
    .command("ai")
    .description("AI connection management and testing");

  ai
    .command("status")
    .description("Show current AI configuration and availability")
    .action(async () => {
      console.log(chalk.bold("\n👍 AI Configuration\n"));

      const aiConfig = ctx.config.ai;

      if (!aiConfig.enabled) {
        console.log(`  Status:   ${chalk.gray("disabled")}`);
        console.log(chalk.gray(`\n  Enable with: ${chalk.cyan("lgtm config --edit")} or set in .lgtmrc.yaml\n`));
        return;
      }

      console.log(`  Status:   ${chalk.green("enabled")}`);
      console.log(`  Provider: ${chalk.cyan(aiConfig.provider ?? "not set")}`);
      if (aiConfig.model) console.log(`  Model:    ${chalk.cyan(aiConfig.model)}`);
      if (aiConfig.baseUrl) console.log(`  Base URL: ${chalk.cyan(aiConfig.baseUrl)}`);

      // Check API key presence
      const keyName = getEnvKeyName(aiConfig.provider);
      const hasKey = keyName ? !!process.env[keyName] : aiConfig.provider === "ollama";
      console.log(`  API Key:  ${hasKey ? chalk.green("found") : chalk.red("missing")}${keyName ? chalk.gray(` (${keyName})`) : ""}`);

      // Quick availability check
      console.log(chalk.gray("\n  Checking connection..."));

      // Auto-start Ollama if needed
      if (aiConfig.provider === "ollama") {
        const running = await ensureOllamaRunning();
        if (!running) {
          console.log(`  Connection: ${chalk.red("✗ unreachable")}\n`);
          return;
        }
        console.log(`  Connection: ${chalk.green("✓ reachable")}`);
      } else {
        const llm = createLLMProvider(aiConfig as LLMConfig);
        const available = await llm.isAvailable();
        if (available) {
          console.log(`  Connection: ${chalk.green("✓ reachable")}`);
        } else {
          console.log(`  Connection: ${chalk.red("✗ unreachable")}`);
          printTroubleshooting(aiConfig.provider);
        }
      }
      console.log();
    });

  ai
    .command("test")
    .description("Test the AI connection with a sample prompt")
    .action(async () => {
      const aiConfig = ctx.config.ai;

      if (!aiConfig.enabled) {
        console.log(chalk.red("\n  AI is disabled. Enable it first:\n"));
        console.log(chalk.gray(`  ${chalk.cyan("lgtm config --edit")} → select an AI provider\n`));
        return;
      }

      console.log(chalk.bold("\n👍 Testing AI Connection\n"));
      console.log(`  Provider: ${chalk.cyan(aiConfig.provider ?? "unknown")}`);
      console.log(`  Model:    ${chalk.cyan(aiConfig.model ?? "default")}`);

      const llm = createLLMProvider(aiConfig as LLMConfig);

      // Step 1: Availability check (auto-start Ollama if needed)
      console.log(chalk.gray("\n  1. Checking availability..."));
      if (aiConfig.provider === "ollama") {
        const running = await ensureOllamaRunning();
        if (!running) return;
      } else {
        const available = await llm.isAvailable();
        if (!available) {
          console.log(`     ${chalk.red("✗ Provider not reachable")}`);
          printTroubleshooting(aiConfig.provider);
          return;
        }
      }
      console.log(`     ${chalk.green("✓ Provider reachable")}`);

      // Step 2: Send a test prompt
      console.log(chalk.gray("  2. Sending test prompt..."));
      try {
        const start = Date.now();
        const response = await llm.complete(
          "Respond with exactly: 'lgtm connection successful' and nothing else.",
          { maxTokens: 20, temperature: 0 }
        );
        const elapsed = Date.now() - start;

        console.log(`     ${chalk.green("✓ Response received")} ${chalk.gray(`(${elapsed}ms)`)}`);
        console.log(`     ${chalk.cyan(`"${response.trim().slice(0, 80)}"`)}`);
      } catch (err) {
        console.log(`     ${chalk.red("✗ Request failed")}`);
        console.log(`     ${chalk.red((err as Error).message)}`);
        printTroubleshooting(aiConfig.provider);
        return;
      }

      // Step 3: Test structured output (JSON)
      console.log(chalk.gray("  3. Testing structured output..."));
      try {
        const response = await llm.complete(
          'Respond with valid JSON only: {"status": "ok", "provider": "your-name"}',
          { maxTokens: 50, temperature: 0 }
        );
        const jsonMatch = response.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          JSON.parse(jsonMatch[0]);
          console.log(`     ${chalk.green("✓ JSON output works")}`);
        } else {
          console.log(`     ${chalk.yellow("⚠ JSON output not clean (rule enforcement may be flaky)")}`);
        }
      } catch {
        console.log(`     ${chalk.yellow("⚠ JSON parsing failed (rule enforcement may need retries)")}`);
      }

      console.log(chalk.bold(`\n  ${chalk.green("✓")} AI connection working!\n`));
    });

  ai
    .command("model [name]")
    .description("Show or set the AI model")
    .action(async (name?: string) => {
      if (!name) {
        // Show current model + suggestions
        const aiConfig = ctx.config.ai;
        const provider = aiConfig.provider ?? "not set";
        const model = aiConfig.model ?? "(default)";
        console.log(chalk.bold("\n👍 AI Model\n"));
        console.log(`  Provider: ${chalk.cyan(provider)}`);
        console.log(`  Model:    ${chalk.cyan(model)}`);

        // Show suggestions
        const suggestions: Record<string, string[]> = {
          openai: ["gpt-4o-mini", "gpt-4o", "o3-mini"],
          anthropic: ["claude-sonnet-4-20250514", "claude-opus-4-20250514"],
          ollama: ["llama3.2", "codellama", "qwen2.5-coder", "deepseek-coder-v2"],
        };
        const providerSuggestions = suggestions[provider];
        if (providerSuggestions) {
          console.log(chalk.gray(`\n  Available: ${providerSuggestions.join(", ")}`));
          console.log(chalk.gray(`  Set with: ${chalk.cyan("lgtm ai model <name>")}`));
        }
        console.log();
        return;
      }

      // Set model in profile
      try {
        const { loadBootstrap, resolveLgtmDir } = await import("../../config/loader.js");
        const { findGitRoot } = await import("../../store/paths.js");
        const { createOKFStore } = await import("../../store/okf.js");

        const repoRoot = findGitRoot();
        const bootstrap = loadBootstrap();
        const lgtmDir = resolveLgtmDir(bootstrap, repoRoot);
        const store = createOKFStore(lgtmDir);

        const doc = await store.read("profile.md");
        if (!doc) {
          console.log(chalk.red("\n  No profile found. Run `lgtm init` first.\n"));
          return;
        }

        // Update AI model in frontmatter
        const data = { ...doc.data };
        if (typeof data.ai === "object" && data.ai !== null) {
          (data.ai as Record<string, unknown>).model = name;
        } else {
          data.ai = { enabled: true, model: name };
        }

        await store.write("profile.md", data, doc.content);
        console.log(chalk.green(`\n  ✓ Model set to: ${chalk.cyan(name)}\n`));
      } catch (err) {
        console.log(chalk.red(`\n  Failed: ${(err as Error).message}\n`));
      }
    });

  // ─── lgtm ai discover ──────────────────────────────────────────────────
  ai
    .command("discover")
    .description("Run AI provider autodiscovery with debug output")
    .action(async () => {
      const { discoverAIProviders } = await import("../../onboarding/detect-ai.js");

      console.log(chalk.bold("\n👍 AI Provider Discovery (debug mode)\n"));

      const result = await discoverAIProviders((msg) => {
        console.log(chalk.gray(`  ${msg}`));
      });

      console.log();
      console.log(chalk.bold("  ── Results ──"));
      console.log(`  ${result.summary}`);
      console.log();

      if (result.providers.length > 0) {
        console.log(chalk.bold("  Providers found:"));
        for (const p of result.providers) {
          const avail = p.available ? chalk.green("✓ available") : chalk.yellow("✗ not reachable");
          console.log(`    ${chalk.cyan(p.name)} — ${p.detectedVia} [${avail}]`);
          if (p.keyHint) console.log(chalk.gray(`      Key: ${p.keyHint}`));
          console.log(chalk.gray(`      Model: ${p.defaultModel}`));
          if (p.detail) console.log(chalk.gray(`      Detail: ${p.detail}`));
        }
      } else {
        console.log(chalk.yellow("  No providers found."));
      }

      if (result.toolsDetected.length > 0) {
        console.log(chalk.gray(`\n  Tools detected: ${result.toolsDetected.join(", ")}`));
      }

      console.log(chalk.gray(`\n  To share this output for debugging, run:`));
      console.log(chalk.cyan(`    lgtm ai discover 2>&1 | pbcopy`));
      console.log(chalk.gray(`  (or pipe to a file: lgtm ai discover > ai-debug.txt)\n`));
    });
}

function getEnvKeyName(provider?: string): string | null {
  switch (provider) {
    case "openai": return "OPENAI_API_KEY";
    case "anthropic": return "ANTHROPIC_API_KEY";
    case "ollama": return null; // no key needed
    default: return null;
  }
}

/**
 * Check if Ollama is running, offer to start it in background if not.
 * Returns true if Ollama is available after this call.
 */
async function ensureOllamaRunning(): Promise<boolean> {
  try {
    const res = await fetch("http://localhost:11434/api/tags", {
      signal: AbortSignal.timeout(2000),
    });
    if (res.ok) return true;
  } catch {
    // Not running
  }

  console.log(chalk.yellow("  Ollama is not running."));

  // Check if ollama binary exists
  const { execSync } = await import("child_process");
  try {
    execSync("which ollama", { stdio: "ignore" });
  } catch {
    console.log(chalk.red("  Ollama not found. Install from: https://ollama.com"));
    return false;
  }

  // Start ollama serve in background
  console.log(chalk.gray("  Starting ollama serve in background..."));
  try {
    const { spawn } = await import("child_process");
    const child = spawn("ollama", ["serve"], {
      detached: true,
      stdio: "ignore",
    });
    child.unref();

    // Wait for it to come up (max 5 seconds)
    for (let i = 0; i < 10; i++) {
      await new Promise((r) => setTimeout(r, 500));
      try {
        const res = await fetch("http://localhost:11434/api/tags", {
          signal: AbortSignal.timeout(1000),
        });
        if (res.ok) {
          console.log(chalk.green("  ✓ Ollama started (PID " + child.pid + ")"));
          return true;
        }
      } catch {
        // Still starting...
      }
    }

    console.log(chalk.yellow("  Ollama started but not responding yet. Try again in a moment."));
    return false;
  } catch (err) {
    console.log(chalk.red(`  Failed to start Ollama: ${(err as Error).message}`));
    return false;
  }
}

function printTroubleshooting(provider?: string) {
  console.log(chalk.gray("\n  Troubleshooting:"));
  switch (provider) {
    case "openai":
      console.log(chalk.gray("    • Set OPENAI_API_KEY environment variable"));
      console.log(chalk.gray("    • Check: https://platform.openai.com/api-keys"));
      break;
    case "anthropic":
      console.log(chalk.gray("    • Set ANTHROPIC_API_KEY environment variable"));
      console.log(chalk.gray("    • Check: https://console.anthropic.com/"));
      break;
    case "ollama":
      console.log(chalk.gray("    • Ensure Ollama is running: ollama serve"));
      console.log(chalk.gray("    • Check: curl http://localhost:11434/api/tags"));
      console.log(chalk.gray("    • Pull a model: ollama pull llama3.2"));
      break;
    default:
      console.log(chalk.gray("    • Check your AI provider configuration"));
  }
}

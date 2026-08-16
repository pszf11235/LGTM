/**
 * `yak ai` — AI connection management and testing.
 *
 * Commands:
 *   yak ai test     — test the configured AI connection
 *   yak ai status   — show current AI config and availability
 */

import type { Command } from "commander";
import chalk from "chalk";
import type { YakContext } from "../../plugin.js";
import { createLLMProvider, type LLMConfig } from "../../llm/provider.js";

export function registerAICommands(program: Command, ctx: YakContext) {
  const ai = program
    .command("ai")
    .description("AI connection management and testing");

  ai
    .command("status")
    .description("Show current AI configuration and availability")
    .action(async () => {
      console.log(chalk.bold("\n🦬 AI Configuration\n"));

      const aiConfig = ctx.config.ai;

      if (!aiConfig.enabled) {
        console.log(`  Status:   ${chalk.gray("disabled")}`);
        console.log(chalk.gray(`\n  Enable with: ${chalk.cyan("yak config --edit")} or set in .yakrc.yaml\n`));
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
      const llm = createLLMProvider(aiConfig as LLMConfig);
      const available = await llm.isAvailable();

      if (available) {
        console.log(`  Connection: ${chalk.green("✓ reachable")}`);
      } else {
        console.log(`  Connection: ${chalk.red("✗ unreachable")}`);
        printTroubleshooting(aiConfig.provider);
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
        console.log(chalk.gray(`  ${chalk.cyan("yak config --edit")} → select an AI provider\n`));
        return;
      }

      console.log(chalk.bold("\n🦬 Testing AI Connection\n"));
      console.log(`  Provider: ${chalk.cyan(aiConfig.provider ?? "unknown")}`);
      console.log(`  Model:    ${chalk.cyan(aiConfig.model ?? "default")}`);

      const llm = createLLMProvider(aiConfig as LLMConfig);

      // Step 1: Availability check
      console.log(chalk.gray("\n  1. Checking availability..."));
      const available = await llm.isAvailable();
      if (!available) {
        console.log(`     ${chalk.red("✗ Provider not reachable")}`);
        printTroubleshooting(aiConfig.provider);
        return;
      }
      console.log(`     ${chalk.green("✓ Provider reachable")}`);

      // Step 2: Send a test prompt
      console.log(chalk.gray("  2. Sending test prompt..."));
      try {
        const start = Date.now();
        const response = await llm.complete(
          "Respond with exactly: 'yak connection successful' and nothing else.",
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
}

function getEnvKeyName(provider?: string): string | null {
  switch (provider) {
    case "openai": return "OPENAI_API_KEY";
    case "anthropic": return "ANTHROPIC_API_KEY";
    case "ollama": return null; // no key needed
    default: return null;
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

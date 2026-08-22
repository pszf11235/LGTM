/**
 * Onboarding flow runner.
 *
 * Runs the onboarding questions sequentially via readline.
 * Each question is skippable with 's'. Entire flow skippable with Ctrl+C.
 *
 * Supports resuming: if a partial profile exists, only asks unanswered questions.
 */

import readline from "readline";
import chalk from "chalk";
import type { ProjectProfile } from "../plugin.js";
import type { BootstrapConfig } from "../config/loader.js";
import {
  ONBOARDING_QUESTIONS,
  type OnboardingQuestion,
} from "./questions.js";
import { detectTechStack } from "./detect.js";
import { saveBootstrap, getDefaultFarmPath, loadBootstrap, resolveLgtmDir, loadProfile } from "../config/loader.js";
import { ensureLgtmDirs } from "../store/paths.js";
import { createOKFStore } from "../store/okf.js";
import { findGitRoot } from "../store/paths.js";

/**
 * Check if onboarding is complete (all required questions answered).
 */
export function isOnboardingComplete(lgtmDir: string): boolean {
  const profile = loadProfile(lgtmDir);
  if (!profile) return false;

  // A complete profile has all required fields set to non-default placeholder values
  return !!(
    profile.goal &&
    profile.feedbackStyle &&
    profile.teamSize
  );
}

/**
 * Run the onboarding flow.
 * If a partial profile exists, resumes from where it left off.
 */
export async function runOnboarding(): Promise<{
  profile: ProjectProfile;
  bootstrap: BootstrapConfig;
}> {
  const repoRoot = findGitRoot();
  const projectName = repoRoot.split("/").pop() ?? "unknown";

  // Load existing answers (if resuming)
  const existingBootstrap = loadBootstrap();
  const existingLgtmDir = resolveLgtmDir(existingBootstrap, repoRoot);
  const existingProfile = loadProfile(existingLgtmDir);

  // Map existing profile back to answers (for resume)
  const answers: Record<string, string> = {};
  if (existingProfile) {
    if (existingBootstrap.storageMode) answers.storageMode = existingBootstrap.storageMode;
    if (existingProfile.goal) answers.goal = existingProfile.goal;
    if (existingProfile.qualityReferences?.length > 0) {
      answers.qualityReferences = existingProfile.qualityReferences.join(", ");
    }
    if (existingProfile.feedbackStyle) answers.feedbackStyle = existingProfile.feedbackStyle;
    if (existingProfile.teamSize) answers.teamSize = existingProfile.teamSize;
    if (existingProfile.ai?.provider) answers.aiProvider = existingProfile.ai.provider;
    else if (existingProfile.ai?.enabled === false) answers.aiProvider = "none";
    if (existingProfile.ai?.model) answers.aiModel = existingProfile.ai.model;
  }

  // Figure out which questions still need answers
  const unansweredQuestions = ONBOARDING_QUESTIONS.filter((q) => !(q.id in answers));

  if (unansweredQuestions.length === 0) {
    // All questions already answered — re-run all for editing
    console.log(
      `\n${chalk.bold("👍 LGTM Setup")} — updating your configuration.\n`
    );
    console.log(
      chalk.gray("  Press [s] to keep current value. Ctrl+C to exit.\n")
    );
  } else if (existingProfile) {
    // Partial — resuming
    console.log(
      `\n${chalk.bold("👍 LGTM Setup")} — continuing where you left off.\n`
    );
    console.log(
      chalk.gray("  Press [s] to skip any question. Ctrl+C to exit.\n")
    );
  } else {
    // Fresh start
    console.log(
      `\n${chalk.bold("👍 Welcome to LGTM!")} Let's set up your workspace.\n`
    );
    console.log(
      chalk.gray("  Press [s] to skip any question. Ctrl+C to exit.\n")
    );
  }

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  // ── Start AI autodiscovery in background (runs while user answers early questions) ──
  const aiDiscoveryPromise = (async () => {
    try {
      const { discoverAIProviders } = await import("./detect-ai.js");
      return await discoverAIProviders();
    } catch {
      return null;
    }
  })();

  // Helper: build and save current state
  const saveProgress = async () => {
    const bootstrap: BootstrapConfig = {
      storageMode: (answers.storageMode as "farm" | "repo") ?? "repo",
    };
    saveBootstrap(bootstrap);

    const lgtmDir = resolveLgtmDir(bootstrap, repoRoot);
    ensureLgtmDirs(lgtmDir);

    const detectedStack = detectTechStack(repoRoot);

    const aiEnabled = answers.aiProvider !== "none" && !!answers.aiProvider;
    const profile: ProjectProfile = {
      project: projectName,
      goal: answers.goal ?? "",
      qualityReferences: answers.qualityReferences
        ? answers.qualityReferences.split(",").map((s) => s.trim()).filter(Boolean)
        : [],
      feedbackStyle: (answers.feedbackStyle as ProjectProfile["feedbackStyle"]) ?? "",
      techStack: detectedStack,
      teamSize: (answers.teamSize as ProjectProfile["teamSize"]) ?? "",
      ai: {
        enabled: aiEnabled,
        ...(aiEnabled && answers.aiProvider ? { provider: answers.aiProvider as "openai" | "anthropic" | "ollama" } : {}),
        ...(aiEnabled && answers.aiModel ? { model: answers.aiModel } : {}),
      },
      createdAt: existingProfile?.createdAt ?? new Date().toISOString(),
    };

    const store = createOKFStore(lgtmDir);
    const cleanData = JSON.parse(JSON.stringify({ type: "lgtm/profile", ...profile }));
    await store.write("profile.md", cleanData, generateProfileBody(profile));

    return { profile, bootstrap, lgtmDir, detectedStack };
  };

  // Determine which questions to ask
  const questionsToAsk = unansweredQuestions.length > 0 ? unansweredQuestions : ONBOARDING_QUESTIONS;

  try {
    for (const q of questionsToAsk) {
      // ── Before AI questions: show autodiscovery results ──────────────
      if (q.id === "aiProvider") {
        const discovery = await aiDiscoveryPromise;

        if (discovery?.hasAI && discovery.recommended) {
          const rec = discovery.recommended;
          console.log(`  ${chalk.green("✓")} AI auto-detected: ${chalk.cyan(rec.name)} ${chalk.gray(`(${rec.detectedVia})`)}`);
          if (rec.detail) {
            console.log(chalk.gray(`    ${rec.detail}`));
          }
          if (discovery.providers.filter((p) => p.available).length > 1) {
            const others = discovery.providers
              .filter((p) => p.id !== rec.id && p.available)
              .map((p) => p.name);
            if (others.length > 0) {
              console.log(chalk.gray(`    Also available: ${others.join(", ")}`));
            }
          }
          console.log();

          // Auto-configure: set the discovered provider as the answer and skip the question
          answers.aiProvider = rec.id;
          answers.aiModel = rec.defaultModel;
          if (rec.apiKey) {
            // Key already discovered — save it
            try {
              const { saveToken } = await import("../auth/github-oauth.js");
              const credId = rec.id === "anthropic" ? "claude" : rec.id;
              saveToken(credId, rec.apiKey);
            } catch { /* non-critical */ }
          }
          await saveProgress();
          continue; // Skip the aiProvider select question
        } else if (discovery && discovery.providers.length > 0) {
          // Found providers but none available — show info but still ask
          const names = discovery.providers.map((p) => `${p.name} (${p.detail ?? "not reachable"})`);
          console.log(chalk.yellow(`  ⚠ Found AI tools but none reachable:`));
          for (const name of names) {
            console.log(chalk.gray(`    • ${name}`));
          }
          console.log();
        }
        // If no discovery results, fall through to ask the question normally
      }

      // ── Skip aiModel/aiApiKey if autodiscovery already configured them ──
      if (q.id === "aiModel" && answers.aiProvider && answers.aiModel && answers.aiProvider !== "none") {
        console.log(`  ${chalk.green("✓")} Model: ${chalk.cyan(answers.aiModel)}`);
        continue;
      }
      if (q.id === "aiApiKey" && answers.aiProvider && answers.aiProvider !== "none") {
        // Check if we already have a key from discovery
        const discovery = await aiDiscoveryPromise;
        const found = discovery?.providers.find((p) => p.id === answers.aiProvider && p.apiKey);
        if (found) {
          console.log(`  ${chalk.green("✓")} API key: ${chalk.cyan(found.keyHint ?? "configured")} ${chalk.gray(`(${found.detectedVia})`)}`);
          continue;
        }
      }

      // Show current value if re-running (editing mode)
      const currentValue = answers[q.id];
      const answer = await askQuestion(rl, q, currentValue, answers);
      if (answer !== null) {
        answers[q.id] = answer;
      }
      // Save after every answer
      await saveProgress();
    }

    // Final save and summary
    const { profile, bootstrap, lgtmDir, detectedStack } = await saveProgress();

    if (detectedStack.length > 0) {
      console.log(
        `\n  ${chalk.green("✓")} Detected tech stack: ${chalk.cyan(detectedStack.join(", "))}`
      );
    }

    // Show AI status in summary (no separate discovery block needed — it ran before questions)
    if (profile.ai.enabled) {
      console.log(
        `  ${chalk.green("✓")} AI: ${chalk.cyan(profile.ai.provider ?? "enabled")}${profile.ai.model ? ` (${profile.ai.model})` : ""}`
      );
    } else {
      console.log(chalk.gray(`  ○ AI disabled. Enable later: ${chalk.cyan("lgtm config --edit")}`));
    }

    if (bootstrap.storageMode === "farm") {
      console.log(
        chalk.gray(
          `  LGTM-farm location: ${chalk.cyan(getDefaultFarmPath())}`
        )
      );
    }

    console.log(
      `\n  ${chalk.green("✓")} Profile saved to ${chalk.cyan(lgtmDir + "/profile.md")}`
    );
    console.log(
      `  ${chalk.green("✓")} Storage mode: ${chalk.cyan(bootstrap.storageMode === "farm" ? "lgtm-farm" : "per-repo (.lgtm/)")}`
    );
    console.log(`\n${chalk.bold("👍 You're all set!")} Run ${chalk.cyan("lgtm --help")} to get started.\n`);

    return { profile, bootstrap };
  } finally {
    rl.close();
  }
}

/**
 * Ask a single onboarding question.
 * Uses arrow keys for select, readline for text.
 * Returns null if skipped.
 */
async function askQuestion(
  rl: readline.Interface,
  q: OnboardingQuestion,
  currentValue?: string,
  answers?: Record<string, string>
): Promise<string | null> {
  if (q.type === "select" && q.options) {
    // If editing, pre-select the current value
    const currentIdx = currentValue
      ? q.options.findIndex((o) => o.value === currentValue)
      : -1;
    const startIdx = currentIdx >= 0 ? currentIdx : 0;

    const result = await selectWithArrows(
      q.question,
      q.options,
      startIdx,
      currentValue
    );
    return result;
  }

  if (q.type === "text") {
    // Skip model question if AI is disabled
    if (q.id === "aiModel" && (!answers?.aiProvider || answers.aiProvider === "none")) {
      return null;
    }

    // Skip API key if provider is none or ollama (no key needed)
    if (q.id === "aiApiKey") {
      if (!answers?.aiProvider || answers.aiProvider === "none" || answers.aiProvider === "ollama") {
        return null;
      }
      // Check if key already exists (env var or saved)
      const envVar = answers.aiProvider === "openai" ? "OPENAI_API_KEY" : "ANTHROPIC_API_KEY";
      if (process.env[envVar]) {
        console.log(chalk.green(`  ✓ ${envVar} found in environment — skipping.`));
        return null;
      }
      try {
        const { loadToken } = await import("../auth/github-oauth.js");
        const existing = loadToken(answers.aiProvider) || loadToken(answers.aiProvider === "anthropic" ? "claude" : answers.aiProvider);
        if (existing) {
          console.log(chalk.green(`  ✓ Key already saved in ~/.lgtm-credentials — skipping.`));
          return null;
        }
      } catch { /* continue to prompt */ }

      // Show where to get the key
      const keyUrls: Record<string, string> = {
        openai: "https://platform.openai.com/api-keys",
        anthropic: "https://console.anthropic.com/settings/keys",
      };
      const url = keyUrls[answers.aiProvider];
      if (url) {
        console.log(chalk.gray(`\n  Get your key from: ${chalk.cyan(url)}`));
      }
    }

    // Show model suggestions based on provider
    let hint = currentValue ? chalk.gray(` (current: ${currentValue})`) : "";
    if (q.id === "aiModel" && !currentValue) {
      const suggestions = getModelSuggestions(answers?.aiProvider);
      if (suggestions) {
        hint = chalk.gray(`\n  Suggestions: ${suggestions}`);
      }
    }

    const answer = await prompt(rl, `  ${chalk.bold(q.question)}${hint}\n  > `);
    if (answer.toLowerCase() === "s" || answer === "") {
      return currentValue ?? null;
    }

    // If it's an API key, save it to credentials file
    if (q.id === "aiApiKey" && answer && answers?.aiProvider) {
      try {
        const { saveToken } = await import("../auth/github-oauth.js");
        const credId = answers.aiProvider === "anthropic" ? "claude" : answers.aiProvider;
        saveToken(credId, answer);
        console.log(chalk.green(`  ✓ API key saved securely to ~/.lgtm-credentials`));
      } catch (err) {
        console.log(chalk.yellow(`  ⚠ Could not save key: ${(err as Error).message}`));
      }
      return answer; // Store in answers but won't be written to profile.md
    }

    return answer;
  }

  return currentValue ?? null;
}

/**
 * Interactive arrow-key selector.
 * ↑/↓ to navigate, Enter to confirm, s to skip.
 */
function selectWithArrows(
  question: string,
  options: { value: string; label: string; description?: string }[],
  defaultIdx: number,
  currentValue?: string
): Promise<string | null> {
  return new Promise((resolve) => {
    let selectedIdx = defaultIdx;

    // Number of lines the options + help text occupy.
    // Each option = 1 line, help text = 1 line.
    // drawOptions writes each with explicit \n, so after drawing
    // the cursor sits on the line AFTER the last \n.
    const totalDrawnLines = options.length + 1;

    const drawOptions = () => {
      options.forEach((opt, i) => {
        const marker = i === selectedIdx ? chalk.green("❯") : " ";
        const label =
          i === selectedIdx ? chalk.cyan(opt.label) : opt.label;
        const desc = opt.description ? chalk.gray(` — ${opt.description}`) : "";
        const current = opt.value === currentValue ? chalk.gray(" (current)") : "";
        process.stdout.write(`  ${marker} ${label}${desc}${current}\n`);
      });
      process.stdout.write(
        chalk.gray("  [↑/↓] navigate  [enter] select  [s] skip")
      );
    };

    const redraw = () => {
      // Move cursor to start of line, then up to first option line, clear to end of screen
      process.stdout.write(`\r\x1b[${totalDrawnLines - 1}A`);
      process.stdout.write(`\x1b[0J`);
      drawOptions();
    };

    // Initial draw: question + blank line + options
    console.log(`  ${chalk.bold(question)}\n`);
    drawOptions();

    // Switch stdin to raw mode for keypress detection
    const stdin = process.stdin;
    const wasRaw = stdin.isRaw;
    try {
      stdin.setRawMode(true);
    } catch {
      // If setRawMode fails (e.g., piped stdin), fall back
      resolve(options[defaultIdx].value);
      return;
    }
    stdin.resume();
    stdin.setEncoding("utf-8");

    const cleanup = () => {
      stdin.setRawMode(wasRaw ?? false);
      stdin.removeListener("data", onData);
      // Don't pause stdin — readline needs it to remain active
      stdin.resume();
    };

    const onData = (key: string) => {
      // Ctrl+C
      if (key === "\x03") {
        cleanup();
        console.log();
        process.exit(0);
      }

      // Enter
      if (key === "\r" || key === "\n") {
        cleanup();
        // Clear the options area and print confirmation
        process.stdout.write(`\r\x1b[${totalDrawnLines - 1}A`);
        process.stdout.write(`\x1b[0J`);
        console.log(`  ${chalk.green("✓")} ${options[selectedIdx].label}\n`);
        resolve(options[selectedIdx].value);
        return;
      }

      // Skip
      if (key === "s" || key === "S") {
        cleanup();
        process.stdout.write(`\r\x1b[${totalDrawnLines - 1}A`);
        process.stdout.write(`\x1b[0J`);
        if (currentValue) {
          const currentLabel = options.find((o) => o.value === currentValue)?.label ?? currentValue;
          console.log(`  ${chalk.gray("kept:")} ${currentLabel}\n`);
        } else {
          console.log(chalk.gray("  (skipped)\n"));
        }
        resolve(currentValue ?? null);
        return;
      }

      // Arrow up
      if (key === "\x1b[A" || key === "k") {
        selectedIdx = (selectedIdx - 1 + options.length) % options.length;
        redraw();
        return;
      }

      // Arrow down
      if (key === "\x1b[B" || key === "j") {
        selectedIdx = (selectedIdx + 1) % options.length;
        redraw();
        return;
      }
    };

    stdin.on("data", onData);
  });
}

/**
 * Prompt the user for text input.
 */
function prompt(rl: readline.Interface, question: string): Promise<string> {
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      resolve(answer.trim());
    });
  });
}

/**
 * Get model suggestions based on provider.
 */
function getModelSuggestions(provider?: string): string | null {
  switch (provider) {
    case "openai":
      return "gpt-4o-mini (fast/cheap), gpt-4o (thorough), o3-mini (reasoning)";
    case "anthropic":
      return "claude-sonnet-4-20250514 (balanced), claude-opus-4-20250514 (deep)";
    case "ollama":
      return "llama3.2 (general), codellama (code), qwen2.5-coder (code)";
    default:
      return null;
  }
}

/**
 * Generate the markdown body for the profile file.
 */
function generateProfileBody(profile: ProjectProfile): string {
  const lines = [
    `# Project Profile: ${profile.project}`,
    "",
  ];

  if (profile.goal) {
    lines.push("## Goals");
    lines.push(`${profile.goal.charAt(0).toUpperCase() + profile.goal.slice(1)} project.`);
    lines.push("");
  }

  if (profile.qualityReferences.length > 0) {
    lines.push("## Quality References");
    lines.push("Aspiring toward the code quality of:");
    for (const ref of profile.qualityReferences) {
      lines.push(`- ${ref}`);
    }
    lines.push("");
  }

  if (profile.techStack.length > 0) {
    lines.push("## Tech Stack");
    lines.push(`Detected: ${profile.techStack.join(", ")}`);
    lines.push("");
  }

  lines.push("## Preferences");
  if (profile.feedbackStyle) lines.push(`- Feedback style: ${profile.feedbackStyle}`);
  if (profile.teamSize) lines.push(`- Team size: ${profile.teamSize}`);
  lines.push(
    `- AI: ${profile.ai.enabled ? `${profile.ai.provider}` : "disabled"}`
  );
  lines.push("");

  return lines.join("\n");
}

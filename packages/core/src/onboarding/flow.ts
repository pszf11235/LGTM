/**
 * Onboarding flow runner.
 *
 * Runs the onboarding questions sequentially via readline (simple, no TUI deps).
 * Each question is skippable with 's'. Entire flow skippable with Ctrl+C.
 *
 * In a future version, this could use Ink for a prettier TUI experience.
 * For now, readline keeps it simple and dep-free.
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
import { saveBootstrap, getDefaultFarmPath } from "../config/loader.js";
import { ensureYakDirs } from "../store/paths.js";
import { createOKFStore } from "../store/okf.js";
import { resolveYakDir } from "../config/loader.js";
import { findGitRoot } from "../store/paths.js";

/**
 * Run the full onboarding flow.
 * Returns the created profile and bootstrap config.
 */
export async function runOnboarding(): Promise<{
  profile: ProjectProfile;
  bootstrap: BootstrapConfig;
}> {
  const repoRoot = findGitRoot();
  const projectName = repoRoot.split("/").pop() ?? "unknown";

  console.log(
    `\n${chalk.bold("🦬 Welcome to Yak!")} Let's set up your workspace.\n`
  );
  console.log(
    chalk.gray("  Press [s] to skip any question. Ctrl+C to exit.\n")
  );

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const answers: Record<string, string> = {};

  // Helper: save whatever we have so far (partial or complete)
  const saveProgress = async () => {
    const bootstrap: BootstrapConfig = {
      storageMode: (answers.storageMode as "farm" | "repo") ?? "repo",
    };
    saveBootstrap(bootstrap);

    const yakDir = resolveYakDir(bootstrap, repoRoot);
    ensureYakDirs(yakDir);

    const detectedStack = detectTechStack(repoRoot);

    const profile: ProjectProfile = {
      project: projectName,
      goal: answers.goal ?? "production",
      qualityReferences: answers.qualityReferences
        ? answers.qualityReferences.split(",").map((s) => s.trim()).filter(Boolean)
        : [],
      feedbackStyle:
        (answers.feedbackStyle as ProjectProfile["feedbackStyle"]) ?? "direct",
      techStack: detectedStack,
      teamSize: (answers.teamSize as ProjectProfile["teamSize"]) ?? "solo",
      ai: {
        enabled: answers.aiProvider !== "none" && !!answers.aiProvider,
        provider:
          answers.aiProvider !== "none"
            ? (answers.aiProvider as "openai" | "anthropic" | "ollama")
            : undefined,
      },
      createdAt: new Date().toISOString(),
    };

    const store = createOKFStore(yakDir);
    await store.write(
      "profile.md",
      { type: "yak/profile", ...profile },
      generateProfileBody(profile)
    );

    return { profile, bootstrap, yakDir, detectedStack };
  };

  try {
    for (const q of ONBOARDING_QUESTIONS) {
      const answer = await askQuestion(rl, q);
      if (answer !== null) {
        answers[q.id] = answer;
      }
      // Save after every answer (partial config survives Ctrl+C / crash)
      await saveProgress();
    }

    // Final save and summary
    const { profile, bootstrap, yakDir, detectedStack } = await saveProgress();

    if (detectedStack.length > 0) {
      console.log(
        `\n  ${chalk.green("✓")} Detected tech stack: ${chalk.cyan(detectedStack.join(", "))}`
      );
    }

    if (bootstrap.storageMode === "farm") {
      console.log(
        chalk.gray(
          `  Yak-farm location: ${chalk.cyan(getDefaultFarmPath())}`
        )
      );
    }

    console.log(
      `\n  ${chalk.green("✓")} Profile saved to ${chalk.cyan(yakDir + "/profile.md")}`
    );
    console.log(
      `  ${chalk.green("✓")} Storage mode: ${chalk.cyan(bootstrap.storageMode === "farm" ? "yak-farm" : "per-repo (.yak/)")}`
    );
    console.log(`\n${chalk.bold("🦬 You're all set!")} Run ${chalk.cyan("yak --help")} to get started.\n`);

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
  q: OnboardingQuestion
): Promise<string | null> {
  if (q.type === "select" && q.options) {
    const defaultIdx = q.options.findIndex((o) => o.value === q.default);
    const result = await selectWithArrows(
      q.question,
      q.options,
      defaultIdx >= 0 ? defaultIdx : 0
    );
    return result;
  }

  if (q.type === "text") {
    const answer = await prompt(rl, `  ${chalk.bold(q.question)}\n  > `);
    if (answer.toLowerCase() === "s" || answer === "") return q.default ?? null;
    return answer;
  }

  return q.default ?? null;
}

/**
 * Interactive arrow-key selector.
 * ↑/↓ to navigate, Enter to confirm, s to skip.
 */
function selectWithArrows(
  question: string,
  options: { value: string; label: string; description?: string }[],
  defaultIdx: number
): Promise<string | null> {
  return new Promise((resolve) => {
    let selectedIdx = defaultIdx;
    let firstRender = true;

    // Number of lines the options + help text occupy
    const optionLines = options.length + 1; // options + help line

    const drawOptions = () => {
      options.forEach((opt, i) => {
        const marker = i === selectedIdx ? chalk.green("❯") : " ";
        const label =
          i === selectedIdx ? chalk.cyan(opt.label) : opt.label;
        const desc = opt.description ? chalk.gray(` — ${opt.description}`) : "";
        process.stdout.write(`  ${marker} ${label}${desc}\n`);
      });
      process.stdout.write(
        chalk.gray("  [↑/↓] navigate  [enter] select  [s] skip\n")
      );
    };

    const redraw = () => {
      // Move cursor up to beginning of options area and clear
      process.stdout.write(`\x1b[${optionLines}A`);
      process.stdout.write(`\x1b[0J`);
      drawOptions();
    };

    // Initial draw: question + blank line + options
    console.log(`  ${chalk.bold(question)}\n`);
    drawOptions();
    firstRender = false;

    // Switch stdin to raw mode for keypress detection
    const stdin = process.stdin;
    const wasRaw = stdin.isRaw;
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf-8");

    const cleanup = () => {
      stdin.setRawMode(wasRaw ?? false);
      stdin.removeListener("data", onData);
      stdin.pause();
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
        process.stdout.write(`\x1b[${optionLines}A`);
        process.stdout.write(`\x1b[0J`);
        console.log(`  ${chalk.green("✓")} ${options[selectedIdx].label}\n`);
        resolve(options[selectedIdx].value);
        return;
      }

      // Skip
      if (key === "s" || key === "S") {
        cleanup();
        process.stdout.write(`\x1b[${optionLines}A`);
        process.stdout.write(`\x1b[0J`);
        console.log(chalk.gray("  (skipped)\n"));
        resolve(null);
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
 * Generate the markdown body for the profile file.
 */
function generateProfileBody(profile: ProjectProfile): string {
  const lines = [
    `# Project Profile: ${profile.project}`,
    "",
    "## Goals",
    `${profile.goal.charAt(0).toUpperCase() + profile.goal.slice(1)} project.`,
    "",
  ];

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
  lines.push(`- Feedback style: ${profile.feedbackStyle}`);
  lines.push(`- Team size: ${profile.teamSize}`);
  lines.push(
    `- AI: ${profile.ai.enabled ? `${profile.ai.provider}` : "disabled"}`
  );
  lines.push("");

  return lines.join("\n");
}

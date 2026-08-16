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

  try {
    for (const q of ONBOARDING_QUESTIONS) {
      const answer = await askQuestion(rl, q);
      if (answer !== null) {
        answers[q.id] = answer;
      }
    }

    // Auto-detect tech stack
    const detectedStack = detectTechStack(repoRoot);
    if (detectedStack.length > 0) {
      console.log(
        `\n  ${chalk.green("✓")} Detected tech stack: ${chalk.cyan(detectedStack.join(", "))}`
      );
    }

    // Build bootstrap config
    const bootstrap: BootstrapConfig = {
      storageMode: (answers.storageMode as "farm" | "repo") ?? "repo",
    };

    if (bootstrap.storageMode === "farm") {
      console.log(
        chalk.gray(
          `\n  Yak-farm location: ${chalk.cyan(getDefaultFarmPath())}`
        )
      );
    }

    // Save bootstrap
    saveBootstrap(bootstrap);

    // Resolve yak dir and create structure
    const yakDir = resolveYakDir(bootstrap, repoRoot);
    ensureYakDirs(yakDir);

    // Build profile
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

    // Save profile as OKF
    const store = createOKFStore(yakDir);
    await store.write(
      "profile.md",
      {
        type: "yak/profile",
        ...profile,
      },
      generateProfileBody(profile)
    );

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
 * Ask a single onboarding question via readline.
 * Returns null if skipped.
 */
async function askQuestion(
  rl: readline.Interface,
  q: OnboardingQuestion
): Promise<string | null> {
  if (q.type === "select" && q.options) {
    console.log(`  ${chalk.bold(q.question)}\n`);
    q.options.forEach((opt, i) => {
      const marker = opt.value === q.default ? chalk.green("●") : chalk.gray("○");
      const desc = opt.description ? chalk.gray(` — ${opt.description}`) : "";
      console.log(`    ${marker} ${i + 1}) ${opt.label}${desc}`);
    });
    console.log();

    const answer = await prompt(
      rl,
      `  Choice [1-${q.options.length}] (s=skip, default=${q.default}): `
    );

    if (answer.toLowerCase() === "s") return null;
    if (answer === "") return q.default ?? null;

    const idx = parseInt(answer, 10) - 1;
    if (idx >= 0 && idx < q.options.length) {
      return q.options[idx].value;
    }
    return q.default ?? null;
  }

  if (q.type === "text") {
    const answer = await prompt(rl, `  ${chalk.bold(q.question)}\n  > `);
    if (answer.toLowerCase() === "s" || answer === "") return q.default ?? null;
    return answer;
  }

  return q.default ?? null;
}

/**
 * Prompt the user for input.
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

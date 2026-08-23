/**
 * Store initialisation.
 *
 * There is no onboarding questionnaire. Storage is always the central store at
 * ~/.lgtm-farm/, the review prompt ships as a default agent config, and the AI
 * provider is detected when a review actually runs.
 *
 * `lgtm init` calls initStore(). Bare `lgtm` calls it silently when the store
 * is missing, then opens the TUI.
 */

import fs from "fs";
import path from "path";
import chalk from "chalk";
import type { ProjectProfile } from "../plugin.js";
import { resolveLgtmDir, loadBootstrap, loadProfile } from "../config/loader.js";
import { ensureLgtmDirs, getAgentsDir } from "../store/paths.js";
import { createOKFStore } from "../store/okf.js";

/** The default review prompt, written to agents/reviewer.md on first init. */
const DEFAULT_AGENT = `---
name: reviewer
provider: auto
model: null
severity: high
timeout: 300
commentDelay: [20, 90]
enabled: true
prompt: |
  Focus on high and critical issues only.
  Use my tone and voice: concise, actionable, no fluff, dev to dev.
  Never use em dashes or semicolons.
  Do not spell out the severity in the comment body.
  Instead of "High / borderline critical - these events won't make it to GA4."
  write "These events probably won't make it to GA4 (this is an important one)..."
  Cite the exact file and line for every finding.
---

# Review Agent

Edit the \`prompt\` field above to change how reviews are written.

\`provider: auto\` picks the first available CLI in priority order:
kiro-cli, claude-cli, codex-cli, openrouter, ollama.
Set it explicitly to pin one.
`;

export interface InitResult {
  lgtmDir: string;
  created: boolean;
  agentCreated: boolean;
}

/**
 * Create the central store if it does not exist. Idempotent.
 */
export async function initStore(): Promise<InitResult> {
  const bootstrap = loadBootstrap();
  const lgtmDir = resolveLgtmDir(bootstrap);
  const existed = fs.existsSync(lgtmDir);

  ensureLgtmDirs(lgtmDir);

  // Default agent config
  const agentPath = path.join(getAgentsDir(lgtmDir), "reviewer.md");
  const agentCreated = !fs.existsSync(agentPath);
  if (agentCreated) {
    fs.writeFileSync(agentPath, DEFAULT_AGENT, "utf-8");
  }

  // Minimal profile
  if (!loadProfile(lgtmDir)) {
    const profile: ProjectProfile = {
      ai: { enabled: false },
      createdAt: new Date().toISOString(),
    };
    const store = createOKFStore(lgtmDir);
    await store.write(
      "profile.md",
      JSON.parse(JSON.stringify({ type: "lgtm/profile", ...profile })),
      [
        "# LGTM Store",
        "",
        "Central store for review findings across every watched repository.",
        "",
        "- `agents/` — review prompts, edit these to change review style",
        "- `reviews/<owner>-<repo>-<pr>/` — findings per PR, per round",
        "- `rules/` — regex and prompt-context rules",
        "- `watch.md` — watched repositories",
        "",
      ].join("\n")
    );
  }

  return { lgtmDir, created: !existed, agentCreated };
}

/**
 * True when the central store exists.
 */
export function storeExists(): boolean {
  return fs.existsSync(resolveLgtmDir(loadBootstrap()));
}

/**
 * `lgtm init` — create the store and report what happened.
 */
export async function runInit(): Promise<InitResult> {
  const result = await initStore();

  if (result.created) {
    console.log(`\n${chalk.bold("👍 LGTM store created")}\n`);
    console.log(`  ${chalk.cyan(result.lgtmDir)}`);
    console.log(chalk.gray(`    agents/     review prompts`));
    console.log(chalk.gray(`    reviews/    findings per PR`));
    console.log(chalk.gray(`    rules/      regex and prompt-context rules`));
  } else {
    console.log(`\n${chalk.bold("👍 LGTM store")}\n`);
    console.log(`  ${chalk.cyan(result.lgtmDir)} ${chalk.gray("(already initialised)")}`);
  }

  if (result.agentCreated) {
    console.log(
      `\n  ${chalk.green("✓")} Wrote default review prompt to ${chalk.cyan("agents/reviewer.md")}`
    );
  }

  console.log(chalk.gray("\n  Next:"));
  console.log(chalk.gray(`    ${chalk.cyan("lgtm discover --ingest")}  find local repos to watch`));
  console.log(chalk.gray(`    ${chalk.cyan("lgtm watch")}              poll for PRs and review them`));
  console.log(chalk.gray(`    ${chalk.cyan("lgtm ai discover")}        check which review providers are available`));
  console.log();

  return result;
}

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
import chalk from "chalk";
import type { ProjectProfile } from "../plugin.js";
import { resolveLgtmDir, loadBootstrap, loadProfile } from "../config/loader.js";
import { ensureLgtmDirs } from "../store/paths.js";
import { ensureDefaultAgent } from "../store/agents.js";
import { createOKFStore } from "../store/okf.js";

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

  // The review prompt is store data, not code, so it ships as a file the user
  // can edit rather than a string baked into the reviewer.
  const agentCreated = ensureDefaultAgent(lgtmDir);

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

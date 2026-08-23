/**
 * `lgtm review pr <ref>` — review one pull request now, on demand.
 *
 * The manual route into the same pipeline the watcher uses, for a PR in a repo
 * nobody is watching. It writes findings to the store and posts nothing, which
 * is the same guarantee the watcher makes. `lgtm review post` is still the only
 * thing that talks to GitHub.
 *
 * This replaces the old `lgtm review auto`, which posted a live review directly.
 * That contradicted the human gate the rest of the tool is built around, and it
 * was one typo away from publishing unreviewed comments on someone's PR.
 */

import type { Command } from "commander";
import type { LGTMContext } from "@lgtm/core/plugin.js";
import chalk from "chalk";
import { parsePrRef, formatRef } from "../domain/pr-ref.js";
import { checkPR, type OpenPR, type CycleDeps } from "../domain/watch-cycle.js";
import { loadMeta, pendingFindings, type PRRef } from "../domain/review-store.js";
import type { WatchedRepo } from "@lgtm/core/registry/watch-list.js";

interface Options {
  repo?: string;
  force?: boolean;
  agent?: string;
}

export function registerReviewPrCommand(program: Command, ctx: LGTMContext) {
  program
    .command("pr <ref>")
    // The old name, kept so existing muscle memory still lands somewhere sane
    // rather than on a command that posts without asking.
    .alias("auto")
    .description("Review one PR now and store the findings locally (posts nothing)")
    .option("--repo <owner/repo>", "Repository, when the ref is a bare number")
    .option("--force", "Review again even if this commit was already reviewed")
    .option("--agent <name>", "Use only this agent")
    .action(async (refArg: string, opts: Options) => {
      await run(ctx, refArg, opts);
    });
}

async function run(ctx: LGTMContext, refArg: string, opts: Options): Promise<void> {
  const ref = await resolveTarget(ctx, refArg, opts.repo);
  if (!ref) return;

  const { loadEnabledAgents } = await import("@lgtm/core/store/agents.js");
  const { detectProviders } = await import("@lgtm/core/ai/providers.js");
  const { createGitHubAdapter } = await import("../infra/github.js");
  const { createRulesEngine, rulesAsPromptContext } = await import("../domain/rules.js");

  let agents = loadEnabledAgents(ctx.lgtmDir);

  if (opts.agent) {
    agents = agents.filter((a) => a.name === opts.agent);
    if (agents.length === 0) {
      console.log(chalk.red(`\n  No enabled agent named "${opts.agent}".`));
      console.log(chalk.gray(`  Available: ${loadEnabledAgents(ctx.lgtmDir).map((a) => a.name).join(", ")}\n`));
      return;
    }
  }

  if (agents.length === 0) {
    console.log(chalk.yellow(`\n  Every agent in ${chalk.cyan("agents/")} is disabled.\n`));
    return;
  }

  const statuses = await detectProviders();
  if (!statuses.some((s) => s.available)) {
    console.log(chalk.yellow(`\n  No review provider is available.`));
    console.log(chalk.gray(`  Details: ${chalk.cyan("lgtm ai discover")}\n`));
    return;
  }

  // Fetch the PR so the round records its real title, author and head SHA. The
  // SHA is what makes a later `lgtm watch` recognise this as already reviewed.
  const github = createGitHubAdapter(ref.owner, ref.repo);

  let pr: OpenPR;
  try {
    const meta = await github.fetchPR(ref.pr);
    pr = {
      number: ref.pr,
      title: meta.title,
      author: meta.author,
      createdAt: new Date().toISOString(),
      url: `https://github.com/${ref.owner}/${ref.repo}/pull/${ref.pr}`,
      headSha: meta.head?.sha ?? "",
    };
  } catch (err) {
    console.log(chalk.red(`\n  Could not fetch ${formatRef(ref)}: ${(err as Error).message}\n`));
    return;
  }

  // --force reviews the same commit again. Without it the shared decision logic
  // would correctly skip, which is right for the watcher and wrong for someone
  // who just asked for a review.
  if (opts.force) {
    const existing = loadMeta(ctx.lgtmDir, ref);
    if (existing && existing.lastReviewedSha === pr.headSha) {
      console.log(chalk.gray(`\n  Re-reviewing the same commit because --force was given.`));
    }
  }

  const watched: WatchedRepo = { owner: ref.owner, repo: ref.repo, filter: "all" };
  const rules = await createRulesEngine(ctx.store).loadRules();

  console.log(chalk.bold(`\n👍 Reviewing ${formatRef(ref)}`));
  console.log(chalk.gray(`  ${pr.title}${pr.author !== "unknown" ? ` by @${pr.author}` : ""}`));
  console.log(chalk.gray(`  Agents: ${agents.map((a) => `${a.name} (${a.provider})`).join(", ")}\n`));

  const deps: CycleDeps = {
    fetchDiff: async (owner, repo, prNumber) => createGitHubAdapter(owner, repo).fetchDiff(prNumber),
    fetchOpenPRs: async () => [pr],
  };

  const result = await checkPR(
    ctx.lgtmDir,
    watched,
    pr,
    agents,
    deps,
    rulesAsPromptContext(rules),
    {
      info: (m) => console.log(chalk.gray(`  ${m}`)),
      warn: (m) => console.log(chalk.yellow(`  ${m}`)),
      error: (m) => console.log(chalk.red(`  ${m}`)),
    },
    opts.force ?? false
  );

  console.log("");

  switch (result.action) {
    case "reviewed":
      console.log(chalk.green(`  ✓ Round ${result.round}: ${result.findings} finding(s)`));
      break;
    case "re-reviewed":
      console.log(
        chalk.green(
          `  ✓ Round ${result.round}: ${result.findings} finding(s), ` +
            `${result.resolved} earlier resolved, ${result.unresolved} still open`
        )
      );
      break;
    case "skipped":
      console.log(chalk.gray(`  · Skipped: ${result.reason}`));
      if (result.reason === "no new commits") {
        console.log(chalk.gray(`    Review it again anyway: ${chalk.cyan(`lgtm review pr ${formatRef(ref)} --force`)}`));
      }
      break;
    case "failed":
      console.log(chalk.red(`  ✗ Failed: ${result.reason}`));
      break;
  }

  const pending = pendingFindings(ctx.lgtmDir, ref).length;
  if (pending > 0) {
    console.log(chalk.gray(`\n  See them:  ${chalk.cyan(`lgtm review list ${formatRef(ref)}`)}`));
    console.log(chalk.gray(`  Post them: ${chalk.cyan(`lgtm review post ${formatRef(ref)}`)}`));
  }
  console.log("");
}

/**
 * Work out which PR to review.
 *
 * A bare number needs a repo. `--repo` wins, then the current checkout's git
 * remote, which is what someone running this inside a repo means.
 */
async function resolveTarget(
  ctx: LGTMContext,
  refArg: string,
  repoOpt?: string
): Promise<PRRef | null> {
  const parsed = parsePrRef(refArg);

  if ("error" in parsed) {
    console.log(chalk.red(`\n  ${parsed.error}\n`));
    return null;
  }

  if (parsed.owner && parsed.repo) {
    return { owner: parsed.owner, repo: parsed.repo, pr: parsed.pr };
  }

  if (repoOpt) {
    const [owner, repo] = repoOpt.split("/");
    if (!owner || !repo) {
      console.log(chalk.red(`\n  --repo must be owner/repo, got "${repoOpt}"\n`));
      return null;
    }
    return { owner, repo, pr: parsed.pr };
  }

  // Fall back to the checkout we are standing in, which is what someone running
  // this from inside a repo means.
  try {
    const { createGitAdapter } = await import("@lgtm/core/utils/git.js");
    const info = await createGitAdapter(ctx.repoRoot).getRepoInfo();

    if (info?.owner && info?.repo) {
      return { owner: info.owner, repo: info.repo, pr: parsed.pr };
    }
  } catch {
    // No remote, fall through to the error below.
  }

  console.log(chalk.red(`\n  Which repository is #${parsed.pr} in?`));
  console.log(chalk.gray(`  Use ${chalk.cyan(`lgtm review pr owner/repo#${parsed.pr}`)}`));
  console.log(chalk.gray(`  or run this from inside the repo's checkout.\n`));
  return null;
}

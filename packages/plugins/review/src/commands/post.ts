/**
 * `lgtm review post|list|discard|submit` — the human gate.
 *
 * Reviews are produced locally by the watcher and go nowhere until one of these
 * runs. `post` creates a PENDING review, which is a draft only the author can
 * see, so the last edit before anything becomes public happens in GitHub's own
 * diff UI.
 */

import type { Command } from "commander";
import type { LGTMContext } from "@lgtm/core/plugin.js";
import chalk from "chalk";
import {
  loadMeta,
  loadAllRounds,
  pendingFindings,
  markFindingsPosted,
  markFindingsSkipped,
  markFindingsDiscarded,
  setPendingReviewId,
  markSubmitted,
  listReviewedPRs,
  prUrl,
  type PRRef,
} from "../domain/review-store.js";
import { resolvePrRef, describeRefError, formatRef } from "../domain/pr-ref.js";
import {
  postPendingReview,
  submitPendingReview,
  deletePendingReview,
  checkLines,
  formatCommentBody,
  formatReviewSummary,
  type PostableFinding,
} from "../domain/pending-review.js";

// ─── Shared helpers ─────────────────────────────────────────────────────────

/** Resolve a PR argument, printing guidance and returning null on failure. */
function resolve(ctx: LGTMContext, input: string, command: string): PRRef | null {
  const resolved = resolvePrRef(ctx.lgtmDir, input);

  if ("error" in resolved) {
    console.log("");
    for (const line of describeRefError(resolved, command)) {
      console.log(`  ${line}`);
    }
    console.log("");
    return null;
  }

  return resolved;
}

async function githubToken(): Promise<string | null> {
  const { resolveGitHubToken, describeMissingGitHubToken } = await import(
    "@lgtm/core/auth/github-oauth.js"
  );
  const token = resolveGitHubToken();

  if (!token) {
    console.log("");
    for (const line of describeMissingGitHubToken()) console.log(chalk.gray(`  ${line}`));
    console.log("");
    return null;
  }

  return token;
}

/** A token if one is available, without complaining when it is not. */
async function optionalToken(): Promise<string | null> {
  const { resolveGitHubToken } = await import("@lgtm/core/auth/github-oauth.js");
  return resolveGitHubToken();
}

const severityColour: Record<string, (s: string) => string> = {
  critical: chalk.red,
  high: chalk.yellow,
  medium: chalk.blue,
  low: chalk.gray,
};

// ─── review list ────────────────────────────────────────────────────────────

export function registerListCommand(program: Command, ctx: LGTMContext) {
  program
    .command("list [pr]")
    .description("Show findings for a PR, or every PR with findings")
    .option("--all", "Include posted and discarded findings")
    .action(async (pr: string | undefined, opts: { all?: boolean }) => {
      if (!pr) {
        listAll(ctx);
        return;
      }

      const ref = resolve(ctx, pr, "lgtm review list");
      if (!ref) return;

      const meta = loadMeta(ctx.lgtmDir, ref);
      const rounds = loadAllRounds(ctx.lgtmDir, ref);

      if (rounds.length === 0) {
        console.log(chalk.gray(`\n  No review on disk for ${formatRef(ref)}.\n`));
        return;
      }

      console.log(chalk.bold(`\n👍 ${formatRef(ref)}`));
      if (meta?.title) {
        console.log(chalk.gray(`  ${meta.title}${meta.author ? ` by @${meta.author}` : ""}`));
      }
      console.log(chalk.gray(`  ${prUrl(ref)}`));

      if (meta?.pendingReviewId) {
        console.log(
          chalk.cyan(`\n  A draft review is open. Edit and submit it: ${prUrl(ref)}/files`)
        );
      }

      for (const round of rounds) {
        const provider = round.provider ? ` via ${round.provider}` : "";
        console.log(chalk.bold(`\n  Round ${round.round} — ${round.agent}${provider}`));

        if (round.error) {
          console.log(chalk.red(`    failed: ${round.error}`));
          continue;
        }

        const shown = opts.all
          ? round.findings
          : round.findings.filter((f) => !f.posted && !f.discarded);

        if (shown.length === 0) {
          console.log(
            chalk.gray(
              round.findings.length === 0
                ? "    no findings"
                : "    nothing pending (use --all to see posted and discarded)"
            )
          );
          continue;
        }

        for (const f of shown) {
          const colour = severityColour[f.severity] ?? chalk.white;
          const state = f.discarded
            ? chalk.gray(" [discarded]")
            : f.posted
              ? chalk.green(" [posted]")
              : f.skipped
                ? chalk.yellow(` [held back: ${f.skipReason}]`)
                : "";

          console.log(
            `    ${chalk.dim(f.id)} ${colour(f.severity.padEnd(8))} ${f.file}:${f.line}${state}`
          );
          console.log(`       ${f.comment}`);
          if (f.suggestion) console.log(chalk.gray(`       Suggested: ${f.suggestion}`));
          if (f.resolved !== undefined) {
            console.log(
              f.resolved
                ? chalk.green(`       resolved: ${f.resolvedNote ?? ""}`)
                : chalk.yellow(`       still open: ${f.resolvedNote ?? ""}`)
            );
          }
        }
      }

      const pending = pendingFindings(ctx.lgtmDir, ref).length;
      console.log(
        pending > 0
          ? chalk.gray(`\n  ${pending} pending. Post them: ${chalk.cyan(`lgtm review post ${formatRef(ref)}`)}\n`)
          : chalk.gray(`\n  Nothing pending.\n`)
      );
    });
}

function listAll(ctx: LGTMContext) {
  const refs = listReviewedPRs(ctx.lgtmDir);

  if (refs.length === 0) {
    console.log(chalk.gray(`\n  No reviews yet. Start the watcher: ${chalk.cyan("lgtm watch")}\n`));
    return;
  }

  console.log(chalk.bold(`\n👍 Reviews (${refs.length})\n`));

  for (const ref of refs) {
    const meta = loadMeta(ctx.lgtmDir, ref);
    const pending = pendingFindings(ctx.lgtmDir, ref).length;

    const state = pending > 0
      ? chalk.yellow(`${pending} pending`)
      : meta?.pendingReviewId
        ? chalk.cyan("draft open on GitHub")
        : chalk.gray("nothing pending");

    console.log(`  ${chalk.cyan(formatRef(ref))}  ${state}`);
    if (meta?.title) console.log(chalk.gray(`    ${meta.title}`));
    console.log(chalk.gray(`    ${prUrl(ref)}`));
  }

  console.log(chalk.gray(`\n  Details: ${chalk.cyan("lgtm review list <owner/repo#pr>")}\n`));
}

// ─── review post ────────────────────────────────────────────────────────────

export function registerPostCommand(program: Command, ctx: LGTMContext) {
  program
    .command("post <pr>")
    .description("Create a draft (pending) review on GitHub from local findings")
    .option("--dry-run", "Show exactly what would be sent, without sending it")
    .option("--recreate", "Replace an existing draft review")
    .action(async (prArg: string, opts: { dryRun?: boolean; recreate?: boolean }) => {
      const ref = resolve(ctx, prArg, "lgtm review post");
      if (!ref) return;

      const meta = loadMeta(ctx.lgtmDir, ref);
      if (!meta) {
        console.log(chalk.gray(`\n  No review on disk for ${formatRef(ref)}.\n`));
        return;
      }

      const pending = pendingFindings(ctx.lgtmDir, ref);
      if (pending.length === 0) {
        console.log(chalk.gray(`\n  Nothing pending for ${formatRef(ref)}.\n`));
        return;
      }

      // The API cannot append to an existing pending review, so a second post
      // would create a second draft. Require an explicit --recreate.
      if (meta.pendingReviewId && !opts.recreate) {
        console.log(chalk.yellow(`\n  ${formatRef(ref)} already has a draft review open.`));
        console.log(chalk.gray(`  GitHub cannot add comments to an existing draft, so either:`));
        console.log(chalk.gray(`    submit or delete it at ${prUrl(ref)}/files`));
        console.log(chalk.gray(`    or replace it: ${chalk.cyan(`lgtm review post ${formatRef(ref)} --recreate`)}\n`));
        return;
      }

      // A dry run can proceed without a token. It exists to show what would be
      // sent, which is most useful precisely when the API is not reachable.
      const token = opts.dryRun ? (await optionalToken()) : await githubToken();
      if (!token && !opts.dryRun) return;

      // Validate against the current diff, not the one the review ran on. The
      // PR may have moved since, and GitHub rejects the whole call if any single
      // comment targets a line it cannot find.
      const { createGitHubAdapter } = await import("../infra/github.js");
      const { parseDiff } = await import("../domain/diff-parser.js");

      let diff = null;
      let diffError: string | null = null;
      try {
        const github = createGitHubAdapter(ref.owner, ref.repo);
        diff = parseDiff(await github.fetchDiff(ref.pr));
      } catch (err) {
        diffError = (err as Error).message;
      }

      if (!diff) {
        // Posting without validation risks GitHub rejecting the whole review
        // because of one bad line, so a real post stops here.
        if (!opts.dryRun) {
          console.log(chalk.red(`\n  Could not fetch the diff: ${diffError}`));
          console.log(chalk.gray(`  Line validation needs it, and one bad line loses the whole review.\n`));
          return;
        }
        console.log(chalk.yellow(`\n  Could not fetch the diff: ${diffError}`));
        console.log(chalk.gray(`  Showing the request anyway. Lines were NOT validated.`));
      }

      const { postable, skipped } = diff
        ? checkLines(pending as PostableFinding[], diff)
        : { postable: pending as PostableFinding[], skipped: [] };

      if (skipped.length > 0) {
        console.log(chalk.yellow(`\n  ${skipped.length} finding(s) cannot be attached to a diff line:`));
        for (const s of skipped) {
          console.log(chalk.gray(`    ${s.finding.id} ${s.finding.file}:${s.finding.line} — ${s.reason}`));
        }
        // Held, not dropped. A later round may bring the line back.
        markFindingsSkipped(
          ctx.lgtmDir,
          ref,
          skipped.map((s) => ({ id: s.finding.id, reason: s.reason }))
        );
      }

      if (postable.length === 0) {
        console.log(chalk.yellow(`\n  Nothing can be posted for ${formatRef(ref)}.\n`));
        return;
      }

      const currentRound = meta.rounds.find((r) => r.round === meta.currentRound);
      const summary = formatReviewSummary({
        owner: ref.owner,
        repo: ref.repo,
        pr: ref.pr,
        round: meta.currentRound,
        commentCount: postable.length,
        skippedCount: skipped.length,
        unresolvedFromPrior: currentRound?.unresolvedFromPrior,
      });

      const comments = postable.map((f) => ({
        path: f.file,
        line: f.line,
        body: formatCommentBody(f),
      }));

      if (opts.dryRun) {
        const { buildPendingReviewRequest } = await import("../domain/pending-review.js");
        const request = buildPendingReviewRequest({
          ...ref,
          token: "<redacted>",
          summary,
          comments,
        });

        console.log(chalk.bold(`\n  Would POST ${request.url}\n`));
        console.log(chalk.gray(`  No "event" field, which is what makes it a draft.\n`));
        console.log(JSON.stringify(request.body, null, 2));
        console.log(chalk.gray(`\n  Nothing was sent.\n`));
        return;
      }

      // Past the dry-run branch a token is guaranteed, since githubToken()
      // returns early without one.
      if (!token) return;

      if (meta.pendingReviewId && opts.recreate) {
        try {
          await deletePendingReview({ ...ref, reviewId: meta.pendingReviewId, token });
          console.log(chalk.gray(`\n  Deleted the previous draft.`));
        } catch (err) {
          console.log(chalk.red(`\n  Could not delete the previous draft: ${(err as Error).message}`));
          return;
        }
      }

      try {
        const result = await postPendingReview({ ...ref, token, summary, comments });

        markFindingsPosted(
          ctx.lgtmDir,
          ref,
          postable.map((f) => f.id),
          result.reviewId
        );
        setPendingReviewId(ctx.lgtmDir, ref, result.reviewId);

        console.log(
          chalk.green(`\n  ✓ Draft review created with ${result.commentCount} comment(s)`)
        );
        console.log(chalk.gray(`    Only you can see it until you submit it.`));
        console.log(`\n    ${chalk.cyan(`${prUrl(ref)}/files`)}\n`);
        console.log(chalk.gray(`  Edit the comments there, then click "Submit review".`));
        console.log(chalk.gray(`  Or from here: ${chalk.cyan(`lgtm review submit ${formatRef(ref)}`)}\n`));
      } catch (err) {
        console.log(chalk.red(`\n  Failed to create the review: ${(err as Error).message}\n`));
      }
    });
}

// ─── review submit ──────────────────────────────────────────────────────────

export function registerSubmitCommand(program: Command, ctx: LGTMContext) {
  program
    .command("submit <pr>")
    .description("Submit the draft review, making its comments visible")
    .action(async (prArg: string) => {
      const ref = resolve(ctx, prArg, "lgtm review submit");
      if (!ref) return;

      const meta = loadMeta(ctx.lgtmDir, ref);
      if (!meta?.pendingReviewId) {
        console.log(chalk.gray(`\n  No draft review open for ${formatRef(ref)}.\n`));
        return;
      }

      const token = await githubToken();
      if (!token) return;

      try {
        await submitPendingReview({ ...ref, reviewId: meta.pendingReviewId, token });
        markSubmitted(ctx.lgtmDir, ref);

        console.log(chalk.green(`\n  ✓ Review submitted on ${formatRef(ref)}`));
        console.log(`    ${chalk.cyan(prUrl(ref))}\n`);
      } catch (err) {
        console.log(chalk.red(`\n  Failed to submit: ${(err as Error).message}\n`));
      }
    });
}

// ─── review discard ─────────────────────────────────────────────────────────

export function registerDiscardCommand(program: Command, ctx: LGTMContext) {
  program
    .command("discard <pr>")
    .description("Drop findings so they are never posted")
    .requiredOption("-f, --finding <ids...>", "Finding ids, e.g. f2 f3")
    .action(async (prArg: string, opts: { finding: string[] }) => {
      const ref = resolve(ctx, prArg, "lgtm review discard");
      if (!ref) return;

      const changed = markFindingsDiscarded(ctx.lgtmDir, ref, opts.finding);
      const missed = opts.finding.filter((id) => !changed.includes(id));

      if (changed.length > 0) {
        console.log(chalk.gray(`\n  ○ Discarded ${changed.join(", ")}`));
      }

      if (missed.length > 0) {
        // Either the id does not exist or it is already on GitHub. Both matter.
        console.log(
          chalk.yellow(`  ⚠ Not discarded: ${missed.join(", ")} (unknown id, or already posted)`)
        );
      }

      console.log("");
    });
}

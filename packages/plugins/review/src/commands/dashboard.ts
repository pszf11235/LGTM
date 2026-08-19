/**
 * `lgtm review dashboard` — show what needs your attention.
 *
 * Fetches from watched repos, shows PRs needing review, activity on your
 * work, and items you need to respond to. Each item has a "why" context.
 */

import type { Command } from "commander";
import type { LGTMContext } from "@lgtm/core/plugin.js";
import chalk from "chalk";
import {
  collectAttentionItems,
  loadDismissed,
  filterDismissed,
  dismissItem,
  type AttentionItem,
} from "../domain/attention.js";

export function registerDashboardCommand(program: Command, ctx: LGTMContext) {
  const dashboard = program
    .command("dashboard")
    .description("Show what needs your attention");

  dashboard
    .command("show", { isDefault: true })
    .description("Display attention items")
    .option("--all", "Include dismissed items")
    .action(async (opts: { all?: boolean }) => {
      const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
      if (!token) {
        console.log(chalk.red("\n  GitHub token required. Set GITHUB_TOKEN env var.\n"));
        return;
      }

      console.log(chalk.gray("\n  Fetching from watched repos...\n"));

      const items = await collectAttentionItems(ctx.store, token);

      if (items.length === 0) {
        console.log(chalk.green("  ✓ All clear! Nothing needs your attention right now.\n"));
        console.log(chalk.gray(`  Watch repos with: ${chalk.cyan("lgtm review watch add owner/repo")}\n`));
        return;
      }

      // Filter dismissed unless --all
      let displayItems = items;
      if (!opts.all) {
        const dismissed = await loadDismissed(ctx.store);
        displayItems = filterDismissed(items, dismissed);
      }

      if (displayItems.length === 0) {
        console.log(chalk.green("  ✓ All caught up! (some items dismissed)\n"));
        console.log(chalk.gray(`  Show all: ${chalk.cyan("lgtm review dashboard show --all")}\n`));
        return;
      }

      // Group by type
      const reviews = displayItems.filter((i) => i.type === "review_needed");
      const activity = displayItems.filter((i) => i.type === "activity");
      const replies = displayItems.filter((i) => i.type === "reply_awaiting");
      const ci = displayItems.filter((i) => i.type === "ci_status");

      console.log(chalk.bold(`👍 ${displayItems.length} item(s) need attention\n`));

      if (reviews.length > 0) {
        console.log(chalk.bold(`  📋 PRs Needing Review (${reviews.length})\n`));
        for (const item of reviews) {
          printItem(item);
        }
      }

      if (activity.length > 0) {
        console.log(chalk.bold(`  🔔 Activity on Your Work (${activity.length})\n`));
        for (const item of activity) {
          printItem(item);
        }
      }

      if (replies.length > 0) {
        console.log(chalk.bold(`  💬 Replies Awaiting (${replies.length})\n`));
        for (const item of replies) {
          printItem(item);
        }
      }

      if (ci.length > 0) {
        console.log(chalk.bold(`  ⚙️ CI Status (${ci.length})\n`));
        for (const item of ci) {
          printItem(item);
        }
      }

      console.log(chalk.gray(`  Dismiss: ${chalk.cyan("lgtm review dashboard dismiss <id>")}`));
      console.log(chalk.gray(`  Refresh: ${chalk.cyan("lgtm review dashboard")}\n`));
    });

  dashboard
    .command("dismiss <id>")
    .description("Dismiss an attention item")
    .action(async (id: string) => {
      await dismissItem(ctx.store, id);
      console.log(chalk.gray(`\n  ○ Dismissed: ${id}\n`));
    });
}

function printItem(item: AttentionItem) {
  const urgencyIcon =
    item.urgency === "high" ? chalk.red("●") :
    item.urgency === "medium" ? chalk.yellow("●") :
    chalk.green("●");

  const age = item.age < 24 ? `${item.age}h` : `${Math.floor(item.age / 24)}d`;

  console.log(`  ${urgencyIcon} #${item.prNumber} ${item.title}`);
  console.log(chalk.gray(`    ${item.repo}${item.author ? ` by @${item.author}` : ""} · ${age} old`));
  console.log(chalk.gray(`    ${item.context}`));
  console.log(chalk.cyan(`    ${item.url}`));
  console.log();
}

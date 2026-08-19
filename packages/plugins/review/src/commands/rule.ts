/**
 * `lgtm review rule <action>` — Manage review rules.
 *
 * Subcommands:
 *   add "description" [--pattern regex] [--category security] [--severity warn]
 *   list
 *   enable <id>
 *   disable <id>
 */

import type { Command } from "commander";
import type { LGTMContext } from "@lgtm/core/plugin.js";
import { createRulesEngine } from "../domain/rules.js";
import chalk from "chalk";

export function registerRuleCommand(program: Command, ctx: LGTMContext) {
  const rule = program
    .command("rule")
    .description("Manage review rules (add/list/enable/disable)");

  rule
    .command("add <description>")
    .description("Create a new review rule")
    .option("-p, --pattern <regex>", "Regex pattern to match (for regex enforcement)")
    .option("-c, --category <cat>", "Category: security|style|testing|architecture|performance|general", "general")
    .option("-s, --severity <sev>", "Severity: warn|error", "warn")
    .option("-e, --enforcement <type>", "Enforcement: regex|llm (auto-detected from --pattern)")
    .option("-f, --file-pattern <glob>", "File glob to limit rule scope (e.g., '**/*.ts')")
    .option("--bad <examples...>", "Example code that violates this rule")
    .option("--good <examples...>", "Example code that follows this rule")
    .option("--from-pr <number>", "PR number where this pattern was noticed")
    .action(async (description: string, opts: {
      pattern?: string;
      category?: string;
      severity?: string;
      enforcement?: string;
      filePattern?: string;
      bad?: string[];
      good?: string[];
      fromPr?: string;
    }) => {
      const engine = createRulesEngine(ctx.store);

      const rule = await engine.createRule({
        description,
        category: opts.category as any,
        severity: opts.severity as any,
        enforcement: opts.enforcement as any,
        pattern: opts.pattern,
        filePattern: opts.filePattern,
        examples: {
          bad: opts.bad ?? [],
          good: opts.good ?? [],
        },
        createdFrom: opts.fromPr,
      });

      console.log(chalk.bold(`\n👍 Rule created: ${rule.id}\n`));
      console.log(`  ${chalk.cyan(rule.description)}`);
      console.log(`  Category: ${rule.category} | Severity: ${rule.severity} | Enforcement: ${rule.enforcement}`);
      if (rule.pattern) console.log(`  Pattern: ${chalk.gray(rule.pattern)}`);
      if (rule.filePattern) console.log(`  Files: ${chalk.gray(rule.filePattern)}`);
      console.log();
    });

  rule
    .command("list")
    .description("List all review rules")
    .action(async () => {
      const engine = createRulesEngine(ctx.store);
      const rules = await engine.loadRules();

      if (rules.length === 0) {
        console.log(chalk.gray(`\n  No rules yet. Create one with ${chalk.cyan("lgtm review rule add \"...\"")} \n`));
        return;
      }

      console.log(chalk.bold(`\n👍 Review Rules (${rules.length})\n`));
      console.log(chalk.gray("  ID              Sev   Cat          Enforcement  Description"));
      console.log(chalk.gray("  " + "─".repeat(75)));

      for (const r of rules) {
        const icon = r.enabled ? chalk.green("●") : chalk.gray("○");
        const sev = r.severity === "error" ? chalk.red("error") : chalk.yellow("warn ");
        const cat = r.category.padEnd(12);
        const enf = r.enforcement.padEnd(6);
        const desc = r.description.length > 35 ? r.description.slice(0, 32) + "..." : r.description;
        const triggered = r.timesTriggered > 0 ? chalk.gray(` (×${r.timesTriggered})`) : "";

        console.log(`  ${icon} ${r.id.padEnd(14)} ${sev}  ${cat}  ${enf}  ${desc}${triggered}`);
      }
      console.log();
    });

  rule
    .command("enable <id>")
    .description("Enable a rule")
    .action(async (id: string) => {
      const engine = createRulesEngine(ctx.store);
      await engine.setEnabled(id, true);
      console.log(chalk.green(`  ● Rule ${id} enabled\n`));
    });

  rule
    .command("disable <id>")
    .description("Disable a rule")
    .action(async (id: string) => {
      const engine = createRulesEngine(ctx.store);
      await engine.setEnabled(id, false);
      console.log(chalk.gray(`  ○ Rule ${id} disabled\n`));
    });

  rule
    .command("import [file]")
    .description("Import rules from a file (CLAUDE.md, .cursorrules, etc.)")
    .option("--discover", "Auto-discover rule source files in the repo")
    .action(async (file: string | undefined, opts: { discover?: boolean }) => {
      const { discoverRuleSources, importRulesFromFile } = await import("../domain/rules-import.js");

      if (opts.discover || !file) {
        // Auto-discover
        const sources = discoverRuleSources(ctx.repoRoot);
        if (sources.length === 0) {
          console.log(chalk.gray("\n  No rule source files found (CLAUDE.md, .cursorrules, .kiro/steering, etc.)\n"));
          return;
        }
        console.log(chalk.bold("\n👍 Discovered rule sources:\n"));
        for (const s of sources) {
          console.log(`  📄 ${s}`);
        }
        console.log(chalk.gray(`\n  Import with: ${chalk.cyan(`lgtm review rule import <file>`)}\n`));
        return;
      }

      // Import from specific file
      console.log(chalk.gray(`\n  Importing rules from ${file}...\n`));
      try {
        const rules = await importRulesFromFile(file, ctx.repoRoot, ctx.store, ctx.llm);
        console.log(chalk.bold(`  👍 Imported ${rules.length} rule(s):\n`));
        for (const r of rules) {
          console.log(`  ${chalk.green("+")} ${r.id}: ${r.description} [${r.enforcement}]`);
        }
        console.log();
      } catch (err) {
        ctx.logger.error(`Failed to import: ${(err as Error).message}`);
      }
    });

  rule
    .command("export")
    .description("Export rules as enforcement mechanisms (hook/steering/eslint)")
    .requiredOption("-f, --format <format>", "Output format: hook, steering, or eslint")
    .option("-o, --output <file>", "Write to file (default: stdout)")
    .action(async (opts: { format: string; output?: string }) => {
      const { exportAsHook, exportAsSteering, exportAsESLint } = await import("../domain/rules-export.js");
      const engine = createRulesEngine(ctx.store);
      const rules = await engine.loadRules();

      if (rules.length === 0) {
        console.log(chalk.gray(`\n  No rules to export. Create some first.\n`));
        return;
      }

      let output: string;
      let defaultFile: string;

      switch (opts.format) {
        case "hook":
          output = exportAsHook(rules);
          defaultFile = ".git/hooks/pre-commit";
          break;
        case "steering":
          output = exportAsSteering(rules);
          defaultFile = ".kiro/steering/lgtm-rules.md";
          break;
        case "eslint":
          output = exportAsESLint(rules);
          defaultFile = ".eslintrc.lgtm.json";
          break;
        default:
          ctx.logger.error(`Unknown format: ${opts.format}. Use: hook, steering, or eslint`);
          return;
      }

      if (opts.output) {
        const fs = await import("fs");
        const path = await import("path");
        const fullPath = path.default.resolve(ctx.repoRoot, opts.output);
        fs.default.mkdirSync(path.default.dirname(fullPath), { recursive: true });
        fs.default.writeFileSync(fullPath, output);

        // Make hook executable
        if (opts.format === "hook") {
          fs.default.chmodSync(fullPath, 0o755);
        }

        console.log(chalk.green(`\n  ✓ Exported to ${opts.output}`));
        if (opts.format === "hook") {
          console.log(chalk.gray(`    (made executable)`));
        }
      } else {
        // Print to stdout
        console.log(output);
      }
      console.log();
    });

  rule
    .command("suggest")
    .description("Analyze your review comments for patterns and suggest rules")
    .action(async () => {
      const { analyzeCommentPatterns } = await import("../domain/patterns.js");

      console.log(chalk.bold("\n👍 Analyzing review comments for patterns...\n"));

      const suggestions = await analyzeCommentPatterns(ctx.store, ctx.llm);

      if (suggestions.length === 0) {
        console.log(chalk.gray("  No patterns found yet. Keep reviewing — suggestions appear after 3+ similar comments across PRs.\n"));
        return;
      }

      console.log(chalk.bold(`  Found ${suggestions.length} pattern(s):\n`));

      for (const s of suggestions) {
        const confIcon = s.confidence === "high" ? chalk.green("●") : s.confidence === "medium" ? chalk.yellow("●") : chalk.gray("●");
        console.log(`  ${confIcon} ${chalk.bold(s.description)}`);
        console.log(chalk.gray(`    Category: ${s.category} | Severity: ${s.severity} | Confidence: ${s.confidence}`));
        if (s.sourceComments.length > 0) {
          console.log(chalk.gray(`    Based on:`));
          for (const c of s.sourceComments.slice(0, 3)) {
            console.log(chalk.gray(`      • ${c}`));
          }
        }
        console.log();
      }

      console.log(chalk.gray(`  Create a rule from a suggestion with:`));
      console.log(chalk.cyan(`    lgtm review rule add "<description>" [--pattern "..."]`));
      console.log();
    });
}

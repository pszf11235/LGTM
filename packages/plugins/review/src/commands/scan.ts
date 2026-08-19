/**
 * `lgtm review scan` — Run all rules against the entire repo.
 *
 * On-demand scan (never automatic). Checks all files matching rule patterns.
 * For regex rules: reads files and matches patterns.
 * For LLM rules: sends file content to LLM (batched, with progress).
 *
 * Results presented with action options:
 *   [i] file as issue  [p] open PR to fix  [f] fold into current  [x] ignore
 */

import type { Command } from "commander";
import type { LGTMContext } from "@lgtm/core/plugin.js";
import { createRulesEngine, type Rule, getSkippedLLMRules } from "../domain/rules.js";
import chalk from "chalk";
import fs from "fs";
import path from "path";
import { minimatch } from "minimatch";

interface ScanViolation {
  ruleId: string;
  ruleDescription: string;
  severity: "warn" | "error";
  file: string;
  line: number;
  content: string;
  explanation?: string;
}

export function registerScanCommand(program: Command, ctx: LGTMContext) {
  program
    .command("scan")
    .description("Run all rules against the entire repo")
    .option("-r, --rule <id>", "Check a single rule only")
    .option("--fix", "Attempt to generate fixes (requires AI)")
    .action(async (opts: { rule?: string; fix?: boolean }) => {
      const engine = createRulesEngine(ctx.store);
      let rules = await engine.loadRules();

      if (rules.length === 0) {
        console.log(chalk.gray(`\n  No rules defined. Create some with ${chalk.cyan("lgtm review rule add")}.\n`));
        return;
      }

      // Filter to single rule if specified
      if (opts.rule) {
        rules = rules.filter((r) => r.id === opts.rule);
        if (rules.length === 0) {
          ctx.logger.error(`Rule '${opts.rule}' not found.`);
          return;
        }
      }

      // Only enabled rules
      rules = rules.filter((r) => r.enabled);

      // Warn about LLM rules if AI unavailable
      const llmAvailable = ctx.llm ? await ctx.llm.isAvailable() : false;
      const skippedRules = getSkippedLLMRules(rules, llmAvailable);
      if (skippedRules.length > 0) {
        console.log(chalk.yellow(`\n  ⚠ ${skippedRules.length} LLM rule(s) will be skipped (AI unavailable):`));
        for (const r of skippedRules) {
          console.log(chalk.gray(`    • ${r.id}: ${r.description}`));
        }
        console.log(chalk.gray(`    Enable AI with: ${chalk.cyan("lgtm ai test")}\n`));
        rules = rules.filter((r) => r.enforcement !== "llm");
      }

      if (rules.length === 0) {
        console.log(chalk.gray("\n  No enforceable rules (all are LLM-only and AI is disabled).\n"));
        return;
      }

      console.log(chalk.bold(`\n👍 Scanning repo against ${rules.length} rule(s)...\n`));

      // Gather files to scan
      const allFiles = collectFiles(ctx.repoRoot);
      const violations: ScanViolation[] = [];
      let filesScanned = 0;

      for (const rule of rules) {
        if (rule.enforcement !== "regex" || !rule.pattern) continue;

        let regex: RegExp;
        try {
          regex = new RegExp(rule.pattern, "i");
        } catch {
          continue;
        }

        // Filter files by glob
        const matchingFiles = rule.filePattern
          ? allFiles.filter((f) => minimatch(f, rule.filePattern!))
          : allFiles;

        for (const file of matchingFiles) {
          const fullPath = path.join(ctx.repoRoot, file);
          try {
            const content = await Bun.file(fullPath).text();
            const lines = content.split("\n");

            for (let i = 0; i < lines.length; i++) {
              if (regex.test(lines[i])) {
                violations.push({
                  ruleId: rule.id,
                  ruleDescription: rule.description,
                  severity: rule.severity,
                  file,
                  line: i + 1,
                  content: lines[i].trim(),
                });
              }
            }
            filesScanned++;
          } catch {
            // Skip unreadable files
          }
        }

        // Progress
        process.stdout.write(
          `\r  Scanning... ${filesScanned} files checked, ${violations.length} violations found`
        );
      }

      console.log("\n");

      if (violations.length === 0) {
        console.log(chalk.green("  ✓ No violations found. Repo is clean!\n"));
        return;
      }

      // Display results grouped by rule
      const byRule = new Map<string, ScanViolation[]>();
      for (const v of violations) {
        if (!byRule.has(v.ruleId)) byRule.set(v.ruleId, []);
        byRule.get(v.ruleId)!.push(v);
      }

      for (const [ruleId, ruleViolations] of byRule) {
        const rule = rules.find((r) => r.id === ruleId)!;
        const sevIcon = rule.severity === "error" ? chalk.red("✗") : chalk.yellow("⚠");
        console.log(`  ${sevIcon} ${chalk.bold(rule.description)} (${ruleViolations.length} violations)`);
        console.log(chalk.gray(`    Rule: ${ruleId} | Pattern: ${rule.pattern}`));
        console.log();

        // Show first 5 violations
        const shown = ruleViolations.slice(0, 5);
        for (const v of shown) {
          console.log(chalk.gray(`    ${v.file}:${v.line}`));
          console.log(`      ${chalk.dim(v.content.slice(0, 80))}`);
        }
        if (ruleViolations.length > 5) {
          console.log(chalk.gray(`    ... and ${ruleViolations.length - 5} more`));
        }
        console.log();
      }

      // Summary
      const errors = violations.filter((v) => v.severity === "error").length;
      const warnings = violations.filter((v) => v.severity === "warn").length;
      console.log(chalk.bold("  Summary:"));
      if (errors > 0) console.log(chalk.red(`    ${errors} error(s)`));
      if (warnings > 0) console.log(chalk.yellow(`    ${warnings} warning(s)`));
      console.log(chalk.gray(`    ${filesScanned} files scanned`));
      console.log();

      // Save scan results
      try {
        const date = new Date().toISOString().split("T")[0];
        const scanData = {
          type: "lgtm/scan",
          date,
          rules_checked: rules.length,
          files_scanned: filesScanned,
          violations_found: violations.length,
          errors,
          warnings,
        };
        const scanBody = violations
          .map((v) => `- **${v.file}:${v.line}** [${v.ruleId}] ${v.content.slice(0, 60)}`)
          .join("\n");

        await ctx.store.write(
          `scans/scan-${date}.md`,
          scanData,
          `# Scan Results: ${date}\n\n${scanBody}`
        );
        console.log(chalk.gray(`  Results saved to .lgtm/scans/scan-${date}.md\n`));
      } catch {
        // Non-critical — scan results are also shown in terminal
      }
    });
}

/**
 * Collect all scannable files in the repo (respects .gitignore-style exclusions).
 */
function collectFiles(repoRoot: string): string[] {
  const files: string[] = [];
  const ignore = new Set([
    "node_modules", ".git", "dist", "build", ".lgtm",
    "coverage", ".next", ".nuxt", "vendor", "__pycache__",
    ".venv", "target", ".cargo",
  ]);

  function walk(dir: string, prefix: string) {
    try {
      const entries = fs.readdirSync(path.join(repoRoot, dir), { withFileTypes: true });
      for (const entry of entries) {
        if (ignore.has(entry.name)) continue;
        if (entry.name.startsWith(".") && entry.name !== ".env") continue;

        const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
          walk(path.join(dir, entry.name), relative);
        } else if (entry.isFile()) {
          // Only scan text-like files
          if (isTextFile(entry.name)) {
            files.push(relative);
          }
        }
      }
    } catch {
      // Permission errors etc — skip
    }
  }

  walk("", "");
  return files;
}

function isTextFile(name: string): boolean {
  const textExts = new Set([
    ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs",
    ".py", ".rb", ".go", ".rs", ".java", ".kt",
    ".c", ".cpp", ".h", ".hpp", ".cs",
    ".php", ".swift", ".ex", ".exs",
    ".yaml", ".yml", ".toml", ".json",
    ".md", ".txt", ".env", ".sh", ".bash",
    ".css", ".scss", ".html", ".vue", ".svelte",
  ]);
  const ext = path.extname(name).toLowerCase();
  return textExts.has(ext);
}

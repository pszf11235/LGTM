/**
 * Rules Engine — create, load, match, and enforce review rules.
 *
 * Rules are stored as individual OKF markdown files in .lgtm/rules/.
 * Each rule has: description, category, severity, enforcement type,
 * optional regex pattern, file glob, and examples (bad/good).
 *
 * Enforcement modes:
 * - "regex": pattern matched against diff lines (zero tokens)
 * - "llm": appended to the review agent prompt as extra instructions
 */

import type { OKFStore } from "@lgtm/core/plugin.js";
import type { RuleViolation } from "./types.js";
import type { ParsedDiff } from "./diff-parser.js";
import { minimatch } from "minimatch";

/**
 * A review rule (stored as OKF markdown).
 */
export interface Rule {
  id: string;
  description: string;
  category: "security" | "style" | "testing" | "architecture" | "performance" | "general";
  severity: "warn" | "error";
  enforcement: "regex" | "llm";
  pattern?: string;           // regex string (for enforcement: 'regex')
  filePattern?: string;       // glob for which files to check
  examples: {
    bad: string[];
    good: string[];
  };
  createdAt: string;
  createdFrom?: string;       // PR number where this rule originated
  enabled: boolean;
  timesTriggered: number;
}

/**
 * Create a rules engine instance.
 */
export function createRulesEngine(store: OKFStore) {
  /**
   * Load all rules from .lgtm/rules/*.md
   */
  async function loadRules(): Promise<Rule[]> {
    const files = await store.list("rules");
    const rules: Rule[] = [];

    for (const file of files) {
      if (file === "rules/index.md") continue; // skip index
      const doc = await store.read(file);
      if (!doc || doc.data.type !== "lgtm/rule") continue;

      rules.push({
        id: doc.data.id as string,
        description: doc.data.description as string,
        category: (doc.data.category as Rule["category"]) ?? "general",
        severity: (doc.data.severity as Rule["severity"]) ?? "warn",
        enforcement: (doc.data.enforcement as Rule["enforcement"]) ?? "regex",
        pattern: doc.data.pattern as string | undefined,
        filePattern: doc.data.filePattern as string | undefined,
        examples: (doc.data.examples as Rule["examples"]) ?? { bad: [], good: [] },
        createdAt: doc.data.createdAt as string ?? "",
        createdFrom: doc.data.createdFrom as string | undefined,
        enabled: doc.data.enabled !== false,
        timesTriggered: (doc.data.timesTriggered as number) ?? 0,
      });
    }

    return rules;
  }

  /**
   * Create and save a new rule.
   */
  async function createRule(opts: {
    description: string;
    category?: Rule["category"];
    severity?: Rule["severity"];
    enforcement?: Rule["enforcement"];
    pattern?: string;
    filePattern?: string;
    examples?: { bad: string[]; good: string[] };
    createdFrom?: string;
  }): Promise<Rule> {
    const id = `r-${Date.now().toString(36)}`;
    const rule: Rule = {
      id,
      description: opts.description,
      category: opts.category ?? "general",
      severity: opts.severity ?? "warn",
      enforcement: opts.enforcement ?? (opts.pattern ? "regex" : "llm"),
      pattern: opts.pattern,
      filePattern: opts.filePattern,
      examples: opts.examples ?? { bad: [], good: [] },
      createdAt: new Date().toISOString(),
      createdFrom: opts.createdFrom,
      enabled: true,
      timesTriggered: 0,
    };

    const slug = opts.description
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .slice(0, 40);

    // Strip undefined values (YAML serializer chokes on them)
    const data = JSON.parse(JSON.stringify({
      type: "lgtm/rule",
      ...rule,
    }));

    await store.write(`rules/${id}-${slug}.md`, data, generateRuleBody(rule));

    return rule;
  }

  /**
   * Match regex rules against a parsed diff.
   * Returns violations (zero tokens — pure regex).
   */
  function matchRegex(rules: Rule[], diff: ParsedDiff): RuleViolation[] {
    const violations: RuleViolation[] = [];
    const regexRules = rules.filter((r) => r.enabled && r.enforcement === "regex" && r.pattern);

    for (const rule of regexRules) {
      let regex: RegExp;
      try {
        regex = new RegExp(rule.pattern!, "i");
      } catch {
        continue; // Invalid regex — skip
      }

      for (const file of diff.files) {
        // Check file pattern glob
        if (rule.filePattern && !minimatch(file.path, rule.filePattern)) {
          continue;
        }

        for (const hunk of file.hunks) {
          for (const line of hunk.lines) {
            // Only check added lines (new code)
            if (line.type !== "added") continue;

            if (regex.test(line.content)) {
              violations.push({
                ruleId: rule.id,
                file: file.path,
                line: line.newLine ?? 0,
                explanation: rule.description,
                matchedText: line.content.trim(),
              });
            }
          }
        }
      }
    }

    return violations;
  }

  /**
   * Update a rule's triggered count.
   */
  async function incrementTriggered(ruleId: string): Promise<void> {
    const rules = await loadRules();
    const rule = rules.find((r) => r.id === ruleId);
    if (!rule) return;

    rule.timesTriggered++;
    // Re-save (find the file)
    const files = await store.list("rules");
    for (const file of files) {
      const doc = await store.read(file);
      if (doc?.data.id === ruleId) {
        await store.write(file, { ...doc.data, timesTriggered: rule.timesTriggered }, doc.content);
        break;
      }
    }
  }

  /**
   * Enable or disable a rule.
   */
  async function setEnabled(ruleId: string, enabled: boolean): Promise<void> {
    const files = await store.list("rules");
    for (const file of files) {
      const doc = await store.read(file);
      if (doc?.data.id === ruleId) {
        await store.write(file, { ...doc.data, enabled }, doc.content);
        break;
      }
    }
  }

  return {
    loadRules,
    createRule,
    matchRegex,
    incrementTriggered,
    setEnabled,
  };
}

/**
 * Render LLM-enforced rules as extra instructions for the review agent.
 *
 * These rules used to get their own `llm.complete()` call per rule. Once the
 * review itself is delegated to a CLI there is no raw LLM provider to call, and
 * paying for a separate round trip per rule made no sense anyway: the agent is
 * already looking at the diff, so the rules ride along in its prompt for free.
 *
 * Regex rules are not included. They run locally in `matchRegex` and produce
 * findings directly, so restating them here would double up.
 *
 * Returns an empty string when there is nothing to add, so callers can
 * concatenate unconditionally.
 */
export function rulesAsPromptContext(rules: Rule[]): string {
  const promptRules = rules.filter((r) => r.enabled && r.enforcement === "llm");
  if (promptRules.length === 0) return "";

  const lines = [
    "Also enforce these project rules. Report a finding for each violation.",
    "",
  ];

  for (const rule of promptRules) {
    lines.push(`- ${rule.description} (${rule.category}, ${rule.severity})`);

    if (rule.filePattern) {
      lines.push(`  Applies to: ${rule.filePattern}`);
    }
    for (const bad of rule.examples.bad.slice(0, 2)) {
      lines.push(`  Violates: ${collapse(bad)}`);
    }
    for (const good of rule.examples.good.slice(0, 2)) {
      lines.push(`  Correct: ${collapse(good)}`);
    }
  }

  return lines.join("\n");
}

/**
 * Flatten a code example onto one line and cap it, so a long snippet cannot
 * crowd out the review instructions in the prompt.
 */
function collapse(example: string): string {
  const oneLine = example.replace(/\s+/g, " ").trim();
  return oneLine.length > 160 ? `${oneLine.slice(0, 157)}...` : oneLine;
}

/**
 * Generate markdown body for a rule file.
 */
function generateRuleBody(rule: Rule): string {
  const lines = [
    `# Rule: ${rule.description}`,
    "",
    `**Category:** ${rule.category}`,
    `**Severity:** ${rule.severity}`,
    `**Enforcement:** ${rule.enforcement}`,
    "",
  ];

  if (rule.pattern) {
    lines.push(`## Pattern`, "", "```regex", rule.pattern, "```", "");
  }

  if (rule.filePattern) {
    lines.push(`**Applies to:** \`${rule.filePattern}\``, "");
  }

  if (rule.examples.bad.length > 0) {
    lines.push("## Examples", "", "### ❌ Bad", "");
    for (const ex of rule.examples.bad) {
      lines.push("```", ex, "```", "");
    }
  }

  if (rule.examples.good.length > 0) {
    lines.push("### ✅ Good", "");
    for (const ex of rule.examples.good) {
      lines.push("```", ex, "```", "");
    }
  }

  if (rule.createdFrom) {
    lines.push("---", "", `Created from: ${rule.createdFrom}`);
  }

  return lines.join("\n");
}

/**
 * LLM-enforced rules that a purely local scan cannot check.
 *
 * `lgtm review scan` matches regex rules against a diff with no agent involved,
 * so these are reported as not evaluated rather than silently ignored.
 */
export function getSkippedLLMRules(rules: Rule[], llmAvailable: boolean): Rule[] {
  if (llmAvailable) return [];
  return rules.filter((r) => r.enabled && r.enforcement === "llm");
}

export type RulesEngine = ReturnType<typeof createRulesEngine>;

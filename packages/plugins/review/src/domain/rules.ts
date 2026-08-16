/**
 * Rules Engine — create, load, match, and enforce review rules.
 *
 * Rules are stored as individual OKF markdown files in .yak/rules/.
 * Each rule has: description, category, severity, enforcement type,
 * optional regex pattern, file glob, and examples (bad/good).
 *
 * Enforcement modes:
 * - "regex": pattern matched against diff lines (zero tokens)
 * - "llm": sent to LLM with examples (Task 12)
 */

import type { OKFStore } from "@yak/core/plugin.js";
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
   * Load all rules from .yak/rules/*.md
   */
  async function loadRules(): Promise<Rule[]> {
    const files = await store.list("rules");
    const rules: Rule[] = [];

    for (const file of files) {
      if (file === "rules/index.md") continue; // skip index
      const doc = await store.read(file);
      if (!doc || doc.data.type !== "yak/rule") continue;

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
      type: "yak/rule",
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

  /**
   * Match LLM rules against a parsed diff.
   * Sends rule description + examples + changed file content to the LLM.
   * Scoped to changed files ONLY (direct enforcement).
   *
   * @param rules - All rules (only LLM rules will be checked)
   * @param diff - Parsed diff to check
   * @param llm - LLM provider instance
   * @returns Violations found by the LLM
   */
  async function matchLLM(
    rules: Rule[],
    diff: ParsedDiff,
    llm: { complete: (prompt: string, options?: { maxTokens?: number; temperature?: number; systemPrompt?: string }) => Promise<string> }
  ): Promise<RuleViolation[]> {
    const llmRules = rules.filter((r) => r.enabled && r.enforcement === "llm");
    if (llmRules.length === 0) return [];

    const violations: RuleViolation[] = [];

    for (const rule of llmRules) {
      // Build diff content scoped to matching files only
      const relevantFiles = diff.files.filter((f) => {
        if (rule.filePattern) return minimatch(f.path, rule.filePattern);
        return true;
      });

      if (relevantFiles.length === 0) continue;

      // Build a compact representation of changes (only added lines)
      const changesText = relevantFiles
        .map((f) => {
          const addedLines = f.hunks
            .flatMap((h) => h.lines)
            .filter((l) => l.type === "added")
            .map((l) => `${f.path}:${l.newLine}: ${l.content}`);
          return addedLines.join("\n");
        })
        .filter((s) => s.length > 0)
        .join("\n");

      if (!changesText) continue;

      // Truncate to stay within token budget (~4000 chars ≈ 1000 tokens)
      const truncated = changesText.slice(0, 4000);

      const prompt = buildEnforcementPrompt(rule, truncated);

      try {
        const response = await llm.complete(prompt, {
          maxTokens: 500,
          temperature: 0.1,
          systemPrompt: "You are a code reviewer checking for rule violations. Respond ONLY with valid JSON.",
        });

        const parsed = parseViolationResponse(response, rule.id);
        violations.push(...parsed);
      } catch {
        // LLM failure — skip silently (don't block review)
        continue;
      }
    }

    return violations;
  }

  return {
    loadRules,
    createRule,
    matchRegex,
    matchLLM,
    incrementTriggered,
    setEnabled,
  };
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
 * Build the LLM prompt for rule enforcement.
 */
function buildEnforcementPrompt(rule: Rule, changesText: string): string {
  let prompt = `Check the following code changes for violations of this rule:

Rule: ${rule.description}
Category: ${rule.category}
Severity: ${rule.severity}
`;

  if (rule.examples.bad.length > 0) {
    prompt += `\nExamples of violations:\n${rule.examples.bad.map((e) => `- ${e}`).join("\n")}\n`;
  }
  if (rule.examples.good.length > 0) {
    prompt += `\nExamples of correct code:\n${rule.examples.good.map((e) => `- ${e}`).join("\n")}\n`;
  }

  prompt += `\nCode changes to check (format: file:line: content):
${changesText}

If there are violations, respond with a JSON array:
[{"file": "path/to/file.ts", "line": 42, "explanation": "why this violates the rule", "suggestion": "how to fix"}]

If no violations, respond with: []`;

  return prompt;
}

/**
 * Parse the LLM's violation response.
 */
function parseViolationResponse(response: string, ruleId: string): RuleViolation[] {
  try {
    // Extract JSON from response (might have markdown wrapping)
    const jsonMatch = response.match(/\[[\s\S]*?\]/);
    if (!jsonMatch) return [];

    const parsed = JSON.parse(jsonMatch[0]);
    if (!Array.isArray(parsed)) return [];

    return parsed
      .filter((v: any) => v.file && v.line)
      .map((v: any) => ({
        ruleId,
        file: v.file,
        line: typeof v.line === "number" ? v.line : parseInt(v.line, 10),
        explanation: v.explanation ?? "Rule violation detected",
        suggestion: v.suggestion,
      }));
  } catch {
    return [];
  }
}

/**
 * Check which LLM rules would be skipped (for user warning).
 * Returns rules that need LLM but LLM is unavailable.
 */
export function getSkippedLLMRules(rules: Rule[], llmAvailable: boolean): Rule[] {
  if (llmAvailable) return [];
  return rules.filter((r) => r.enabled && r.enforcement === "llm");
}

export type RulesEngine = ReturnType<typeof createRulesEngine>;

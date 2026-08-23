/**
 * Auto Review Engine — AI-powered PR review delegation.
 *
 * Analyzes a PR diff using the rules engine + an LLM pass, then produces
 * structured review findings filtered to HIGH/CRITICAL severity only.
 *
 * Entry point: `generateAutoReview()`
 *
 * Data flow:
 *   1. Run regex rules against diff (zero tokens)
 *   2. Run LLM rules against diff (scoped enforcement)
 *   3. Run general LLM review pass (holistic, high-severity only)
 *   4. Deduplicate against existing PR comments
 *   5. Format findings using profile's feedbackStyle
 *
 * @module auto-review
 */

import type { LLMProvider, ProjectProfile } from "@lgtm/core/plugin.js";
import type { ParsedDiff } from "./diff-parser.js";
import type { Rule } from "./rules.js";
import type { RuleViolation } from "./types.js";
import { getDiffStats } from "./diff-parser.js";

// ─── Types ──────────────────────────────────────────────────────────────────

/**
 * Severity levels for auto-review findings.
 * Only HIGH and CRITICAL are posted to PRs by default.
 */
export type ReviewSeverity = "low" | "medium" | "high" | "critical";

/**
 * A single finding from the auto-review engine.
 */
export interface ReviewFinding {
  /** File path relative to repo root */
  file: string;

  /** Line number in the new version (for inline comment placement) */
  line: number;

  /** The review comment body (already formatted with tone) */
  comment: string;

  /** Severity classification */
  severity: ReviewSeverity;

  /** Source of this finding */
  source: "rule-regex" | "rule-llm" | "llm-review";

  /** Rule ID if from a rule violation */
  ruleId?: string;

  /** Optional suggestion for a fix */
  suggestion?: string;
}

/**
 * Complete output from the auto-review engine.
 */
export interface AutoReviewResult {
  /** All findings (filtered to threshold) */
  findings: ReviewFinding[];

  /** Summary of what was reviewed */
  summary: string;

  /** Stats about the review */
  stats: {
    filesReviewed: number;
    rulesChecked: number;
    llmTokensEstimated: number;
    totalFindings: number;
    filteredFindings: number;
  };
}

/**
 * Configuration for the auto-review engine.
 */
export interface AutoReviewConfig {
  /** Minimum severity to include in output (default: "high") */
  severityThreshold: ReviewSeverity;

  /** Formatting rules */
  formatting: {
    noEmDashes: boolean;
    noSemicolons: boolean;
    noSeverityLabels: boolean;
  };
}

/**
 * Existing comments on a PR (for deduplication).
 */
export interface ExistingComment {
  file?: string;
  line?: number;
  body: string;
}

// ─── Constants ──────────────────────────────────────────────────────────────

const SEVERITY_ORDER: Record<ReviewSeverity, number> = {
  low: 0,
  medium: 1,
  high: 2,
  critical: 3,
};

const DEFAULT_CONFIG: AutoReviewConfig = {
  severityThreshold: "high",
  formatting: {
    noEmDashes: true,
    noSemicolons: true,
    noSeverityLabels: true,
  },
};

// ─── Main Entry Point ───────────────────────────────────────────────────────

/**
 * Generate an automated review for a PR diff.
 *
 * Combines rule enforcement (regex + LLM) with a general LLM review pass.
 * Results are filtered by severity, deduplicated, and formatted with the
 * user's configured tone.
 *
 * @param diff - Parsed PR diff
 * @param rules - All loaded review rules
 * @param profile - User's project profile (for feedbackStyle)
 * @param llm - LLM provider instance
 * @param existingComments - Comments already on the PR (for dedup)
 * @param config - Auto-review configuration overrides
 * @returns Structured review findings ready for posting
 *
 * @example
 * ```ts
 * const result = await generateAutoReview(diff, rules, profile, llm, [], {
 *   severityThreshold: "high",
 *   formatting: { noEmDashes: true, noSemicolons: true, noSeverityLabels: true },
 * });
 * // result.findings → ready to post to GitHub
 * ```
 */
export async function generateAutoReview(
  diff: ParsedDiff,
  rules: Rule[],
  profile: ProjectProfile | null,
  llm: LLMProvider,
  existingComments: ExistingComment[] = [],
  config: Partial<AutoReviewConfig> = {}
): Promise<AutoReviewResult> {
  const resolvedConfig = { ...DEFAULT_CONFIG, ...config };
  const feedbackStyle = "direct";
  const findings: ReviewFinding[] = [];

  // ── Step 1: Rule-based regex matching (zero tokens) ────────────────────
  const enabledRules = rules.filter((r) => r.enabled);
  const regexFindings = runRegexRules(enabledRules, diff);
  findings.push(...regexFindings);

  // ── Step 2: Rule-based LLM enforcement (scoped per rule) ───────────────
  const llmRuleFindings = await runLLMRules(enabledRules, diff, llm);
  findings.push(...llmRuleFindings);

  // ── Step 3: General LLM review pass (holistic) ─────────────────────────
  const llmReviewFindings = await runLLMReview(diff, feedbackStyle, llm, resolvedConfig);
  findings.push(...llmReviewFindings);

  // ── Step 4: Filter by severity threshold ───────────────────────────────
  const thresholdLevel = SEVERITY_ORDER[resolvedConfig.severityThreshold];
  const filtered = findings.filter(
    (f) => SEVERITY_ORDER[f.severity] >= thresholdLevel
  );

  // ── Step 5: Deduplicate against existing comments ──────────────────────
  const deduplicated = deduplicateFindings(filtered, existingComments);

  // ── Step 6: Apply tone formatting ─────────────────────────────────────
  const formatted = deduplicated.map((f) =>
    applyFormatting(f, resolvedConfig.formatting)
  );

  // ── Build stats ────────────────────────────────────────────────────────
  const stats = getDiffStats(diff);
  const tokensEstimated = estimateTokens(diff);

  const summary = buildReviewSummary(formatted, stats, enabledRules.length);

  return {
    findings: formatted,
    summary,
    stats: {
      filesReviewed: stats.filesChanged,
      rulesChecked: enabledRules.length,
      llmTokensEstimated: tokensEstimated,
      totalFindings: findings.length,
      filteredFindings: formatted.length,
    },
  };
}

// ─── Step 1: Regex Rule Enforcement ─────────────────────────────────────────

/**
 * Run regex-based rules against the diff. Zero token cost.
 * Maps rule severity to review severity (error → high, warn → medium).
 */
function runRegexRules(rules: Rule[], diff: ParsedDiff): ReviewFinding[] {
  const findings: ReviewFinding[] = [];
  const regexRules = rules.filter((r) => r.enforcement === "regex" && r.pattern);

  for (const rule of regexRules) {
    let regex: RegExp;
    try {
      regex = new RegExp(rule.pattern!, "gi");
    } catch {
      continue;
    }

    for (const file of diff.files) {
      if (file.status === "binary") continue;

      // Check file pattern
      if (rule.filePattern) {
        try {
          const { minimatch } = require("minimatch");
          if (!minimatch(file.path, rule.filePattern)) continue;
        } catch {
          continue;
        }
      }

      for (const hunk of file.hunks) {
        for (const line of hunk.lines) {
          if (line.type !== "added") continue;

          regex.lastIndex = 0;
          if (regex.test(line.content)) {
            findings.push({
              file: file.path,
              line: line.newLine ?? 0,
              comment: rule.description,
              severity: rule.severity === "error" ? "high" : "medium",
              source: "rule-regex",
              ruleId: rule.id,
              suggestion: rule.examples.good.length > 0
                ? `Consider: ${rule.examples.good[0]}`
                : undefined,
            });
          }
        }
      }
    }
  }

  return findings;
}

// ─── Step 2: LLM Rule Enforcement ───────────────────────────────────────────

/**
 * Run LLM-based rules against scoped file diffs.
 * Each rule is checked independently against matching files.
 */
async function runLLMRules(
  rules: Rule[],
  diff: ParsedDiff,
  llm: LLMProvider
): Promise<ReviewFinding[]> {
  const llmRules = rules.filter((r) => r.enforcement === "llm");
  if (llmRules.length === 0) return [];

  if (!(await llm.isAvailable())) return [];

  const findings: ReviewFinding[] = [];

  for (const rule of llmRules) {
    // Scope to matching files
    const relevantFiles = diff.files.filter((f) => {
      if (f.status === "binary") return false;
      if (rule.filePattern) {
        try {
          const { minimatch } = require("minimatch");
          return minimatch(f.path, rule.filePattern);
        } catch { return true; }
      }
      return true;
    });

    if (relevantFiles.length === 0) continue;

    // Build compact diff of added lines only
    const changesText = relevantFiles
      .map((f) => {
        const addedLines = f.hunks
          .flatMap((h) => h.lines)
          .filter((l) => l.type === "added")
          .map((l) => `${f.path}:${l.newLine}: ${l.content}`);
        return addedLines.join("\n");
      })
      .filter((s) => s.length > 0)
      .join("\n")
      .slice(0, 4000);

    if (!changesText) continue;

    const prompt = `Check this code for the following rule violation:

Rule: ${rule.description}
Category: ${rule.category}
${rule.examples.bad.length > 0 ? `Bad example: ${rule.examples.bad[0]}` : ""}
${rule.examples.good.length > 0 ? `Good example: ${rule.examples.good[0]}` : ""}

Code changes:
${changesText}

If there are violations, respond with a JSON array:
[{"file": "path/to/file.ts", "line": 42, "comment": "explanation", "severity": "high"}]

If no violations, respond with: []`;

    try {
      const response = await llm.complete(prompt, {
        maxTokens: 500,
        temperature: 0.1,
        systemPrompt: "You are a code reviewer checking for rule violations. Respond ONLY with valid JSON.",
      });

      const parsed = parseJSONFindings(response, "rule-llm", rule.id);
      findings.push(...parsed);
    } catch {
      // LLM failure — skip silently
      continue;
    }
  }

  return findings;
}

// ─── Step 3: General LLM Review Pass ────────────────────────────────────────

/**
 * Run a holistic LLM review pass across the entire diff.
 * Focuses on high-impact issues that rules might miss:
 * logic bugs, security holes, performance problems, missing error handling.
 */
async function runLLMReview(
  diff: ParsedDiff,
  feedbackStyle: string,
  llm: LLMProvider,
  config: AutoReviewConfig
): Promise<ReviewFinding[]> {
  if (!(await llm.isAvailable())) return [];

  const stats = getDiffStats(diff);
  const compactDiff = buildReviewDiff(diff, 6000);

  if (!compactDiff) return [];

  const toneInstructions = getToneInstructions(feedbackStyle);

  const prompt = `Review this PR diff. Focus ONLY on high-impact issues:
- Security vulnerabilities
- Logic bugs that would cause incorrect behavior
- Performance problems (O(n²) or worse, memory leaks)
- Missing error handling for critical paths
- Race conditions or concurrency issues

DO NOT flag: style issues, naming preferences, missing comments, minor refactors.

Stats: ${stats.filesChanged} files, +${stats.additions} -${stats.deletions}

${compactDiff}

Respond with a JSON array of findings. Each finding must have:
- "file": relative file path
- "line": line number in the new version
- "comment": review comment (${toneInstructions})
- "severity": "high" or "critical" only

If no high-impact issues found, respond with: []`;

  const systemPrompt = buildSystemPrompt(feedbackStyle, config.formatting);

  try {
    const response = await llm.complete(prompt, {
      maxTokens: 1500,
      temperature: 0.2,
      systemPrompt,
    });

    return parseJSONFindings(response, "llm-review");
  } catch {
    return [];
  }
}

// ─── Deduplication ──────────────────────────────────────────────────────────

/**
 * Remove findings that duplicate existing PR comments.
 * Matches on file + line proximity + content similarity.
 */
function deduplicateFindings(
  findings: ReviewFinding[],
  existingComments: ExistingComment[]
): ReviewFinding[] {
  if (existingComments.length === 0) return findings;

  return findings.filter((finding) => {
    const isDuplicate = existingComments.some((comment) => {
      // Same file and line
      if (comment.file === finding.file && comment.line === finding.line) {
        return true;
      }

      // Similar content (simple substring check)
      if (comment.body && finding.comment) {
        const normalizedExisting = comment.body.toLowerCase().trim();
        const normalizedNew = finding.comment.toLowerCase().trim();

        // If the first 50 chars overlap significantly, consider it a duplicate
        const snippet = normalizedNew.slice(0, 50);
        if (normalizedExisting.includes(snippet)) {
          return true;
        }
      }

      return false;
    });

    return !isDuplicate;
  });
}

// ─── Formatting ─────────────────────────────────────────────────────────────

/**
 * Apply formatting rules to a finding's comment text.
 */
function applyFormatting(
  finding: ReviewFinding,
  formatting: AutoReviewConfig["formatting"]
): ReviewFinding {
  let comment = finding.comment;

  if (formatting.noEmDashes) {
    comment = comment.replace(/—/g, " - ");
  }

  if (formatting.noSemicolons) {
    comment = comment.replace(/;/g, ".");
  }

  if (formatting.noSeverityLabels) {
    // Strip severity prefixes like "[HIGH]", "CRITICAL:", etc.
    comment = comment.replace(/^\[(high|critical|medium|low)\]\s*/i, "");
    comment = comment.replace(/^(high|critical|medium|low):\s*/i, "");
  }

  return { ...finding, comment };
}

// ─── Prompt Building ────────────────────────────────────────────────────────

/**
 * Build the system prompt based on feedback style and formatting rules.
 */
function buildSystemPrompt(
  feedbackStyle: string,
  formatting: AutoReviewConfig["formatting"]
): string {
  const toneInstructions = getToneInstructions(feedbackStyle);

  let prompt = `You are a senior code reviewer. ${toneInstructions}

Focus only on high-impact issues. Respond ONLY with valid JSON.`;

  if (formatting.noEmDashes) {
    prompt += "\nDo not use em dashes (—). Use hyphens or rewrite.";
  }
  if (formatting.noSemicolons) {
    prompt += "\nDo not use semicolons in prose. Use periods instead.";
  }
  if (formatting.noSeverityLabels) {
    prompt += "\nDo not prefix comments with severity labels like [HIGH] or CRITICAL:.";
  }

  return prompt;
}

/**
 * Map feedbackStyle to concrete writing instructions for the LLM.
 */
function getToneInstructions(feedbackStyle: string): string {
  switch (feedbackStyle) {
    case "direct":
      return "Be concise and direct. State the issue plainly. No sugar-coating.";
    case "gentle":
      return "Be polite and constructive. Frame issues as suggestions. Use 'consider' and 'might want to'.";
    case "socratic":
      return "Guide via questions. Ask 'What happens if...?' or 'Have you considered...?' to lead the developer to the issue.";
    case "minimal":
      return "Be extremely brief. One sentence max per comment. Only critical issues.";
    default:
      return "Be concise and direct. State the issue plainly.";
  }
}

/**
 * Build a compact diff representation for the general LLM review pass.
 * Includes both added and removed lines (with context) for holistic review.
 */
function buildReviewDiff(diff: ParsedDiff, maxChars: number): string {
  const parts: string[] = [];
  let totalChars = 0;

  for (const file of diff.files) {
    if (file.status === "binary") continue;

    const header = `\n=== ${file.path} (${file.status}) ===\n`;
    if (totalChars + header.length > maxChars) break;
    parts.push(header);
    totalChars += header.length;

    for (const hunk of file.hunks) {
      // Include hunk context header
      if (hunk.context) {
        const ctx = `  [${hunk.context}]\n`;
        parts.push(ctx);
        totalChars += ctx.length;
      }

      for (const line of hunk.lines) {
        let entry: string;
        if (line.type === "added") {
          entry = `+${line.newLine}: ${line.content}\n`;
        } else if (line.type === "removed") {
          entry = `-${line.oldLine}: ${line.content}\n`;
        } else {
          continue; // Skip context lines to save tokens
        }

        if (totalChars + entry.length > maxChars) {
          parts.push("... (truncated)\n");
          return parts.join("");
        }

        parts.push(entry);
        totalChars += entry.length;
      }
    }
  }

  return parts.join("");
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Parse JSON response from LLM into ReviewFinding objects.
 * Gracefully handles malformed responses.
 */
function parseJSONFindings(
  response: string,
  source: ReviewFinding["source"],
  ruleId?: string
): ReviewFinding[] {
  try {
    // Extract JSON array from response (handle markdown code blocks)
    const jsonMatch = response.match(/\[[\s\S]*\]/);
    if (!jsonMatch) return [];

    const parsed = JSON.parse(jsonMatch[0]);
    if (!Array.isArray(parsed)) return [];

    return parsed
      .filter(
        (item: any) =>
          item &&
          typeof item.file === "string" &&
          typeof item.line === "number" &&
          typeof item.comment === "string"
      )
      .map((item: any) => ({
        file: item.file,
        line: item.line,
        comment: item.comment,
        severity: validateSeverity(item.severity),
        source,
        ruleId,
        suggestion: item.suggestion,
      }));
  } catch {
    return [];
  }
}

/**
 * Validate and normalize severity string.
 */
function validateSeverity(s: unknown): ReviewSeverity {
  if (typeof s === "string") {
    const lower = s.toLowerCase();
    if (lower === "critical" || lower === "high" || lower === "medium" || lower === "low") {
      return lower;
    }
  }
  return "high"; // Default to high if unspecified/invalid
}

/**
 * Estimate token usage for a diff.
 * Rough heuristic: ~4 chars per token.
 */
function estimateTokens(diff: ParsedDiff): number {
  let chars = 0;
  for (const file of diff.files) {
    for (const hunk of file.hunks) {
      for (const line of hunk.lines) {
        if (line.type === "added" || line.type === "removed") {
          chars += line.content.length + file.path.length + 10;
        }
      }
    }
  }
  return Math.ceil(chars / 4);
}

/**
 * Build a human-readable summary of the review.
 */
function buildReviewSummary(
  findings: ReviewFinding[],
  stats: { filesChanged: number; additions: number; deletions: number },
  rulesChecked: number
): string {
  if (findings.length === 0) {
    return `Reviewed ${stats.filesChanged} files (+${stats.additions} -${stats.deletions}) against ${rulesChecked} rules. No high-severity issues found.`;
  }

  const critical = findings.filter((f) => f.severity === "critical").length;
  const high = findings.filter((f) => f.severity === "high").length;

  const parts = [`Found ${findings.length} issue(s)`];
  if (critical > 0) parts.push(`${critical} critical`);
  if (high > 0) parts.push(`${high} high`);
  parts.push(`across ${stats.filesChanged} files`);

  return parts.join(", ") + ".";
}

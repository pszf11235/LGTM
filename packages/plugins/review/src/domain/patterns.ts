/**
 * Comment Pattern Analysis — ruleify from reviewer behavior.
 *
 * Mines review comment history for repeated themes:
 * "You commented about X five times across different PRs → create a rule?"
 *
 * Uses LLM to identify patterns (or simple text matching as fallback).
 */

import type { OKFStore, LLMProvider } from "@lgtm/core/plugin.js";
import type { ReviewComment } from "./types.js";
import { createRulesEngine, type Rule } from "./rules.js";

/**
 * A suggested rule derived from comment patterns.
 */
export interface RuleSuggestion {
  description: string;
  category: Rule["category"];
  severity: Rule["severity"];
  enforcement: Rule["enforcement"];
  pattern?: string;
  examples: { bad: string[]; good: string[] };
  sourceComments: string[]; // the comments that triggered this suggestion
  confidence: "high" | "medium" | "low";
}

/**
 * Analyze review comments for repeated patterns and suggest rules.
 *
 * @param store - OKF store to read review history
 * @param llm - LLM provider (optional — falls back to text matching)
 * @returns Suggested rules
 */
export async function analyzeCommentPatterns(
  store: OKFStore,
  llm?: LLMProvider | null
): Promise<RuleSuggestion[]> {
  // Collect all comments from review sessions
  const comments = await collectAllComments(store);

  if (comments.length < 3) {
    return []; // Need at least 3 comments to find patterns
  }

  if (llm && await llm.isAvailable()) {
    return await analyzeWithLLM(comments, llm);
  }

  return analyzeWithTextMatching(comments);
}

/**
 * Collect all comments from review session files.
 * Sessions are stored at sessions/YYYY-MM-DD/pr-N.md (date subdirectories).
 * Also handles flat structure (sessions/pr-N.md) for backward compat.
 */
async function collectAllComments(
  store: OKFStore
): Promise<Array<{ text: string; file: string; pr: number }>> {
  const comments: Array<{ text: string; file: string; pr: number }> = [];

  // Strategy 1: Scan for date subdirectories (sessions/YYYY-MM-DD/)
  // Since store.list() only returns .md files, we need to discover subdirs
  // by looking for index.md files at the sessions level AND in subdirs.
  try {
    const fs = await import("fs");
    const path = await import("path");

    // Get the store's root directory by reading a known path
    // We'll use a filesystem scan as store.list() can't recurse
    const topFiles = await store.list("sessions");

    // Check flat files first (backward compat: sessions/pr-N.md)
    for (const sessionFile of topFiles) {
      if (sessionFile.endsWith("index.md")) {
        // This is sessions/index.md — check for pr files in same dir
        const dir = sessionFile.replace("/index.md", "");
        const dirFiles = await store.list(dir);
        for (const reviewFile of dirFiles) {
          if (reviewFile.endsWith("index.md")) continue;
          const review = await store.read(reviewFile);
          if (!review || review.data.type !== "lgtm/review") continue;
          const prNumber = (review.data.pr as number) ?? 0;
          const extracted = extractCommentsFromMarkdown(review.content, prNumber);
          comments.push(...extracted);
        }
      } else {
        // Flat file: sessions/pr-N.md (backward compat)
        const review = await store.read(sessionFile);
        if (!review || review.data.type !== "lgtm/review") continue;
        const prNumber = (review.data.pr as number) ?? 0;
        const extracted = extractCommentsFromMarkdown(review.content, prNumber);
        comments.push(...extracted);
      }
    }

    // Strategy 2: Try date subdirectories (sessions/YYYY-MM-DD/)
    // Attempt to list files from recent date directories
    const today = new Date();
    for (let daysBack = 0; daysBack < 90; daysBack++) {
      const d = new Date(today);
      d.setDate(d.getDate() - daysBack);
      const dateStr = d.toISOString().split("T")[0];
      const dateDirFiles = await store.list(`sessions/${dateStr}`);

      for (const reviewFile of dateDirFiles) {
        if (reviewFile.endsWith("index.md")) continue;
        const review = await store.read(reviewFile);
        if (!review || review.data.type !== "lgtm/review") continue;
        const prNumber = (review.data.pr as number) ?? 0;
        const extracted = extractCommentsFromMarkdown(review.content, prNumber);
        comments.push(...extracted);
      }
    }
  } catch {
    // If filesystem access fails, fall back to flat scan only
  }

  return comments;
}

/**
 * Extract comments from review markdown body.
 * Looks for patterns like: - **L14:** comment text
 */
function extractCommentsFromMarkdown(
  content: string,
  prNumber: number
): Array<{ text: string; file: string; pr: number }> {
  const comments: Array<{ text: string; file: string; pr: number }> = [];
  let currentFile = "";

  for (const line of content.split("\n")) {
    // File headers: ### src/auth/login.ts
    const fileMatch = line.match(/^###\s+(.+)/);
    if (fileMatch) {
      currentFile = fileMatch[1].trim();
      continue;
    }

    // Comment lines: - **L14:** comment text
    const commentMatch = line.match(/^-\s+\*\*L\d+:\*\*\s+(.+)/);
    if (commentMatch) {
      comments.push({
        text: commentMatch[1].trim(),
        file: currentFile,
        pr: prNumber,
      });
    }
  }

  return comments;
}

/**
 * LLM-powered pattern analysis.
 */
async function analyzeWithLLM(
  comments: Array<{ text: string; file: string; pr: number }>,
  llm: LLMProvider
): Promise<RuleSuggestion[]> {
  const commentTexts = comments
    .map((c) => `[PR#${c.pr} ${c.file}]: ${c.text}`)
    .slice(0, 50) // limit context
    .join("\n");

  const prompt = `Analyze these code review comments and identify repeated patterns (same feedback given multiple times across different PRs).

Review comments:
${commentTexts}

For each pattern you find (minimum 2 similar comments), suggest a rule:
- description: clear one-line rule description
- category: security|style|testing|architecture|performance|general
- severity: warn or error
- pattern: regex to detect violations (if possible, otherwise null)
- bad: example code that violates this
- good: example code that follows this
- sourceComments: the original comments that form this pattern
- confidence: high (3+ identical), medium (2-3 similar), low (thematic)

Respond with JSON array only. If no patterns found, respond with [].`;

  try {
    const response = await llm.complete(prompt, { maxTokens: 1500, temperature: 0.2 });
    return parsePatternResponse(response);
  } catch {
    return analyzeWithTextMatching(comments);
  }
}

/**
 * Simple text-matching fallback (no LLM needed).
 * Groups comments by similarity and suggests rules for repeated ones.
 */
function analyzeWithTextMatching(
  comments: Array<{ text: string; file: string; pr: number }>
): RuleSuggestion[] {
  // Normalize and group by lowercased keywords
  const groups = new Map<string, Array<{ text: string; file: string; pr: number }>>();

  for (const comment of comments) {
    const key = normalizeComment(comment.text);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(comment);
  }

  const suggestions: RuleSuggestion[] = [];

  for (const [_, group] of groups) {
    if (group.length < 2) continue; // Need 2+ similar comments

    // Check they're from different PRs (not just commenting same thing in one review)
    const uniquePRs = new Set(group.map((c) => c.pr));
    if (uniquePRs.size < 2) continue;

    suggestions.push({
      description: group[0].text.slice(0, 80),
      category: "general",
      severity: "warn",
      enforcement: "llm",
      examples: { bad: [], good: [] },
      sourceComments: group.map((c) => `[PR#${c.pr}] ${c.text}`),
      confidence: group.length >= 3 ? "high" : "medium",
    });
  }

  return suggestions.sort((a, b) => {
    const conf = { high: 3, medium: 2, low: 1 };
    return conf[b.confidence] - conf[a.confidence];
  });
}

/**
 * Normalize a comment for grouping (lowercase, strip noise).
 */
function normalizeComment(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z\s]/g, "")
    .split(/\s+/)
    .filter((w) => w.length > 3) // skip small words
    .sort()
    .slice(0, 5) // use top 5 keywords
    .join(" ");
}

/**
 * Parse LLM pattern analysis response.
 */
function parsePatternResponse(response: string): RuleSuggestion[] {
  try {
    const jsonMatch = response.match(/\[[\s\S]*\]/);
    if (!jsonMatch) return [];

    const parsed = JSON.parse(jsonMatch[0]);
    if (!Array.isArray(parsed)) return [];

    return parsed
      .filter((s: any) => s.description)
      .map((s: any) => ({
        description: s.description,
        category: s.category ?? "general",
        severity: s.severity ?? "warn",
        enforcement: s.pattern ? "regex" : "llm",
        pattern: s.pattern ?? undefined,
        examples: {
          bad: s.bad ?? s.examples?.bad ?? [],
          good: s.good ?? s.examples?.good ?? [],
        },
        sourceComments: s.sourceComments ?? [],
        confidence: s.confidence ?? "medium",
      }));
  } catch {
    return [];
  }
}

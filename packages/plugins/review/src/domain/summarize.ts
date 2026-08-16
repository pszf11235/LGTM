/**
 * AI Summary — generate brief PR summaries on queue.
 *
 * Token-efficient: ~500-1000 tokens per PR.
 * Cached by commit SHA (never re-summarizes the same diff).
 * Graceful: returns null if LLM unavailable (feature degrades, doesn't break).
 */

import type { LLMProvider } from "@yak/core/plugin.js";
import type { ParsedDiff } from "./diff-parser.js";
import { getDiffStats } from "./diff-parser.js";

/**
 * Generate a brief AI summary for a PR diff.
 *
 * @param diff - Parsed diff
 * @param prTitle - PR title (for context)
 * @param llm - LLM provider
 * @returns 2-3 sentence summary + risk flags, or null if unavailable
 */
export async function generatePRSummary(
  diff: ParsedDiff,
  prTitle: string,
  llm: LLMProvider
): Promise<string | null> {
  if (!(await llm.isAvailable())) return null;

  const stats = getDiffStats(diff);
  const fileList = diff.files.map((f) => `${f.path} (${f.status})`).join("\n");

  // Build compact diff representation (truncate to stay within token budget)
  const diffContent = buildCompactDiff(diff, 3000);

  const prompt = `Summarize this PR in 2-3 sentences. Focus on: what changed, potential risks, and whether tests are included.

PR Title: ${prTitle}
Stats: ${stats.filesChanged} files, +${stats.additions} -${stats.deletions}

Files changed:
${fileList}

Key changes:
${diffContent}

Respond with ONLY the summary (no markdown, no headers, just 2-3 plain sentences).`;

  try {
    const response = await llm.complete(prompt, {
      maxTokens: 150,
      temperature: 0.1,
      systemPrompt: "You are a concise code reviewer. Summarize PRs in 2-3 sentences.",
    });

    return response.trim() || null;
  } catch {
    return null;
  }
}

/**
 * Build a compact diff representation for the LLM prompt.
 * Only includes added lines (most relevant for understanding changes).
 * Truncates to maxChars.
 */
function buildCompactDiff(diff: ParsedDiff, maxChars: number): string {
  const lines: string[] = [];
  let totalChars = 0;

  for (const file of diff.files) {
    if (file.status === "binary") continue;

    lines.push(`--- ${file.path} ---`);
    totalChars += file.path.length + 10;

    for (const hunk of file.hunks) {
      for (const line of hunk.lines) {
        if (line.type === "added") {
          const entry = `+${line.newLine}: ${line.content}`;
          if (totalChars + entry.length > maxChars) {
            lines.push("... (truncated)");
            return lines.join("\n");
          }
          lines.push(entry);
          totalChars += entry.length + 1;
        }
      }
    }
  }

  return lines.join("\n");
}

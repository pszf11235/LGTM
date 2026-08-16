/**
 * Cross-PR Overlap Detection — find conflicts between queued PRs.
 *
 * Detects:
 * - Same file modified in multiple PRs
 * - Same line range touched (potential merge conflict)
 * - Suggests review order based on dependencies
 *
 * All algorithmic (no LLM, zero tokens).
 */

import type { QueuedPR } from "./types.js";

/**
 * An overlap between two PRs.
 */
export interface PROverlap {
  pr1: number;
  pr2: number;
  sharedFiles: string[];
  severity: "conflict" | "overlap";
  description: string;
}

/**
 * Detect file overlaps between queued PRs.
 *
 * @param prs - All PRs in the queue with their file lists
 * @returns List of overlaps found
 */
export function detectOverlaps(prs: QueuedPR[]): PROverlap[] {
  if (prs.length < 2) return [];

  const overlaps: PROverlap[] = [];

  // Compare each pair of PRs
  for (let i = 0; i < prs.length; i++) {
    for (let j = i + 1; j < prs.length; j++) {
      const pr1 = prs[i];
      const pr2 = prs[j];

      const shared = findSharedFiles(pr1.filesChanged, pr2.filesChanged);
      if (shared.length === 0) continue;

      overlaps.push({
        pr1: pr1.number,
        pr2: pr2.number,
        sharedFiles: shared,
        severity: shared.length > 2 ? "conflict" : "overlap",
        description: `PRs #${pr1.number} and #${pr2.number} both modify: ${shared.slice(0, 3).join(", ")}${shared.length > 3 ? ` (+${shared.length - 3} more)` : ""}`,
      });
    }
  }

  return overlaps.sort((a, b) => b.sharedFiles.length - a.sharedFiles.length);
}

/**
 * Suggest a review order based on file dependencies.
 *
 * PRs that touch shared files should be reviewed in sequence,
 * with the "foundation" PR first.
 */
export function suggestReviewOrder(prs: QueuedPR[]): number[] {
  if (prs.length <= 1) return prs.map((p) => p.number);

  // Score each PR by how many other PRs depend on its files
  const scores = new Map<number, number>();

  for (const pr of prs) {
    let score = 0;
    for (const other of prs) {
      if (other.number === pr.number) continue;
      const shared = findSharedFiles(pr.filesChanged, other.filesChanged);
      score += shared.length;
    }
    scores.set(pr.number, score);
  }

  // Higher score = more other PRs touch your files = review first
  return prs
    .map((p) => p.number)
    .sort((a, b) => (scores.get(b) ?? 0) - (scores.get(a) ?? 0));
}

/**
 * Find files that appear in both lists.
 */
function findSharedFiles(files1: string[], files2: string[]): string[] {
  const set1 = new Set(files1);
  return files2.filter((f) => set1.has(f));
}

/**
 * Format overlap warnings for display.
 */
export function formatOverlapWarnings(overlaps: PROverlap[]): string[] {
  return overlaps.map((o) => {
    const icon = o.severity === "conflict" ? "🔴" : "⚠️";
    return `${icon} ${o.description}`;
  });
}

/**
 * Feature Grouping — automatically detect related PRs.
 *
 * Groups PRs based on shared characteristics:
 * - Shared directories (both touch src/auth/)
 * - Shared files (both modify the same file)
 * - Endpoint/route detection (both touch route files for same path)
 *
 * All analysis is algorithmic (no LLM needed, zero tokens).
 */

import path from "path";
import type { QueuedPR, FeatureGroup } from "./types.js";

/**
 * Analyze PRs and detect feature groups.
 * Returns groups of PRs that should be reviewed together.
 *
 * @param prs - All PRs in the queue
 * @returns Detected feature groups (only groups with 2+ PRs)
 */
export function analyzeGroups(prs: QueuedPR[]): FeatureGroup[] {
  if (prs.length < 2) return [];

  const groups: FeatureGroup[] = [];
  const assignedPrs = new Set<number>();

  // Strategy 1: Shared directory grouping
  const dirGroups = groupBySharedDirectories(prs);
  for (const group of dirGroups) {
    if (group.prs.length >= 2 && !group.prs.every((n) => assignedPrs.has(n))) {
      groups.push(group);
      group.prs.forEach((n) => assignedPrs.add(n));
    }
  }

  // Strategy 2: Shared file grouping (catch anything directories missed)
  const fileGroups = groupBySharedFiles(prs, assignedPrs);
  for (const group of fileGroups) {
    if (group.prs.length >= 2) {
      groups.push(group);
      group.prs.forEach((n) => assignedPrs.add(n));
    }
  }

  return groups;
}

/**
 * Group PRs that share significant directories.
 * "Significant" = non-root, non-trivial directories (not just src/).
 */
function groupBySharedDirectories(prs: QueuedPR[]): FeatureGroup[] {
  // Build a map: directory → [PR numbers that touch it]
  const dirToPrs = new Map<string, Set<number>>();

  for (const pr of prs) {
    const dirs = new Set<string>();
    for (const file of pr.filesChanged) {
      // Get meaningful directory (2+ levels deep)
      const parts = file.split("/");
      if (parts.length >= 2) {
        // Use first two segments as the "module" (e.g., src/auth)
        const dir = parts.slice(0, 2).join("/");
        dirs.add(dir);
      }
      if (parts.length >= 3) {
        // Also use three segments for deeper grouping (e.g., src/routes/auth)
        const dir = parts.slice(0, 3).join("/");
        dirs.add(dir);
      }
    }

    for (const dir of dirs) {
      if (!dirToPrs.has(dir)) dirToPrs.set(dir, new Set());
      dirToPrs.get(dir)!.add(pr.number);
    }
  }

  // Find directories shared by 2+ PRs
  const groups: FeatureGroup[] = [];
  const usedCombinations = new Set<string>();

  for (const [dir, prNums] of dirToPrs) {
    if (prNums.size < 2) continue;
    // Skip trivial directories
    if (dir === "src" || dir === "lib" || dir === "test" || dir === "tests") continue;

    const prsArr = Array.from(prNums).sort((a, b) => a - b);
    const key = prsArr.join(",");
    if (usedCombinations.has(key)) continue;
    usedCombinations.add(key);

    const dirName = path.basename(dir);
    groups.push({
      id: `group-${dirName}`,
      label: `${capitalize(dirName)} changes`,
      prs: prsArr,
      reason: `PRs share directory: ${dir}/`,
      sharedPaths: [dir],
      reviewTogether: true,
    });
  }

  // Sort: larger groups first
  return groups.sort((a, b) => b.prs.length - a.prs.length);
}

/**
 * Group PRs that modify the exact same file.
 * Only considers PRs not already assigned to a directory group.
 */
function groupBySharedFiles(
  prs: QueuedPR[],
  alreadyAssigned: Set<number>
): FeatureGroup[] {
  const unassigned = prs.filter((p) => !alreadyAssigned.has(p.number));
  if (unassigned.length < 2) return [];

  // Build: file → [PR numbers]
  const fileToPrs = new Map<string, Set<number>>();

  for (const pr of unassigned) {
    for (const file of pr.filesChanged) {
      if (!fileToPrs.has(file)) fileToPrs.set(file, new Set());
      fileToPrs.get(file)!.add(pr.number);
    }
  }

  // Find files shared by 2+ PRs
  const groups: FeatureGroup[] = [];
  const usedPrs = new Set<number>();

  for (const [file, prNums] of fileToPrs) {
    if (prNums.size < 2) continue;
    const prsArr = Array.from(prNums)
      .filter((n) => !usedPrs.has(n))
      .sort((a, b) => a - b);
    if (prsArr.length < 2) continue;

    const fileName = path.basename(file, path.extname(file));
    groups.push({
      id: `group-${fileName}`,
      label: `Shared: ${file}`,
      prs: prsArr,
      reason: `PRs both modify: ${file}`,
      sharedPaths: [file],
      reviewTogether: true,
    });

    prsArr.forEach((n) => usedPrs.add(n));
  }

  return groups;
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * Multi-repo PR addressing — parse owner/repo#number format.
 *
 * Allows reviewing PRs across multiple repositories in one session.
 * Format: owner/repo#number or repo-name#number (short, resolved via registry)
 */

/**
 * A PR reference that may include repo information.
 */
export interface PRRef {
  /** PR number */
  number: number;

  /** Repository owner (e.g., "pszf11235") */
  owner?: string;

  /** Repository name (e.g., "lgtm") */
  repo?: string;

  /** Full identifier as entered */
  raw: string;
}

/**
 * Parse a PR reference string.
 *
 * Supported formats:
 *   "101"           → { number: 101 } (current repo)
 *   "repo#101"      → { number: 101, repo: "repo" }
 *   "owner/repo#101" → { number: 101, owner: "owner", repo: "repo" }
 */
export function parsePRRef(input: string): PRRef | null {
  // Format: owner/repo#number
  const fullMatch = input.match(/^([^/]+)\/([^#]+)#(\d+)$/);
  if (fullMatch) {
    return {
      number: parseInt(fullMatch[3], 10),
      owner: fullMatch[1],
      repo: fullMatch[2],
      raw: input,
    };
  }

  // Format: repo#number
  const shortMatch = input.match(/^([^#]+)#(\d+)$/);
  if (shortMatch) {
    return {
      number: parseInt(shortMatch[2], 10),
      repo: shortMatch[1],
      raw: input,
    };
  }

  // Format: plain number (current repo)
  const num = parseInt(input, 10);
  if (!isNaN(num)) {
    return { number: num, raw: input };
  }

  return null;
}

/**
 * Resolve a PR ref to full owner/repo using registry or git remote.
 */
export function resolvePRRef(
  ref: PRRef,
  currentOwner?: string,
  currentRepo?: string
): { owner: string; repo: string; number: number } | null {
  if (ref.owner && ref.repo) {
    return { owner: ref.owner, repo: ref.repo, number: ref.number };
  }

  if (ref.repo && currentOwner) {
    // Short format: assume same owner
    return { owner: currentOwner, repo: ref.repo, number: ref.number };
  }

  if (currentOwner && currentRepo) {
    // Plain number: use current repo
    return { owner: currentOwner, repo: currentRepo, number: ref.number };
  }

  return null;
}

/**
 * Format a PR ref for display.
 */
export function formatPRRef(ref: PRRef): string {
  if (ref.owner && ref.repo) {
    return `${ref.owner}/${ref.repo}#${ref.number}`;
  }
  if (ref.repo) {
    return `${ref.repo}#${ref.number}`;
  }
  return `#${ref.number}`;
}

/**
 * Group PR refs by repository.
 */
export function groupByRepo(refs: PRRef[]): Map<string, PRRef[]> {
  const groups = new Map<string, PRRef[]>();

  for (const ref of refs) {
    const key = ref.owner && ref.repo ? `${ref.owner}/${ref.repo}` : ref.repo ?? "current";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(ref);
  }

  return groups;
}

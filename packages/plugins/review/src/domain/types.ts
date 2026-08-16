/**
 * Domain types for the review plugin.
 */

/**
 * A PR in the review queue.
 */
export interface QueuedPR {
  /** PR number (GitHub) or branch identifier (local) */
  number: number;

  /** PR title */
  title: string;

  /** Current review state */
  state: "queued" | "reviewing" | "approved" | "flagged";

  /** When added to queue */
  addedAt: string;

  /** When review was completed */
  reviewedAt?: string;

  /** Reason for flagging (if state is 'flagged') */
  flagReason?: string;

  /** AI-generated summary (cached) */
  summary?: string;

  /** Commit SHA used to generate summary (cache key) */
  summaryHash?: string;

  /** List of changed file paths */
  filesChanged: string[];

  /** Source: GitHub API or local git */
  source: "github" | "local";

  /** Feature group ID (if grouped) */
  featureGroup?: string;
}

/**
 * A group of related PRs detected during ingestion.
 */
export interface FeatureGroup {
  /** Unique group ID (e.g., "auth-feature") */
  id: string;

  /** Human-readable label (e.g., "Authentication overhaul") */
  label: string;

  /** PR numbers in this group */
  prs: number[];

  /** Why they're grouped */
  reason: string;

  /** Shared file paths/directories */
  sharedPaths: string[];

  /** Recommendation: review these together */
  reviewTogether: boolean;
}

/**
 * A review comment attached to a specific line.
 */
export interface ReviewComment {
  /** Unique ID */
  id: string;

  /** File path */
  file: string;

  /** Line number in the diff */
  line: number;

  /** Which side of the diff */
  side: "added" | "removed" | "context";

  /** Comment text */
  text: string;

  /** When created */
  createdAt: string;

  /** If auto-generated from a rule */
  ruleId?: string;
}

/**
 * A complete review session for one PR.
 */
export interface ReviewSession {
  /** PR number */
  prNumber: number;

  /** PR title */
  prTitle: string;

  /** Final state */
  state: "in-progress" | "approved" | "flagged";

  /** Comments made during review */
  comments: ReviewComment[];

  /** Rule violations found */
  ruleViolations: RuleViolation[];

  /** AI summary (if available) */
  summary?: string;

  /** Feature group (if grouped) */
  featureGroup?: string;

  /** When review started */
  startedAt: string;

  /** When review completed */
  completedAt?: string;
}

/**
 * A rule violation found during review.
 */
export interface RuleViolation {
  /** Rule ID that was violated */
  ruleId: string;

  /** File path */
  file: string;

  /** Line number */
  line: number;

  /** Why this is a violation */
  explanation: string;

  /** Suggested fix */
  suggestion?: string;

  /** Matched text (for regex rules) */
  matchedText?: string;
}

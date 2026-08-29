/**
 * The Provider seam: what runs a Round, and how the daemon asks for one.
 *
 * A Provider is an AI tool already installed and authenticated on the user's
 * machine (CONTEXT.md). LGTM does not review code itself; it delegates, and
 * normalises whatever comes back. v1 ships exactly one Provider, the Claude
 * CLI. The interface exists so codex can be added by configuration later
 * (requirements R3.1), not because a second one is coming this release.
 *
 * Ported from packages/plugins/review/src/domain/providers.ts on the old
 * `main` branch, minus the four Providers v1 does not ship and minus the
 * verification pass, which is an explicit v1 non-goal.
 */

import type { FindingKey, Severity } from "@/core";
import { claudeProvider, DEFAULT_MODEL } from "./claude";
import type { RawFinding } from "./parse";

export { extractFindings, validateFindings, meetsSeverity, SEVERITY_ORDER, type RawFinding } from "./parse";
export { DEFAULT_MODEL } from "./claude";

// ─── Agent configuration ────────────────────────────────────────────────────

export type ProviderId = "claude-cli";

export const PROVIDER_IDS = ["claude-cli"] as const;

/**
 * The 10-minute ceiling from requirements R3.3. The M0 spike measured 5m44s
 * for a two-file PR, so this is the right number and not a generous one.
 */
export const DEFAULT_TIMEOUT_MINUTES = 10;

export const DEFAULT_SEVERITY_FLOOR: Severity = "high";

/**
 * One Agent as the Store holds it: the frontmatter of `agents/<name>.md`
 * plus its body. The Store owns reading and writing that file; the Provider
 * only consumes the result, so this is the shape the loader must produce.
 */
export interface AgentConfig {
  /** The filename stem under agents/, e.g. "reviewer". Part of every finding key. */
  name: string;

  /** Which Provider executes this Agent's Rounds. */
  provider: ProviderId;

  /**
   * Pinned explicitly, never inherited. The spike ran once on the session
   * default and cost twice as much for the same review, and a daemon that
   * reviews every PR would repeat that on every PR.
   */
  model: string;

  /** Findings below this are dropped before they are ever written. */
  severityFloor: Severity;

  /** Minutes before the Round is killed and whatever arrived is salvaged. */
  timeoutMinutes: number;

  enabled: boolean;

  /** The body of the Agent file: appended to the CLI's own review skill. */
  prompt: string;
}

// ─── Invocation ─────────────────────────────────────────────────────────────

/**
 * A Finding from an earlier Round, replayed as do-not-repeat context
 * (requirements R3.6). Carries its FindingKey rather than a printed string so
 * the prompt cannot disagree with the store about what a finding is called.
 */
export interface PriorFinding {
  key: FindingKey;
  file: string;
  line: number;
  severity: Severity;
  comment: string;
}

export interface ReviewInput {
  agent: AgentConfig;

  /** Full PR URL. The CLI fetches the PR itself; v1 keeps no local clone. */
  prUrl: string;

  /**
   * Absolute path to the Provider's binary, resolved by the daemon's
   * login-shell probe. launchd hands the daemon a bare PATH, so a bare
   * command name is not enough (requirements R7.3). Falls back to the bare
   * name for local runs and tests.
   */
  binPath?: string;

  /** Findings from earlier Rounds on this PR. */
  priorFindings?: PriorFinding[];
}

/**
 * The result of one Round, before the Store writes it.
 *
 * `status` mirrors the Round file's own field. It is derived here rather than
 * at the call site so no caller can record a Round as `ok` while its output
 * failed to parse: unparseable output is a failed Round plus a .raw.txt dump
 * of `raw`, never a silent zero findings (requirements R3.4).
 */
export interface ReviewOutcome {
  provider: ProviderId;
  status: "ok" | "failed";
  findings: RawFinding[];

  /** Everything the Provider printed, including partial output after a timeout. */
  raw: string;

  /** Null when status is "ok". */
  error: string | null;

  durationMs: number;

  /** Findings the Provider returned that were unusable or below the floor. */
  dropped: number;
}

/**
 * What every Provider implements. One call, one Round.
 *
 * `review` never throws. A Provider failure degrades to a failed Round with
 * the error recorded, or one broken CLI takes the daemon down for every
 * watched repo.
 */
export interface Provider {
  id: ProviderId;
  review(input: ReviewInput): Promise<ReviewOutcome>;
}

const PROVIDERS: Record<ProviderId, Provider> = {
  "claude-cli": claudeProvider,
};

/** The Provider for an id, or null when the Agent names one that does not exist. */
export function resolveProvider(id: string): Provider | null {
  return PROVIDERS[id as ProviderId] ?? null;
}

/**
 * Run one Round through whichever Provider the Agent names.
 *
 * Never throws, for the same reason `Provider.review` never throws.
 */
export async function runReview(input: ReviewInput): Promise<ReviewOutcome> {
  const provider = resolveProvider(input.agent.provider);

  if (!provider) {
    return {
      provider: input.agent.provider,
      status: "failed",
      findings: [],
      raw: "",
      error: `unknown provider "${input.agent.provider}", expected one of ${PROVIDER_IDS.join(", ")}`,
      durationMs: 0,
      dropped: 0,
    };
  }

  return provider.review(input);
}

/**
 * The Agent config used when `agents/reviewer.md` is missing or unreadable,
 * with an empty prompt so the CLI's built-in review skill runs alone.
 */
export function defaultAgentConfig(name = "reviewer"): AgentConfig {
  return {
    name,
    provider: "claude-cli",
    model: DEFAULT_MODEL,
    severityFloor: DEFAULT_SEVERITY_FLOOR,
    timeoutMinutes: DEFAULT_TIMEOUT_MINUTES,
    enabled: true,
    prompt: "",
  };
}

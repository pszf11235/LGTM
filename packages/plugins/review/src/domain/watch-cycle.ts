/**
 * One pass of the watcher: for every watched repo, decide what each open PR
 * needs, and do it.
 *
 * The decision is the interesting part. A PR is either unseen, unchanged since
 * the last review, or has new commits. Only the third case is subtle: before
 * reviewing again, the findings already posted are checked against the new diff,
 * so the next round knows what is still open and does not repeat itself.
 *
 * Nothing is posted here. The cycle ends with findings on disk and a human
 * deciding, which is the whole shape of the tool.
 */

import type { AgentConfig } from "@lgtm/core/store/agents.js";
import type { WatchedRepo } from "@lgtm/core/registry/watch-list.js";
import {
  loadMeta,
  saveRound,
  saveMeta,
  postedFindings,
  applyVerdicts,
  type PRRef,
} from "./review-store.js";
import { orchestrate, orchestrateVerify, type Logger } from "./orchestrator.js";

// ─── Types ──────────────────────────────────────────────────────────────────

export interface OpenPR {
  number: number;
  title: string;
  author: string;
  createdAt: string;
  url: string;
  headSha: string;
}

export type PRAction =
  | { action: "reviewed"; round: number; findings: number }
  | { action: "re-reviewed"; round: number; findings: number; resolved: number; unresolved: number }
  | { action: "skipped"; reason: string }
  | { action: "failed"; reason: string };

export interface PRDecision {
  /** What the PR needs, before doing any work. */
  kind: "review" | "re-review" | "skip";
  reason: string;
  /** Next round number. */
  round: number;
}

export interface CycleDeps {
  /** Fetch the unified diff for a PR. */
  fetchDiff: (owner: string, repo: string, pr: number) => Promise<string>;
  /** Fetch open PRs for a repo. */
  fetchOpenPRs: (watched: WatchedRepo) => Promise<OpenPR[]>;
}

// ─── Decision ───────────────────────────────────────────────────────────────

/**
 * Decide what a PR needs, from stored state alone. Pure, so the rule that
 * decides whether to spend a provider call is testable without one.
 */
export function decidePR(
  lgtmDir: string,
  ref: PRRef,
  headSha: string
): PRDecision {
  const meta = loadMeta(lgtmDir, ref);

  if (!meta) {
    return { kind: "review", reason: "not reviewed yet", round: 1 };
  }

  // An unknown head SHA means the API did not give us one. Reviewing again on
  // every cycle would burn provider calls forever, so treat it as unchanged.
  if (!headSha) {
    return { kind: "skip", reason: "no head sha available", round: meta.currentRound };
  }

  if (meta.lastReviewedSha === headSha) {
    return { kind: "skip", reason: "no new commits", round: meta.currentRound };
  }

  return {
    kind: "re-review",
    reason: `new commits since ${meta.lastReviewedSha.slice(0, 8)}`,
    round: meta.currentRound + 1,
  };
}

// ─── One PR ─────────────────────────────────────────────────────────────────

/**
 * Review one PR, verifying prior findings first when there are new commits.
 */
export async function checkPR(
  lgtmDir: string,
  watched: WatchedRepo,
  pr: OpenPR,
  agents: AgentConfig[],
  deps: CycleDeps,
  ruleContext: string,
  log: Logger
): Promise<PRAction> {
  const ref: PRRef = { owner: watched.owner, repo: watched.repo, pr: pr.number };
  const decision = decidePR(lgtmDir, ref, pr.headSha);

  if (decision.kind === "skip") {
    return { action: "skipped", reason: decision.reason };
  }

  let diff: string;
  try {
    diff = await deps.fetchDiff(watched.owner, watched.repo, pr.number);
  } catch (err) {
    return { action: "failed", reason: `could not fetch diff: ${(err as Error).message}` };
  }

  if (!diff.trim()) {
    // Record the SHA anyway. An empty diff will stay empty, and without this the
    // PR is re-fetched every cycle forever.
    saveMeta(lgtmDir, {
      ref,
      title: pr.title,
      author: pr.author,
      sha: pr.headSha,
      round: decision.round,
      agents: [],
      findingCount: 0,
    });
    return { action: "skipped", reason: "empty diff" };
  }

  // ── Verification, only on a re-review with something already posted ──────
  let resolved = 0;
  let unresolved = 0;
  let priorForContext: Array<{ file: string; line: number; severity?: string; comment: string }> = [];

  if (decision.kind === "re-review") {
    // Only posted findings can have been acted on. Asking about a finding the
    // author never saw would produce a meaningless verdict.
    const prior = postedFindings(lgtmDir, ref).filter((f) => !f.discarded);

    if (prior.length > 0) {
      const checked = prior.map((f) => ({ id: f.id, round: f.round, agent: f.agent }));
      const asked = prior.map((f) => ({
        file: f.file,
        line: f.line,
        severity: f.severity,
        comment: f.comment,
      }));

      log.info(`verifying ${prior.length} earlier finding(s)`);

      const verification = await orchestrateVerify(agents[0], asked, { diff, prUrl: pr.url, repoPath: watched.path }, log);

      if (verification.error) {
        log.warn(`verification failed: ${verification.error}`);
      } else {
        const counts = applyVerdicts(lgtmDir, ref, checked, verification.verdicts);
        resolved = counts.resolved;
        unresolved = counts.unresolved;
      }

      // Whatever the verification said, anything not confirmed resolved is
      // context for the next round so it is not raised twice.
      const stillOpen = postedFindings(lgtmDir, ref).filter((f) => !f.discarded && !f.resolved);
      priorForContext = stillOpen.map((f) => ({
        file: f.file,
        line: f.line,
        severity: f.severity,
        comment: f.comment,
      }));
    }
  }

  // ── The review itself ────────────────────────────────────────────────────
  const result = await orchestrate(
    {
      agents,
      diff,
      prUrl: pr.url,
      repoPath: watched.path,
      priorFindings: priorForContext,
      ruleContext,
    },
    log
  );

  // One round file per agent, so two reviewers stay attributable.
  for (const run of result.runs) {
    saveRound(lgtmDir, {
      ref,
      title: pr.title,
      author: pr.author,
      sha: pr.headSha,
      round: decision.round,
      agent: run.agent,
      provider: run.provider,
      findings: run.findings,
      durationMs: run.durationMs,
      error: run.error,
      raw: run.raw,
    });
  }

  saveMeta(lgtmDir, {
    ref,
    title: pr.title,
    author: pr.author,
    sha: pr.headSha,
    round: decision.round,
    agents: result.runs.map((r) => r.agent),
    findingCount: result.runs.reduce((n, r) => n + r.findings.length, 0),
    ...(decision.kind === "re-review"
      ? {
          verifiedPriorRound: decision.round - 1,
          resolvedFromPrior: resolved,
          unresolvedFromPrior: unresolved,
        }
      : {}),
  });

  const findings = result.runs.reduce((n, r) => n + r.findings.length, 0);

  if (result.failed) {
    const reasons = result.runs.map((r) => r.error).filter(Boolean).join("; ");
    return { action: "failed", reason: reasons || "every agent failed" };
  }

  return decision.kind === "re-review"
    ? { action: "re-reviewed", round: decision.round, findings, resolved, unresolved }
    : { action: "reviewed", round: decision.round, findings };
}

// ─── One cycle ──────────────────────────────────────────────────────────────

export interface RepoResult {
  repo: string;
  prs: Array<{ pr: OpenPR; result: PRAction }>;
  error?: string;
}

export interface CycleResult {
  repos: RepoResult[];
  reviewed: number;
  reReviewed: number;
  skipped: number;
  failed: number;
  findings: number;
}

/**
 * Run one cycle across every watched repo.
 *
 * A repo that fails is reported and the cycle continues. One unreachable repo
 * must not stop the others, since the watcher is meant to run unattended.
 */
export async function runCycle(
  lgtmDir: string,
  repos: WatchedRepo[],
  agents: AgentConfig[],
  deps: CycleDeps,
  ruleContext: string,
  log: Logger
): Promise<CycleResult> {
  const results: RepoResult[] = [];
  let reviewed = 0;
  let reReviewed = 0;
  let skipped = 0;
  let failed = 0;
  let findings = 0;

  for (const watched of repos) {
    const repoStr = `${watched.owner}/${watched.repo}`;

    let openPRs: OpenPR[];
    try {
      openPRs = await deps.fetchOpenPRs(watched);
    } catch (err) {
      results.push({ repo: repoStr, prs: [], error: (err as Error).message });
      failed++;
      continue;
    }

    const prs: Array<{ pr: OpenPR; result: PRAction }> = [];

    for (const pr of openPRs) {
      // Every line names the repo, because one store holds them all and a bare
      // "#42" is meaningless in a multi-repo log.
      const prefixed: Logger = {
        info: (m) => log.info(`${repoStr}#${pr.number}: ${m}`),
        warn: (m) => log.warn(`${repoStr}#${pr.number}: ${m}`),
        error: (m) => log.error(`${repoStr}#${pr.number}: ${m}`),
      };

      const result = await checkPR(lgtmDir, watched, pr, agents, deps, ruleContext, prefixed);
      prs.push({ pr, result });

      switch (result.action) {
        case "reviewed":
          reviewed++;
          findings += result.findings;
          break;
        case "re-reviewed":
          reReviewed++;
          findings += result.findings;
          break;
        case "skipped":
          skipped++;
          break;
        case "failed":
          failed++;
          break;
      }
    }

    results.push({ repo: repoStr, prs });
  }

  return { repos: results, reviewed, reReviewed, skipped, failed, findings };
}

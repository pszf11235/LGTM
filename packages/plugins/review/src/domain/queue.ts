/**
 * Queue Manager — PR review queue lifecycle.
 *
 * Manages the state machine for PRs:
 *   queued → reviewing → approved | flagged
 *
 * Persists queue state to session index.md (OKF format).
 */

import type { OKFStore } from "@yak/core/plugin.js";
import type { QueuedPR, FeatureGroup } from "./types.js";
import { analyzeGroups } from "./grouping.js";

/** Session state persisted to index.md */
interface SessionState {
  date: string;
  prs: QueuedPR[];
  featureGroups: FeatureGroup[];
}

/**
 * Create a queue manager for a given session.
 *
 * @param store - OKF store instance
 * @param date - Session date (YYYY-MM-DD), defaults to today
 */
export function createQueueManager(store: OKFStore, date?: string) {
  const sessionDate = date ?? new Date().toISOString().split("T")[0];
  const indexPath = `sessions/${sessionDate}/index.md`;

  /**
   * Load the current session state (or create empty).
   */
  async function loadSession(): Promise<SessionState> {
    const doc = await store.read(indexPath);
    if (!doc) {
      return { date: sessionDate, prs: [], featureGroups: [] };
    }

    return {
      date: sessionDate,
      prs: (doc.data.prs as QueuedPR[]) ?? [],
      featureGroups: (doc.data.featureGroups as FeatureGroup[]) ?? [],
    };
  }

  /**
   * Save session state to index.md.
   */
  async function saveSession(session: SessionState): Promise<void> {
    const body = generateSessionBody(session);
    await store.write(
      indexPath,
      {
        type: "yak/session",
        date: session.date,
        status: session.prs.some((p) => p.state === "reviewing")
          ? "in-progress"
          : "complete",
        prs: session.prs,
        featureGroups: session.featureGroups,
      },
      body
    );
  }

  /**
   * Add PRs to the queue.
   * Validates: no duplicates, computes feature groups.
   *
   * @param prs - PRs to add (must have number, title, filesChanged)
   * @returns Updated session state
   */
  async function addToQueue(
    prs: Array<{ number: number; title: string; filesChanged: string[]; source: "github" | "local" }>
  ): Promise<SessionState> {
    const session = await loadSession();

    for (const pr of prs) {
      // Skip duplicates
      if (session.prs.some((p) => p.number === pr.number)) {
        continue;
      }

      session.prs.push({
        number: pr.number,
        title: pr.title,
        state: "queued",
        addedAt: new Date().toISOString(),
        filesChanged: pr.filesChanged,
        source: pr.source,
      });
    }

    // Recompute feature groups with all PRs
    session.featureGroups = analyzeGroups(session.prs);

    // Assign group IDs back to PRs
    for (const group of session.featureGroups) {
      for (const prNum of group.prs) {
        const pr = session.prs.find((p) => p.number === prNum);
        if (pr) pr.featureGroup = group.id;
      }
    }

    await saveSession(session);
    return session;
  }

  /**
   * Get the current queue.
   */
  async function getQueue(): Promise<SessionState> {
    return loadSession();
  }

  /**
   * Transition a PR's state.
   * Validates state machine: queued → reviewing → approved | flagged
   */
  async function updateState(
    prNumber: number,
    newState: "reviewing" | "approved" | "flagged",
    reason?: string
  ): Promise<QueuedPR | null> {
    const session = await loadSession();
    const pr = session.prs.find((p) => p.number === prNumber);
    if (!pr) return null;

    // Validate transition
    const validTransitions: Record<string, string[]> = {
      queued: ["reviewing"],
      reviewing: ["approved", "flagged"],
    };

    const allowed = validTransitions[pr.state] ?? [];
    if (!allowed.includes(newState)) {
      return null; // Invalid transition
    }

    pr.state = newState;
    if (newState === "approved" || newState === "flagged") {
      pr.reviewedAt = new Date().toISOString();
    }
    if (newState === "flagged" && reason) {
      pr.flagReason = reason;
    }

    await saveSession(session);
    return pr;
  }

  /**
   * Remove a PR from the queue.
   */
  async function removeFromQueue(prNumber: number): Promise<boolean> {
    const session = await loadSession();
    const idx = session.prs.findIndex((p) => p.number === prNumber);
    if (idx === -1) return false;

    session.prs.splice(idx, 1);

    // Recompute groups
    session.featureGroups = analyzeGroups(session.prs);

    await saveSession(session);
    return true;
  }

  return {
    addToQueue,
    getQueue,
    updateState,
    removeFromQueue,
    loadSession,
  };
}

/**
 * Generate the markdown body for the session index.
 */
function generateSessionBody(session: SessionState): string {
  const lines = [`# Review Session: ${session.date}`, ""];

  if (session.featureGroups.length > 0) {
    lines.push("## Feature Groups", "");
    for (const group of session.featureGroups) {
      lines.push(`### ${group.label}`);
      lines.push(`PRs: ${group.prs.map((n) => `#${n}`).join(", ")}`);
      lines.push(`Reason: ${group.reason}`);
      lines.push("");
    }
  }

  lines.push("## Queue", "");
  for (const pr of session.prs) {
    const icon =
      pr.state === "approved" ? "✅" :
      pr.state === "flagged" ? "🚩" :
      pr.state === "reviewing" ? "🔄" : "⏳";
    const group = pr.featureGroup ? ` [${pr.featureGroup}]` : "";
    const reason = pr.flagReason ? ` — ${pr.flagReason}` : "";
    lines.push(`- ${icon} PR #${pr.number}: ${pr.title}${group}${reason}`);
  }
  lines.push("");

  return lines.join("\n");
}

export type QueueManager = ReturnType<typeof createQueueManager>;

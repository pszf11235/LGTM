/**
 * ReviewTab — top-level component for the Review plugin tab.
 *
 * Manages navigation between pages and persists reviews on exit.
 */

import React, { useState } from "react";
import { Box, Text } from "ink";
import { QueuePage } from "./QueuePage.js";
import { ReviewPage } from "./ReviewPage.js";
import type { ParsedDiff } from "../domain/diff-parser.js";
import type { ReviewComment } from "../domain/types.js";

interface ReviewTabProps {
  onStatusHint: (hint: string) => void;
}

type Page =
  | { type: "queue" }
  | { type: "review"; prNumber: number; prTitle: string; diff: ParsedDiff; featureGroup?: string };

export function ReviewTab({ onStatusHint }: ReviewTabProps) {
  const [page, setPage] = useState<Page>({ type: "queue" });

  function handleOpenReview(prNumber: number, prTitle: string, diff: ParsedDiff, featureGroup?: string) {
    setPage({ type: "review", prNumber, prTitle, diff, featureGroup });
  }

  async function handleExitReview(action: "approve" | "flag" | "back", comments?: ReviewComment[]) {
    if (page.type !== "review") return;

    // Save review to OKF store
    try {
      const { createOKFStore } = await import("@lgtm/core/store/okf.js");
      const { findGitRoot } = await import("@lgtm/core/store/paths.js");
      const { loadBootstrap, resolveYakDir } = await import("@lgtm/core/config/loader.js");
      const { createQueueManager } = await import("../domain/queue.js");

      const repoRoot = findGitRoot();
      const bootstrap = loadBootstrap();
      const lgtmDir = resolveYakDir(bootstrap, repoRoot);
      const store = createOKFStore(lgtmDir);
      const queue = createQueueManager(store);

      const date = new Date().toISOString().split("T")[0];

      // Save review markdown
      if (comments && comments.length > 0 || action !== "back") {
        const reviewData = {
          type: "lgtm/review",
          pr: page.prNumber,
          title: page.prTitle,
          state: action === "back" ? "in-progress" : action,
          reviewed_at: new Date().toISOString(),
          comments_count: comments?.length ?? 0,
          feature_group: page.featureGroup,
        };

        const reviewBody = generateReviewMarkdown(
          page.prNumber,
          page.prTitle,
          action,
          comments ?? [],
          page.featureGroup
        );

        await store.write(
          `sessions/${date}/pr-${page.prNumber}.md`,
          reviewData,
          reviewBody
        );
      }

      // Update queue state
      if (action === "approve" || action === "flag") {
        // Transition through reviewing first if needed
        await queue.updateState(page.prNumber, "reviewing");
        await queue.updateState(
          page.prNumber,
          action === "approve" ? "approved" : "flagged",
          action === "flag" ? "Flagged during review" : undefined
        );
      }
    } catch (err) {
      // Silent failure — don't crash the TUI if save fails
      // TODO: show error in status bar
    }

    setPage({ type: "queue" });
  }

  switch (page.type) {
    case "queue":
      return (
        <QueuePage
          onStatusHint={onStatusHint}
          onOpenReview={handleOpenReview}
        />
      );

    case "review":
      return (
        <ReviewPage
          diff={page.diff}
          prNumber={page.prNumber}
          prTitle={page.prTitle}
          featureGroup={page.featureGroup}
          onStatusHint={onStatusHint}
          onExit={handleExitReview}
        />
      );

    default:
      return <Text color="gray">Unknown page</Text>;
  }
}

/**
 * Generate review markdown for persistence.
 */
function generateReviewMarkdown(
  prNumber: number,
  prTitle: string,
  action: "approve" | "flag" | "back",
  comments: ReviewComment[],
  featureGroup?: string
): string {
  const lines = [
    `# Review: PR #${prNumber} — ${prTitle}`,
    "",
  ];

  if (featureGroup) {
    lines.push(`**Feature group:** ${featureGroup}`, "");
  }

  const stateLabel = action === "approve" ? "✅ Approved" : action === "flag" ? "🚩 Flagged" : "💾 Saved (in progress)";
  lines.push(`**Decision:** ${stateLabel}`, "");

  if (comments.length > 0) {
    lines.push(`## Comments (${comments.length})`, "");

    // Group by file
    const byFile = new Map<string, ReviewComment[]>();
    for (const c of comments) {
      if (!byFile.has(c.file)) byFile.set(c.file, []);
      byFile.get(c.file)!.push(c);
    }

    for (const [file, fileComments] of byFile) {
      lines.push(`### ${file}`, "");
      for (const c of fileComments.sort((a, b) => a.line - b.line)) {
        lines.push(`- **L${c.line}:** ${c.text}`);
      }
      lines.push("");
    }
  } else {
    lines.push("*No comments.*", "");
  }

  return lines.join("\n");
}

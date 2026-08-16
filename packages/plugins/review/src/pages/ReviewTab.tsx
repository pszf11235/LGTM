/**
 * ReviewTab — top-level component for the Review plugin tab.
 *
 * Manages navigation between pages:
 *   QueuePage ←→ ReviewPage
 *
 * This is what gets registered as the tab component in the TUI shell.
 */

import React, { useState } from "react";
import { Box, Text } from "ink";
import { QueuePage } from "./QueuePage.js";
import { ReviewPage } from "./ReviewPage.js";
import type { ParsedDiff } from "../domain/diff-parser.js";

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

  function handleExitReview(action: "approve" | "flag" | "back") {
    // TODO (Task 10): handle approve/flag actions (update queue state)
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

/**
 * Review Tab — the PRs that have findings on disk.
 *
 * Reads the review store (~/.lgtm-farm/reviews/<owner>-<repo>-<pr>/), which is
 * the same place `lgtm review list` reads. It previously read the older
 * sessions/<date>/index.md queue, so it reported "No PRs in queue" while
 * completed reviews sat in the store, and pointed at `lgtm review add`, which
 * is not part of the watch → review → post loop.
 *
 * Read-only. Posting is a deliberate act with a confirmation surface, so it
 * stays in `lgtm review post`.
 */

import React, { useState, useEffect } from "react";
import { Box, Text, useInput } from "ink";
import type { PRRef, ReviewMeta, StoredFinding } from "../domain/review-store.js";

interface ReviewTabProps {
  onStatusHint: (hint: string) => void;
}

interface PRSummary {
  ref: PRRef;
  meta: ReviewMeta | null;
  pending: Array<StoredFinding & { round: number; agent: string }>;
  postedCount: number;
}

interface ReviewTabState {
  prs: PRSummary[];
  selected: number;
  loading: boolean;
  error: string;
}

export function ReviewTab({ onStatusHint }: ReviewTabProps) {
  const [state, setState] = useState<ReviewTabState>({
    prs: [],
    selected: 0,
    loading: true,
    error: "",
  });

  useEffect(() => {
    onStatusHint("↑↓ select  [r] refresh");
  }, []);

  useEffect(() => {
    void load();
  }, []);

  async function load() {
    setState((prev) => ({ ...prev, loading: true }));
    try {
      const { resolveLgtmDir } = await import("@lgtm/core/config/loader.js");
      const { listReviewedPRs, loadMeta, pendingFindings, postedFindings } = await import(
        "../domain/review-store.js"
      );

      const lgtmDir = resolveLgtmDir();
      const prs: PRSummary[] = listReviewedPRs(lgtmDir).map((ref) => ({
        ref,
        meta: loadMeta(lgtmDir, ref),
        pending: pendingFindings(lgtmDir, ref),
        postedCount: postedFindings(lgtmDir, ref).length,
      }));

      setState((prev) => ({
        prs,
        selected: Math.min(prev.selected, Math.max(0, prs.length - 1)),
        loading: false,
        error: "",
      }));
    } catch (err) {
      setState((prev) => ({ ...prev, loading: false, error: (err as Error).message }));
    }
  }

  useInput((input, key) => {
    if (input === "r") void load();
    if (key.upArrow) {
      setState((prev) => ({ ...prev, selected: Math.max(0, prev.selected - 1) }));
    }
    if (key.downArrow) {
      setState((prev) => ({
        ...prev,
        selected: Math.min(prev.prs.length - 1, prev.selected + 1),
      }));
    }
  });

  if (state.loading && state.prs.length === 0) {
    return (
      <Box paddingX={2}>
        <Text dimColor>Loading reviews...</Text>
      </Box>
    );
  }

  if (state.error !== "") {
    return (
      <Box paddingX={2}>
        <Text color="red">{state.error}</Text>
      </Box>
    );
  }

  if (state.prs.length === 0) {
    return (
      <Box flexDirection="column" paddingX={2}>
        <Text dimColor>No reviews on disk yet.</Text>
        <Text dimColor>
          Run <Text color="cyan">lgtm watch --once</Text>, or review one PR with{" "}
          <Text color="cyan">lgtm review pr owner/repo#42</Text>.
        </Text>
      </Box>
    );
  }

  const current = state.prs[state.selected];

  return (
    <Box flexDirection="column" paddingX={2}>
      <Text bold>
        Reviews — {state.prs.length} PR{state.prs.length === 1 ? "" : "s"} with findings
      </Text>
      <Box height={1} />

      {state.prs.map((p, i) => {
        const isSelected = i === state.selected;
        const label = `${p.ref.owner}/${p.ref.repo}#${p.ref.pr}`;
        return (
          <Box key={label}>
            <Text color={isSelected ? "cyan" : undefined}>{isSelected ? "▸ " : "  "}</Text>
            <Text color={isSelected ? "cyan" : undefined} bold={isSelected}>
              {label.padEnd(28)}
            </Text>
            <Text dimColor>
              {p.pending.length} pending
              {p.postedCount > 0 ? `, ${p.postedCount} posted` : ""}
              {p.meta ? `  round ${p.meta.currentRound}` : ""}
            </Text>
          </Box>
        );
      })}

      <Box height={1} />
      {current.meta && (
        <>
          <Text dimColor>{current.meta.title}</Text>
          <Text dimColor>{current.meta.url}</Text>
          <Box height={1} />
        </>
      )}

      {current.pending.slice(0, 8).map((f) => (
        <Box key={`${f.round}-${f.agent}-${f.id}`} flexDirection="column">
          <Box>
            <Text dimColor>{`  ${f.id} `}</Text>
            <Text color={severityColour(f.severity)}>{f.severity.padEnd(9)}</Text>
            <Text dimColor>{`${f.file}:${f.line}`}</Text>
          </Box>
          <Text dimColor>{`     ${truncate(f.comment, 110)}`}</Text>
        </Box>
      ))}

      {current.pending.length > 8 && (
        <Text dimColor>{`  ...and ${current.pending.length - 8} more`}</Text>
      )}

      {current.pending.length === 0 && (
        <Text dimColor>  Nothing pending. Everything here is posted or discarded.</Text>
      )}

      <Box height={1} />
      <Text dimColor>
        Post with <Text color="cyan">{`lgtm review post ${current.ref.owner}/${current.ref.repo}#${current.ref.pr}`}</Text>
      </Text>
    </Box>
  );
}

function severityColour(severity: string): string {
  switch (severity) {
    case "critical": return "red";
    case "high": return "yellow";
    case "medium": return "blue";
    default: return "gray";
  }
}

function truncate(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

/**
 * Review Page — full-screen diff view for reviewing a single PR.
 *
 * Layout (vertical scroll, OpenCode-style):
 *   ┌─────────────────────────────────────────┐
 *   │ Summary Banner (PR title, stats, group) │
 *   ├─────────────────────────────────────────┤
 *   │ Diff View (scrollable)                  │
 *   │   file header                           │
 *   │   hunk header                           │
 *   │   + added lines (green)                 │
 *   │   - removed lines (red)                 │
 *   │     context lines (gray)                │
 *   ├─────────────────────────────────────────┤
 *   │ Comments (if any)                       │
 *   └─────────────────────────────────────────┘
 *
 * Navigation: j/k scroll, n/N next/prev file, h/H next/prev hunk
 */

import React, { useState, useEffect, useMemo } from "react";
import { Box, Text, useInput, useStdout } from "ink";
import type { ParsedDiff, DiffFile, DiffLine } from "../domain/diff-parser.js";

interface ReviewPageProps {
  diff: ParsedDiff;
  prNumber: number;
  prTitle: string;
  summary?: string;
  featureGroup?: string;
  onStatusHint: (hint: string) => void;
  onExit: (action: "approve" | "flag" | "back") => void;
}

/** A flat line for rendering (file header, hunk header, or diff line) */
interface RenderLine {
  type: "file-header" | "hunk-header" | "diff-line";
  content: string;
  fileIdx: number;
  hunkIdx?: number;
  lineIdx?: number;
  diffLine?: DiffLine;
}

export function ReviewPage({
  diff,
  prNumber,
  prTitle,
  summary,
  featureGroup,
  onStatusHint,
  onExit,
}: ReviewPageProps) {
  const { stdout } = useStdout();
  const termHeight = (stdout?.rows ?? 24) - 6; // reserve for header/footer/summary
  const [scrollOffset, setScrollOffset] = useState(0);
  const [currentFileIdx, setCurrentFileIdx] = useState(0);

  // Flatten diff into renderable lines
  const flatLines = useMemo(() => flattenDiff(diff), [diff]);

  // Track file start positions for jump navigation
  const fileStarts = useMemo(() => {
    const starts: number[] = [];
    flatLines.forEach((line, i) => {
      if (line.type === "file-header") starts.push(i);
    });
    return starts;
  }, [flatLines]);

  // Track hunk start positions
  const hunkStarts = useMemo(() => {
    const starts: number[] = [];
    flatLines.forEach((line, i) => {
      if (line.type === "hunk-header") starts.push(i);
    });
    return starts;
  }, [flatLines]);

  useEffect(() => {
    onStatusHint("j/k scroll  n/N file  h/H hunk  a approve  f flag  q back");
  }, []);

  // Update current file index based on scroll position
  useEffect(() => {
    for (let i = fileStarts.length - 1; i >= 0; i--) {
      if (fileStarts[i] <= scrollOffset) {
        setCurrentFileIdx(i);
        break;
      }
    }
  }, [scrollOffset, fileStarts]);

  useInput((input: string, key: { downArrow?: boolean; upArrow?: boolean; return?: boolean }) => {
    // Scroll
    if (key.downArrow || input === "j") {
      setScrollOffset((prev) => Math.min(prev + 1, flatLines.length - termHeight));
      return;
    }
    if (key.upArrow || input === "k") {
      setScrollOffset((prev) => Math.max(prev - 1, 0));
      return;
    }

    // Page down/up
    if (input === "d") {
      setScrollOffset((prev) => Math.min(prev + Math.floor(termHeight / 2), flatLines.length - termHeight));
      return;
    }
    if (input === "u") {
      setScrollOffset((prev) => Math.max(prev - Math.floor(termHeight / 2), 0));
      return;
    }

    // Next/prev file
    if (input === "n") {
      const next = fileStarts.find((s) => s > scrollOffset);
      if (next !== undefined) setScrollOffset(next);
      return;
    }
    if (input === "N") {
      const prev = [...fileStarts].reverse().find((s) => s < scrollOffset);
      if (prev !== undefined) setScrollOffset(prev);
      return;
    }

    // Next/prev hunk
    if (input === "h") {
      const next = hunkStarts.find((s) => s > scrollOffset);
      if (next !== undefined) setScrollOffset(next);
      return;
    }
    if (input === "H") {
      const prev = [...hunkStarts].reverse().find((s) => s < scrollOffset);
      if (prev !== undefined) setScrollOffset(prev);
      return;
    }

    // Actions
    if (input === "a") {
      onExit("approve");
      return;
    }
    if (input === "f") {
      onExit("flag");
      return;
    }
    if (input === "q") {
      onExit("back");
      return;
    }
  });

  // Visible slice
  const visibleLines = flatLines.slice(scrollOffset, scrollOffset + termHeight);

  // Stats
  const totalAdditions = diff.files.reduce(
    (sum, f) => sum + f.hunks.reduce((s, h) => s + h.lines.filter((l) => l.type === "added").length, 0),
    0
  );
  const totalDeletions = diff.files.reduce(
    (sum, f) => sum + f.hunks.reduce((s, h) => s + h.lines.filter((l) => l.type === "removed").length, 0),
    0
  );

  return (
    <Box flexDirection="column">
      {/* Summary Banner */}
      <Box flexDirection="column" marginBottom={1}>
        <Text bold>
          PR #{prNumber}: {prTitle}
        </Text>
        <Box>
          <Text color="green">+{totalAdditions}</Text>
          <Text> </Text>
          <Text color="red">-{totalDeletions}</Text>
          <Text color="gray">
            {"  "}
            {diff.files.length} file(s)
            {featureGroup ? `  [${featureGroup}]` : ""}
          </Text>
        </Box>
        {summary && (
          <Box marginTop={0}>
            <Text color="gray">📋 {summary}</Text>
          </Box>
        )}
      </Box>

      {/* File position indicator */}
      <Box>
        <Text color="gray">
          File {currentFileIdx + 1}/{diff.files.length}: {diff.files[currentFileIdx]?.path ?? ""}
          {"  "}
          (line {scrollOffset + 1}/{flatLines.length})
        </Text>
      </Box>

      {/* Diff content */}
      <Box flexDirection="column">
        {visibleLines.map((line, i) => (
          <DiffRenderLine key={scrollOffset + i} line={line} />
        ))}
      </Box>
    </Box>
  );
}

/** Render a single line based on its type */
function DiffRenderLine({ line }: { line: RenderLine }) {
  switch (line.type) {
    case "file-header":
      return (
        <Box marginTop={1}>
          <Text bold color="white">
            ── {line.content} ──
          </Text>
        </Box>
      );

    case "hunk-header":
      return (
        <Text color="cyan" dimColor>
          {line.content}
        </Text>
      );

    case "diff-line": {
      const dl = line.diffLine!;
      const lineNum = dl.type === "removed"
        ? String(dl.oldLine ?? "").padStart(4)
        : String(dl.newLine ?? "").padStart(4);
      const prefix = dl.type === "added" ? "+" : dl.type === "removed" ? "-" : " ";
      const color = dl.type === "added" ? "green" : dl.type === "removed" ? "red" : undefined;

      return (
        <Box>
          <Text color="gray">{lineNum} </Text>
          <Text color={color}>
            {prefix} {dl.content}
          </Text>
        </Box>
      );
    }

    default:
      return null;
  }
}

/** Flatten a ParsedDiff into a linear list of renderable lines */
function flattenDiff(diff: ParsedDiff): RenderLine[] {
  const lines: RenderLine[] = [];

  diff.files.forEach((file, fileIdx) => {
    // File header
    lines.push({
      type: "file-header",
      content: file.status === "renamed"
        ? `${file.oldPath} → ${file.path}`
        : `${file.path}${file.status === "added" ? " (new)" : file.status === "deleted" ? " (deleted)" : ""}`,
      fileIdx,
    });

    if (file.status === "binary") {
      lines.push({
        type: "diff-line",
        content: "Binary file",
        fileIdx,
        diffLine: { type: "context", content: "Binary file — cannot display diff", oldLine: null, newLine: null },
      });
      return;
    }

    // Hunks
    file.hunks.forEach((hunk, hunkIdx) => {
      lines.push({
        type: "hunk-header",
        content: hunk.header + (hunk.context ? ` ${hunk.context}` : ""),
        fileIdx,
        hunkIdx,
      });

      hunk.lines.forEach((dl, lineIdx) => {
        lines.push({
          type: "diff-line",
          content: dl.content,
          fileIdx,
          hunkIdx,
          lineIdx,
          diffLine: dl,
        });
      });
    });
  });

  return lines;
}

/**
 * Review Page — full-screen diff view with commenting.
 *
 * Navigation: j/k scroll, n/N file, h/H hunk, c comment, a approve, f flag, q back
 */

import React, { useState, useEffect, useMemo } from "react";
import { Box, Text, useInput, useStdout } from "ink";
import type { ParsedDiff, DiffLine } from "../domain/diff-parser.js";
import type { ReviewComment } from "../domain/types.js";
import { CommentInput } from "../components/CommentInput.js";
import { CommentList } from "../components/CommentList.js";

interface ReviewPageProps {
  diff: ParsedDiff;
  prNumber: number;
  prTitle: string;
  summary?: string;
  featureGroup?: string;
  onStatusHint: (hint: string) => void;
  onExit: (action: "approve" | "flag" | "back", comments?: ReviewComment[]) => void;
}

/** A flat line for rendering */
interface RenderLine {
  type: "file-header" | "hunk-header" | "diff-line";
  content: string;
  fileIdx: number;
  filePath: string;
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
  const termHeight = (stdout?.rows ?? 24) - 8; // reserve for header/footer/summary/comments
  const [scrollOffset, setScrollOffset] = useState(0);
  const [currentFileIdx, setCurrentFileIdx] = useState(0);
  const [comments, setComments] = useState<ReviewComment[]>([]);
  const [isCommenting, setIsCommenting] = useState(false);
  const [showComments, setShowComments] = useState(false);

  // Flatten diff into renderable lines
  const flatLines = useMemo(() => flattenDiff(diff), [diff]);

  // Track file/hunk positions
  const fileStarts = useMemo(() => {
    const starts: number[] = [];
    flatLines.forEach((line, i) => {
      if (line.type === "file-header") starts.push(i);
    });
    return starts;
  }, [flatLines]);

  const hunkStarts = useMemo(() => {
    const starts: number[] = [];
    flatLines.forEach((line, i) => {
      if (line.type === "hunk-header") starts.push(i);
    });
    return starts;
  }, [flatLines]);

  useEffect(() => {
    updateStatusHint();
  }, [isCommenting, showComments, comments.length]);

  function updateStatusHint() {
    if (isCommenting) {
      onStatusHint("typing comment... enter submit · escape cancel");
    } else if (showComments) {
      onStatusHint("l hide comments  c comment  a approve  f flag  q back");
    } else {
      const commentCount = comments.length > 0 ? `  💬${comments.length}` : "";
      onStatusHint(`j/k scroll  n/N file  h/H hunk  c comment  l comments  a approve  f flag  q back${commentCount}`);
    }
  }

  // Update current file index based on scroll
  useEffect(() => {
    for (let i = fileStarts.length - 1; i >= 0; i--) {
      if (fileStarts[i] <= scrollOffset) {
        setCurrentFileIdx(i);
        break;
      }
    }
  }, [scrollOffset, fileStarts]);

  // Get current line info (for commenting)
  function getCurrentLineInfo(): { file: string; line: number } | null {
    const currentLine = flatLines[scrollOffset];
    if (!currentLine) return null;
    if (currentLine.type !== "diff-line" || !currentLine.diffLine) return null;

    const lineNum = currentLine.diffLine.newLine ?? currentLine.diffLine.oldLine;
    if (!lineNum) return null;

    return { file: currentLine.filePath, line: lineNum };
  }

  useInput((input, key) => {
    // Scroll
    if (key.downArrow || input === "j") {
      setScrollOffset((prev) => Math.min(prev + 1, Math.max(0, flatLines.length - termHeight)));
      return;
    }
    if (key.upArrow || input === "k") {
      setScrollOffset((prev) => Math.max(prev - 1, 0));
      return;
    }

    // Page scroll
    if (input === "d") {
      setScrollOffset((prev) => Math.min(prev + Math.floor(termHeight / 2), Math.max(0, flatLines.length - termHeight)));
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
    if (input === "h" && !showComments) {
      const next = hunkStarts.find((s) => s > scrollOffset);
      if (next !== undefined) setScrollOffset(next);
      return;
    }
    if (input === "H") {
      const prev = [...hunkStarts].reverse().find((s) => s < scrollOffset);
      if (prev !== undefined) setScrollOffset(prev);
      return;
    }

    // Comment on current line
    if (input === "c") {
      const lineInfo = getCurrentLineInfo();
      if (lineInfo) {
        setIsCommenting(true);
      }
      return;
    }

    // Toggle comment list
    if (input === "l") {
      setShowComments((prev) => !prev);
      return;
    }

    // Actions
    if (input === "a") {
      onExit("approve", comments);
      return;
    }
    if (input === "f") {
      onExit("flag", comments);
      return;
    }
    if (input === "q" || key.escape) {
      onExit("back", comments);
      return;
    }
  }, { isActive: !isCommenting });

  function handleCommentSubmit(text: string) {
    const lineInfo = getCurrentLineInfo();
    if (!lineInfo) {
      setIsCommenting(false);
      return;
    }

    const newComment: ReviewComment = {
      id: crypto.randomUUID(),
      file: lineInfo.file,
      line: lineInfo.line,
      side: "added", // simplified — could detect from diffLine type
      text,
      createdAt: new Date().toISOString(),
    };

    setComments((prev) => [...prev, newComment]);
    setIsCommenting(false);
  }

  function handleCommentCancel() {
    setIsCommenting(false);
  }

  // Visible lines
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
        <Text bold>PR #{prNumber}: {prTitle}</Text>
        <Box>
          <Text color="green">+{totalAdditions}</Text>
          <Text> </Text>
          <Text color="red">-{totalDeletions}</Text>
          <Text color="gray">
            {"  "}{diff.files.length} file(s)
            {featureGroup ? `  [${featureGroup}]` : ""}
            {comments.length > 0 ? `  💬 ${comments.length} comment(s)` : ""}
          </Text>
        </Box>
        {summary && <Text color="gray">📋 {summary}</Text>}
      </Box>

      {/* Position indicator */}
      <Box>
        <Text color="gray">
          File {currentFileIdx + 1}/{diff.files.length}: {diff.files[currentFileIdx]?.path ?? ""}
          {"  "}(line {scrollOffset + 1}/{flatLines.length})
        </Text>
      </Box>

      {/* Diff content or Comments list */}
      {showComments ? (
        <CommentList
          comments={comments}
          currentFile={diff.files[currentFileIdx]?.path}
        />
      ) : (
        <Box flexDirection="column">
          {visibleLines.map((line, i) => {
            const globalIdx = scrollOffset + i;
            const hasComment = comments.some(
              (c) => line.diffLine && c.file === line.filePath &&
                c.line === (line.diffLine.newLine ?? line.diffLine.oldLine)
            );

            return (
              <Box key={globalIdx} flexDirection="column">
                <DiffRenderLine line={line} isCurrentLine={i === 0} hasComment={hasComment} />
              </Box>
            );
          })}
        </Box>
      )}

      {/* Comment input overlay */}
      {isCommenting && (() => {
        const lineInfo = getCurrentLineInfo();
        if (!lineInfo) return null;
        return (
          <CommentInput
            file={lineInfo.file}
            line={lineInfo.line}
            onSubmit={handleCommentSubmit}
            onCancel={handleCommentCancel}
          />
        );
      })()}
    </Box>
  );
}

/** Render a single line */
function DiffRenderLine({ line, isCurrentLine, hasComment }: { line: RenderLine; isCurrentLine: boolean; hasComment: boolean }) {
  switch (line.type) {
    case "file-header":
      return (
        <Box marginTop={1}>
          <Text bold color="white">── {line.content} ──</Text>
        </Box>
      );

    case "hunk-header":
      return <Text color="cyan" dimColor>{line.content}</Text>;

    case "diff-line": {
      const dl = line.diffLine!;
      const lineNum = dl.type === "removed"
        ? String(dl.oldLine ?? "").padStart(4)
        : String(dl.newLine ?? "").padStart(4);
      const prefix = dl.type === "added" ? "+" : dl.type === "removed" ? "-" : " ";
      const color = dl.type === "added" ? "green" : dl.type === "removed" ? "red" : undefined;
      const cursor = isCurrentLine ? "▶" : " ";
      const commentMarker = hasComment ? " 💬" : "";

      return (
        <Box>
          <Text color={isCurrentLine ? "cyan" : "gray"}>{cursor}</Text>
          <Text color="gray">{lineNum} </Text>
          <Text color={color}>{prefix} {dl.content}</Text>
          {commentMarker && <Text>{commentMarker}</Text>}
        </Box>
      );
    }

    default:
      return null;
  }
}

/** Flatten diff into renderable lines */
function flattenDiff(diff: ParsedDiff): RenderLine[] {
  const lines: RenderLine[] = [];

  diff.files.forEach((file, fileIdx) => {
    const label = file.status === "renamed"
      ? `${file.oldPath} → ${file.path}`
      : `${file.path}${file.status === "added" ? " (new)" : file.status === "deleted" ? " (deleted)" : ""}`;

    lines.push({ type: "file-header", content: label, fileIdx, filePath: file.path });

    if (file.status === "binary") {
      lines.push({
        type: "diff-line",
        content: "Binary file",
        fileIdx,
        filePath: file.path,
        diffLine: { type: "context", content: "Binary file — cannot display", oldLine: null, newLine: null },
      });
      return;
    }

    file.hunks.forEach((hunk, hunkIdx) => {
      lines.push({
        type: "hunk-header",
        content: hunk.header + (hunk.context ? ` ${hunk.context}` : ""),
        fileIdx,
        filePath: file.path,
        hunkIdx,
      });

      hunk.lines.forEach((dl, lineIdx) => {
        lines.push({ type: "diff-line", content: dl.content, fileIdx, filePath: file.path, hunkIdx, lineIdx, diffLine: dl });
      });
    });
  });

  return lines;
}

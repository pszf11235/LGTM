/**
 * Side-by-Side Diff View — shows old and new code in parallel columns.
 *
 * Toggle with 's' key in ReviewPage.
 * Left column = old file, right column = new file.
 * Aligned by hunk — matching lines on same row.
 */

import React from "react";
import { Box, Text, useStdout } from "ink";
import type { DiffFile, DiffHunk, DiffLine } from "../domain/diff-parser.js";

interface SideBySideViewProps {
  file: DiffFile;
  scrollOffset: number;
  visibleLines: number;
  cursorLine?: number;
}

/** A row in side-by-side view */
interface SideBySideRow {
  left: { lineNum: number | null; content: string; type: "removed" | "context" | "empty" };
  right: { lineNum: number | null; content: string; type: "added" | "context" | "empty" };
  globalIdx: number;
}

export function SideBySideView({ file, scrollOffset, visibleLines, cursorLine }: SideBySideViewProps) {
  const { stdout } = useStdout();
  const termWidth = stdout?.columns ?? 80;
  const colWidth = Math.floor((termWidth - 3) / 2); // -3 for separator + margins

  // Build side-by-side rows from hunks
  const rows = buildSideBySideRows(file);
  const visible = rows.slice(scrollOffset, scrollOffset + visibleLines);

  return (
    <Box flexDirection="column">
      {/* File header */}
      <Box marginBottom={1}>
        <Text bold color="white">── {file.path} (side-by-side) ──</Text>
      </Box>

      {/* Column headers */}
      <Box>
        <Text color="gray">{"Old".padEnd(colWidth)}</Text>
        <Text color="gray">│</Text>
        <Text color="gray">{"New".padEnd(colWidth)}</Text>
      </Box>

      {/* Rows */}
      {visible.map((row, i) => {
        const globalIdx = scrollOffset + i;
        const isCursor = globalIdx === cursorLine;

        return (
          <Box key={globalIdx}>
            {/* Left (old) */}
            <Box width={colWidth}>
              <Text color="gray">{row.left.lineNum ? String(row.left.lineNum).padStart(3) : "   "} </Text>
              <Text color={row.left.type === "removed" ? "red" : undefined}>
                {truncate(row.left.content, colWidth - 5)}
              </Text>
            </Box>

            {/* Separator */}
            <Text color={isCursor ? "cyan" : "gray"}>│</Text>

            {/* Right (new) */}
            <Box width={colWidth}>
              <Text color="gray">{row.right.lineNum ? String(row.right.lineNum).padStart(3) : "   "} </Text>
              <Text color={row.right.type === "added" ? "green" : undefined}>
                {truncate(row.right.content, colWidth - 5)}
              </Text>
            </Box>
          </Box>
        );
      })}
    </Box>
  );
}

/**
 * Build side-by-side rows from a file's hunks.
 */
function buildSideBySideRows(file: DiffFile): SideBySideRow[] {
  const rows: SideBySideRow[] = [];
  let globalIdx = 0;

  for (const hunk of file.hunks) {
    // Hunk header row
    rows.push({
      left: { lineNum: null, content: hunk.header, type: "context" },
      right: { lineNum: null, content: "", type: "empty" },
      globalIdx: globalIdx++,
    });

    // Process lines — pair removed with added
    let i = 0;
    while (i < hunk.lines.length) {
      const line = hunk.lines[i];

      if (line.type === "context") {
        rows.push({
          left: { lineNum: line.oldLine, content: line.content, type: "context" },
          right: { lineNum: line.newLine, content: line.content, type: "context" },
          globalIdx: globalIdx++,
        });
        i++;
      } else if (line.type === "removed") {
        // Look ahead for a matching added line
        const nextAdded = i + 1 < hunk.lines.length && hunk.lines[i + 1].type === "added"
          ? hunk.lines[i + 1]
          : null;

        if (nextAdded) {
          // Paired: show old left, new right
          rows.push({
            left: { lineNum: line.oldLine, content: line.content, type: "removed" },
            right: { lineNum: nextAdded.newLine, content: nextAdded.content, type: "added" },
            globalIdx: globalIdx++,
          });
          i += 2;
        } else {
          // Unpaired removal
          rows.push({
            left: { lineNum: line.oldLine, content: line.content, type: "removed" },
            right: { lineNum: null, content: "", type: "empty" },
            globalIdx: globalIdx++,
          });
          i++;
        }
      } else if (line.type === "added") {
        // Unpaired addition (no preceding removal)
        rows.push({
          left: { lineNum: null, content: "", type: "empty" },
          right: { lineNum: line.newLine, content: line.content, type: "added" },
          globalIdx: globalIdx++,
        });
        i++;
      } else {
        i++;
      }
    }
  }

  return rows;
}

function truncate(s: string, maxLen: number): string {
  if (s.length <= maxLen) return s;
  return s.slice(0, maxLen - 1) + "…";
}

export { buildSideBySideRows };

/**
 * DiffView — reusable diff rendering component.
 *
 * Takes a ParsedDiff and renders it as colored terminal output.
 * Used by ReviewPage but can also be used standalone.
 */

import React from "react";
import { Box, Text } from "ink";
import type { DiffFile, DiffHunk, DiffLine } from "../domain/diff-parser.js";

interface DiffViewProps {
  files: DiffFile[];
  /** Highlight violations at specific file:line positions */
  violations?: Array<{ file: string; line: number; message: string }>;
}

export function DiffView({ files, violations = [] }: DiffViewProps) {
  return (
    <Box flexDirection="column">
      {files.map((file, i) => (
        <FileView key={i} file={file} violations={violations} />
      ))}
    </Box>
  );
}

function FileView({
  file,
  violations,
}: {
  file: DiffFile;
  violations: Array<{ file: string; line: number; message: string }>;
}) {
  const statusLabel =
    file.status === "added" ? " (new)" :
    file.status === "deleted" ? " (deleted)" :
    file.status === "renamed" ? ` (from ${file.oldPath})` :
    file.status === "binary" ? " (binary)" : "";

  return (
    <Box flexDirection="column" marginTop={1}>
      <Text bold color="white">
        ── {file.path}{statusLabel} ──
      </Text>

      {file.status === "binary" ? (
        <Text color="gray">  Binary file — cannot display diff</Text>
      ) : (
        file.hunks.map((hunk, i) => (
          <HunkView
            key={i}
            hunk={hunk}
            filePath={file.path}
            violations={violations}
          />
        ))
      )}
    </Box>
  );
}

function HunkView({
  hunk,
  filePath,
  violations,
}: {
  hunk: DiffHunk;
  filePath: string;
  violations: Array<{ file: string; line: number; message: string }>;
}) {
  return (
    <Box flexDirection="column">
      <Text color="cyan" dimColor>
        {hunk.header}{hunk.context ? ` ${hunk.context}` : ""}
      </Text>

      {hunk.lines.map((line, i) => {
        const lineNum = line.type === "removed" ? line.oldLine : line.newLine;
        const violation = violations.find(
          (v) => v.file === filePath && v.line === lineNum
        );

        return (
          <Box key={i} flexDirection="column">
            <LineView line={line} />
            {violation && (
              <Text color="yellow">
                {"     "}⚠️ {violation.message}
              </Text>
            )}
          </Box>
        );
      })}
    </Box>
  );
}

function LineView({ line }: { line: DiffLine }) {
  const lineNum = line.type === "removed"
    ? String(line.oldLine ?? "").padStart(4)
    : String(line.newLine ?? "").padStart(4);
  const prefix = line.type === "added" ? "+" : line.type === "removed" ? "-" : " ";
  const color = line.type === "added" ? "green" : line.type === "removed" ? "red" : undefined;

  return (
    <Box>
      <Text color="gray">{lineNum} </Text>
      <Text color={color}>
        {prefix} {line.content}
      </Text>
    </Box>
  );
}

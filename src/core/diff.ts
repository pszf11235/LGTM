/**
 * Diff Parser — parse unified diff format into structured data.
 *
 * Converts raw `git diff` output into navigable TypeScript objects:
 * files → hunks → lines, with proper line numbering for both sides.
 *
 * Handles:
 * - Multi-file diffs
 * - New/deleted/renamed files
 * - Binary files (flagged, not parsed)
 * - Hunk headers with context
 * - Line-level old/new numbering
 */

/**
 * A parsed diff containing all changed files.
 */
export interface ParsedDiff {
  files: DiffFile[];
}

/**
 * A single file's diff.
 */
export interface DiffFile {
  /** File path (new path if renamed, otherwise the file path) */
  path: string;

  /** Original path (if renamed/moved) */
  oldPath?: string;

  /** Type of change */
  status: "added" | "deleted" | "modified" | "renamed" | "binary";

  /** Diff hunks (empty for binary files) */
  hunks: DiffHunk[];
}

/**
 * A hunk within a file diff (a contiguous block of changes).
 */
export interface DiffHunk {
  /** Raw hunk header (e.g., "@@ -1,4 +1,6 @@") */
  header: string;

  /** Optional context from the @@ line (e.g., "function name") */
  context?: string;

  /** Starting line number in the old file */
  oldStart: number;

  /** Number of lines in the old version */
  oldCount: number;

  /** Starting line number in the new file */
  newStart: number;

  /** Number of lines in the new version */
  newCount: number;

  /** Individual lines in this hunk */
  lines: DiffLine[];
}

/**
 * A single line in a diff hunk.
 */
export interface DiffLine {
  /** Type of line */
  type: "added" | "removed" | "context";

  /** Line content (without the +/-/space prefix) */
  content: string;

  /** Line number in the old file (null for added lines) */
  oldLine: number | null;

  /** Line number in the new file (null for removed lines) */
  newLine: number | null;
}

/**
 * A sliced hunk for display on a finding card.
 */
export interface SlicedHunk {
  /** Raw hunk header (e.g., "@@ -1,4 +1,6 @@") */
  header: string;

  /** Lines in the slice (hunk lines with preserved indices) */
  lines: DiffLine[];
}

/**
 * Parse a raw unified diff string into structured data.
 *
 * @param raw - Raw unified diff output from `git diff`
 * @returns Parsed diff with files, hunks, and lines
 */
export function parseDiff(raw: string): ParsedDiff {
  const files: DiffFile[] = [];
  const lines = raw.split("\n");
  let i = 0;

  while (i < lines.length) {
    // Look for file header: "diff --git a/path b/path"
    if (lines[i].startsWith("diff --git ")) {
      const file = parseFile(lines, i);
      if (file) {
        files.push(file.file);
        i = file.nextIndex;
      } else {
        i++;
      }
    } else {
      i++;
    }
  }

  return { files };
}

/**
 * Parse a single file's diff starting at the "diff --git" line.
 */
function parseFile(
  lines: string[],
  startIdx: number
): { file: DiffFile; nextIndex: number } | null {
  const diffLine = lines[startIdx];
  const pathMatch = diffLine.match(/^diff --git a\/(.+?) b\/(.+)$/);
  if (!pathMatch) return null;

  const oldPath = pathMatch[1];
  const newPath = pathMatch[2];

  let i = startIdx + 1;
  let status: DiffFile["status"] = "modified";
  let finalOldPath: string | undefined;

  // Parse metadata lines (index, new file mode, deleted file mode, rename, binary)
  while (i < lines.length && !lines[i].startsWith("diff --git ")) {
    const line = lines[i];

    if (line.startsWith("new file mode")) {
      status = "added";
      i++;
    } else if (line.startsWith("deleted file mode")) {
      status = "deleted";
      i++;
    } else if (line.startsWith("rename from ")) {
      status = "renamed";
      finalOldPath = line.replace("rename from ", "");
      i++;
    } else if (line.startsWith("rename to ")) {
      i++;
    } else if (line.startsWith("similarity index")) {
      i++;
    } else if (line === "Binary files differ" || line.startsWith("Binary files")) {
      return {
        file: {
          path: newPath,
          oldPath: oldPath !== newPath ? oldPath : undefined,
          status: "binary",
          hunks: [],
        },
        nextIndex: i + 1,
      };
    } else if (line.startsWith("index ")) {
      i++;
    } else if (line.startsWith("--- ")) {
      // Start of actual diff content — break to parse hunks
      break;
    } else {
      i++;
    }
  }

  // Parse hunks
  const hunks: DiffHunk[] = [];

  // Skip --- and +++ lines
  if (i < lines.length && lines[i].startsWith("--- ")) i++;
  if (i < lines.length && lines[i].startsWith("+++ ")) i++;

  // Parse hunk headers and content
  while (i < lines.length && !lines[i].startsWith("diff --git ")) {
    if (lines[i].startsWith("@@ ")) {
      const hunk = parseHunk(lines, i);
      if (hunk) {
        hunks.push(hunk.hunk);
        i = hunk.nextIndex;
      } else {
        i++;
      }
    } else {
      i++;
    }
  }

  return {
    file: {
      path: newPath,
      oldPath: finalOldPath ?? (oldPath !== newPath ? oldPath : undefined),
      status,
      hunks,
    },
    nextIndex: i,
  };
}

/**
 * Parse a single hunk starting at the @@ line.
 */
function parseHunk(
  lines: string[],
  startIdx: number
): { hunk: DiffHunk; nextIndex: number } | null {
  const headerLine = lines[startIdx];
  const match = headerLine.match(
    /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/
  );
  if (!match) return null;

  const oldStart = parseInt(match[1], 10);
  const oldCount = match[2] !== undefined ? parseInt(match[2], 10) : 1;
  const newStart = parseInt(match[3], 10);
  const newCount = match[4] !== undefined ? parseInt(match[4], 10) : 1;
  const context = match[5]?.trim() || undefined;

  const hunkLines: DiffLine[] = [];
  let oldLine = oldStart;
  let newLine = newStart;
  let i = startIdx + 1;

  // A hunk header declares exactly how many old and new lines follow. Honour
  // those counts: splitting a newline-terminated diff leaves a trailing empty
  // element, and an empty string is otherwise indistinguishable from a context
  // line whose trailing space was stripped. Without this bound the last hunk of
  // the last file gains a phantom line one past the end of the file, which
  // passes local validation and then makes GitHub reject the entire review.
  let oldTaken = 0;
  let newTaken = 0;

  while (i < lines.length) {
    if (oldTaken >= oldCount && newTaken >= newCount) break;

    const line = lines[i];

    // Stop at next hunk, next file, or end of diff
    if (
      line.startsWith("@@ ") ||
      line.startsWith("diff --git ") ||
      line === "\\ No newline at end of file"
    ) {
      if (line === "\\ No newline at end of file") {
        i++;
        continue;
      }
      break;
    }

    if (line.startsWith("+")) {
      hunkLines.push({
        type: "added",
        content: line.slice(1),
        oldLine: null,
        newLine: newLine++,
      });
      newTaken++;
    } else if (line.startsWith("-")) {
      hunkLines.push({
        type: "removed",
        content: line.slice(1),
        oldLine: oldLine++,
        newLine: null,
      });
      oldTaken++;
    } else if (line.startsWith(" ") || line === "") {
      hunkLines.push({
        type: "context",
        content: line.startsWith(" ") ? line.slice(1) : line,
        oldLine: oldLine++,
        newLine: newLine++,
      });
      oldTaken++;
      newTaken++;
    } else {
      // Unknown line format — skip
      break;
    }

    i++;
  }

  return {
    hunk: {
      header: headerLine,
      context,
      oldStart,
      oldCount,
      newStart,
      newCount,
      lines: hunkLines,
    },
    nextIndex: i,
  };
}

/**
 * Get a flat list of all changed file paths from a parsed diff.
 */
export function getChangedPaths(diff: ParsedDiff): string[] {
  return diff.files.map((f) => f.path);
}

/**
 * Count total lines added and removed across all files.
 */
export function getDiffStats(diff: ParsedDiff): {
  filesChanged: number;
  additions: number;
  deletions: number;
} {
  let additions = 0;
  let deletions = 0;

  for (const file of diff.files) {
    for (const hunk of file.hunks) {
      for (const line of hunk.lines) {
        if (line.type === "added") additions++;
        if (line.type === "removed") deletions++;
      }
    }
  }

  return { filesChanged: diff.files.length, additions, deletions };
}

/**
 * Get a map of file paths to sets of commentable line numbers (added and context lines on RHS).
 */
export function getCommentableLines(diff: ParsedDiff): Map<string, Set<number>> {
  const result = new Map<string, Set<number>>();

  for (const file of diff.files) {
    const lines = new Set<number>();
    for (const hunk of file.hunks) {
      for (const line of hunk.lines) {
        // Added and context lines can be commented on in the new file.
        if ((line.type === "added" || line.type === "context") && line.newLine !== null) {
          lines.add(line.newLine);
        }
      }
    }
    result.set(file.path, lines);
  }

  return result;
}

/**
 * Slice a hunk from the diff for a finding card.
 *
 * Returns surrounding lines for a specific file and line number, with optional context window.
 * Returns null if the file, line, or commentable status is not found in the diff.
 *
 * @param diff - Parsed diff
 * @param file - File path to search for
 * @param line - Line number (RHS line number from new file)
 * @param context - Number of context lines to include on each side (default 5)
 * @returns Sliced hunk with header and lines, or null if not found
 */
export function sliceHunk(
  diff: ParsedDiff,
  file: string,
  line: number,
  context: number = 5
): SlicedHunk | null {
  // Find the file in the diff
  const diffFile = diff.files.find((f) => f.path === file);
  if (!diffFile) return null;

  // Search for the hunk containing this line
  for (const hunk of diffFile.hunks) {
    const lineIndex = hunk.lines.findIndex((l) => l.newLine === line);
    if (lineIndex === -1) continue;

    // Verify the line is commentable (added or context)
    const targetLine = hunk.lines[lineIndex];
    if (targetLine.type === "removed") return null;

    // Calculate slice boundaries within the hunk
    const startIdx = Math.max(0, lineIndex - context);
    const endIdx = Math.min(hunk.lines.length - 1, lineIndex + context);

    return {
      header: hunk.header,
      lines: hunk.lines.slice(startIdx, endIdx + 1),
    };
  }

  return null;
}

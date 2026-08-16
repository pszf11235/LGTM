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

  while (i < lines.length) {
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
    } else if (line.startsWith("-")) {
      hunkLines.push({
        type: "removed",
        content: line.slice(1),
        oldLine: oldLine++,
        newLine: null,
      });
    } else if (line.startsWith(" ") || line === "") {
      hunkLines.push({
        type: "context",
        content: line.startsWith(" ") ? line.slice(1) : line,
        oldLine: oldLine++,
        newLine: newLine++,
      });
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

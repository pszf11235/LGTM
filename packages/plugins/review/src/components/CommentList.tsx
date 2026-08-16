/**
 * CommentList — displays comments made during the review.
 *
 * Shows below the diff or in a dedicated section.
 * Each comment is linked to a file and line.
 */

import React from "react";
import { Box, Text } from "ink";
import type { ReviewComment } from "../domain/types.js";

interface CommentListProps {
  comments: ReviewComment[];
  /** Currently focused file (to highlight relevant comments) */
  currentFile?: string;
}

export function CommentList({ comments, currentFile }: CommentListProps) {
  if (comments.length === 0) {
    return (
      <Box marginTop={1}>
        <Text color="gray">No comments yet. Press c to comment on a line.</Text>
      </Box>
    );
  }

  // Group comments by file
  const byFile = new Map<string, ReviewComment[]>();
  for (const c of comments) {
    if (!byFile.has(c.file)) byFile.set(c.file, []);
    byFile.get(c.file)!.push(c);
  }

  return (
    <Box flexDirection="column" marginTop={1}>
      <Text bold>💬 Comments ({comments.length})</Text>

      {Array.from(byFile.entries()).map(([file, fileComments]) => (
        <Box key={file} flexDirection="column" marginTop={0}>
          <Text color={file === currentFile ? "cyan" : "gray"} bold={file === currentFile}>
            {file}
          </Text>
          {fileComments
            .sort((a, b) => a.line - b.line)
            .map((c) => (
              <Box key={c.id} paddingLeft={2}>
                <Text color="gray">L{String(c.line).padEnd(4)}</Text>
                <Text>{c.text}</Text>
              </Box>
            ))}
        </Box>
      ))}
    </Box>
  );
}

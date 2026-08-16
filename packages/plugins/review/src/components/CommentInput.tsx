/**
 * CommentInput — overlay text input for adding comments to lines.
 *
 * Appears at the bottom of the review page when `c` is pressed.
 * Shows the file and line number being commented on.
 */

import React, { useState } from "react";
import { Box, Text, useInput } from "ink";

interface CommentInputProps {
  file: string;
  line: number;
  onSubmit: (text: string) => void;
  onCancel: () => void;
}

export function CommentInput({ file, line, onSubmit, onCancel }: CommentInputProps) {
  const [text, setText] = useState("");

  useInput((input: string, key: { escape?: boolean; return?: boolean; backspace?: boolean; delete?: boolean }) => {
    if (key.escape) {
      onCancel();
      return;
    }
    if (key.return) {
      if (text.trim()) {
        onSubmit(text.trim());
      } else {
        onCancel();
      }
      return;
    }
    if (key.backspace || key.delete) {
      setText((prev) => prev.slice(0, -1));
      return;
    }
    // Regular character input
    if (input && !key.escape && !key.return) {
      setText((prev) => prev + input);
    }
  });

  return (
    <Box flexDirection="column" borderStyle="single" borderColor="cyan" paddingX={1}>
      <Text color="gray">
        Comment on {file}:{line}
      </Text>
      <Box>
        <Text color="cyan">{">"} </Text>
        <Text>{text}</Text>
        <Text color="gray">█</Text>
      </Box>
      <Text color="gray" dimColor>
        Enter to submit · Escape to cancel
      </Text>
    </Box>
  );
}

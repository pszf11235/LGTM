/**
 * Model Picker — dialog triggered by 'm' key in TUI.
 *
 * Shows available LLM models/connections, lets user switch mid-session.
 * OpenCode-style: overlay dialog with arrow selection.
 */

import React, { useState } from "react";
import { Box, Text, useInput } from "ink";

interface ModelOption {
  name: string;
  provider: string;
  model: string;
  isCurrent: boolean;
}

interface ModelPickerProps {
  models: ModelOption[];
  onSelect: (model: ModelOption) => void;
  onClose: () => void;
}

export function ModelPicker({ models, onSelect, onClose }: ModelPickerProps) {
  const [selectedIdx, setSelectedIdx] = useState(
    models.findIndex((m) => m.isCurrent) || 0
  );

  useInput((input, key) => {
    if (key.downArrow || input === "j") {
      setSelectedIdx((prev) => Math.min(prev + 1, models.length - 1));
    }
    if (key.upArrow || input === "k") {
      setSelectedIdx((prev) => Math.max(prev - 1, 0));
    }
    if (key.return) {
      onSelect(models[selectedIdx]);
    }
    if (key.escape || input === "m" || input === "q") {
      onClose();
    }
  });

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={2} paddingY={1}>
      <Text bold>Select Model</Text>
      <Text color="gray">↑↓ navigate · enter select · esc close</Text>
      <Box marginTop={1} flexDirection="column">
        {models.map((model, i) => {
          const isSelected = i === selectedIdx;
          const marker = model.isCurrent ? "●" : isSelected ? "❯" : " ";
          const color = isSelected ? "cyan" : model.isCurrent ? "green" : undefined;

          return (
            <Box key={model.name}>
              <Text color={color} bold={isSelected}>
                {marker} {model.model} <Text color="gray">({model.provider})</Text>
                {model.isCurrent && <Text color="green"> current</Text>}
              </Text>
            </Box>
          );
        })}
      </Box>
    </Box>
  );
}

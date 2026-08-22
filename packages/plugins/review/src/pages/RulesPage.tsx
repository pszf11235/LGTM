/**
 * Rules Browser Page — TUI page for browsing and managing rules.
 *
 * Lists all rules with enable/disable toggle, trigger counts, details.
 */

import React, { useState, useEffect } from "react";
import { Box, Text, useInput, useApp } from "ink";
import type { Rule } from "../domain/rules.js";

interface RulesPageProps {
  onStatusHint: (hint: string) => void;
}

export function RulesPage({ onStatusHint }: RulesPageProps) {
  const [rules, setRules] = useState<Rule[]>([]);
  const [selectedIdx, setSelectedIdx] = useState(0);
  const [loading, setLoading] = useState(true);
  const { exit } = useApp();

  useEffect(() => {
    onStatusHint("↑↓ navigate  enter toggle  d detail  q quit");
    loadRules();
  }, []);

  async function loadRules() {
    try {
      const { createOKFStore } = await import("@lgtm/core/store/okf.js");
      const { findGitRoot } = await import("@lgtm/core/store/paths.js");
      const { loadBootstrap, resolveLgtmDir } = await import("@lgtm/core/config/loader.js");
      const { createRulesEngine } = await import("../domain/rules.js");

      const repoRoot = findGitRoot();
      const bootstrap = loadBootstrap();
      const lgtmDir = resolveLgtmDir(bootstrap, repoRoot);
      const store = createOKFStore(lgtmDir);
      const engine = createRulesEngine(store);

      const loaded = await engine.loadRules();
      setRules(loaded);
    } catch { /* no rules */ }
    setLoading(false);
  }

  useInput((input, key) => {
    if (key.downArrow || input === "j") {
      setSelectedIdx((prev) => Math.min(prev + 1, rules.length - 1));
    }
    if (key.upArrow || input === "k") {
      setSelectedIdx((prev) => Math.max(prev - 1, 0));
    }
    if (input === "q") {
      exit();
    }
  });

  if (loading) {
    return <Text color="gray">Loading rules...</Text>;
  }

  if (rules.length === 0) {
    return (
      <Box flexDirection="column" paddingY={1}>
        <Text color="gray">No rules defined.</Text>
        <Text color="gray">Create with: lgtm review rule add "description"</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      <Box marginBottom={1}>
        <Text bold>Rules ({rules.length})</Text>
      </Box>

      {rules.map((rule, i) => {
        const isSelected = i === selectedIdx;
        const icon = rule.enabled ? "●" : "○";
        const sevColor = rule.severity === "error" ? "red" : "yellow";
        const triggered = rule.timesTriggered > 0 ? ` (×${rule.timesTriggered})` : "";

        return (
          <Box key={rule.id} flexDirection="column">
            <Text inverse={isSelected} bold={isSelected}>
              {isSelected ? "❯ " : "  "}
              <Text color={rule.enabled ? "green" : "gray"}>{icon}</Text>
              {" "}{rule.id.padEnd(14)} <Text color={sevColor}>{rule.severity.padEnd(5)}</Text>
              {" "}{rule.category.padEnd(12)}
              {" "}{rule.enforcement.padEnd(5)}
              {" "}{rule.description.slice(0, 35)}{triggered}
            </Text>
            {isSelected && (
              <Box paddingLeft={4} flexDirection="column">
                {rule.pattern && <Text color="gray">Pattern: {rule.pattern}</Text>}
                {rule.filePattern && <Text color="gray">Files: {rule.filePattern}</Text>}
                {rule.examples.bad.length > 0 && <Text color="red">Bad: {rule.examples.bad[0]}</Text>}
                {rule.examples.good.length > 0 && <Text color="green">Good: {rule.examples.good[0]}</Text>}
              </Box>
            )}
          </Box>
        );
      })}
    </Box>
  );
}

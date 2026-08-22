/**
 * Rules Browser Page — TUI page for browsing and managing rules.
 *
 * Lists all rules with enable/disable toggle. Enter toggles the selected rule.
 * Scrollable with viewport clipping.
 */

import React, { useState, useEffect } from "react";
import { Box, Text, useInput } from "ink";
import type { Rule } from "../domain/rules.js";
import { useScrollableList, useFlash } from "@lgtm/core/tui/hooks/index.js";

interface RulesPageProps {
  onStatusHint: (hint: string) => void;
}

export function RulesPage({ onStatusHint }: RulesPageProps) {
  const [rules, setRules] = useState<Rule[]>([]);
  const [loading, setLoading] = useState(true);
  const { flash, showFlash } = useFlash();

  const {
    selectedIdx, visibleItems, moveDown, moveUp, pageDown, pageUp, goTop, goBottom, position,
  } = useScrollableList(rules, { reservedLines: 8 });

  useEffect(() => {
    onStatusHint("↑↓ navigate  enter toggle  d/u page  g/G top/bottom");
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

  async function toggleRule() {
    const rule = rules[selectedIdx];
    if (!rule) return;

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

      await engine.setEnabled(rule.id, !rule.enabled);
      const newEnabled = !rule.enabled;
      setRules((prev) => prev.map((r) => r.id === rule.id ? { ...r, enabled: newEnabled } : r));
      showFlash(`${newEnabled ? "✓ Enabled" : "○ Disabled"}: ${rule.description}`, newEnabled ? "green" : "gray");
    } catch {
      showFlash("✗ Failed to toggle rule", "red");
    }
  }

  useInput((input, key) => {
    if (key.downArrow || input === "j") moveDown();
    if (key.upArrow || input === "k") moveUp();
    if (input === "d") pageDown();
    if (input === "u") pageUp();
    if (input === "g") goTop();
    if (input === "G") goBottom();
    if (key.return) toggleRule();
  });

  if (loading) {
    return <Text color="gray">  Loading rules...</Text>;
  }

  if (rules.length === 0) {
    return (
      <Box flexDirection="column" paddingY={1}>
        <Text color="gray">  No rules defined.</Text>
        <Text color="gray">  Create with: lgtm review rule add "description"</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      <Box marginBottom={1}>
        <Text bold>  Rules ({rules.length})</Text>
        <Text color="gray">  {position}</Text>
      </Box>

      {flash && <Text color={flash.color}>  {flash.text}</Text>}

      {visibleItems.map((rule) => {
        const isSelected = rules.indexOf(rule) === selectedIdx;
        const icon = rule.enabled ? "●" : "○";
        const sevColor = rule.severity === "error" ? "red" : "yellow";
        const triggered = rule.timesTriggered > 0 ? ` (×${rule.timesTriggered})` : "";

        return (
          <Box key={rule.id} flexDirection="column">
            <Text inverse={isSelected} bold={isSelected}>
              {isSelected ? "▸ " : "  "}
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

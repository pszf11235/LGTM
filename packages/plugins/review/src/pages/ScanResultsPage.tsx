/**
 * Scan Results Page — TUI page showing repo scan violations.
 *
 * Violations grouped by rule, navigate to specific file:line.
 */

import React, { useState, useEffect } from "react";
import { Box, Text, useInput, useApp } from "ink";

interface Violation {
  ruleId: string;
  ruleDescription: string;
  severity: string;
  file: string;
  line: number;
  content: string;
}

interface ScanResultsPageProps {
  onStatusHint: (hint: string) => void;
}

export function ScanResultsPage({ onStatusHint }: ScanResultsPageProps) {
  const [violations, setViolations] = useState<Violation[]>([]);
  const [selectedIdx, setSelectedIdx] = useState(0);
  const [loading, setLoading] = useState(true);
  const { exit } = useApp();

  useEffect(() => {
    onStatusHint("↑↓ navigate  enter open  q quit");
    loadResults();
  }, []);

  async function loadResults() {
    try {
      const { createOKFStore } = await import("@lgtm/core/store/okf.js");
      const { findGitRoot } = await import("@lgtm/core/store/paths.js");
      const { loadBootstrap, resolveLgtmDir } = await import("@lgtm/core/config/loader.js");

      const repoRoot = findGitRoot();
      const bootstrap = loadBootstrap();
      const lgtmDir = resolveLgtmDir(bootstrap, repoRoot);
      const store = createOKFStore(lgtmDir);

      // Find most recent scan
      const scanFiles = await store.list("scans");
      if (scanFiles.length === 0) {
        setLoading(false);
        return;
      }

      const latest = scanFiles.sort().reverse()[0];
      const doc = await store.read(latest);
      if (doc) {
        // Parse violations from scan markdown body
        const parsed = doc.content
          .split("\n")
          .filter((l) => l.startsWith("- **"))
          .map((l) => {
            const match = l.match(/\*\*(.+?):(\d+)\*\* \[(.+?)\] (.+)/);
            if (!match) return null;
            return {
              file: match[1],
              line: parseInt(match[2]),
              ruleId: match[3],
              ruleDescription: match[3],
              severity: "warn",
              content: match[4],
            };
          })
          .filter(Boolean) as Violation[];
        setViolations(parsed);
      }
    } catch { /* no scan results */ }
    setLoading(false);
  }

  useInput((input, key) => {
    if (key.downArrow || input === "j") {
      setSelectedIdx((prev) => Math.min(prev + 1, violations.length - 1));
    }
    if (key.upArrow || input === "k") {
      setSelectedIdx((prev) => Math.max(prev - 1, 0));
    }
    if (input === "q") {
      exit();
    }
  });

  if (loading) return <Text color="gray">Loading scan results...</Text>;

  if (violations.length === 0) {
    return (
      <Box flexDirection="column" paddingY={1}>
        <Text color="green">✓ No violations found (or no scan run yet).</Text>
        <Text color="gray">Run: lgtm review scan</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      <Box marginBottom={1}>
        <Text bold>Scan Results ({violations.length} violations)</Text>
      </Box>

      {violations.map((v, i) => {
        const isSelected = i === selectedIdx;
        const sevColor = v.severity === "error" ? "red" : "yellow";

        return (
          <Box key={`${v.file}:${v.line}`}>
            <Text inverse={isSelected} bold={isSelected}>
              {isSelected ? "❯ " : "  "}
              <Text color={sevColor}>●</Text>
              {" "}{v.file}:{v.line}
              {"  "}<Text color="gray">{v.content.slice(0, 50)}</Text>
            </Text>
          </Box>
        );
      })}

      <Box marginTop={1}>
        <Text color="red">{violations.filter((v) => v.severity === "error").length} errors</Text>
        <Text> </Text>
        <Text color="yellow">{violations.filter((v) => v.severity === "warn").length} warnings</Text>
      </Box>
    </Box>
  );
}

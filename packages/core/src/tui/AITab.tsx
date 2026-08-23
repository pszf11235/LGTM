/**
 * AI Tab — which review provider will be used, and why.
 *
 * This is the same data `lgtm ai discover` prints, from the same detection
 * (`ai/providers.ts`). It used to run a second, older discovery that knew about
 * a different set of providers, so the tab and the CLI disagreed on a machine
 * where both worked.
 *
 * Read-only on purpose. The provider is chosen by the `provider` field in
 * ~/.lgtm-farm/agents/<agent>.md, so a control here that looked like it changed
 * something would be lying: nothing in the review path reads TUI state.
 */

import React, { useState, useEffect } from "react";
import { Box, Text, useInput } from "ink";
import type { ProviderStatus, ProviderId } from "../ai/providers.js";

interface AITabProps {
  onStatusHint: (hint: string) => void;
}

interface AITabState {
  statuses: ProviderStatus[];
  resolved: ProviderId | null;
  resolveError: string;
  skipped: ProviderId[];
  isDiscovering: boolean;
}

export function AITab({ onStatusHint }: AITabProps) {
  const [state, setState] = useState<AITabState>({
    statuses: [],
    resolved: null,
    resolveError: "",
    skipped: [],
    isDiscovering: true,
  });

  useEffect(() => {
    onStatusHint("[r] re-detect");
  }, []);

  useEffect(() => {
    void runDiscovery();
  }, []);

  async function runDiscovery() {
    setState((prev) => ({ ...prev, isDiscovering: true }));
    try {
      const { detectProviders, resolveProvider } = await import("../ai/providers.js");
      const statuses = await detectProviders();
      const resolved = resolveProvider("auto", statuses);

      setState({
        statuses,
        resolved: "error" in resolved ? null : resolved.id,
        resolveError: "error" in resolved ? resolved.error : "",
        skipped: "error" in resolved ? [] : resolved.skipped,
        isDiscovering: false,
      });
    } catch (err) {
      setState((prev) => ({
        ...prev,
        isDiscovering: false,
        resolveError: (err as Error).message,
      }));
    }
  }

  useInput((input) => {
    if (input === "r") void runDiscovery();
  });

  if (state.isDiscovering && state.statuses.length === 0) {
    return (
      <Box paddingX={2}>
        <Text dimColor>Detecting review providers...</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" paddingX={2}>
      <Text bold>Review Providers</Text>
      <Box height={1} />

      {state.statuses.map((s) => (
        <Box key={s.id} flexDirection="column">
          <Box>
            <Text color={s.available ? "green" : "gray"}>{s.available ? "✓" : "✗"} </Text>
            <Text color={s.available ? "cyan" : "gray"}>{s.id.padEnd(12)}</Text>
            <Text dimColor>{s.detail}</Text>
            {s.hasBuiltInReview && <Text dimColor> (has its own review command)</Text>}
          </Box>
          {!s.available && s.fix !== "" && (
            <Text dimColor>{"      → "}{s.fix}</Text>
          )}
        </Box>
      ))}

      <Box height={1} />

      {state.resolved !== null ? (
        <>
          <Box>
            <Text bold>provider: auto</Text>
            <Text> resolves to </Text>
            <Text color="green">{state.resolved}</Text>
          </Box>
          {state.skipped.length > 0 && (
            <Text dimColor>Skipped, in priority order: {state.skipped.join(", ")}</Text>
          )}
        </>
      ) : (
        <Text color="yellow">{state.resolveError}</Text>
      )}

      <Box height={1} />
      <Text dimColor>Pin a provider in ~/.lgtm-farm/agents/reviewer.md</Text>
    </Box>
  );
}

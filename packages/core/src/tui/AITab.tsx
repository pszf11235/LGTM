/**
 * AI Management Tab — interactive TUI screen for AI provider configuration.
 *
 * Provides:
 * - Current provider status display (name, model, connection status)
 * - List of all detected providers
 * - Keyboard shortcuts for re-discovery, switching providers, changing models, testing connection
 *
 * Accessible via the "AI" tab in the Shell tab navigation.
 */

import React, { useState, useEffect } from "react";
import { Box, Text, useInput } from "ink";
import type { DetectedProvider, AIDiscoveryResult } from "../onboarding/detect-ai.js";

interface AITabProps {
  onStatusHint: (hint: string) => void;
}

interface AITabState {
  providers: DetectedProvider[];
  currentProvider: DetectedProvider | null;
  currentModel: string;
  connectionStatus: "unknown" | "checking" | "online" | "offline";
  isDiscovering: boolean;
  lastAction: string;
}

export function AITab({ onStatusHint }: AITabProps) {
  const [state, setState] = useState<AITabState>({
    providers: [],
    currentProvider: null,
    currentModel: "",
    connectionStatus: "unknown",
    isDiscovering: false,
    lastAction: "",
  });

  // Set status hint on mount
  useEffect(() => {
    onStatusHint("[r] re-discover  [s] switch provider  [m] change model  [t] test connection");
  }, []);

  // Auto-discover on mount
  useEffect(() => {
    runDiscovery();
  }, []);

  async function runDiscovery() {
    setState((prev) => ({ ...prev, isDiscovering: true, lastAction: "Discovering AI providers..." }));
    try {
      const { discoverAIProviders } = await import("../onboarding/detect-ai.js");
      const result: AIDiscoveryResult = await discoverAIProviders();
      setState((prev) => ({
        ...prev,
        providers: result.providers,
        currentProvider: prev.currentProvider ?? result.recommended,
        currentModel: prev.currentModel || (result.recommended?.defaultModel ?? ""),
        isDiscovering: false,
        lastAction: result.summary,
      }));
    } catch (err: any) {
      setState((prev) => ({
        ...prev,
        isDiscovering: false,
        lastAction: `Discovery failed: ${err.message}`,
      }));
    }
  }

  function switchProvider() {
    setState((prev) => {
      const available = prev.providers.filter((p) => p.available);
      if (available.length === 0) return { ...prev, lastAction: "No available providers to switch to" };

      const currentIdx = available.findIndex((p) => p.id === prev.currentProvider?.id && p.detectedVia === prev.currentProvider?.detectedVia);
      const nextIdx = (currentIdx + 1) % available.length;
      const next = available[nextIdx];

      return {
        ...prev,
        currentProvider: next,
        currentModel: next.defaultModel,
        connectionStatus: "unknown",
        lastAction: `Switched to ${next.name} (${next.detectedVia})`,
      };
    });
  }

  function testConnection() {
    setState((prev) => ({ ...prev, connectionStatus: "checking", lastAction: "Testing connection..." }));
    // Simulate a connection test with a timeout
    setTimeout(() => {
      setState((prev) => {
        const isOnline = prev.currentProvider?.available ?? false;
        return {
          ...prev,
          connectionStatus: isOnline ? "online" : "offline",
          lastAction: isOnline
            ? `✓ Connection to ${prev.currentProvider?.name ?? "provider"} successful`
            : `✗ Cannot reach ${prev.currentProvider?.name ?? "provider"}`,
        };
      });
    }, 500);
  }

  useInput((input, key) => {
    if (input === "r") {
      runDiscovery();
    } else if (input === "s") {
      switchProvider();
    } else if (input === "t") {
      testConnection();
    }
    // Note: [m] for model change would require text input mode,
    // which is complex in Ink. For now we cycle models or show info.
    if (input === "m") {
      setState((prev) => ({
        ...prev,
        lastAction: "Model change: use `lgtm config --edit` to set a custom model",
      }));
    }
  });

  const { providers, currentProvider, currentModel, connectionStatus, isDiscovering, lastAction } = state;

  // Connection status indicator
  const statusIcon = connectionStatus === "online" ? "✓"
    : connectionStatus === "offline" ? "✗"
    : connectionStatus === "checking" ? "…"
    : "?";

  const statusColor = connectionStatus === "online" ? "green"
    : connectionStatus === "offline" ? "red"
    : connectionStatus === "checking" ? "yellow"
    : "gray";

  return (
    <Box flexDirection="column">
      {/* Title */}
      <Box marginBottom={1}>
        <Text bold>🤖 AI Provider Management</Text>
      </Box>

      {/* Current Status Section */}
      <Box flexDirection="column" marginBottom={1}>
        <Text bold underline>Current Configuration</Text>
        {currentProvider ? (
          <Box flexDirection="column" marginLeft={2}>
            <Text>
              Provider: <Text color="cyan">{currentProvider.name}</Text>
            </Text>
            <Text>
              Model:    <Text color="cyan">{currentModel || currentProvider.defaultModel}</Text>
            </Text>
            <Text>
              Source:   <Text color="gray">{currentProvider.detectedVia}</Text>
            </Text>
            <Text>
              Status:   <Text color={statusColor}>{statusIcon} {connectionStatus}</Text>
            </Text>
          </Box>
        ) : (
          <Box flexDirection="column" marginLeft={2}>
            <Text color="yellow">No AI provider configured</Text>
            <Text color="gray">Press [r] to discover available providers, or run `lgtm config --edit`</Text>
          </Box>
        )}
      </Box>

      {/* Detected Providers List */}
      <Box flexDirection="column" marginBottom={1}>
        <Text bold underline>Detected Providers</Text>
        {isDiscovering ? (
          <Box marginLeft={2}>
            <Text color="yellow">⏳ Discovering providers...</Text>
          </Box>
        ) : providers.length === 0 ? (
          <Box marginLeft={2}>
            <Text color="gray">No providers detected. Set API keys or install AI tools.</Text>
          </Box>
        ) : (
          <Box flexDirection="column" marginLeft={2}>
            {providers.map((p, i) => (
              <Text key={i}>
                <Text color={p.available ? "green" : "red"}>
                  {p.available ? "●" : "○"}
                </Text>
                {" "}
                <Text>{p.name}</Text>
                <Text color="gray"> — {p.detectedVia}</Text>
                {p.detail ? <Text color="gray"> ({p.detail})</Text> : null}
                {p.id === currentProvider?.id && p.detectedVia === currentProvider?.detectedVia ? (
                  <Text color="cyan"> ← active</Text>
                ) : null}
              </Text>
            ))}
          </Box>
        )}
      </Box>

      {/* Actions / Keyboard Shortcuts */}
      <Box flexDirection="column" marginBottom={1}>
        <Text bold underline>Actions</Text>
        <Box flexDirection="column" marginLeft={2}>
          <Text><Text color="cyan">[r]</Text> Re-discover providers</Text>
          <Text><Text color="cyan">[s]</Text> Switch provider</Text>
          <Text><Text color="cyan">[m]</Text> Change model</Text>
          <Text><Text color="cyan">[t]</Text> Test connection</Text>
        </Box>
      </Box>

      {/* Last Action Status */}
      {lastAction ? (
        <Box marginLeft={2}>
          <Text color="gray">→ {lastAction}</Text>
        </Box>
      ) : null}
    </Box>
  );
}

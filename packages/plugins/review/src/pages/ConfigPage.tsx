/**
 * Config Viewer Page — read-only view of the resolved config and store layout.
 *
 * Sections:
 * - Configuration: plugins, AI settings
 * - Agents: the review prompts that actually shape reviews
 * - Paths: where the central store lives and what is in it
 */

import React, { useState, useEffect } from "react";
import { Box, Text, useInput } from "ink";
import { useScrollableList } from "@lgtm/core/tui/hooks/index.js";

interface ConfigPageProps {
  onStatusHint: (hint: string) => void;
}

interface ConfigData {
  plugins: Record<string, { enabled: boolean }>;
  ai: { enabled: boolean; provider?: string; model?: string; baseUrl?: string; apiKey?: string };
}

interface ProfileData {
  ai: { enabled: boolean; provider?: string; model?: string; baseUrl?: string };
  createdAt: string;
}

type Section = "config" | "agents" | "paths";

const SECTIONS: { key: Section; label: string; icon: string }[] = [
  { key: "config", label: "Configuration", icon: "⚙" },
  { key: "agents", label: "Agents", icon: "🤖" },
  { key: "paths", label: "Paths & Storage", icon: "📁" },
];

export function ConfigPage({ onStatusHint }: ConfigPageProps) {
  const [config, setConfig] = useState<ConfigData | null>(null);
  const [profile, setProfile] = useState<ProfileData | null>(null);
  const [agents, setAgents] = useState<string[]>([]);
  const [lgtmDir, setLgtmDir] = useState<string>("");
  const [repoRoot, setRepoRoot] = useState<string>("");
  const [reviewCount, setReviewCount] = useState<number>(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const { selectedIdx, moveDown, moveUp } = useScrollableList(SECTIONS, { reservedLines: 6 });

  useEffect(() => {
    onStatusHint("↑↓ sections  ←→ tabs");
    loadData();
  }, []);

  async function loadData() {
    try {
      const { loadConfig, loadProfile, loadBootstrap, resolveLgtmDir } = await import(
        "@lgtm/core/config/loader.js"
      );
      const { findGitRoot } = await import("@lgtm/core/store/paths.js");
      const { createOKFStore } = await import("@lgtm/core/store/okf.js");

      const root = findGitRoot();
      const dir = resolveLgtmDir(loadBootstrap());
      const store = createOKFStore(dir);

      setRepoRoot(root);
      setLgtmDir(dir);
      setConfig(loadConfig());
      setProfile(loadProfile(dir));

      try {
        const agentFiles = await store.list("agents");
        setAgents(agentFiles.map((f) => f.replace(/^agents\//, "")));
      } catch { /* no agents dir */ }

      try {
        const fs = await import("fs");
        const path = await import("path");
        const reviewsDir = path.default.join(dir, "reviews");
        if (fs.default.existsSync(reviewsDir)) {
          setReviewCount(fs.default.readdirSync(reviewsDir).length);
        }
      } catch { /* no reviews dir */ }
    } catch (err) {
      setError((err as Error).message);
    }
    setLoading(false);
  }

  useInput((input, key) => {
    if (key.downArrow || input === "j") moveDown();
    if (key.upArrow || input === "k") moveUp();
  });

  if (loading) {
    return (
      <Box paddingY={1}>
        <Text color="gray">  Loading configuration...</Text>
      </Box>
    );
  }

  if (error) {
    return (
      <Box paddingY={1} flexDirection="column">
        <Text color="red">  Error: {error}</Text>
        <Text color="gray">  Run `lgtm init` to create the store.</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      <Box marginBottom={1}>
        {SECTIONS.map((s, i) => (
          <Box key={s.key} marginRight={2}>
            <Text inverse={i === selectedIdx} bold={i === selectedIdx} color={i === selectedIdx ? "cyan" : "gray"}>
              {" "}{s.icon} {s.label}{" "}
            </Text>
          </Box>
        ))}
      </Box>

      {SECTIONS[selectedIdx].key === "config" && renderConfig()}
      {SECTIONS[selectedIdx].key === "agents" && renderAgents()}
      {SECTIONS[selectedIdx].key === "paths" && renderPaths()}
    </Box>
  );

  function renderConfig() {
    if (!config) {
      return (
        <Box paddingY={1}>
          <Text color="yellow">  No configuration loaded.</Text>
        </Box>
      );
    }

    return (
      <Box flexDirection="column" paddingLeft={1}>
        <Box marginBottom={1}>
          <Text bold>⚙ Resolved Configuration</Text>
        </Box>

        <Box marginBottom={1}>
          <Text bold color="gray">Plugins</Text>
        </Box>
        <Box flexDirection="column" paddingLeft={2}>
          {Object.keys(config.plugins).map((name) => {
            const enabled = config.plugins[name]?.enabled;
            return (
              <Text key={name}>
                <Text color={enabled ? "green" : "red"}>{enabled ? "●" : "○"}</Text>
                {" "}{name}
                <Text color="gray"> ({enabled ? "enabled" : "disabled"})</Text>
              </Text>
            );
          })}
        </Box>

        <Box marginTop={1} marginBottom={1}>
          <Text bold color="gray">AI (openrouter / ollama HTTP paths)</Text>
        </Box>
        <Box paddingLeft={2} flexDirection="column">
          <Field label="Enabled" value={config.ai.enabled ? "yes" : "no"} color={config.ai.enabled ? "green" : "gray"} />
          {config.ai.provider && <Field label="Provider" value={config.ai.provider} />}
          {config.ai.model && <Field label="Model" value={config.ai.model} />}
          {config.ai.baseUrl && <Field label="Base URL" value={config.ai.baseUrl} color="gray" />}
          {config.ai.apiKey && <Field label="API Key" value={maskKey(config.ai.apiKey)} color="gray" />}
        </Box>

        <Box marginTop={1}>
          <Text color="gray">  CLI providers are detected at review time — see `lgtm ai discover`.</Text>
        </Box>

        {profile && (
          <Box marginTop={1}>
            <Field label="Store created" value={formatDate(profile.createdAt)} color="gray" />
          </Box>
        )}
      </Box>
    );
  }

  function renderAgents() {
    return (
      <Box flexDirection="column" paddingLeft={1}>
        <Box marginBottom={1}>
          <Text bold>🤖 Review Agents</Text>
        </Box>

        {agents.length === 0 ? (
          <Box flexDirection="column">
            <Text color="yellow">  No agents configured.</Text>
            <Text color="gray">  Run `lgtm init` to write the default reviewer.</Text>
          </Box>
        ) : (
          <>
            <Box flexDirection="column" paddingLeft={2}>
              {agents.map((a) => (
                <Text key={a} color="white">• {a}</Text>
              ))}
            </Box>
            <Box marginTop={1} flexDirection="column">
              <Text color="gray">  Agent files hold the review prompt, provider and severity.</Text>
              <Text color="gray">  Edit them to change how reviews are written:</Text>
              <Text color="cyan">  {lgtmDir}/agents/</Text>
            </Box>
          </>
        )}
      </Box>
    );
  }

  function renderPaths() {
    return (
      <Box flexDirection="column" paddingLeft={1}>
        <Box marginBottom={1}>
          <Text bold>📁 Paths & Storage</Text>
        </Box>

        <Field label="Central store" value={lgtmDir} color="white" />
        <Field label="Current repo" value={repoRoot} color="gray" />
        <Field label="Reviews stored" value={String(reviewCount)} color="white" />

        <Box marginTop={1} marginBottom={1}>
          <Text bold color="gray">Store Layout</Text>
        </Box>
        <Box flexDirection="column" paddingLeft={2}>
          <Text color="gray">agents/                      <Text color="white">review prompts</Text></Text>
          <Text color="gray">reviews/{"<owner>-<repo>-<pr>"}/  <Text color="white">findings per round</Text></Text>
          <Text color="gray">rules/                       <Text color="white">regex + prompt-context rules</Text></Text>
          <Text color="gray">watch.md                     <Text color="white">watched repositories</Text></Text>
          <Text color="gray">cache/                       <Text color="white">fetched diffs</Text></Text>
        </Box>

        <Box marginTop={1} marginBottom={1}>
          <Text bold color="gray">Config Resolution Order</Text>
        </Box>
        <Box flexDirection="column" paddingLeft={2}>
          <Text color="gray">1. Built-in defaults</Text>
          <Text color="gray">2. Profile ({lgtmDir}/profile.md)</Text>
          <Text color="white">3. .lgtmrc.yaml (repo override)</Text>
          <Text color="gray">4. CLI flags</Text>
        </Box>

        <Box marginTop={1}>
          <Text color="gray">  One store serves every repo. Findings are namespaced by owner-repo-pr.</Text>
        </Box>
      </Box>
    );
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function Field({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <Box>
      <Text color="gray">{label.padEnd(16)}</Text>
      <Text color={color as any ?? "white"}>{value}</Text>
    </Box>
  );
}

function maskKey(key: string): string {
  if (key.length <= 8) return "••••••••";
  return key.slice(0, 4) + "•".repeat(key.length - 8) + key.slice(-4);
}

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString("en-US", {
      year: "numeric", month: "short", day: "numeric",
    });
  } catch {
    return iso;
  }
}

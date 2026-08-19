/**
 * Config/Profile Viewer Page — TUI page for viewing current config and profile.
 *
 * Shows:
 * - Profile: project, goal, stack, feedback style, team size, AI config
 * - Config: storage mode, enabled plugins, AI settings
 * - Bootstrap: farm path
 *
 * Read-only viewer with section navigation.
 */

import React, { useState, useEffect } from "react";
import { Box, Text, useInput, useApp } from "ink";

interface ConfigPageProps {
  onStatusHint: (hint: string) => void;
}

interface ProfileData {
  project: string;
  goal: string;
  qualityReferences: string[];
  feedbackStyle: string;
  techStack: string[];
  teamSize: string;
  ai: { enabled: boolean; provider?: string; model?: string; baseUrl?: string };
  createdAt: string;
}

interface ConfigData {
  storageMode: string;
  plugins: Record<string, { enabled: boolean }>;
  ai: { enabled: boolean; provider?: string; model?: string; baseUrl?: string; apiKey?: string };
}

interface BootstrapData {
  storageMode: string;
  farmPath?: string;
}

type Section = "profile" | "config" | "paths";

const SECTIONS: { key: Section; label: string; icon: string }[] = [
  { key: "profile", label: "Profile", icon: "👤" },
  { key: "config", label: "Configuration", icon: "⚙" },
  { key: "paths", label: "Paths & Storage", icon: "📁" },
];

export function ConfigPage({ onStatusHint }: ConfigPageProps) {
  const [profile, setProfile] = useState<ProfileData | null>(null);
  const [config, setConfig] = useState<ConfigData | null>(null);
  const [bootstrap, setBootstrap] = useState<BootstrapData | null>(null);
  const [lgtmDir, setLgtmDir] = useState<string>("");
  const [repoRoot, setRepoRoot] = useState<string>("");
  const [sectionIdx, setSectionIdx] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const { exit } = useApp();

  useEffect(() => {
    onStatusHint("↑↓ sections  q quit");
    loadData();
  }, []);

  async function loadData() {
    try {
      const { loadConfig, loadProfile, loadBootstrap, resolveYakDir } = await import(
        "@lgtm/core/config/loader.js"
      );
      const { findGitRoot } = await import("@lgtm/core/store/paths.js");

      const root = findGitRoot();
      const bs = loadBootstrap();
      const dir = resolveYakDir(bs, root);
      const cfg = loadConfig();
      const prof = loadProfile(dir);

      setRepoRoot(root);
      setLgtmDir(dir);
      setBootstrap(bs);
      setConfig(cfg);
      setProfile(prof);
    } catch (err) {
      setError((err as Error).message);
    }
    setLoading(false);
  }

  useInput((input, key) => {
    if (key.downArrow || input === "j") {
      setSectionIdx((prev) => Math.min(prev + 1, SECTIONS.length - 1));
    }
    if (key.upArrow || input === "k") {
      setSectionIdx((prev) => Math.max(prev - 1, 0));
    }
    if (input === "q") {
      exit();
    }
  });

  if (loading) {
    return (
      <Box paddingY={1}>
        <Text color="gray">Loading configuration...</Text>
      </Box>
    );
  }

  if (error) {
    return (
      <Box paddingY={1} flexDirection="column">
        <Text color="red">Error: {error}</Text>
        <Text color="gray">Run `lgtm init` to set up your project.</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      {/* Section tabs */}
      <Box marginBottom={1}>
        {SECTIONS.map((s, i) => (
          <Box key={s.key} marginRight={2}>
            <Text inverse={i === sectionIdx} bold={i === sectionIdx} color={i === sectionIdx ? "cyan" : "gray"}>
              {" "}{s.icon} {s.label}{" "}
            </Text>
          </Box>
        ))}
      </Box>

      {/* Section content */}
      {SECTIONS[sectionIdx].key === "profile" && renderProfile()}
      {SECTIONS[sectionIdx].key === "config" && renderConfig()}
      {SECTIONS[sectionIdx].key === "paths" && renderPaths()}
    </Box>
  );

  function renderProfile() {
    if (!profile) {
      return (
        <Box flexDirection="column" paddingY={1}>
          <Text color="yellow">No profile found.</Text>
          <Text color="gray">Run `lgtm init` to create a project profile.</Text>
        </Box>
      );
    }

    return (
      <Box flexDirection="column" paddingLeft={1}>
        <Box marginBottom={1}>
          <Text bold>👤 Project Profile</Text>
        </Box>

        <Field label="Project" value={profile.project} />
        <Field label="Goal" value={profile.goal} color={goalColor(profile.goal)} />
        <Field label="Feedback Style" value={profile.feedbackStyle} color="cyan" />
        <Field label="Team Size" value={profile.teamSize} />
        <Field label="Created" value={formatDate(profile.createdAt)} color="gray" />

        <Box marginTop={1} marginBottom={1}>
          <Text bold color="gray">Tech Stack</Text>
        </Box>
        {profile.techStack.length > 0 ? (
          <Box flexDirection="column" paddingLeft={2}>
            {profile.techStack.map((tech, i) => (
              <Text key={i} color="white">• {tech}</Text>
            ))}
          </Box>
        ) : (
          <Text color="gray" dimColor>  (none configured)</Text>
        )}

        {profile.qualityReferences.length > 0 && (
          <>
            <Box marginTop={1} marginBottom={1}>
              <Text bold color="gray">Quality References</Text>
            </Box>
            <Box flexDirection="column" paddingLeft={2}>
              {profile.qualityReferences.map((ref, i) => (
                <Text key={i} color="white">• {ref}</Text>
              ))}
            </Box>
          </>
        )}

        <Box marginTop={1} marginBottom={1}>
          <Text bold color="gray">AI Configuration</Text>
        </Box>
        <Box paddingLeft={2} flexDirection="column">
          <Field label="Enabled" value={profile.ai.enabled ? "yes" : "no"} color={profile.ai.enabled ? "green" : "red"} />
          {profile.ai.provider && <Field label="Provider" value={profile.ai.provider} />}
          {profile.ai.model && <Field label="Model" value={profile.ai.model} />}
          {profile.ai.baseUrl && <Field label="Base URL" value={profile.ai.baseUrl} color="gray" />}
        </Box>
      </Box>
    );
  }

  function renderConfig() {
    if (!config) {
      return (
        <Box paddingY={1}>
          <Text color="yellow">No configuration loaded.</Text>
        </Box>
      );
    }

    const pluginNames = Object.keys(config.plugins);

    return (
      <Box flexDirection="column" paddingLeft={1}>
        <Box marginBottom={1}>
          <Text bold>⚙ Resolved Configuration</Text>
        </Box>

        <Field label="Storage Mode" value={config.storageMode} color={config.storageMode === "farm" ? "yellow" : "cyan"} />

        <Box marginTop={1} marginBottom={1}>
          <Text bold color="gray">Plugins</Text>
        </Box>
        <Box flexDirection="column" paddingLeft={2}>
          {pluginNames.map((name) => {
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
          <Text bold color="gray">AI Settings</Text>
        </Box>
        <Box paddingLeft={2} flexDirection="column">
          <Field label="Enabled" value={config.ai.enabled ? "yes" : "no"} color={config.ai.enabled ? "green" : "red"} />
          {config.ai.provider && <Field label="Provider" value={config.ai.provider} />}
          {config.ai.model && <Field label="Model" value={config.ai.model} />}
          {config.ai.baseUrl && <Field label="Base URL" value={config.ai.baseUrl} color="gray" />}
          {config.ai.apiKey && <Field label="API Key" value={maskKey(config.ai.apiKey)} color="gray" />}
        </Box>
      </Box>
    );
  }

  function renderPaths() {
    return (
      <Box flexDirection="column" paddingLeft={1}>
        <Box marginBottom={1}>
          <Text bold>📁 Paths & Storage</Text>
        </Box>

        <Field label="Repo Root" value={repoRoot} color="white" />
        <Field label="LGTM Data Dir" value={lgtmDir} color="white" />
        <Field label="Storage Mode" value={bootstrap?.storageMode ?? "unknown"} color={bootstrap?.storageMode === "farm" ? "yellow" : "cyan"} />
        {bootstrap?.farmPath && <Field label="Farm Path" value={bootstrap.farmPath} color="white" />}

        <Box marginTop={1} marginBottom={1}>
          <Text bold color="gray">Config Resolution Order</Text>
        </Box>
        <Box flexDirection="column" paddingLeft={2}>
          <Text color="gray">1. Built-in defaults</Text>
          <Text color="gray">2. ~/.lgtmrc (bootstrap)</Text>
          <Text color="gray">3. Profile (AI prefs from onboarding)</Text>
          <Text color="white">4. .lgtmrc.yaml (repo override)</Text>
          <Text color="gray">5. CLI flags</Text>
        </Box>

        <Box marginTop={1} marginBottom={1}>
          <Text bold color="gray">Key Files</Text>
        </Box>
        <Box flexDirection="column" paddingLeft={2}>
          <Text color="gray">Bootstrap:  <Text color="white">~/.lgtmrc</Text></Text>
          <Text color="gray">Profile:    <Text color="white">{lgtmDir}/profile.md</Text></Text>
          <Text color="gray">Config:     <Text color="white">{repoRoot}/.lgtmrc.yaml</Text></Text>
          <Text color="gray">Credentials:<Text color="white"> ~/.lgtm-credentials</Text></Text>
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

function goalColor(goal: string): string {
  switch (goal) {
    case "production": return "green";
    case "enterprise": return "cyan";
    case "vibed": return "magenta";
    case "learning": return "yellow";
    default: return "white";
  }
}

function maskKey(key: string): string {
  if (key.length <= 8) return "••••••••";
  return key.slice(0, 4) + "•".repeat(key.length - 8) + key.slice(-4);
}

function formatDate(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" });
  } catch {
    return iso;
  }
}

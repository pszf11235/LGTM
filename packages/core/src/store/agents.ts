/**
 * Agent configuration — the review prompt lives in the store, not in the code.
 *
 * This sits in core rather than the review plugin because `agents/` is part of
 * the store layout, and core owns the store. The plugin consumes it.
 *
 * Each file in `<store>/agents/*.md` is one reviewer: OKF frontmatter holds the
 * settings, and the `prompt` field holds the instructions handed to whichever
 * CLI runs the review. Editing that file is the only thing a user has to do to
 * change how reviews read, which is the point: the prompt is data, not a
 * hardcoded string buried in a service.
 *
 * Enabling a second agent file is how you get two reviewers on one PR. The
 * orchestrator spawns one process per enabled agent.
 */

import fs from "fs";
import path from "path";
import matter from "gray-matter";
import { getAgentsDir } from "./paths.js";

// ─── Types ──────────────────────────────────────────────────────────────────

/** Providers that can run a review, in priority order for `auto`. */
export const PROVIDER_IDS = [
  "kiro-cli",
  "claude-cli",
  "codex-cli",
  "openrouter",
  "ollama",
] as const;

export type ProviderId = (typeof PROVIDER_IDS)[number];

/** `auto` resolves to the first available provider at review time. */
export type ProviderChoice = ProviderId | "auto";

export type Severity = "low" | "medium" | "high" | "critical";

export const SEVERITY_ORDER: Record<Severity, number> = {
  low: 0,
  medium: 1,
  high: 2,
  critical: 3,
};

export interface AgentConfig {
  /** Derived from the filename, so two agents can never collide. */
  name: string;

  /** Which CLI or API runs the review. */
  provider: ProviderChoice;

  /** Only meaningful for openrouter and ollama; CLIs pick their own model. */
  model: string | null;

  /** Findings below this are dropped before they are ever written. */
  severity: Severity;

  /** Seconds before the orchestrator kills the worker. */
  timeout: number;

  /** [min, max] seconds to wait between individual comment posts. */
  commentDelay: [number, number];

  enabled: boolean;

  /** The review instructions. This is the part users edit. */
  prompt: string;

  /** Absolute path of the file this came from, for error messages. */
  sourcePath: string;
}

// ─── Defaults ───────────────────────────────────────────────────────────────

const DEFAULT_PROMPT = `Focus on high and critical issues only.
Use my tone and voice: concise, actionable, no fluff, dev to dev.
Never use em dashes or semicolons.
Do not spell out the severity in the comment body.
Instead of "High / borderline critical - these events won't make it to GA4."
write "These events probably won't make it to GA4 (this is an important one)..."
Cite the exact file and line for every finding.`;

/**
 * The file written to `agents/reviewer.md` on first init.
 *
 * Kept as a literal rather than generated from AgentConfig so the comments
 * survive into the file the user opens.
 */
export const DEFAULT_AGENT_FILE = `---
name: reviewer
provider: auto
model: null
severity: high
timeout: 300
commentDelay: [20, 90]
enabled: true
prompt: |
${DEFAULT_PROMPT.split("\n")
  .map((l) => `  ${l}`)
  .join("\n")}
---

# Review Agent

Edit the \`prompt\` field above to change how reviews are written. It is passed
straight to the review CLI, on top of whatever built-in review skill that CLI has.

| Field | Meaning |
|---|---|
| \`provider\` | \`auto\` picks the first available of ${PROVIDER_IDS.join(", ")}. Set it explicitly to pin one. |
| \`model\` | Only used by openrouter and ollama. The CLIs choose their own. |
| \`severity\` | Minimum severity to record. Anything lower is dropped. |
| \`timeout\` | Seconds before the review is abandoned. |
| \`commentDelay\` | \`[min, max]\` seconds between individual comment posts. |
| \`enabled\` | Set false to skip this agent without deleting the file. |

To run two reviewers on every PR, copy this file to \`agents/second.md\` and give
it a different \`provider\`. Each enabled agent runs in its own process.
`;

/** The config used when an agent file is missing or unreadable. */
export function defaultAgentConfig(sourcePath = "<built-in>"): AgentConfig {
  return {
    name: "reviewer",
    provider: "auto",
    model: null,
    severity: "high",
    timeout: 300,
    commentDelay: [20, 90],
    enabled: true,
    prompt: DEFAULT_PROMPT,
    sourcePath,
  };
}

// ─── Parsing ────────────────────────────────────────────────────────────────

function asProvider(value: unknown): ProviderChoice {
  if (typeof value !== "string") return "auto";
  const normalised = value.trim().toLowerCase();
  if (normalised === "auto") return "auto";
  return (PROVIDER_IDS as readonly string[]).includes(normalised)
    ? (normalised as ProviderId)
    : "auto";
}

function asSeverity(value: unknown, fallback: Severity = "high"): Severity {
  if (typeof value !== "string") return fallback;
  const normalised = value.trim().toLowerCase();
  return normalised in SEVERITY_ORDER ? (normalised as Severity) : fallback;
}

/**
 * commentDelay accepts `[20, 90]` or a single number meaning "exactly this".
 * A reversed pair is swapped rather than rejected, since the intent is obvious.
 */
function asCommentDelay(value: unknown): [number, number] {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
    return [value, value];
  }
  if (Array.isArray(value) && value.length >= 2) {
    const min = Number(value[0]);
    const max = Number(value[1]);
    if (Number.isFinite(min) && Number.isFinite(max) && min >= 0 && max >= 0) {
      return min <= max ? [min, max] : [max, min];
    }
  }
  return [20, 90];
}

function asTimeout(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : 300;
}

/**
 * Parse one agent file. Malformed fields fall back to defaults rather than
 * throwing: a typo in `severity` should not stop every review from running.
 */
export function parseAgentFile(raw: string, sourcePath: string): AgentConfig {
  const { data } = matter(raw);
  const fallbackName = path.basename(sourcePath, ".md");

  return {
    // The filename wins over the `name` field. Two files claiming the same name
    // would otherwise overwrite each other's findings.
    name: fallbackName || String(data.name ?? "reviewer"),
    provider: asProvider(data.provider),
    model: typeof data.model === "string" && data.model.trim() ? data.model.trim() : null,
    severity: asSeverity(data.severity),
    timeout: asTimeout(data.timeout),
    commentDelay: asCommentDelay(data.commentDelay),
    enabled: data.enabled !== false,
    prompt: typeof data.prompt === "string" && data.prompt.trim() ? data.prompt.trim() : DEFAULT_PROMPT,
    sourcePath,
  };
}

// ─── Loading ────────────────────────────────────────────────────────────────

/**
 * Write `agents/reviewer.md` if the agents directory has no agent in it.
 * Returns true when a file was created.
 */
export function ensureDefaultAgent(lgtmDir: string): boolean {
  const dir = getAgentsDir(lgtmDir);
  fs.mkdirSync(dir, { recursive: true });

  const hasAny = fs.readdirSync(dir).some((f) => f.endsWith(".md"));
  if (hasAny) return false;

  fs.writeFileSync(path.join(dir, "reviewer.md"), DEFAULT_AGENT_FILE, "utf-8");
  return true;
}

/**
 * Load every agent from the store, creating the default one if none exist.
 *
 * Returns all agents including disabled ones so `lgtm config` can show them.
 * Callers that are about to run a review want `loadEnabledAgents()`.
 */
export function loadAgentConfigs(lgtmDir: string): AgentConfig[] {
  ensureDefaultAgent(lgtmDir);

  const dir = getAgentsDir(lgtmDir);
  let files: string[];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith(".md")).sort();
  } catch {
    return [defaultAgentConfig()];
  }

  const agents: AgentConfig[] = [];

  for (const file of files) {
    const fullPath = path.join(dir, file);
    try {
      agents.push(parseAgentFile(fs.readFileSync(fullPath, "utf-8"), fullPath));
    } catch {
      // An unreadable agent file should not take the whole review down.
      agents.push({ ...defaultAgentConfig(fullPath), name: path.basename(file, ".md") });
    }
  }

  return agents.length > 0 ? agents : [defaultAgentConfig()];
}

/**
 * The agents that should actually run.
 */
export function loadEnabledAgents(lgtmDir: string): AgentConfig[] {
  return loadAgentConfigs(lgtmDir).filter((a) => a.enabled);
}

// ─── Severity filtering ─────────────────────────────────────────────────────

/**
 * True when `severity` is at or above the agent's floor.
 */
export function meetsSeverity(severity: Severity, floor: Severity): boolean {
  return SEVERITY_ORDER[severity] >= SEVERITY_ORDER[floor];
}

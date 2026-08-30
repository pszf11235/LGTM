/**
 * Agent-file loader — the store's half of R3.2: the review prompt lives in
 * an editable markdown file, `agents/<name>.md`, and editing it changes
 * review behaviour without a restart.
 *
 * Frontmatter maps onto @/provider's `AgentConfig` (imported, not
 * redeclared here):
 *
 *   provider          -> provider        (must be a known ProviderId)
 *   model             -> model
 *   timeout_minutes   -> timeoutMinutes
 *   severity_floor    -> severityFloor
 *   enabled           -> enabled
 *
 * The body is the prompt: appended to the CLI's own review command
 * (design.md, "Prompt assembly").
 *
 * No restart, no cache. `loadAgent` calls `createOKFStore(lgtmDir).read(...)`
 * on every call and keeps nothing in memory between calls, so a hand-edit
 * takes effect on the very next read, not the next daemon restart. This is
 * why `DispatchDeps.agent` in @/daemon/cycle already accepts a function
 * instead of a plain `AgentConfig`: callers that want R3.2's promise must
 * call `loadAgent` per Round rather than loading once and holding onto the
 * result.
 *
 * Lenient in one direction, strict in another. A missing file or a field
 * that fails to parse falls back to the matching default (mirrored from
 * `defaultAgentConfig`/`DEFAULT_*` in @/provider), because a hand-edited
 * file must not take the daemon down. Two fields are the deliberate
 * exception and throw instead of falling back:
 *
 *   - `timeout_minutes` <= 0 would fail every Round instantly if silently
 *     defaulted away; a hand-typed 0 needs to be seen, not hidden.
 *   - an unknown `provider` name is almost always a typo; falling back to
 *     claude-cli would run the wrong reviewer without telling anyone.
 *
 * Both surface as a thrown Error, so a bad file becomes one clearly failed
 * Round (via the daemon queue's dispatch-error path) instead of a quiet
 * misconfiguration that looks like a working one.
 */

import path from "path";
import { createOKFStore } from "./okf.js";
import type { OKFDocument } from "./okf.js";
import { PROVIDER_IDS, defaultAgentConfig } from "@/provider";
import type { AgentConfig, ProviderId } from "@/provider";
import type { Severity } from "@/core";

const SEVERITIES: ReadonlySet<string> = new Set<Severity>(["low", "medium", "high", "critical"]);
const PROVIDER_ID_SET: ReadonlySet<string> = new Set<string>(PROVIDER_IDS);

function agentRelativePath(name: string): string {
  return path.join("agents", `${name}.md`);
}

type Store = ReturnType<typeof createOKFStore>;

/**
 * `store.read` only swallows ENOENT (okf.ts). Anything else — a permission
 * error on a hand-edited file, say — must not take the whole load down
 * either, so it is treated the same as "missing" here.
 */
async function readDocSafely(store: Store, relPath: string): Promise<OKFDocument | null> {
  try {
    return await store.read(relPath);
  } catch {
    return null;
  }
}

/**
 * Load one Agent from `<lgtmDir>/agents/<name>.md`.
 *
 * Missing file or missing individual fields fall back to
 * `defaultAgentConfig(name)`'s values. An unknown `provider` or a
 * non-positive `timeout_minutes` throws — see the module docstring.
 */
export async function loadAgent(lgtmDir: string, name: string): Promise<AgentConfig> {
  const fallback = defaultAgentConfig(name);
  const store = createOKFStore(lgtmDir);
  const doc = await readDocSafely(store, agentRelativePath(name));

  if (!doc) {
    return fallback;
  }

  const data = doc.data;

  return {
    name,
    provider: parseProvider(name, data.provider, fallback.provider),
    model: parseString(data.model, fallback.model),
    severityFloor: parseSeverity(data.severity_floor ?? data.severity, fallback.severityFloor),
    timeoutMinutes: parseTimeoutMinutes(name, data.timeout_minutes, fallback.timeoutMinutes),
    enabled: parseEnabled(data.enabled),
    prompt: doc.content,
  };
}

/**
 * Every Agent under `agents/` whose `enabled` field is not explicitly
 * `false`. The filename stem (minus `.md`) is the Agent's name.
 *
 * A single broken-but-enabled agent file throws out of this call rather
 * than being quietly dropped from the list — the same "surface it, don't
 * hide it" reasoning as `loadAgent`'s two reject cases. Silently returning
 * every *other* agent would look like a healthy roster with one reviewer
 * missing and no sign why.
 */
export async function loadEnabledAgents(lgtmDir: string): Promise<AgentConfig[]> {
  const store = createOKFStore(lgtmDir);
  const relPaths = await store.list("agents");

  const agents: AgentConfig[] = [];
  for (const relPath of relPaths) {
    const name = path.basename(relPath, ".md");
    const agent = await loadAgent(lgtmDir, name);
    if (agent.enabled) agents.push(agent);
  }

  return agents.sort((a, b) => a.name.localeCompare(b.name));
}

// ─── Field parsing ──────────────────────────────────────────────────────────

function parseProvider(agentName: string, value: unknown, fallback: ProviderId): ProviderId {
  if (value === undefined || value === null) return fallback;
  // "auto" is what the previous version wrote when it picked a provider from
  // whatever was installed. v1 has exactly one, so the honest reading of "pick
  // for me" is that one rather than an error. Kept as an alias so a store
  // written by the old version keeps reviewing instead of failing every Round.
  if (value === "auto") return fallback;

  if (typeof value !== "string" || !PROVIDER_ID_SET.has(value)) {
    throw new Error(
      `agents/${agentName}.md: unknown provider "${String(value)}", expected one of ${PROVIDER_IDS.join(", ")}`
    );
  }

  return value as ProviderId;
}

function parseString(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() !== "" ? value : fallback;
}

function parseSeverity(value: unknown, fallback: Severity): Severity {
  return typeof value === "string" && SEVERITIES.has(value) ? (value as Severity) : fallback;
}

function parseTimeoutMinutes(agentName: string, value: unknown, fallback: number): number {
  if (value === undefined || value === null) return fallback;

  const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;

  // Not a number at all (wrong type, or an unparseable string): a malformed
  // field, not a deliberate zero. Fall back rather than reject.
  if (!Number.isFinite(n)) return fallback;

  if (n <= 0) {
    throw new Error(`agents/${agentName}.md: timeout_minutes must be positive, got ${JSON.stringify(value)}`);
  }

  return n;
}

function parseEnabled(value: unknown): boolean {
  return value !== false;
}

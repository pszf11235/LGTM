/**
 * Provider detection — which review CLI can we actually run?
 *
 * Detection is deliberately shallow. It checks that a binary is on PATH or an
 * endpoint answers, and nothing more. The old detector went digging through the
 * macOS Keychain, Continue.dev config, Aider config and Cursor's storage to
 * extract API keys, because there was a raw LLM provider that needed one. Now
 * that reviews are delegated to a CLI, each CLI authenticates itself and none of
 * that is our business.
 *
 * That matters legally as well as architecturally: Anthropic forbids
 * third-party use of the `sk-ant-oat01-*` subscription tokens their CLI stores,
 * so we must not read them. Spawning the official binary, which authenticates
 * itself, is fine.
 *
 * Invocation lives in the review plugin. This module only answers "is it there".
 */

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

export interface ProviderStatus {
  id: ProviderId;

  available: boolean;

  /** Human-readable reason, shown by `lgtm ai discover`. */
  detail: string;

  /**
   * True when the CLI has its own review command. Those get pointed at the PR
   * and do their own analysis; the others get a raw prompt and a JSON contract.
   */
  hasBuiltInReview: boolean;

  /** What the user should do to make this one work. Empty when available. */
  fix: string;
}

export const OLLAMA_BASE_URL = process.env.OLLAMA_HOST ?? "http://localhost:11434";

/**
 * Is a binary on PATH? Returns its path, or null.
 *
 * stderr is discarded. Without that, `which: no claude in (...)` leaks into the
 * middle of our own output on machines that do not have it.
 */
export function which(cmd: string): string | null {
  try {
    const proc = Bun.spawnSync(["which", cmd], { stdio: ["ignore", "pipe", "ignore"] });
    if (proc.exitCode !== 0) return null;
    const out = proc.stdout.toString().trim();
    return out || null;
  } catch {
    return null;
  }
}

async function reachable(url: string, timeoutMs = 1500): Promise<boolean> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Check all five providers. Array order is the priority order for `auto`.
 */
export async function detectProviders(): Promise<ProviderStatus[]> {
  const kiroPath = which("kiro-cli") ?? which("kiro");
  const kiroKey = !!process.env.KIRO_API_KEY;
  const claudePath = which("claude");
  const codexPath = which("codex");
  const openrouterKey = !!process.env.OPENROUTER_API_KEY;
  const ollamaUp = await reachable(`${OLLAMA_BASE_URL}/api/tags`);

  return [
    {
      id: "kiro-cli",
      // Headless mode needs an API key. The binary alone is not enough: without
      // it the CLI drops into an interactive login we cannot answer.
      available: !!kiroPath && kiroKey,
      detail: !kiroPath
        ? "not on PATH"
        : !kiroKey
          ? `${kiroPath}, but KIRO_API_KEY is not set`
          : kiroPath,
      hasBuiltInReview: false,
      fix: !kiroPath
        ? "install the Kiro CLI"
        : !kiroKey
          ? "export KIRO_API_KEY=... (required for --no-interactive)"
          : "",
    },
    {
      id: "claude-cli",
      // Auth lives in the Keychain or an OAuth token we deliberately do not
      // read, so presence on PATH is as much as we can check without a call.
      available: !!claudePath,
      detail: claudePath ?? "not on PATH",
      hasBuiltInReview: true,
      fix: claudePath ? "" : "install Claude Code, then run `claude` once to log in",
    },
    {
      id: "codex-cli",
      available: !!codexPath,
      detail: codexPath ?? "not on PATH",
      hasBuiltInReview: true,
      fix: codexPath ? "" : "install the Codex CLI, then run `codex` once to log in",
    },
    {
      id: "openrouter",
      available: openrouterKey,
      detail: openrouterKey ? "OPENROUTER_API_KEY set" : "OPENROUTER_API_KEY not set",
      hasBuiltInReview: false,
      fix: openrouterKey ? "" : "export OPENROUTER_API_KEY=...",
    },
    {
      id: "ollama",
      available: ollamaUp,
      detail: ollamaUp ? `reachable at ${OLLAMA_BASE_URL}` : `not reachable at ${OLLAMA_BASE_URL}`,
      hasBuiltInReview: false,
      fix: ollamaUp ? "" : "install Ollama and run `ollama serve`",
    },
  ];
}

export interface ResolvedProvider {
  id: ProviderId;
  /** Providers passed over on the way here, for the fallback trail. */
  skipped: ProviderId[];
}

/**
 * Pick the provider to use.
 *
 * A pinned provider is honoured or fails loudly. Silently reviewing with
 * something other than what was configured would be worse than an error.
 * `auto` walks the priority list.
 */
export function resolveProvider(
  choice: ProviderChoice,
  statuses: ProviderStatus[]
): ResolvedProvider | { error: string } {
  const byId = new Map(statuses.map((s) => [s.id, s]));

  if (choice !== "auto") {
    const status = byId.get(choice);
    if (!status) return { error: `unknown provider "${choice}"` };
    if (!status.available) {
      return { error: `provider "${choice}" is not available: ${status.detail}` };
    }
    return { id: choice, skipped: [] };
  }

  const skipped: ProviderId[] = [];
  for (const id of PROVIDER_IDS) {
    const status = byId.get(id);
    if (status?.available) return { id, skipped };
    skipped.push(id);
  }

  const summary = statuses.map((s) => `${s.id}: ${s.detail}`).join("; ");
  return { error: `no review provider available. ${summary}` };
}

/**
 * Provider dispatch — detect which review CLI is available, invoke it, and
 * normalise whatever it prints back into findings.
 *
 * The tool does not implement code review. Claude's `/review` already runs a
 * multi-agent pass with false-positive filtering, and Codex ships a model
 * trained for it. Reimplementing that against a raw completions API would be
 * strictly worse, so we shell out to the CLI the user already has installed and
 * authenticated, and add our prompt on top of its built-in review skill.
 *
 * Subscription auth is the reason this is a subprocess and not an HTTP call.
 * Anthropic forbids third-party use of the `sk-ant-oat01-*` OAuth tokens their
 * CLI stores, so reading them out of the Keychain is not an option. Spawning
 * the official binary, which authenticates itself, is.
 *
 * openrouter and ollama have no built-in review, so they get a raw prompt and
 * a JSON output contract.
 */

import type { AgentConfig, Severity } from "@lgtm/core/store/agents.js";
import { meetsSeverity } from "@lgtm/core/store/agents.js";
import type { ProviderId } from "@lgtm/core/ai/providers.js";
import { which, OLLAMA_BASE_URL } from "@lgtm/core/ai/providers.js";

// Detection and provider resolution live in core, next to the `ai` commands
// that report on them. Re-exported so callers need one import.
export {
  detectProviders,
  resolveProvider,
  PROVIDER_IDS,
  OLLAMA_BASE_URL,
  which,
  type ProviderId,
  type ProviderChoice,
  type ProviderStatus,
  type ResolvedProvider,
} from "@lgtm/core/ai/providers.js";

// ─── Types ──────────────────────────────────────────────────────────────────

/** A finding as it comes back from a provider, before storage. */
export interface RawFinding {
  file: string;
  line: number;
  severity: Severity;
  comment: string;
  suggestion?: string;
}

export interface InvokeInput {
  agent: AgentConfig;

  /** Unified diff of the PR. */
  diff: string;

  /** Used by CLIs that can fetch the PR themselves. */
  prUrl?: string;

  /** Working directory for the CLI, so it can read the repo. */
  repoPath?: string;

  /** Findings already raised on an earlier round, to avoid repeats. */
  priorFindings?: Array<{ file: string; line: number; comment: string }>;

  /** Extra instructions from LLM-enforced rules. */
  ruleContext?: string;
}

export interface InvokeResult {
  provider: ProviderId;
  findings: RawFinding[];
  /** Raw stdout, kept so unparseable output can be written out for debugging. */
  raw: string;
  stats: {
    durationMs: number;
    dropped: number;
    rawLength: number;
    /** Set when `auto` fell back past an unavailable provider. */
    fallbackFrom?: ProviderId[];
  };
  error: string | null;
}

/** A verdict on whether an earlier finding has been addressed. */
export interface Verdict {
  index: number;
  resolved: boolean;
  note: string;
}

// ─── Prompt building ────────────────────────────────────────────────────────

const JSON_CONTRACT = `Respond with JSON only, no prose and no code fence:
{"findings": [{"file": "src/a.ts", "line": 42, "severity": "high", "comment": "...", "suggestion": "..."}]}
severity is one of low, medium, high, critical.
line must be a line number that appears in the diff.
Return {"findings": []} if you find nothing.`;

/**
 * Cap the diff so a large PR cannot blow the context window.
 *
 * Truncation is announced in the prompt. A model that silently receives half a
 * diff will confidently review the half it got and imply the rest was fine.
 */
export function truncateDiff(diff: string, maxChars: number): string {
  if (diff.length <= maxChars) return diff;
  const omitted = diff.length - maxChars;
  return `${diff.slice(0, maxChars)}\n\n[diff truncated, ${omitted} characters omitted. Review only what is shown above.]`;
}

function priorFindingsBlock(prior: InvokeInput["priorFindings"]): string {
  if (!prior || prior.length === 0) return "";

  const lines = prior.map((f, i) => `${i + 1}. ${f.file}:${f.line} ${f.comment}`);
  return [
    "These issues were already raised on this PR. Do not repeat them.",
    "Report only new problems, or problems these comments missed.",
    "",
    ...lines,
  ].join("\n");
}

/**
 * The instruction block handed to a provider, minus the diff.
 */
export function buildInstructions(input: InvokeInput): string {
  const parts = [input.agent.prompt];

  if (input.ruleContext) parts.push(input.ruleContext);

  const prior = priorFindingsBlock(input.priorFindings);
  if (prior) parts.push(prior);

  return parts.filter(Boolean).join("\n\n");
}

/** Full prompt for providers with no built-in review command. */
function buildRawPrompt(input: InvokeInput, maxDiffChars: number): string {
  return [
    "Review this pull request diff.",
    "",
    buildInstructions(input),
    "",
    JSON_CONTRACT,
    "",
    "Diff:",
    truncateDiff(input.diff, maxDiffChars),
  ].join("\n");
}

/** Verification prompt: are these earlier findings addressed? */
export function buildVerifyPrompt(
  prior: Array<{ file: string; line: number; severity?: string; comment: string }>,
  diff: string,
  maxDiffChars = 40000
): string {
  const numbered = prior.map(
    (f, i) => `${i + 1}. ${f.file}:${f.line}${f.severity ? ` (${f.severity})` : ""} ${f.comment}`
  );

  return [
    "These issues were raised on an earlier version of this pull request:",
    "",
    ...numbered,
    "",
    "Here is the current diff:",
    truncateDiff(diff, maxDiffChars),
    "",
    "For each numbered issue, say whether it is now addressed.",
    'Respond with JSON only: {"verdicts": [{"index": 1, "resolved": true, "note": "short reason"}]}',
    "Include every index. If you cannot tell, use resolved: false and say why in the note.",
  ].join("\n");
}

// ─── Invocation ─────────────────────────────────────────────────────────────

interface SpawnOutcome {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
}

/**
 * Run a command with a hard timeout.
 *
 * The timeout races the output read rather than gating it. Killing the child is
 * not enough to unblock `Response(proc.stdout).text()`: every one of these CLIs
 * spawns subprocesses of its own, those inherit the stdout pipe, and the pipe
 * stays open while any of them lives. So reading to completion after a kill can
 * block forever, which would hang the whole watcher on one stuck provider.
 *
 * Whatever output arrived before the deadline is returned. A grandchild may
 * outlive us, but it can no longer hold the cycle hostage.
 */
async function run(
  cmd: string[],
  opts: { cwd?: string; env?: Record<string, string>; timeoutSeconds: number; stdin?: string }
): Promise<SpawnOutcome> {
  const proc = Bun.spawn({
    cmd,
    cwd: opts.cwd,
    env: opts.env ? { ...process.env, ...opts.env } : process.env,
    stdin: opts.stdin === undefined ? "ignore" : new TextEncoder().encode(opts.stdin),
    stdout: "pipe",
    stderr: "pipe",
  });

  // Buffer incrementally so a timeout still yields whatever was written.
  let stdout = "";
  let stderr = "";

  const drain = async (stream: ReadableStream<Uint8Array>, onChunk: (s: string) => void) => {
    const decoder = new TextDecoder();
    for await (const chunk of stream) {
      onChunk(decoder.decode(chunk, { stream: true }));
    }
  };

  const reading = Promise.all([
    drain(proc.stdout as ReadableStream<Uint8Array>, (s) => { stdout += s; }),
    drain(proc.stderr as ReadableStream<Uint8Array>, (s) => { stderr += s; }),
    proc.exited,
  ]);

  // Swallow late failures. Once we time out nobody is awaiting this, and an
  // unhandled rejection would take the process down.
  reading.catch(() => {});

  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), opts.timeoutSeconds * 1000);
  });

  try {
    const outcome = await Promise.race([reading.then(() => "done" as const), deadline]);

    if (outcome === "timeout") {
      proc.kill("SIGKILL");
      return { stdout, stderr, exitCode: null, timedOut: true };
    }

    return { stdout, stderr, exitCode: proc.exitCode, timedOut: false };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Invoke one provider and return normalised findings.
 *
 * Never throws. A provider failure has to degrade to an empty round with an
 * error recorded, or one broken CLI takes down the watcher for every repo.
 */
export async function invokeProvider(
  id: ProviderId,
  input: InvokeInput
): Promise<InvokeResult> {
  const startedAt = Date.now();
  const base = (raw: string, error: string | null, findings: RawFinding[], dropped = 0): InvokeResult => ({
    provider: id,
    findings,
    raw,
    stats: { durationMs: Date.now() - startedAt, dropped, rawLength: raw.length },
    error,
  });

  try {
    const raw = await callProvider(id, input);

    if (raw.error) return base(raw.output, raw.error, []);

    const extracted = extractFindings(raw.output);
    if (extracted === null) {
      return base(raw.output, "could not parse provider output", []);
    }

    const { findings, dropped } = validateFindings(extracted, input.agent.severity);
    return base(raw.output, null, findings, dropped);
  } catch (err) {
    return base("", (err as Error).message, []);
  }
}

/**
 * Ask a provider to verify earlier findings. Returns one verdict per index.
 */
export async function verifyWithProvider(
  id: ProviderId,
  input: InvokeInput,
  prior: Array<{ file: string; line: number; severity?: string; comment: string }>
): Promise<{ verdicts: Verdict[]; raw: string; error: string | null }> {
  const prompt = buildVerifyPrompt(prior, input.diff);

  try {
    const raw = await callProvider(id, { ...input, diff: input.diff }, prompt);
    if (raw.error) return { verdicts: [], raw: raw.output, error: raw.error };

    const verdicts = extractVerdicts(raw.output, prior.length);
    return {
      verdicts,
      raw: raw.output,
      error: verdicts.length === 0 ? "could not parse verdicts" : null,
    };
  } catch (err) {
    return { verdicts: [], raw: "", error: (err as Error).message };
  }
}

interface ProviderOutput {
  output: string;
  error: string | null;
}

/**
 * Dispatch to the right CLI or API. `overridePrompt` is used by verification,
 * which needs a different prompt but the same transport.
 */
async function callProvider(
  id: ProviderId,
  input: InvokeInput,
  overridePrompt?: string
): Promise<ProviderOutput> {
  switch (id) {
    case "kiro-cli":
      return callKiro(input, overridePrompt);
    case "claude-cli":
      return callClaude(input, overridePrompt);
    case "codex-cli":
      return callCodex(input, overridePrompt);
    case "openrouter":
      return callOpenRouter(input, overridePrompt);
    case "ollama":
      return callOllama(input, overridePrompt);
  }
}

/** Turn a spawn outcome into output or an error string. */
function fromSpawn(name: string, outcome: SpawnOutcome, timeoutSeconds: number): ProviderOutput {
  if (outcome.timedOut) {
    return { output: outcome.stdout, error: `${name} timed out after ${timeoutSeconds}s` };
  }

  // A non-zero exit with usable stdout still gets parsed. Some CLIs exit
  // non-zero when they found problems, which is exactly the case we want.
  if (outcome.exitCode !== 0 && !outcome.stdout.trim()) {
    const detail = outcome.stderr.trim().split("\n").slice(0, 3).join(" ") || `exit ${outcome.exitCode}`;
    return { output: "", error: `${name} failed: ${detail}` };
  }

  return { output: outcome.stdout, error: null };
}

async function callKiro(input: InvokeInput, overridePrompt?: string): Promise<ProviderOutput> {
  const prompt = overridePrompt ?? buildRawPrompt(input, 60000);
  const cmd = which("kiro-cli") ? "kiro-cli" : "kiro";

  const outcome = await run(
    [cmd, "--no-interactive", prompt, "--trust-all-tools"],
    { cwd: input.repoPath, timeoutSeconds: input.agent.timeout }
  );

  return fromSpawn("kiro-cli", outcome, input.agent.timeout);
}

async function callClaude(input: InvokeInput, overridePrompt?: string): Promise<ProviderOutput> {
  // With a PR URL, `/review` fetches the PR itself and runs Claude's own
  // multi-agent review, which is better than anything we would prompt for.
  // Without one, `/code-review` works on the local diff.
  const instructions = overridePrompt ?? `${buildInstructions(input)}\n\n${JSON_CONTRACT}`;
  const prompt = input.prUrl
    ? `/review ${input.prUrl}\n\nAdditional instructions:\n${instructions}`
    : `/code-review\n\nAdditional instructions:\n${instructions}\n\nDiff:\n${truncateDiff(input.diff, 60000)}`;

  const outcome = await run(
    ["claude", "-p", prompt, "--output-format", "json"],
    { cwd: input.repoPath, timeoutSeconds: input.agent.timeout }
  );

  return fromSpawn("claude", outcome, input.agent.timeout);
}

async function callCodex(input: InvokeInput, overridePrompt?: string): Promise<ProviderOutput> {
  const instructions = overridePrompt ?? `${buildInstructions(input)}\n\n${JSON_CONTRACT}`;
  const prompt = `/review\n\nAdditional instructions:\n${instructions}`;

  const outcome = await run(
    // --skip-git-repo-check so a review can run outside a checkout, which is
    // the case when the watcher only has a diff fetched from the API.
    ["codex", "exec", prompt, "--skip-git-repo-check"],
    { cwd: input.repoPath, timeoutSeconds: input.agent.timeout }
  );

  return fromSpawn("codex", outcome, input.agent.timeout);
}

async function callOpenRouter(input: InvokeInput, overridePrompt?: string): Promise<ProviderOutput> {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) return { output: "", error: "OPENROUTER_API_KEY not set" };

  const model = input.agent.model ?? "anthropic/claude-sonnet-4";
  const prompt = overridePrompt ?? buildRawPrompt(input, 60000);

  try {
    const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
        // OpenRouter attributes traffic by these, and unattributed traffic can
        // be rate limited harder.
        "HTTP-Referer": "https://github.com/pszf11235/LGTM",
        "X-Title": "LGTM",
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: "You are a senior code reviewer. Respond with JSON only." },
          { role: "user", content: prompt },
        ],
        response_format: { type: "json_object" },
      }),
      signal: AbortSignal.timeout(input.agent.timeout * 1000),
    });

    if (!res.ok) {
      const body = (await res.text()).slice(0, 300);
      return { output: "", error: `openrouter ${res.status}: ${body}` };
    }

    const json = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const content = json.choices?.[0]?.message?.content ?? "";
    return { output: content, error: content ? null : "openrouter returned no content" };
  } catch (err) {
    return { output: "", error: `openrouter: ${(err as Error).message}` };
  }
}

async function callOllama(input: InvokeInput, overridePrompt?: string): Promise<ProviderOutput> {
  // Local models have far less context, so the diff budget is halved.
  const prompt = overridePrompt ?? buildRawPrompt(input, 30000);
  const model = input.agent.model ?? "qwen2.5-coder:7b";

  try {
    const res = await fetch(`${OLLAMA_BASE_URL}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model, prompt, format: "json", stream: false }),
      signal: AbortSignal.timeout(input.agent.timeout * 1000),
    });

    if (!res.ok) {
      const body = (await res.text()).slice(0, 300);
      return { output: "", error: `ollama ${res.status}: ${body}` };
    }

    const json = (await res.json()) as { response?: string };
    const content = json.response ?? "";
    return { output: content, error: content ? null : "ollama returned no content" };
  } catch (err) {
    return { output: "", error: `ollama: ${(err as Error).message}` };
  }
}

// ─── Output normalisation ───────────────────────────────────────────────────

/**
 * Pull findings out of whatever a provider printed.
 *
 * Five CLIs with five output conventions, and none of them guarantee stability
 * across versions, so this tries every shape we have seen rather than trusting
 * one. Returns null only when nothing at all could be extracted, which the
 * caller records as a parse error along with the raw text.
 *
 * Strategies, in order:
 *   1. a bare JSON array
 *   2. an object with a `findings` (or `issues`/`comments`) key
 *   3. JSON inside a ```json fence
 *   4. Claude's --output-format json envelope, unwrapped then retried
 *   5. prose lines shaped like `file:line severity comment`
 *   6. nothing
 */
export function extractFindings(raw: string): unknown[] | null {
  const text = raw.trim();
  if (!text) return null;

  // 1 and 2: the whole output is JSON.
  const direct = tryParseJson(text);
  if (direct !== undefined) {
    const unwrapped = unwrapFindings(direct);
    if (unwrapped) return unwrapped;

    // 4: Claude wraps the model's answer in an envelope. Recurse on the inner
    // text, which is itself usually JSON or a fenced block.
    const inner = envelopeText(direct);
    if (inner) return extractFindings(inner);
  }

  // 3: a fenced block anywhere in the output.
  for (const fenced of fencedBlocks(text)) {
    const parsed = tryParseJson(fenced);
    if (parsed === undefined) continue;
    const unwrapped = unwrapFindings(parsed);
    if (unwrapped) return unwrapped;
  }

  // 2 again, but for JSON embedded in prose without a fence.
  for (const candidate of embeddedJson(text)) {
    const parsed = tryParseJson(candidate);
    if (parsed === undefined) continue;
    const unwrapped = unwrapFindings(parsed);
    if (unwrapped) return unwrapped;
  }

  // 5: prose fallback.
  const prose = parseProseFindings(text);
  if (prose.length > 0) return prose;

  // 6.
  return null;
}

function tryParseJson(text: string): unknown | undefined {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** An array, or an object with a known findings key. */
function unwrapFindings(value: unknown): unknown[] | null {
  if (Array.isArray(value)) return value;

  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    for (const key of ["findings", "issues", "comments", "results"]) {
      if (Array.isArray(obj[key])) return obj[key] as unknown[];
    }
  }

  return null;
}

/** The text payload of a CLI envelope, e.g. Claude's `{"result": "..."}`. */
function envelopeText(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  const obj = value as Record<string, unknown>;

  for (const key of ["result", "response", "output", "content", "text", "message"]) {
    const inner = obj[key];
    if (typeof inner === "string" && inner.trim()) return inner;
  }

  return null;
}

function* fencedBlocks(text: string): Generator<string> {
  const fence = /```(?:json|jsonc)?\s*\n([\s\S]*?)```/g;
  let match: RegExpExecArray | null;
  while ((match = fence.exec(text)) !== null) {
    yield match[1].trim();
  }
}

/**
 * Balanced JSON objects and arrays embedded in prose.
 *
 * A greedy regex cannot do this: a finding whose comment contains a brace would
 * cut the match short. So brackets are counted, skipping anything inside a
 * string literal.
 */
function* embeddedJson(text: string): Generator<string> {
  for (let i = 0; i < text.length; i++) {
    const open = text[i];
    if (open !== "{" && open !== "[") continue;

    const close = open === "{" ? "}" : "]";
    let depth = 0;
    let inString = false;
    let escaped = false;

    for (let j = i; j < text.length; j++) {
      const ch = text[j];

      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === "\\") {
        escaped = true;
        continue;
      }
      if (ch === '"') {
        inString = !inString;
        continue;
      }
      if (inString) continue;

      if (ch === open) depth++;
      else if (ch === close) {
        depth--;
        if (depth === 0) {
          yield text.slice(i, j + 1);
          i = j;
          break;
        }
      }
    }
  }
}

const SEVERITY_WORDS = ["critical", "high", "medium", "low"] as const;

/**
 * Last-resort parse of prose like:
 *   src/auth.ts:42 (critical) Hardcoded API key. Move it to an env var.
 *   src/db.ts:18 - high - Query built by string concat
 *
 * Deliberately strict about the leading `path:line`. Anything looser matches
 * stack traces and log lines and fills the review with noise.
 */
function parseProseFindings(text: string): unknown[] {
  const findings: unknown[] = [];
  const pattern = /^\s*(?:[-*]\s*|\d+[.)]\s*)?([\w./\\@+-]+\.[\w]+):(\d+)\s*(.*)$/;

  for (const line of text.split("\n")) {
    const match = line.match(pattern);
    if (!match) continue;

    const [, file, lineNo, rest] = match;
    let comment = rest.trim();
    let severity: string | undefined;

    // Strip a leading severity marker in any of the shapes CLIs use.
    const sevMatch = comment.match(/^[([]?(critical|high|medium|low)[)\]]?\s*[-:–—]?\s*/i);
    if (sevMatch) {
      severity = sevMatch[1].toLowerCase();
      comment = comment.slice(sevMatch[0].length).trim();
    } else {
      const word = SEVERITY_WORDS.find((s) => new RegExp(`\\b${s}\\b`, "i").test(comment));
      if (word) severity = word;
    }

    comment = comment.replace(/^[-:–—]\s*/, "").trim();
    if (!comment) continue;

    findings.push({ file, line: Number(lineNo), severity, comment });
  }

  return findings;
}

// ─── Validation ─────────────────────────────────────────────────────────────

const SEVERITY_ALIASES: Record<string, Severity> = {
  critical: "critical",
  crit: "critical",
  blocker: "critical",
  high: "high",
  major: "high",
  error: "high",
  medium: "medium",
  moderate: "medium",
  warn: "medium",
  warning: "medium",
  low: "low",
  minor: "low",
  info: "low",
  nit: "low",
  suggestion: "low",
};

function normaliseSeverity(value: unknown): Severity {
  if (typeof value !== "string") return "medium";
  return SEVERITY_ALIASES[value.trim().toLowerCase()] ?? "medium";
}

function firstString(obj: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

/**
 * Drop anything that cannot become a GitHub review comment.
 *
 * A finding with no file or no line has nowhere to be posted, and GitHub
 * rejects the entire review call if one comment is malformed, so it is better
 * to lose one finding than the whole round. `dropped` is reported so a provider
 * that returns unusable output does not look like a clean PR.
 */
export function validateFindings(
  candidates: unknown[],
  severityFloor: Severity
): { findings: RawFinding[]; dropped: number } {
  const findings: RawFinding[] = [];
  let dropped = 0;

  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== "object") {
      dropped++;
      continue;
    }

    const obj = candidate as Record<string, unknown>;

    const file = firstString(obj, ["file", "path", "filename", "file_path"]);
    const comment = firstString(obj, ["comment", "body", "message", "description", "issue", "text"]);

    // Providers report the line under several names, and sometimes as a string.
    const lineRaw = obj.line ?? obj.line_number ?? obj.lineNumber ?? obj.start_line ?? obj.startLine;
    const line = typeof lineRaw === "number" ? lineRaw : parseInt(String(lineRaw ?? ""), 10);

    if (!file || !comment || !Number.isInteger(line) || line <= 0) {
      dropped++;
      continue;
    }

    const severity = normaliseSeverity(obj.severity ?? obj.level ?? obj.priority);
    if (!meetsSeverity(severity, severityFloor)) {
      dropped++;
      continue;
    }

    findings.push({
      // Leading "./" and "a/"/"b/" from diff headers would not match the paths
      // GitHub expects on a review comment.
      file: file.replace(/^\.\//, "").replace(/^[ab]\//, ""),
      line,
      severity,
      comment,
      suggestion: firstString(obj, ["suggestion", "fix", "recommendation"]) ?? undefined,
    });
  }

  return { findings, dropped };
}

/**
 * Parse verification verdicts. Missing indices are treated as unresolved:
 * assuming an unanswered finding was fixed would quietly drop real problems.
 */
export function extractVerdicts(raw: string, expected: number): Verdict[] {
  const text = raw.trim();
  if (!text) return [];

  const candidates: unknown[] = [];

  const collect = (value: unknown) => {
    if (Array.isArray(value)) candidates.push(...value);
    else if (value && typeof value === "object") {
      const obj = value as Record<string, unknown>;
      if (Array.isArray(obj.verdicts)) candidates.push(...obj.verdicts);
      else {
        const inner = envelopeText(obj);
        if (inner) {
          const nested = tryParseJson(inner);
          if (nested !== undefined) collect(nested);
        }
      }
    }
  };

  const direct = tryParseJson(text);
  if (direct !== undefined) collect(direct);

  if (candidates.length === 0) {
    for (const block of [...fencedBlocks(text), ...embeddedJson(text)]) {
      const parsed = tryParseJson(block);
      if (parsed === undefined) continue;
      collect(parsed);
      if (candidates.length > 0) break;
    }
  }

  if (candidates.length === 0) return [];

  const byIndex = new Map<number, Verdict>();

  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== "object") continue;
    const obj = candidate as Record<string, unknown>;

    const indexRaw = obj.index ?? obj.i ?? obj.id ?? obj.number;
    const index = typeof indexRaw === "number" ? indexRaw : parseInt(String(indexRaw ?? ""), 10);
    if (!Number.isInteger(index) || index < 1 || index > expected) continue;

    byIndex.set(index, {
      index,
      resolved: obj.resolved === true || obj.fixed === true || obj.addressed === true,
      note: firstString(obj, ["note", "reason", "explanation", "comment"]) ?? "",
    });
  }

  const verdicts: Verdict[] = [];
  for (let i = 1; i <= expected; i++) {
    verdicts.push(
      byIndex.get(i) ?? { index: i, resolved: false, note: "no verdict returned for this finding" }
    );
  }

  return verdicts;
}

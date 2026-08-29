/**
 * Output normalisation: turn whatever the Provider printed into Findings.
 *
 * Ported from packages/plugins/review/src/domain/providers.ts on the old
 * `main` branch. The strategy chain is the part that earns its keep. The CLI
 * makes no promise about its output shape across versions, and the M0 spike
 * (docs/spec/spike-provider.md) caught it emitting two different shapes on two
 * runs of the same PR: a fenced JSON block when the contract was appended,
 * markdown list items shaped `- \`README.md:75\` — comment` when it was not.
 * Both have to parse, so none of these strategies is a last resort.
 *
 * One distinction carries the whole failure path. Null means "could not read
 * the output" and becomes a failed Round with a .raw.txt dump, while an empty
 * array means "reviewed, found nothing". Collapsing them would report a broken
 * CLI as a clean PR.
 */

import type { Severity } from "@/core";

/**
 * A Finding as the Provider reports it, before the Store gives it an id and a
 * lifecycle state. Everything here comes from the Agent; nothing here is the
 * human's yet.
 */
export interface RawFinding {
  file: string;
  line: number;
  severity: Severity;
  comment: string;
  suggestion?: string;
}

export const SEVERITY_ORDER: Record<Severity, number> = {
  low: 0,
  medium: 1,
  high: 2,
  critical: 3,
};

/** True when `severity` is at or above the Agent's floor. */
export function meetsSeverity(severity: Severity, floor: Severity): boolean {
  return SEVERITY_ORDER[severity] >= SEVERITY_ORDER[floor];
}

// ─── Extraction ─────────────────────────────────────────────────────────────

/**
 * Pull findings out of whatever the Provider printed.
 *
 * Strategies, in order:
 *   1. a bare JSON array
 *   2. an object with a `findings` (or `issues`/`comments`/`results`) key
 *   3. the CLI's --output-format json envelope, unwrapped then retried
 *   4. JSON inside a ```json fence, which is what the JSON contract produces
 *   5. JSON embedded in prose with no fence
 *   6. prose lines shaped like `file:line severity comment`
 *   7. nothing, which the caller records as a parse error next to the raw text
 *
 * Strategies 1 to 3 all begin by parsing the whole output as JSON, so they
 * share a branch. An envelope recurses: its payload is itself one of the
 * shapes below.
 */
export function extractFindings(raw: string): unknown[] | null {
  const text = raw.trim();
  if (!text) return null;

  // 1, 2 and 3: the whole output is JSON.
  const direct = tryParseJson(text);
  if (direct !== undefined) {
    const unwrapped = unwrapFindings(direct);
    if (unwrapped) return unwrapped;

    // The CLI wraps the review in an envelope alongside its usage and cost
    // data. Recurse on the inner text, which is itself usually a fenced block.
    const inner = envelopeText(direct);
    if (inner) return extractFindings(inner);
  }

  // 4: a fenced block anywhere in the output.
  for (const fenced of fencedBlocks(text)) {
    const parsed = tryParseJson(fenced);
    if (parsed === undefined) continue;
    const unwrapped = unwrapFindings(parsed);
    if (unwrapped) return unwrapped;
  }

  // 5: JSON embedded in prose without a fence.
  for (const candidate of embeddedJson(text)) {
    const parsed = tryParseJson(candidate);
    if (parsed === undefined) continue;
    const unwrapped = unwrapFindings(parsed);
    if (unwrapped) return unwrapped;
  }

  // 6: prose fallback.
  const prose = parseProseFindings(text);
  if (prose.length > 0) return prose;

  // 7.
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

/** The text payload of a CLI envelope, e.g. the CLI's `{"result": "..."}`. */
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
    yield (match[1] ?? "").trim();
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
 * Prose parse of the shapes the CLI actually emits when it answers in
 * markdown instead of JSON:
 *
 *   - `README.md:75` — The retry loop never resets the backoff.
 *   src/auth.ts:42 (critical) Hardcoded API key. Move it to an env var.
 *   src/db.ts:18 - high - Query built by string concat
 *
 * The backticks around `path:line` are the spike's observed shape, not a
 * guess; markdown renders the location as code, so the wrapper is there
 * whenever the CLI is being helpful.
 *
 * Deliberately strict about the leading `path:line`. Anything looser matches
 * stack traces and log lines and fills the review with noise.
 */
function parseProseFindings(text: string): unknown[] {
  const findings: unknown[] = [];
  const pattern = /^\s*(?:[-*]\s*|\d+[.)]\s*)?`?([\w./\\@+-]+\.[\w]+):(\d+)`?\s*(.*)$/;

  for (const line of text.split("\n")) {
    const match = line.match(pattern);
    if (!match) continue;

    const [, file, lineNo, rest] = match as unknown as [string, string, string, string];
    let comment = rest.trim();
    let severity: string | undefined;

    // Strip a leading severity marker in any of the shapes CLIs use.
    const sevMatch = comment.match(/^[([]?(critical|high|medium|low)[)\]]?\s*[-:–—]?\s*/i);
    if (sevMatch) {
      severity = (sevMatch[1] ?? "").toLowerCase();
      comment = comment.slice(sevMatch[0].length).trim();
    } else {
      const word = SEVERITY_WORDS.find((s) => new RegExp(`\\b${s}\\b`, "i").test(comment));
      if (word) severity = word;
    }

    // The separator between location and comment: a dash of any width, or a colon.
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
 * Drop anything that cannot become a review comment on the Forge.
 *
 * A finding with no file or no line has nowhere to be posted, and GitHub
 * rejects the entire review call if one comment is malformed, so it is better
 * to lose one finding than the whole Round. `dropped` is reported so a
 * Provider that returns unusable output does not look like a clean PR.
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
      // the Forge expects on a review comment.
      file: file.replace(/^\.\//, "").replace(/^[ab]\//, ""),
      line,
      severity,
      comment,
      suggestion: firstString(obj, ["suggestion", "fix", "recommendation"]) ?? undefined,
    });
  }

  return { findings, dropped };
}

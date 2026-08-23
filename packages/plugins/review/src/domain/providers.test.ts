/**
 * Output normalisation is the riskiest part of provider dispatch: five CLIs,
 * five output conventions, none of them stable across versions. These tests
 * pin every shape we know how to read.
 */

import { describe, test, expect } from "bun:test";
import {
  extractFindings,
  validateFindings,
  extractVerdicts,
  resolveProvider,
  truncateDiff,
  buildInstructions,
  buildVerifyPrompt,
  type ProviderStatus,
} from "./providers.js";
import { defaultAgentConfig, type Severity } from "@lgtm/core/store/agents.js";

// ─── extractFindings ────────────────────────────────────────────────────────

describe("extractFindings", () => {
  const one = { file: "src/a.ts", line: 1, severity: "high", comment: "boom" };

  test("strategy 1: a bare JSON array", () => {
    expect(extractFindings(JSON.stringify([one]))).toEqual([one]);
  });

  test("strategy 2: an object with a findings key", () => {
    expect(extractFindings(JSON.stringify({ findings: [one] }))).toEqual([one]);
  });

  test("strategy 2: alternative keys CLIs use", () => {
    for (const key of ["issues", "comments", "results"]) {
      expect(extractFindings(JSON.stringify({ [key]: [one] }))).toEqual([one]);
    }
  });

  test("strategy 3: JSON inside a fenced block", () => {
    const raw = `Here is what I found:\n\n\`\`\`json\n${JSON.stringify({ findings: [one] })}\n\`\`\`\n\nHope that helps.`;
    expect(extractFindings(raw)).toEqual([one]);
  });

  test("strategy 3: a fence with no language tag", () => {
    const raw = `\`\`\`\n${JSON.stringify([one])}\n\`\`\``;
    expect(extractFindings(raw)).toEqual([one]);
  });

  test("strategy 4: Claude's --output-format json envelope", () => {
    const envelope = JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: false,
      result: JSON.stringify({ findings: [one] }),
    });
    expect(extractFindings(envelope)).toEqual([one]);
  });

  test("strategy 4: an envelope whose result is a fenced block", () => {
    const envelope = JSON.stringify({
      result: `Reviewed it.\n\n\`\`\`json\n${JSON.stringify({ findings: [one] })}\n\`\`\``,
    });
    expect(extractFindings(envelope)).toEqual([one]);
  });

  test("finds JSON embedded in prose with no fence", () => {
    const raw = `I reviewed the diff. {"findings": [${JSON.stringify(one)}]} That is everything.`;
    expect(extractFindings(raw)).toEqual([one]);
  });

  test("a brace inside a comment does not cut the match short", () => {
    // A greedy regex would stop at the first closing brace inside the string.
    const tricky = {
      file: "src/a.ts",
      line: 3,
      severity: "high",
      comment: 'Use if (x) { return; } here, not a bare return',
    };
    const raw = `Result: {"findings": [${JSON.stringify(tricky)}]}`;

    expect(extractFindings(raw)).toEqual([tricky]);
  });

  test("strategy 5: prose with file:line and a bracketed severity", () => {
    const raw = [
      "I found two problems:",
      "src/auth.ts:42 (critical) Hardcoded API key. Move it to an env var.",
      "src/db.ts:18 [high] - Query built by string concat.",
    ].join("\n");

    expect(extractFindings(raw)).toEqual([
      { file: "src/auth.ts", line: 42, severity: "critical", comment: "Hardcoded API key. Move it to an env var." },
      { file: "src/db.ts", line: 18, severity: "high", comment: "Query built by string concat." },
    ]);
  });

  test("strategy 5: prose as a bulleted or numbered list", () => {
    const raw = ["- src/a.ts:1 high thing one", "2. src/b.ts:2 low thing two"].join("\n");

    expect(extractFindings(raw)).toEqual([
      { file: "src/a.ts", line: 1, severity: "high", comment: "thing one" },
      { file: "src/b.ts", line: 2, severity: "low", comment: "thing two" },
    ]);
  });

  test("strategy 5 ignores stack traces, which are not findings", () => {
    const raw = [
      "Error: something broke",
      "    at Object.<anonymous> (/app/index.js:12:9)",
      "    at Module._compile (node:internal/modules/cjs/loader:1105:14)",
    ].join("\n");

    // The `at ... (path:line:col)` shape has no leading path:line, so nothing
    // should match. Matching it would fill the review with noise.
    expect(extractFindings(raw)).toBeNull();
  });

  test("strategy 6: nothing parseable returns null, not an empty array", () => {
    // Null and empty must stay distinguishable. Empty means "reviewed, found
    // nothing"; null means "we could not read the output" and needs an error.
    expect(extractFindings("I could not review this.")).toBeNull();
    expect(extractFindings("")).toBeNull();
    expect(extractFindings("   \n  ")).toBeNull();
  });

  test("an explicit empty result is an empty array, not null", () => {
    expect(extractFindings('{"findings": []}')).toEqual([]);
    expect(extractFindings("[]")).toEqual([]);
  });
});

// ─── validateFindings ───────────────────────────────────────────────────────

describe("validateFindings", () => {
  test("keeps a well-formed finding", () => {
    const { findings, dropped } = validateFindings(
      [{ file: "src/a.ts", line: 42, severity: "high", comment: "boom", suggestion: "fix it" }],
      "low"
    );

    expect(dropped).toBe(0);
    expect(findings).toEqual([
      { file: "src/a.ts", line: 42, severity: "high", comment: "boom", suggestion: "fix it" },
    ]);
  });

  test("accepts the alternative field names providers use", () => {
    const { findings } = validateFindings(
      [{ path: "src/a.ts", line_number: "42", body: "boom", level: "major" }],
      "low"
    );

    expect(findings[0]).toMatchObject({ file: "src/a.ts", line: 42, comment: "boom", severity: "high" });
  });

  test("drops a finding with no file, since it has nowhere to be posted", () => {
    const { findings, dropped } = validateFindings([{ line: 5, comment: "boom" }], "low");

    expect(findings).toEqual([]);
    expect(dropped).toBe(1);
  });

  test("drops a finding with no usable line number", () => {
    const cases = [
      { file: "a.ts", comment: "x" },
      { file: "a.ts", line: 0, comment: "x" },
      { file: "a.ts", line: -3, comment: "x" },
      { file: "a.ts", line: "not a number", comment: "x" },
    ];

    const { findings, dropped } = validateFindings(cases, "low");

    expect(findings).toEqual([]);
    expect(dropped).toBe(4);
  });

  test("drops a finding with an empty comment", () => {
    const { dropped } = validateFindings([{ file: "a.ts", line: 1, comment: "   " }], "low");
    expect(dropped).toBe(1);
  });

  test("drops non-objects instead of throwing on them", () => {
    const { findings, dropped } = validateFindings(["nope", null, 42, undefined], "low");

    expect(findings).toEqual([]);
    expect(dropped).toBe(4);
  });

  test("a missing severity defaults to medium rather than being dropped", () => {
    const { findings } = validateFindings([{ file: "a.ts", line: 1, comment: "x" }], "low");
    expect(findings[0].severity).toBe("medium");
  });

  test("normalises the severity words different providers emit", () => {
    const pairs: Array<[string, Severity]> = [
      ["blocker", "critical"],
      ["major", "high"],
      ["ERROR", "high"],
      ["warning", "medium"],
      ["nit", "low"],
      ["something odd", "medium"],
    ];

    for (const [input, expected] of pairs) {
      const { findings } = validateFindings([{ file: "a.ts", line: 1, comment: "x", severity: input }], "low");
      expect(findings[0].severity).toBe(expected);
    }
  });

  test("enforces the agent's severity floor", () => {
    const candidates = [
      { file: "a.ts", line: 1, comment: "crit", severity: "critical" },
      { file: "a.ts", line: 2, comment: "high", severity: "high" },
      { file: "a.ts", line: 3, comment: "med", severity: "medium" },
      { file: "a.ts", line: 4, comment: "low", severity: "low" },
    ];

    const { findings, dropped } = validateFindings(candidates, "high");

    expect(findings.map((f) => f.comment)).toEqual(["crit", "high"]);
    expect(dropped).toBe(2);
  });

  test("strips diff path prefixes that GitHub would reject", () => {
    const { findings } = validateFindings(
      [
        { file: "./src/a.ts", line: 1, comment: "x" },
        { file: "b/src/b.ts", line: 1, comment: "y" },
      ],
      "low"
    );

    expect(findings.map((f) => f.file)).toEqual(["src/a.ts", "src/b.ts"]);
  });
});

// ─── extractVerdicts ────────────────────────────────────────────────────────

describe("extractVerdicts", () => {
  test("reads a verdicts array", () => {
    const raw = JSON.stringify({
      verdicts: [
        { index: 1, resolved: true, note: "moved to env var" },
        { index: 2, resolved: false, note: "still concatenating" },
      ],
    });

    expect(extractVerdicts(raw, 2)).toEqual([
      { index: 1, resolved: true, note: "moved to env var" },
      { index: 2, resolved: false, note: "still concatenating" },
    ]);
  });

  test("a missing index is treated as unresolved, never as fixed", () => {
    // Assuming an unanswered finding was fixed would quietly drop a real
    // problem from the next round.
    const raw = JSON.stringify({ verdicts: [{ index: 1, resolved: true, note: "done" }] });

    const verdicts = extractVerdicts(raw, 3);

    expect(verdicts.length).toBe(3);
    expect(verdicts[1]).toEqual({ index: 2, resolved: false, note: "no verdict returned for this finding" });
    expect(verdicts[2].resolved).toBe(false);
  });

  test("ignores an index outside the expected range", () => {
    const raw = JSON.stringify({ verdicts: [{ index: 99, resolved: true, note: "?" }] });

    expect(extractVerdicts(raw, 1)).toEqual([
      { index: 1, resolved: false, note: "no verdict returned for this finding" },
    ]);
  });

  test("accepts fixed and addressed as synonyms for resolved", () => {
    const raw = JSON.stringify({ verdicts: [{ index: 1, fixed: true }, { index: 2, addressed: true }] });

    expect(extractVerdicts(raw, 2).map((v) => v.resolved)).toEqual([true, true]);
  });

  test("reads verdicts from a fenced block", () => {
    const raw = `Checked each one.\n\n\`\`\`json\n{"verdicts": [{"index": 1, "resolved": true, "note": "ok"}]}\n\`\`\``;

    expect(extractVerdicts(raw, 1)[0].resolved).toBe(true);
  });

  test("reads verdicts from a Claude envelope", () => {
    const raw = JSON.stringify({
      result: JSON.stringify({ verdicts: [{ index: 1, resolved: true, note: "ok" }] }),
    });

    expect(extractVerdicts(raw, 1)[0]).toEqual({ index: 1, resolved: true, note: "ok" });
  });

  test("unparseable output yields no verdicts, so the caller can flag it", () => {
    expect(extractVerdicts("I am not sure.", 2)).toEqual([]);
    expect(extractVerdicts("", 2)).toEqual([]);
  });
});

// ─── resolveProvider ────────────────────────────────────────────────────────

describe("resolveProvider", () => {
  function statuses(available: Partial<Record<string, boolean>>): ProviderStatus[] {
    return (["kiro-cli", "claude-cli", "codex-cli", "openrouter", "ollama"] as const).map((id) => ({
      id,
      available: available[id] ?? false,
      detail: available[id] ? "ready" : "not configured",
      hasBuiltInReview: id === "claude-cli" || id === "codex-cli",
      fix: available[id] ? "" : "configure it",
    }));
  }

  test("auto takes the first available in priority order", () => {
    const result = resolveProvider("auto", statuses({ "codex-cli": true, ollama: true }));

    expect(result).toEqual({ id: "codex-cli", skipped: ["kiro-cli", "claude-cli"] });
  });

  test("auto prefers kiro-cli when it is available", () => {
    const result = resolveProvider("auto", statuses({ "kiro-cli": true, "claude-cli": true }));

    expect(result).toEqual({ id: "kiro-cli", skipped: [] });
  });

  test("auto errors with every reason when nothing is available", () => {
    const result = resolveProvider("auto", statuses({}));

    expect(result).toHaveProperty("error");
    const { error } = result as { error: string };
    expect(error).toContain("no review provider available");
    // The report has to name each one, otherwise the user has no idea what to fix.
    for (const id of ["kiro-cli", "claude-cli", "codex-cli", "openrouter", "ollama"]) {
      expect(error).toContain(id);
    }
  });

  test("a pinned provider is honoured", () => {
    const result = resolveProvider("ollama", statuses({ "claude-cli": true, ollama: true }));

    expect(result).toEqual({ id: "ollama", skipped: [] });
  });

  test("a pinned but unavailable provider errors instead of falling back", () => {
    // Silently reviewing with something other than what was configured would
    // be worse than failing.
    const result = resolveProvider("ollama", statuses({ "claude-cli": true }));

    expect(result).toHaveProperty("error");
    expect((result as { error: string }).error).toContain("ollama");
  });
});

// ─── Prompt building ────────────────────────────────────────────────────────

describe("truncateDiff", () => {
  test("leaves a small diff alone", () => {
    expect(truncateDiff("short", 100)).toBe("short");
  });

  test("announces truncation, so the model does not imply the rest was fine", () => {
    const out = truncateDiff("x".repeat(200), 100);

    expect(out.startsWith("x".repeat(100))).toBe(true);
    expect(out).toContain("diff truncated");
    expect(out).toContain("100 characters omitted");
  });
});

describe("buildInstructions", () => {
  const agent = defaultAgentConfig();

  test("is just the agent prompt when there is nothing else", () => {
    expect(buildInstructions({ agent, diff: "" })).toBe(agent.prompt);
  });

  test("appends rule context", () => {
    const out = buildInstructions({ agent, diff: "", ruleContext: "Also enforce: no console.log" });

    expect(out).toContain(agent.prompt);
    expect(out).toContain("no console.log");
  });

  test("tells the agent not to repeat prior findings", () => {
    const out = buildInstructions({
      agent,
      diff: "",
      priorFindings: [{ file: "src/db.ts", line: 18, comment: "string concat" }],
    });

    expect(out).toContain("Do not repeat them");
    expect(out).toContain("src/db.ts:18 string concat");
  });
});

describe("buildVerifyPrompt", () => {
  test("numbers the findings so verdict indices line up", () => {
    const prompt = buildVerifyPrompt(
      [
        { file: "a.ts", line: 1, severity: "critical", comment: "first" },
        { file: "b.ts", line: 2, comment: "second" },
      ],
      "diff here"
    );

    expect(prompt).toContain("1. a.ts:1 (critical) first");
    expect(prompt).toContain("2. b.ts:2 second");
    expect(prompt).toContain("Include every index");
  });
});

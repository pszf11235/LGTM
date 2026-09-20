/**
 * Output normalisation is the riskiest part of the Provider seam: the CLI
 * makes no promise about its output shape across versions, and the M0 spike
 * caught it emitting two different shapes on two runs of the same PR. These
 * tests pin every shape we know how to read.
 *
 * Ported from packages/plugins/review/src/domain/providers.test.ts on the old
 * `main` branch, plus the shapes the spike observed for real.
 */

import { describe, expect, test } from "bun:test";
import type { Severity } from "@/core";
import { extractFindings, extractSessionMeta, meetsSeverity, validateFindings } from "./parse";

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

  test("strategy 3: the CLI's --output-format json envelope", () => {
    const envelope = JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: false,
      result: JSON.stringify({ findings: [one] }),
    });
    expect(extractFindings(envelope)).toEqual([one]);
  });

  test("strategy 3: the envelope survives the usage and cost fields beside it", () => {
    // The real envelope carries token counts and a cost figure next to the
    // review text. Neither is an array, so nothing may mistake them for findings.
    const envelope = JSON.stringify({
      type: "result",
      is_error: false,
      duration_ms: 344_000,
      total_cost_usd: 0.77,
      usage: { input_tokens: 12, output_tokens: 34 },
      result: JSON.stringify({ findings: [one] }),
    });
    expect(extractFindings(envelope)).toEqual([one]);
  });

  test("strategy 4: an envelope whose result is a fenced block", () => {
    // This is the spike's contract path: the CLI answered in the exact schema
    // inside a ```json fence, wrapped in the envelope.
    const envelope = JSON.stringify({
      result: `Reviewed it.\n\n\`\`\`json\n${JSON.stringify({ findings: [one] })}\n\`\`\``,
    });
    expect(extractFindings(envelope)).toEqual([one]);
  });

  test("strategy 4: JSON inside a fenced block", () => {
    const raw = `Here is what I found:\n\n\`\`\`json\n${JSON.stringify({ findings: [one] })}\n\`\`\`\n\nHope that helps.`;
    expect(extractFindings(raw)).toEqual([one]);
  });

  test("strategy 4: a fence with no language tag", () => {
    const raw = `\`\`\`\n${JSON.stringify([one])}\n\`\`\``;
    expect(extractFindings(raw)).toEqual([one]);
  });

  test("strategy 5: JSON embedded in prose with no fence", () => {
    const raw = `I reviewed the diff. {"findings": [${JSON.stringify(one)}]} That is everything.`;
    expect(extractFindings(raw)).toEqual([one]);
  });

  test("a brace inside a comment does not cut the match short", () => {
    // A greedy regex would stop at the first closing brace inside the string.
    const tricky = {
      file: "src/a.ts",
      line: 3,
      severity: "high",
      comment: "Use if (x) { return; } here, not a bare return",
    };
    const raw = `Result: {"findings": [${JSON.stringify(tricky)}]}`;

    expect(extractFindings(raw)).toEqual([tricky]);
  });

  test("strategy 6: the exact prose shape the spike came back with", () => {
    // Without the JSON contract the CLI answers in markdown: a list item, a
    // backticked path:line, an em dash, then the comment. This is transcribed
    // from a real run, not invented.
    const raw = [
      "I reviewed the pull request and found two issues.",
      "",
      "- `README.md:75` — The install snippet points at a tag that does not exist.",
      "- `src/limiter.ts:118` — The retry loop never resets the backoff.",
    ].join("\n");

    expect(extractFindings(raw)).toEqual([
      {
        file: "README.md",
        line: 75,
        severity: undefined,
        comment: "The install snippet points at a tag that does not exist.",
      },
      {
        file: "src/limiter.ts",
        line: 118,
        severity: undefined,
        comment: "The retry loop never resets the backoff.",
      },
    ]);
  });

  test("strategy 6: the prose shape inside the CLI envelope", () => {
    // The envelope is always there in --output-format json mode, prose or not.
    const envelope = JSON.stringify({
      type: "result",
      is_error: false,
      result: "- `src/index.ts:42` (high) Potential null reference",
    });

    expect(extractFindings(envelope)).toEqual([
      { file: "src/index.ts", line: 42, severity: "high", comment: "Potential null reference" },
    ]);
  });

  test("strategy 6: prose with file:line and a bracketed severity", () => {
    const raw = [
      "I found two problems:",
      "src/auth.ts:42 (critical) Hardcoded API key. Move it to an env var.",
      "src/db.ts:18 [high] - Query built by string concat.",
    ].join("\n");

    expect(extractFindings(raw)).toEqual([
      {
        file: "src/auth.ts",
        line: 42,
        severity: "critical",
        comment: "Hardcoded API key. Move it to an env var.",
      },
      { file: "src/db.ts", line: 18, severity: "high", comment: "Query built by string concat." },
    ]);
  });

  test("strategy 6: prose as a bulleted or numbered list", () => {
    const raw = ["- src/a.ts:1 high thing one", "2. src/b.ts:2 low thing two"].join("\n");

    expect(extractFindings(raw)).toEqual([
      { file: "src/a.ts", line: 1, severity: "high", comment: "thing one" },
      { file: "src/b.ts", line: 2, severity: "low", comment: "thing two" },
    ]);
  });

  test("strategy 6 ignores stack traces, which are not findings", () => {
    const raw = [
      "Error: something broke",
      "    at Object.<anonymous> (/app/index.js:12:9)",
      "    at Module._compile (node:internal/modules/cjs/loader:1105:14)",
    ].join("\n");

    // The `at ... (path:line:col)` shape has no leading path:line, so nothing
    // should match. Matching it would fill the review with noise.
    expect(extractFindings(raw)).toBeNull();
  });

  test("strategy 7: nothing parseable returns null, not an empty array", () => {
    // Null and empty must stay distinguishable. Empty means "reviewed, found
    // nothing"; null means "we could not read the output" and becomes a failed
    // Round with a .raw.txt dump.
    expect(extractFindings("I could not review this.")).toBeNull();
    expect(extractFindings("")).toBeNull();
    expect(extractFindings("   \n  ")).toBeNull();
  });

  test("an explicit empty result is an empty array, not null", () => {
    expect(extractFindings('{"findings": []}')).toEqual([]);
    expect(extractFindings("[]")).toEqual([]);
  });
});

// ─── extractSessionMeta ─────────────────────────────────────────────────────

describe("extractSessionMeta", () => {
  const one = { file: "src/a.ts", line: 1, severity: "high", comment: "boom" };

  /** The envelope as the CLI actually prints it, findings and session both. */
  function envelope(over: Record<string, unknown> = {}): string {
    return JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: false,
      duration_ms: 344_000,
      session_id: "f47ac10b-58cc-4372-a567-0e02b2c3d479",
      total_cost_usd: 0.77,
      num_turns: 14,
      modelUsage: { "claude-sonnet-5": { inputTokens: 12, outputTokens: 34 } },
      result: JSON.stringify({ findings: [one] }),
      ...over,
    });
  }

  test("reads the session, cost and turn count out of the envelope", () => {
    expect(extractSessionMeta(envelope())).toEqual({
      sessionId: "f47ac10b-58cc-4372-a567-0e02b2c3d479",
      costUsd: 0.77,
      turns: 14,
    });
  });

  test("the session id is metadata, never a finding", () => {
    // Both halves read the same envelope and neither may see the other's
    // fields. A cost figure in the findings array would post to a PR.
    const raw = envelope();

    expect(extractFindings(raw)).toEqual([one]);
    expect(extractSessionMeta(raw).sessionId).toBe("f47ac10b-58cc-4372-a567-0e02b2c3d479");
  });

  test("a provider that reports no session parses normally and says nothing", () => {
    // The whole point of keeping these apart: findings still come out, and the
    // session reads as three honest nulls rather than a parse failure.
    const raw = JSON.stringify({ findings: [one] });

    expect(extractFindings(raw)).toEqual([one]);
    expect(extractSessionMeta(raw)).toEqual({ sessionId: null, costUsd: null, turns: null });
  });

  test("reports whichever fields are there and nulls the rest", () => {
    const raw = JSON.stringify({ session_id: "abc-123", result: "{}" });

    expect(extractSessionMeta(raw)).toEqual({ sessionId: "abc-123", costUsd: null, turns: null });
  });

  test("finds the envelope behind a line of chatter", () => {
    // Nothing promises the JSON is alone on stdout, and a Round whose session
    // id is lost to a banner line cannot be resumed.
    const raw = `Loading project settings...\n${envelope()}`;

    expect(extractSessionMeta(raw).sessionId).toBe("f47ac10b-58cc-4372-a567-0e02b2c3d479");
  });

  test("unparseable output is a session-less round, not a throw", () => {
    // The garbage case still has to return: this is exactly the round that
    // becomes a .raw.txt dump, and it must not take the provider down first.
    for (const raw of ["", "   ", "This is not valid JSON: {broken [", "- `a.ts:1` — boom"]) {
      expect(extractSessionMeta(raw)).toEqual({ sessionId: null, costUsd: null, turns: null });
    }
  });

  test("an empty session id reads as none rather than as an id", () => {
    expect(extractSessionMeta(JSON.stringify({ session_id: "   ", num_turns: 2 }))).toEqual({
      sessionId: null,
      costUsd: null,
      turns: 2,
    });
  });

  test("rejects a cost or turn count that cannot be true", () => {
    // A negative cost or a fractional turn count is a misread field, and a
    // wrong number here would be reported to the user as fact.
    expect(extractSessionMeta(envelope({ total_cost_usd: -3, num_turns: 1.5 }))).toMatchObject({
      costUsd: null,
      turns: null,
    });
    expect(extractSessionMeta(envelope({ total_cost_usd: "free", num_turns: "many" }))).toMatchObject({
      costUsd: null,
      turns: null,
    });
  });

  test("accepts the numbers as strings, which JSON emitters sometimes do", () => {
    expect(extractSessionMeta(envelope({ total_cost_usd: "0.77", num_turns: "14" }))).toMatchObject({
      costUsd: 0.77,
      turns: 14,
    });
  });

  test("a free round reports zero rather than nothing", () => {
    // Zero and null are different answers: one is a measured cost, the other
    // is a provider that did not say.
    expect(extractSessionMeta(envelope({ total_cost_usd: 0, num_turns: 0 }))).toMatchObject({
      costUsd: 0,
      turns: 0,
    });
  });

  test("a bare findings array carries no session, and looking for one is harmless", () => {
    expect(extractSessionMeta(JSON.stringify([one]))).toEqual({
      sessionId: null,
      costUsd: null,
      turns: null,
    });
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

    expect(findings[0]).toMatchObject({
      file: "src/a.ts",
      line: 42,
      comment: "boom",
      severity: "high",
    });
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
    expect(findings[0]?.severity).toBe("medium");
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
      const { findings } = validateFindings(
        [{ file: "a.ts", line: 1, comment: "x", severity: input }],
        "low"
      );
      expect(findings[0]?.severity).toBe(expected);
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

  test("strips diff path prefixes that the Forge would reject", () => {
    const { findings } = validateFindings(
      [
        { file: "./src/a.ts", line: 1, comment: "x" },
        { file: "b/src/b.ts", line: 1, comment: "y" },
      ],
      "low"
    );

    expect(findings.map((f) => f.file)).toEqual(["src/a.ts", "src/b.ts"]);
  });

  test("the prose fallback's findings survive validation", () => {
    // The two halves have to compose: prose gives severity as undefined, and
    // validation has to turn that into a real severity rather than a drop.
    const extracted = extractFindings("- `README.md:75` — The install snippet is stale.");

    const { findings, dropped } = validateFindings(extracted ?? [], "low");

    expect(dropped).toBe(0);
    expect(findings).toEqual([
      {
        file: "README.md",
        line: 75,
        severity: "medium",
        comment: "The install snippet is stale.",
        suggestion: undefined,
      },
    ]);
  });
});

describe("meetsSeverity", () => {
  test("is inclusive of the floor itself", () => {
    expect(meetsSeverity("high", "high")).toBe(true);
    expect(meetsSeverity("critical", "high")).toBe(true);
    expect(meetsSeverity("medium", "high")).toBe(false);
  });
});

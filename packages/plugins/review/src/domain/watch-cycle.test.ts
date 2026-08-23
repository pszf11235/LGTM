/**
 * The watch loop end to end: decide, spawn a real worker process, parse what it
 * printed, write findings to the store, and on a second pass verify the earlier
 * ones before reviewing again.
 *
 * GitHub is injected. The provider is not: a fake CLI goes on PATH so the actual
 * subprocess boundary and output parsing are exercised, which is where the bugs
 * have been.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import fs from "fs";
import os from "os";
import path from "path";
import { decidePR, runCycle, checkPR, type CycleDeps, type OpenPR } from "./watch-cycle.js";
import { loadMeta, loadAllRounds, markFindingsPosted, saveMeta, type PRRef } from "./review-store.js";
import { defaultAgentConfig, type AgentConfig } from "@lgtm/core/store/agents.js";
import type { WatchedRepo } from "@lgtm/core/registry/watch-list.js";
import type { Logger } from "./orchestrator.js";

let store: string;
let binDir: string;
let originalPath: string | undefined;

const watched: WatchedRepo = { owner: "acme", repo: "app", filter: "all" };
const ref: PRRef = { owner: "acme", repo: "app", pr: 42 };

const silent: Logger = { info: () => {}, warn: () => {}, error: () => {} };

const DIFF = `diff --git a/src/auth.ts b/src/auth.ts
--- a/src/auth.ts
+++ b/src/auth.ts
@@ -1,2 +1,3 @@
 export function login() {
+  const key = "sk-hardcoded";
 }
`;

function openPR(over: Partial<OpenPR> = {}): OpenPR {
  return {
    number: 42,
    title: "Add login",
    author: "someone",
    createdAt: "2026-08-20T10:00:00Z",
    url: "https://github.com/acme/app/pull/42",
    headSha: "a".repeat(40),
    ...over,
  };
}

/**
 * Put a fake `claude` on PATH that prints the given stdout.
 *
 * The worker runs it as a real subprocess, so this covers spawning and parsing
 * as well as the cycle logic.
 */
function fakeProvider(script: string) {
  fs.writeFileSync(path.join(binDir, "claude"), `#!/bin/sh\n${script}\n`, { mode: 0o755 });
}

function findingsJson(findings: Array<{ file: string; line: number; severity: string; comment: string }>) {
  // Wrapped the way Claude's --output-format json does it, fence and all.
  const inner = JSON.stringify({ findings });
  const envelope = JSON.stringify({ type: "result", result: "```json\n" + inner + "\n```" });
  return `cat <<'JSON'\n${envelope}\nJSON`;
}

function agent(over: Partial<AgentConfig> = {}): AgentConfig {
  // Pinned so the test does not depend on what else is installed, and short
  // timeout so a hang fails fast.
  return { ...defaultAgentConfig(), provider: "claude-cli", severity: "low", timeout: 20, ...over };
}

function deps(over: Partial<CycleDeps> = {}): CycleDeps {
  return {
    fetchDiff: async () => DIFF,
    fetchOpenPRs: async () => [openPR()],
    ...over,
  };
}

beforeEach(() => {
  store = fs.mkdtempSync(path.join(os.tmpdir(), "lgtm-cycle-"));
  binDir = fs.mkdtempSync(path.join(os.tmpdir(), "lgtm-cycle-bin-"));
  originalPath = process.env.PATH;
  process.env.PATH = `${binDir}:${process.env.PATH}`;
});

afterEach(() => {
  process.env.PATH = originalPath;
  try { fs.rmSync(store, { recursive: true, force: true }); } catch { /* ignore */ }
  try { fs.rmSync(binDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

// ─── decidePR ───────────────────────────────────────────────────────────────

describe("decidePR", () => {
  function seed(sha: string, round = 1) {
    saveMeta(store, {
      ref, title: "t", author: "a", sha, round, agents: ["reviewer"], findingCount: 1,
    });
  }

  test("an unreviewed PR is round 1", () => {
    expect(decidePR(store, ref, "abc")).toEqual({
      kind: "review", reason: "not reviewed yet", round: 1,
    });
  });

  test("the same head SHA is skipped, which is what stops repeat reviews", () => {
    seed("a".repeat(40));

    expect(decidePR(store, ref, "a".repeat(40))).toMatchObject({
      kind: "skip", reason: "no new commits",
    });
  });

  test("a different head SHA is a re-review at the next round", () => {
    seed("a".repeat(40), 1);

    expect(decidePR(store, ref, "b".repeat(40))).toMatchObject({
      kind: "re-review", round: 2,
    });
  });

  test("a missing head SHA is skipped rather than reviewed every cycle", () => {
    // The API not returning a SHA must not mean "review again forever".
    seed("a".repeat(40));

    expect(decidePR(store, ref, "")).toMatchObject({ kind: "skip" });
  });
});

// ─── One PR, real worker ────────────────────────────────────────────────────

describe("checkPR", () => {
  test("reviews an unseen PR and writes findings to the store", async () => {
    fakeProvider(
      findingsJson([
        { file: "src/auth.ts", line: 2, severity: "critical", comment: "Hardcoded API key." },
      ])
    );

    const result = await checkPR(store, watched, openPR(), [agent()], deps(), "", silent);

    expect(result).toMatchObject({ action: "reviewed", round: 1, findings: 1 });

    const rounds = loadAllRounds(store, ref);
    expect(rounds.length).toBe(1);
    expect(rounds[0].findings[0]).toMatchObject({
      file: "src/auth.ts",
      line: 2,
      severity: "critical",
      posted: false,
    });

    // Nothing is posted by the cycle. That is the human gate.
    expect(rounds[0].findings.every((f) => !f.posted)).toBe(true);
  });

  test("records the head SHA so the next cycle skips the PR", async () => {
    fakeProvider(findingsJson([]));

    await checkPR(store, watched, openPR(), [agent()], deps(), "", silent);

    expect(loadMeta(store, ref)!.lastReviewedSha).toBe("a".repeat(40));

    const second = await checkPR(store, watched, openPR(), [agent()], deps(), "", silent);
    expect(second).toMatchObject({ action: "skipped", reason: "no new commits" });
  });

  test("an empty diff is recorded, not retried forever", async () => {
    fakeProvider(findingsJson([]));

    const result = await checkPR(
      store, watched, openPR(), [agent()], deps({ fetchDiff: async () => "" }), "", silent
    );

    expect(result).toMatchObject({ action: "skipped", reason: "empty diff" });
    // The SHA is stored, so the PR is not fetched again next cycle.
    expect(loadMeta(store, ref)!.lastReviewedSha).toBe("a".repeat(40));
  });

  test("a diff fetch failure is reported without writing a round", async () => {
    fakeProvider(findingsJson([]));

    const result = await checkPR(
      store, watched, openPR(), [agent()],
      deps({ fetchDiff: async () => { throw new Error("API 502"); } }),
      "", silent
    );

    expect(result).toMatchObject({ action: "failed" });
    expect((result as { reason: string }).reason).toContain("502");
    expect(loadAllRounds(store, ref)).toEqual([]);
  });

  test("a provider that returns nothing parseable is a failed round, kept for debugging", async () => {
    fakeProvider(`echo "I could not review this"`);

    const result = await checkPR(store, watched, openPR(), [agent()], deps(), "", silent);

    expect(result.action).toBe("failed");

    // The round file still exists, carrying the error, so the failure is visible
    // rather than looking like a clean PR.
    const rounds = loadAllRounds(store, ref);
    expect(rounds.length).toBe(1);
    expect(rounds[0].error).toBeTruthy();
    expect(rounds[0].findings).toEqual([]);
  });

  test("writes one round file per agent, so two reviewers stay attributable", async () => {
    fakeProvider(
      findingsJson([{ file: "src/auth.ts", line: 2, severity: "high", comment: "Same finding." }])
    );

    await checkPR(
      store, watched, openPR(),
      [agent({ name: "first" }), agent({ name: "second" })],
      deps(), "", silent
    );

    const rounds = loadAllRounds(store, ref);
    expect(rounds.map((r) => r.agent).sort()).toEqual(["first", "second"]);
  });
});

// ─── Re-review with verification ────────────────────────────────────────────

describe("re-review after new commits", () => {
  test("verifies posted findings, then reviews again at the next round", async () => {
    // Round 1: one finding.
    fakeProvider(
      findingsJson([
        { file: "src/auth.ts", line: 2, severity: "critical", comment: "Hardcoded API key." },
      ])
    );
    await checkPR(store, watched, openPR(), [agent()], deps(), "", silent);

    // The author sees it, so it becomes eligible for verification.
    markFindingsPosted(store, ref, ["f1"], 555);

    // New commits. The fake now answers verification and then the new review.
    // First call returns verdicts, second returns findings.
    const marker = path.join(binDir, "called-once");
    fs.writeFileSync(
      path.join(binDir, "claude"),
      [
        "#!/bin/sh",
        `if [ -f "${marker}" ]; then`,
        `  cat <<'JSON'`,
        JSON.stringify({ type: "result", result: JSON.stringify({ findings: [{ file: "src/auth.ts", line: 2, severity: "high", comment: "New problem introduced." }] }) }),
        "JSON",
        "else",
        `  touch "${marker}"`,
        `  cat <<'JSON'`,
        JSON.stringify({ type: "result", result: JSON.stringify({ verdicts: [{ index: 1, resolved: true, note: "moved to env var" }] }) }),
        "JSON",
        "fi",
      ].join("\n"),
      { mode: 0o755 }
    );

    const result = await checkPR(
      store, watched, openPR({ headSha: "b".repeat(40) }), [agent()], deps(), "", silent
    );

    expect(result).toMatchObject({ action: "re-reviewed", round: 2, resolved: 1, unresolved: 0 });

    // The round 1 finding now carries its verdict.
    const round1 = loadAllRounds(store, ref).find((r) => r.round === 1)!;
    expect(round1.findings[0].resolved).toBe(true);
    expect(round1.findings[0].resolvedNote).toContain("env var");

    // And meta records the verification against round 2.
    const meta = loadMeta(store, ref)!;
    expect(meta.currentRound).toBe(2);
    expect(meta.rounds[1]).toMatchObject({
      verifiedPriorRound: 1, resolvedFromPrior: 1, unresolvedFromPrior: 0,
    });
  }, 30000);

  test("skips verification when nothing was ever posted", async () => {
    // A finding the author never saw cannot have been addressed, so spending a
    // provider call to ask is waste.
    fakeProvider(
      findingsJson([{ file: "src/auth.ts", line: 2, severity: "high", comment: "Unposted." }])
    );
    await checkPR(store, watched, openPR(), [agent()], deps(), "", silent);

    const result = await checkPR(
      store, watched, openPR({ headSha: "b".repeat(40) }), [agent()], deps(), "", silent
    );

    // Round 2 happens, but with no verification recorded.
    expect(result).toMatchObject({ action: "re-reviewed", round: 2, resolved: 0, unresolved: 0 });
  }, 30000);
});

// ─── Whole cycle ────────────────────────────────────────────────────────────

describe("runCycle", () => {
  test("counts what happened across repos", async () => {
    fakeProvider(
      findingsJson([{ file: "src/auth.ts", line: 2, severity: "high", comment: "One." }])
    );

    const result = await runCycle(store, [watched], [agent()], deps(), "", silent);

    expect(result).toMatchObject({ reviewed: 1, skipped: 0, failed: 0, findings: 1 });
    expect(result.repos[0].repo).toBe("acme/app");
  });

  test("one unreachable repo does not stop the others", async () => {
    // The watcher runs unattended, so a single bad repo must not end the cycle.
    fakeProvider(
      findingsJson([{ file: "src/auth.ts", line: 2, severity: "high", comment: "One." }])
    );

    const broken: WatchedRepo = { owner: "gone", repo: "missing", filter: "all" };
    const result = await runCycle(
      store,
      [broken, watched],
      [agent()],
      deps({
        fetchOpenPRs: async (w) => {
          if (w.owner === "gone") throw new Error("404 Not Found");
          return [openPR()];
        },
      }),
      "",
      silent
    );

    expect(result.repos[0]).toMatchObject({ repo: "gone/missing", error: "404 Not Found" });
    expect(result.reviewed).toBe(1);
    expect(result.failed).toBe(1);
  }, 30000);

  test("a repo with no open PRs is reported, not treated as an error", async () => {
    const result = await runCycle(
      store, [watched], [agent()], deps({ fetchOpenPRs: async () => [] }), "", silent
    );

    expect(result).toMatchObject({ reviewed: 0, failed: 0 });
    expect(result.repos[0].prs).toEqual([]);
  });

  test("log lines name the repo, since one store holds many", async () => {
    fakeProvider(findingsJson([]));
    const lines: string[] = [];

    await runCycle(store, [watched], [agent()], deps(), "", {
      info: (m) => lines.push(m),
      warn: (m) => lines.push(m),
      error: (m) => lines.push(m),
    });

    // A bare "#42" is meaningless in a multi-repo log.
    expect(lines.every((l) => l.includes("acme/app#42"))).toBe(true);
  });
});

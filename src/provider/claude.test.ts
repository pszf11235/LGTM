/**
 * The Claude CLI Provider: prompt assembly, the spawn helper, and the round
 * trip through the offline shim at test/fixtures/fake-claude.ts.
 *
 * The spawn tests are the load-bearing ones. A timeout that does not actually
 * return leaves one of the daemon's two concurrency slots occupied forever,
 * and nothing upstream would report it.
 */

import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";
import { buildPrompt, claudeArgs, claudeProvider, DEFAULT_MODEL, run } from "./claude";
import { defaultAgentConfig, type AgentConfig, type ReviewInput } from "./index";

const SHIM = join(import.meta.dir, "../../test/fixtures/fake-claude.ts");

/** The session the shim reports on every envelope it emits. */
const SHIM_SESSION = {
  sessionId: "f47ac10b-58cc-4372-a567-0e02b2c3d479",
  costUsd: 0.77,
  turns: 14,
};

/**
 * An executable stand-in for the CLI, written to a scratch directory.
 *
 * Used where the shim cannot help: the tests below need a "binary" that
 * reports the directory it was spawned in, or that prints an envelope whose
 * result will not parse. Both are properties of the spawn, not of any review.
 */
async function fakeBinary(body: string): Promise<string> {
  const dir = await fs.mkdtemp(join(os.tmpdir(), "lgtm-fake-cli-"));
  const binPath = join(dir, "claude");
  await fs.writeFile(binPath, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  return binPath;
}

function agent(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return { ...defaultAgentConfig(), severityFloor: "low", ...overrides };
}

function input(overrides: Partial<ReviewInput> = {}): ReviewInput {
  return {
    agent: agent(),
    prUrl: "https://github.com/acme/api/pull/42",
    binPath: SHIM,
    ...overrides,
  };
}

afterEach(() => {
  delete process.env.FAKE_CLAUDE_MODE;
});

// ─── Prompt assembly ────────────────────────────────────────────────────────

describe("buildPrompt", () => {
  test("leads with the bundled review command and the full PR URL", () => {
    // The URL is the whole input: the spike proved the CLI fetches the PR
    // itself, so v1 has no checkout to point it at.
    const prompt = buildPrompt(input());

    expect(prompt.startsWith("/review https://github.com/acme/api/pull/42")).toBe(true);
  });

  test("appends the agent's prompt as additional instructions", () => {
    const prompt = buildPrompt(
      input({ agent: agent({ prompt: "Never use em dashes.\nCite file and line." }) })
    );

    expect(prompt).toContain("Additional instructions:\nNever use em dashes.\nCite file and line.");
  });

  test("omits the instructions header when the agent file has no body", () => {
    // An empty prompt means the CLI's own review skill runs alone. A bare
    // "Additional instructions:" header with nothing under it reads as a
    // truncated prompt to the model.
    expect(buildPrompt(input())).not.toContain("Additional instructions");
  });

  test("always ends with the JSON contract", () => {
    // With the contract the spike's CLI answered in the exact schema; without
    // it, prose. The contract goes last so nothing in the agent's own prompt
    // can push it out of the model's attention.
    const prompt = buildPrompt(input({ agent: agent({ prompt: "Be terse." }) }));

    expect(prompt.trimEnd().endsWith('Return {"findings": []} when there is nothing to report.')).toBe(
      true
    );
    expect(prompt).toContain('Respond with JSON only: {"findings":');
  });

  test("says so explicitly when there is nothing to report", () => {
    // Without this line a clean PR comes back as prose, fails to parse, and
    // is recorded as a failed round instead of a clean one.
    expect(buildPrompt(input())).toContain('Return {"findings": []}');
  });

  test("carries no prior-findings block on a first round", () => {
    expect(buildPrompt(input())).not.toContain("Already raised");
  });

  test("replays prior findings as do-not-repeat context, keyed by finding key", () => {
    const prompt = buildPrompt(
      input({
        priorFindings: [
          {
            key: { round: 1, agent: "reviewer", id: "f3" },
            file: "src/limiter.ts",
            line: 118,
            severity: "high",
            comment: "The retry loop never resets the backoff.",
          },
        ],
      })
    );

    expect(prompt).toContain("Already raised in earlier reviews. Verify silently; do not repeat:");
    expect(prompt).toContain(
      "- src/limiter.ts:118 [high] The retry loop never resets the backoff.   (r1:reviewer:f3)"
    );
  });

  test("keeps the sections in the order design.md specifies", () => {
    const prompt = buildPrompt(
      input({
        agent: agent({ prompt: "Be terse." }),
        priorFindings: [
          { key: { round: 1, agent: "reviewer", id: "f1" }, file: "a.ts", line: 1, severity: "low", comment: "x" },
        ],
      })
    );

    const order = ["/review ", "Additional instructions:", "Already raised", "Respond with JSON only"];
    const positions = order.map((needle) => prompt.indexOf(needle));

    expect(positions.every((p) => p >= 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
  });
});

describe("claudeArgs", () => {
  test("spawns print mode with the JSON envelope", () => {
    const args = claudeArgs(agent({ model: "sonnet" }), "PROMPT", "/usr/local/bin/claude");

    expect(args).toEqual([
      "/usr/local/bin/claude",
      "-p",
      "PROMPT",
      "--output-format",
      "json",
      "--model",
      "sonnet",
    ]);
  });

  test("never omits --model, even when the agent file leaves it blank", () => {
    // Omitting it inherits the session default. The spike paid $1.55 for the
    // review it later got for $0.77, and a daemon would pay that on every PR.
    const args = claudeArgs(agent({ model: "   " }), "PROMPT");

    expect(args).toContain("--model");
    expect(args[args.indexOf("--model") + 1]).toBe(DEFAULT_MODEL);
  });

  test("honours a model pinned in the agent file", () => {
    const args = claudeArgs(agent({ model: "opus" }), "PROMPT");

    expect(args[args.indexOf("--model") + 1]).toBe("opus");
  });
});

// ─── The spawn helper ───────────────────────────────────────────────────────

describe("run", () => {
  test("spawns in the working directory it is given", async () => {
    // The Claude CLI files each session under a slug of its working
    // directory, so this is the option that decides whether a Round can be
    // resumed at all.
    const dir = await fs.mkdtemp(join(os.tmpdir(), "lgtm-run-cwd-"));

    const outcome = await run(["sh", "-c", "pwd"], { cwd: dir, timeoutSeconds: 10 });

    expect(await fs.realpath(outcome.stdout.trim())).toBe(await fs.realpath(dir));
  });

  test("returns stdout, stderr, and the exit code", async () => {
    const outcome = await run(["sh", "-c", "echo out; echo err >&2; exit 3"], {
      timeoutSeconds: 10,
    });

    expect(outcome.stdout.trim()).toBe("out");
    expect(outcome.stderr.trim()).toBe("err");
    expect(outcome.exitCode).toBe(3);
    expect(outcome.timedOut).toBe(false);
  });

  test("closes stdin, so a child that reads it sees EOF instead of hanging", async () => {
    // The spike's runs warned "no stdin data received in 3s" until stdin was
    // closed. A daemon has no terminal to offer one.
    const outcome = await run(["sh", "-c", "cat; echo done"], { timeoutSeconds: 5 });

    expect(outcome.stdout.trim()).toBe("done");
    expect(outcome.timedOut).toBe(false);
  });

  test("kills on the deadline and salvages the output that arrived first", async () => {
    const outcome = await run(["sh", "-c", "echo partial; sleep 10"], { timeoutSeconds: 1 });

    expect(outcome.timedOut).toBe(true);
    expect(outcome.stdout).toContain("partial");
    expect(outcome.exitCode).toBeNull();
  });

  test("returns on the deadline even while a grandchild holds the stdout pipe open", async () => {
    // This is why the timeout races the read instead of gating it. `sleep` is
    // a child of the shell and inherits the pipe, so it survives the SIGKILL
    // and keeps the pipe open. Awaiting the read after the kill would block
    // here forever, and the daemon would lose a concurrency slot silently.
    const startedAt = Date.now();
    const outcome = await run(["sh", "-c", "echo partial; sleep 20 & sleep 20"], {
      timeoutSeconds: 1,
    });

    expect(outcome.timedOut).toBe(true);
    expect(Date.now() - startedAt).toBeLessThan(5000);
  });
});

// ─── Round trip through the offline shim ────────────────────────────────────

describe("claudeProvider.review", () => {
  test("parses findings out of the CLI envelope", async () => {
    process.env.FAKE_CLAUDE_MODE = "json";

    const outcome = await claudeProvider.review(input());

    expect(outcome.status).toBe("ok");
    expect(outcome.error).toBeNull();
    expect(outcome.provider).toBe("claude-cli");
    expect(outcome.findings.map((f) => `${f.file}:${f.line}`)).toEqual([
      "src/index.ts:42",
      "src/utils.ts:18",
    ]);
    expect(outcome.durationMs).toBeGreaterThanOrEqual(0);
  });

  test("parses the prose shape the CLI falls back to", async () => {
    process.env.FAKE_CLAUDE_MODE = "prose";

    const outcome = await claudeProvider.review(input());

    expect(outcome.status).toBe("ok");
    expect(outcome.findings.map((f) => f.severity)).toEqual(["high", "medium"]);
  });

  test("applies the agent's severity floor and counts what it dropped", async () => {
    process.env.FAKE_CLAUDE_MODE = "json";

    const outcome = await claudeProvider.review(
      input({ agent: agent({ severityFloor: "high" }) })
    );

    expect(outcome.findings.map((f) => f.severity)).toEqual(["high"]);
    expect(outcome.dropped).toBe(1);
  });

  test("an empty review is a clean round, not a failed one", async () => {
    process.env.FAKE_CLAUDE_MODE = "empty";

    const outcome = await claudeProvider.review(input());

    expect(outcome.status).toBe("ok");
    expect(outcome.findings).toEqual([]);
    expect(outcome.error).toBeNull();
  });

  test("unparseable output fails the round and keeps the raw text for the dump", async () => {
    // Never a silent zero findings: the round is failed, and `raw` is what
    // the store writes to r<N>-<agent>.raw.txt.
    process.env.FAKE_CLAUDE_MODE = "garbage";

    const outcome = await claudeProvider.review(input());

    expect(outcome.status).toBe("failed");
    expect(outcome.findings).toEqual([]);
    expect(outcome.error).toBe("could not parse provider output");
    expect(outcome.raw).toContain("This is not valid JSON");
  });

  test("a crashing CLI fails the round with its stderr, and does not throw", async () => {
    process.env.FAKE_CLAUDE_MODE = "crash";

    const outcome = await claudeProvider.review(input());

    expect(outcome.status).toBe("failed");
    expect(outcome.error).toContain("authentication expired");
  });

  test("a hung CLI fails the round on the timeout", async () => {
    process.env.FAKE_CLAUDE_MODE = "timeout";

    // One second, not ten minutes. The shim sleeps for thirty.
    const outcome = await claudeProvider.review(
      input({ agent: agent({ timeoutMinutes: 1 / 60 }) })
    );

    expect(outcome.status).toBe("failed");
    expect(outcome.error).toContain("timed out");
    expect(outcome.findings).toEqual([]);
  });

  test("a missing binary fails the round instead of taking the daemon down", async () => {
    const outcome = await claudeProvider.review(input({ binPath: "/nonexistent/claude" }));

    expect(outcome.status).toBe("failed");
    expect(outcome.error).toBeTruthy();
    expect(outcome.findings).toEqual([]);
  });
});

// ─── The session behind the round ───────────────────────────────────────────

describe("claudeProvider.review: session capture", () => {
  test("carries the session, the cost and the turn count off the envelope", async () => {
    // The session id is the whole feature: `claude --resume <id>` reopens this
    // exact conversation, so a human can argue with the reviewer that wrote a
    // finding instead of starting a fresh review.
    process.env.FAKE_CLAUDE_MODE = "json";

    const outcome = await claudeProvider.review(input());

    expect(outcome).toMatchObject(SHIM_SESSION);
  });

  test("captures the session from the prose shape too, not only from JSON", async () => {
    // The session lives on the envelope, which is there whatever shape the
    // review text inside it takes.
    process.env.FAKE_CLAUDE_MODE = "prose";

    expect(await claudeProvider.review(input())).toMatchObject(SHIM_SESSION);
  });

  test("a provider that reports no session still reviews normally", async () => {
    const binPath = await fakeBinary(`echo '{"result":"{\\"findings\\":[]}"}'`);

    const outcome = await claudeProvider.review(input({ binPath }));

    expect(outcome.status).toBe("ok");
    expect(outcome.findings).toEqual([]);
    expect(outcome).toMatchObject({ sessionId: null, costUsd: null, turns: null });
  });

  test("a round whose output would not parse keeps its session id", async () => {
    // This is the round most worth resuming by hand: the review happened, and
    // only the reading of it failed. Losing the id here would throw away the
    // one thing that could recover the work.
    const binPath = await fakeBinary(`echo '{"session_id":"sess-42","result":"I could not review this."}'`);

    const outcome = await claudeProvider.review(input({ binPath }));

    expect(outcome.status).toBe("failed");
    expect(outcome.error).toBe("could not parse provider output");
    expect(outcome.sessionId).toBe("sess-42");
  });

  test("spawns in the session directory it is given, and reports it back", async () => {
    // Both halves of the resume address: the id says which session, the
    // directory says where the CLI filed it.
    const dir = await fs.mkdtemp(join(os.tmpdir(), "lgtm-sessions-"));
    const probe = join(await fs.mkdtemp(join(os.tmpdir(), "lgtm-probe-")), "cwd.txt");
    const binPath = await fakeBinary(
      `pwd > "${probe}"\necho '{"session_id":"sess-1","result":"{\\"findings\\":[]}"}'`
    );

    const outcome = await claudeProvider.review(input({ binPath, sessionCwd: dir }));

    expect(outcome.status).toBe("ok");
    expect(outcome.sessionId).toBe("sess-1");
    // What the round file records, and where the CLI actually ran, have to be
    // the same directory or the resume command it prints is a lie.
    expect(outcome.sessionCwd).toBe(dir);
    const ranIn = (await fs.readFile(probe, "utf-8")).trim();
    expect(await fs.realpath(ranIn)).toBe(await fs.realpath(dir));
  });

  test("no session directory is no session directory, not an invented one", async () => {
    process.env.FAKE_CLAUDE_MODE = "json";

    expect((await claudeProvider.review(input())).sessionCwd).toBeNull();
  });

  test("a round that never got as far as spawning reports no session", async () => {
    const outcome = await claudeProvider.review(input({ binPath: "/nonexistent/claude" }));

    expect(outcome).toMatchObject({ sessionId: null, costUsd: null, turns: null });
  });
});

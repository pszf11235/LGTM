/**
 * Orchestrator logic. The spawning itself is covered by `lgtm smoke`, which
 * exercises the real process boundary in both source and compiled form.
 */

import { describe, test, expect } from "bun:test";
import { dedupeFindings, assignProviders, workerCommand } from "./orchestrator.js";
import type { RawFinding } from "./providers.js";
import { defaultAgentConfig, type AgentConfig } from "@lgtm/core/store/agents.js";
import type { ProviderStatus, ProviderId } from "@lgtm/core/ai/providers.js";

function statuses(available: ProviderId[]): ProviderStatus[] {
  return (["kiro-cli", "claude-cli", "codex-cli", "openrouter", "ollama"] as const).map((id) => ({
    id,
    available: available.includes(id),
    detail: available.includes(id) ? "ready" : "not configured",
    hasBuiltInReview: id === "claude-cli" || id === "codex-cli",
    fix: available.includes(id) ? "" : "configure it",
  }));
}

function agent(name: string, provider: AgentConfig["provider"]): AgentConfig {
  return { ...defaultAgentConfig(), name, provider };
}

function finding(over: Partial<RawFinding>): RawFinding {
  return { file: "src/a.ts", line: 1, severity: "high", comment: "boom", ...over };
}

// ─── dedupeFindings ─────────────────────────────────────────────────────────

describe("dedupeFindings", () => {
  test("collapses two agents reporting the same thing in the same place", () => {
    const out = dedupeFindings([
      finding({ comment: "Hardcoded API key here" }),
      finding({ comment: "Hardcoded API key here" }),
    ]);

    expect(out.length).toBe(1);
  });

  test("keeps findings on different lines of the same file", () => {
    const out = dedupeFindings([finding({ line: 1 }), finding({ line: 2 })]);
    expect(out.length).toBe(2);
  });

  test("keeps findings in different files on the same line", () => {
    const out = dedupeFindings([finding({ file: "a.ts" }), finding({ file: "b.ts" })]);
    expect(out.length).toBe(2);
  });

  test("ignores punctuation and case when comparing comments", () => {
    const out = dedupeFindings([
      finding({ comment: "Hardcoded API key. Move it." }),
      finding({ comment: "hardcoded api key  move it" }),
    ]);

    expect(out.length).toBe(1);
  });

  test("keeps the higher severity when two agents disagree", () => {
    const out = dedupeFindings([
      finding({ severity: "medium", comment: "same problem here" }),
      finding({ severity: "critical", comment: "same problem here" }),
    ]);

    expect(out.length).toBe(1);
    expect(out[0].severity).toBe("critical");
  });

  test("keeps two differently worded findings, since a duplicate beats a miss", () => {
    // Erring towards keeping both is deliberate: a duplicate comment is noise,
    // a dropped real finding is a bug that ships.
    const out = dedupeFindings([
      finding({ comment: "This key is hardcoded" }),
      finding({ comment: "Secret committed to the repo" }),
    ]);

    expect(out.length).toBe(2);
  });

  test("handles an empty list", () => {
    expect(dedupeFindings([])).toEqual([]);
  });
});

// ─── assignProviders ────────────────────────────────────────────────────────

describe("assignProviders", () => {
  test("honours a pinned provider", () => {
    const out = assignProviders([agent("a", "ollama")], statuses(["ollama", "claude-cli"]));

    expect(out[0].provider).toBe("ollama");
    expect(out[0].error).toBeNull();
  });

  test("errors on a pinned provider that is unavailable, without falling back", () => {
    const out = assignProviders([agent("a", "ollama")], statuses(["claude-cli"]));

    expect(out[0].provider).toBeNull();
    expect(out[0].error).toContain("ollama");
  });

  test("auto takes the highest priority available provider", () => {
    const out = assignProviders([agent("a", "auto")], statuses(["codex-cli", "ollama"]));

    expect(out[0].provider).toBe("codex-cli");
  });

  test("two auto agents get different providers, so the second adds an opinion", () => {
    // Detection runs once for the whole round. If both agents resolved
    // independently they would pick the same provider and produce two identical
    // reviews, which is worse than useless: it looks like corroboration.
    const out = assignProviders(
      [agent("a", "auto"), agent("b", "auto")],
      statuses(["claude-cli", "codex-cli"])
    );

    expect(out.map((o) => o.provider)).toEqual(["claude-cli", "codex-cli"]);
  });

  test("an auto agent avoids the provider another agent pinned", () => {
    const out = assignProviders(
      [agent("pinned", "claude-cli"), agent("auto", "auto")],
      statuses(["claude-cli", "codex-cli"])
    );

    expect(out[0].provider).toBe("claude-cli");
    expect(out[1].provider).toBe("codex-cli");
  });

  test("more auto agents than providers wraps around rather than failing", () => {
    const out = assignProviders(
      [agent("a", "auto"), agent("b", "auto"), agent("c", "auto")],
      statuses(["claude-cli", "codex-cli"])
    );

    expect(out.map((o) => o.provider)).toEqual(["claude-cli", "codex-cli", "claude-cli"]);
    expect(out.every((o) => o.error === null)).toBe(true);
  });

  test("falls back to a pinned provider when it is the only one available", () => {
    const out = assignProviders(
      [agent("pinned", "claude-cli"), agent("auto", "auto")],
      statuses(["claude-cli"])
    );

    expect(out[1].provider).toBe("claude-cli");
  });

  test("every auto agent errors when nothing is available, naming each provider", () => {
    const out = assignProviders([agent("a", "auto")], statuses([]));

    expect(out[0].provider).toBeNull();
    for (const id of ["kiro-cli", "claude-cli", "codex-cli", "openrouter", "ollama"]) {
      expect(out[0].error).toContain(id);
    }
  });
});

// ─── workerCommand ──────────────────────────────────────────────────────────

describe("workerCommand", () => {
  test("targets the hidden worker subcommand", () => {
    const cmd = workerCommand();

    expect(cmd.slice(-2)).toEqual(["review", "internal-worker"]);
    expect(cmd[0]).toBe(process.execPath);
  });

  test("does not point at whatever file started this process", () => {
    // Using process.argv[1] meant the orchestrator re-spawned its own caller
    // with the worker arguments appended. The caller ignored them, ran the
    // orchestrator again, and spawned itself again: a fork bomb. Under `bun
    // test` argv[1] is the test runner, so this asserts the entry is resolved
    // from the package layout instead.
    const cmd = workerCommand();

    expect(cmd).not.toContain(process.argv[1]);
    expect(cmd.some((part) => part.endsWith("orchestrator.test.ts"))).toBe(false);
  });

  test("resolves an entry that exists on disk when running from source", () => {
    const cmd = workerCommand();
    const script = cmd[1];

    // Only meaningful outside a compiled binary, which has no real entry path.
    if (!script.includes("$bunfs")) {
      expect(script.endsWith("index.ts")).toBe(true);
    }
  });
});

/**
 * Dispatch across the Provider seam. v1 has one Provider, so these tests are
 * mostly about what happens when an Agent file names something else: the
 * daemon has to keep polling every other repo when one Agent is misconfigured.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  DEFAULT_MODEL,
  DEFAULT_TIMEOUT_MINUTES,
  PROVIDER_IDS,
  defaultAgentConfig,
  resolveProvider,
  runReview,
  type AgentConfig,
} from "./index";

const SHIM = join(import.meta.dir, "../../test/fixtures/fake-claude.ts");

afterEach(() => {
  delete process.env.FAKE_CLAUDE_MODE;
});

describe("resolveProvider", () => {
  test("resolves the one Provider v1 ships", () => {
    expect(resolveProvider("claude-cli")?.id).toBe("claude-cli");
  });

  test("returns null for a Provider that does not exist", () => {
    // Silently reviewing with something other than what the agent file names
    // would be worse than recording a failed round.
    expect(resolveProvider("codex-cli")).toBeNull();
    expect(resolveProvider("")).toBeNull();
  });

  test("ships exactly one Provider, and the interface is the seam for the next", () => {
    expect([...PROVIDER_IDS]).toEqual(["claude-cli"]);
  });
});

describe("runReview", () => {
  test("dispatches to the Provider the Agent names", async () => {
    process.env.FAKE_CLAUDE_MODE = "json";

    const outcome = await runReview({
      agent: { ...defaultAgentConfig(), severityFloor: "low" },
      prUrl: "https://github.com/acme/api/pull/42",
      binPath: SHIM,
    });

    expect(outcome.status).toBe("ok");
    expect(outcome.findings).toHaveLength(2);
  });

  test("an unknown Provider fails the round by name, and never throws", async () => {
    const agent = { ...defaultAgentConfig(), provider: "codex-cli" } as unknown as AgentConfig;

    const outcome = await runReview({ agent, prUrl: "https://github.com/acme/api/pull/42" });

    expect(outcome.status).toBe("failed");
    expect(outcome.error).toContain("codex-cli");
    expect(outcome.findings).toEqual([]);
  });
});

describe("defaultAgentConfig", () => {
  test("pins a model rather than inheriting the session default", () => {
    expect(defaultAgentConfig().model).toBe(DEFAULT_MODEL);
    expect(DEFAULT_MODEL.trim()).not.toBe("");
  });

  test("carries the ten-minute round ceiling from the requirements", () => {
    expect(defaultAgentConfig().timeoutMinutes).toBe(DEFAULT_TIMEOUT_MINUTES);
    expect(DEFAULT_TIMEOUT_MINUTES).toBe(10);
  });
});

/**
 * Tests for agents.ts — the R3.2 agent-file loader.
 *
 * Three things matter most here, in order: a missing or malformed field
 * degrades to a documented default instead of throwing (a hand-edited file
 * must not take the daemon down), a non-positive timeout or an unknown
 * provider throws instead of degrading (those two must surface, not hide),
 * and nothing is cached across calls (R3.2's "no restart" promise).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { DEFAULT_MODEL, DEFAULT_SEVERITY_FLOOR, DEFAULT_TIMEOUT_MINUTES, defaultAgentConfig } from "@/provider";
import { createOKFStore } from "./okf.js";
import { loadAgent, loadEnabledAgents } from "./agents.js";
import { DEFAULT_AGENT_FRONTMATTER, DEFAULT_AGENT_NAME, DEFAULT_AGENT_PROMPT, initDefaultAgent } from "./defaults.js";

let lgtmDir: string;

beforeEach(async () => {
  lgtmDir = await fs.mkdtemp(path.join(os.tmpdir(), "lgtm-agents-store-"));
});

afterEach(async () => {
  await fs.rm(lgtmDir, { recursive: true, force: true });
});

function writeAgent(name: string, data: Record<string, unknown>, body = "Extra instructions."): Promise<void> {
  return createOKFStore(lgtmDir).write(path.join("agents", `${name}.md`), data, body);
}

describe("loadAgent — missing file", () => {
  test("falls back to defaultAgentConfig(name) entirely", async () => {
    const agent = await loadAgent(lgtmDir, "reviewer");
    expect(agent).toEqual(defaultAgentConfig("reviewer"));
  });

  test("the name in the fallback is the requested name, not the default's", async () => {
    const agent = await loadAgent(lgtmDir, "second-opinion");
    expect(agent.name).toBe("second-opinion");
    expect(agent.model).toBe(DEFAULT_MODEL);
  });
});

describe("loadAgent — a well-formed file", () => {
  test("maps every snake_case field onto AgentConfig, and the body onto prompt", async () => {
    await writeAgent(
      "reviewer",
      {
        provider: "claude-cli",
        model: "opus",
        timeout_minutes: 5,
        severity_floor: "medium",
        enabled: true,
      },
      "Be extra picky about auth code."
    );

    const agent = await loadAgent(lgtmDir, "reviewer");

    expect(agent).toEqual({
      name: "reviewer",
      provider: "claude-cli",
      model: "opus",
      severityFloor: "medium",
      timeoutMinutes: 5,
      enabled: true,
      prompt: "Be extra picky about auth code.",
    });
  });

  test("an empty body is a valid, empty prompt", async () => {
    await writeAgent("reviewer", { provider: "claude-cli" }, "");
    const agent = await loadAgent(lgtmDir, "reviewer");
    expect(agent.prompt).toBe("");
  });
});

describe("loadAgent — per-field leniency", () => {
  test("a missing model falls back to DEFAULT_MODEL", async () => {
    await writeAgent("reviewer", { provider: "claude-cli" });
    const agent = await loadAgent(lgtmDir, "reviewer");
    expect(agent.model).toBe(DEFAULT_MODEL);
  });

  test("an unrecognised severity_floor falls back to DEFAULT_SEVERITY_FLOOR", async () => {
    await writeAgent("reviewer", { severity_floor: "extreme" });
    const agent = await loadAgent(lgtmDir, "reviewer");
    expect(agent.severityFloor).toBe(DEFAULT_SEVERITY_FLOOR);
  });

  test("a missing timeout_minutes falls back to DEFAULT_TIMEOUT_MINUTES", async () => {
    await writeAgent("reviewer", { provider: "claude-cli" });
    const agent = await loadAgent(lgtmDir, "reviewer");
    expect(agent.timeoutMinutes).toBe(DEFAULT_TIMEOUT_MINUTES);
  });

  test("a non-numeric timeout_minutes string falls back rather than throwing", async () => {
    await writeAgent("reviewer", { timeout_minutes: "soon" });
    const agent = await loadAgent(lgtmDir, "reviewer");
    expect(agent.timeoutMinutes).toBe(DEFAULT_TIMEOUT_MINUTES);
  });

  test("a quoted numeric timeout_minutes string still parses", async () => {
    // Written by hand rather than through writeAgent(): the store's own
    // YAML writer never quotes a plain numeric string, so this is the only
    // way to exercise loadAgent's typeof-string branch for a value the
    // frontmatter parser hands back as a string rather than a number.
    const agentPath = path.join(lgtmDir, "agents", "reviewer.md");
    await fs.mkdir(path.dirname(agentPath), { recursive: true });
    await fs.writeFile(agentPath, '---\ntimeout_minutes: "7"\n---\nBody.\n', "utf-8");

    const agent = await loadAgent(lgtmDir, "reviewer");
    expect(agent.timeoutMinutes).toBe(7);
  });

  test("enabled defaults to true when absent", async () => {
    await writeAgent("reviewer", { provider: "claude-cli" });
    const agent = await loadAgent(lgtmDir, "reviewer");
    expect(agent.enabled).toBe(true);
  });

  test("enabled: false is honoured, not defaulted away", async () => {
    await writeAgent("reviewer", { enabled: false });
    const agent = await loadAgent(lgtmDir, "reviewer");
    expect(agent.enabled).toBe(false);
  });

  test("a blank model string falls back rather than shipping an empty model", async () => {
    await writeAgent("reviewer", { model: "" });
    const agent = await loadAgent(lgtmDir, "reviewer");
    expect(agent.model).toBe(DEFAULT_MODEL);
  });
});

describe("loadAgent — reject cases", () => {
  test("timeout_minutes: 0 throws instead of failing every Round silently", async () => {
    await writeAgent("reviewer", { timeout_minutes: 0 });
    await expect(loadAgent(lgtmDir, "reviewer")).rejects.toThrow(/timeout_minutes/);
  });

  test("a negative timeout_minutes throws", async () => {
    await writeAgent("reviewer", { timeout_minutes: -5 });
    await expect(loadAgent(lgtmDir, "reviewer")).rejects.toThrow(/timeout_minutes/);
  });

  test("an unknown provider throws by name, not a silent fallback to claude-cli", async () => {
    await writeAgent("reviewer", { provider: "codex-cli-typo" });
    await expect(loadAgent(lgtmDir, "reviewer")).rejects.toThrow(/codex-cli-typo/);
  });

  test("the reject error names the offending agent file", async () => {
    await writeAgent("second-opinion", { provider: "nope" });
    await expect(loadAgent(lgtmDir, "second-opinion")).rejects.toThrow(/second-opinion\.md/);
  });
});

describe("loadAgent — no restart, no cache", () => {
  test("a second call after a hand-edit reflects the new file, not the first read", async () => {
    await writeAgent("reviewer", { severity_floor: "low" }, "First prompt.");
    const before = await loadAgent(lgtmDir, "reviewer");
    expect(before.severityFloor).toBe("low");
    expect(before.prompt).toBe("First prompt.");

    await writeAgent("reviewer", { severity_floor: "critical" }, "Edited prompt.");
    const after = await loadAgent(lgtmDir, "reviewer");
    expect(after.severityFloor).toBe("critical");
    expect(after.prompt).toBe("Edited prompt.");
  });

  test("editing away a bad field un-breaks the next load without any restart", async () => {
    await writeAgent("reviewer", { timeout_minutes: 0 });
    await expect(loadAgent(lgtmDir, "reviewer")).rejects.toThrow();

    await writeAgent("reviewer", { timeout_minutes: 8 });
    const agent = await loadAgent(lgtmDir, "reviewer");
    expect(agent.timeoutMinutes).toBe(8);
  });
});

describe("loadEnabledAgents", () => {
  test("returns an empty array when the agents directory does not exist", async () => {
    expect(await loadEnabledAgents(lgtmDir)).toEqual([]);
  });

  test("the filename stem is the agent's name", async () => {
    await writeAgent("reviewer", {});
    const agents = await loadEnabledAgents(lgtmDir);
    expect(agents.map((a) => a.name)).toEqual(["reviewer"]);
  });

  test("excludes an agent whose enabled field is explicitly false", async () => {
    await writeAgent("reviewer", { enabled: true });
    await writeAgent("retired", { enabled: false });

    const agents = await loadEnabledAgents(lgtmDir);
    expect(agents.map((a) => a.name)).toEqual(["reviewer"]);
  });

  test("includes an agent whose enabled field is simply absent", async () => {
    await writeAgent("reviewer", {});
    const agents = await loadEnabledAgents(lgtmDir);
    expect(agents).toHaveLength(1);
  });

  test("sorts by name", async () => {
    await writeAgent("zeta", {});
    await writeAgent("alpha", {});

    const agents = await loadEnabledAgents(lgtmDir);
    expect(agents.map((a) => a.name)).toEqual(["alpha", "zeta"]);
  });

  test("a broken enabled agent throws rather than being silently dropped from the roster", async () => {
    await writeAgent("reviewer", {});
    await writeAgent("broken", { provider: "not-a-real-provider" });

    await expect(loadEnabledAgents(lgtmDir)).rejects.toThrow(/broken\.md/);
  });
});

describe("defaults.ts — the shipped agents/reviewer.md", () => {
  test("initDefaultAgent writes a file loadAgent can read back without throwing", async () => {
    await initDefaultAgent(lgtmDir);

    const agent = await loadAgent(lgtmDir, DEFAULT_AGENT_NAME);

    expect(agent.name).toBe(DEFAULT_AGENT_NAME);
    expect(agent.provider).toBe(DEFAULT_AGENT_FRONTMATTER.provider);
    expect(agent.model).toBe(DEFAULT_AGENT_FRONTMATTER.model);
    expect(agent.timeoutMinutes).toBe(DEFAULT_AGENT_FRONTMATTER.timeout_minutes);
    expect(agent.severityFloor).toBe(DEFAULT_AGENT_FRONTMATTER.severity_floor);
    expect(agent.enabled).toBe(true);
    expect(agent.prompt).toBe(DEFAULT_AGENT_PROMPT);
  });

  test("initDefaultAgent is idempotent: it never overwrites a hand-edited file", async () => {
    await initDefaultAgent(lgtmDir);
    await writeAgent(DEFAULT_AGENT_NAME, { severity_floor: "low" }, "My own prompt.");

    await initDefaultAgent(lgtmDir);

    const agent = await loadAgent(lgtmDir, DEFAULT_AGENT_NAME);
    expect(agent.severityFloor).toBe("low");
    expect(agent.prompt).toBe("My own prompt.");
  });

  test("the shipped default is enabled, so a fresh store reviews out of the box", async () => {
    await initDefaultAgent(lgtmDir);
    const agents = await loadEnabledAgents(lgtmDir);
    expect(agents.map((a) => a.name)).toEqual([DEFAULT_AGENT_NAME]);
  });
});

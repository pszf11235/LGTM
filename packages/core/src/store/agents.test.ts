/**
 * Agent config is the one file users are expected to hand-edit, so the parser
 * has to survive typos without taking every review down with it.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import fs from "fs";
import os from "os";
import path from "path";
import {
  loadAgentConfigs,
  loadEnabledAgents,
  ensureDefaultAgent,
  parseAgentFile,
  defaultAgentConfig,
  meetsSeverity,
  DEFAULT_AGENT_FILE,
} from "./agents.js";

let store: string;

function writeAgent(name: string, contents: string): string {
  const dir = path.join(store, "agents");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${name}.md`);
  fs.writeFileSync(file, contents, "utf-8");
  return file;
}

beforeEach(() => {
  store = fs.mkdtempSync(path.join(os.tmpdir(), "lgtm-agents-"));
});

afterEach(() => {
  try { fs.rmSync(store, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe("ensureDefaultAgent", () => {
  test("writes reviewer.md into an empty store", () => {
    expect(ensureDefaultAgent(store)).toBe(true);
    expect(fs.existsSync(path.join(store, "agents", "reviewer.md"))).toBe(true);
  });

  test("does not overwrite an existing agent", () => {
    writeAgent("mine", "---\nprovider: ollama\n---\n");

    expect(ensureDefaultAgent(store)).toBe(false);
    expect(fs.readdirSync(path.join(store, "agents"))).toEqual(["mine.md"]);
  });

  test("the file it writes parses back to the built-in defaults", () => {
    ensureDefaultAgent(store);

    const [agent] = loadAgentConfigs(store);
    const builtIn = defaultAgentConfig();

    expect(agent.name).toBe("reviewer");
    expect(agent.provider).toBe("auto");
    expect(agent.severity).toBe("high");
    expect(agent.timeout).toBe(300);
    expect(agent.enabled).toBe(true);
    expect(agent.prompt).toBe(builtIn.prompt);
  });
});

describe("loadAgentConfigs", () => {
  test("creates the default agent when the store has none", () => {
    const agents = loadAgentConfigs(store);

    expect(agents.length).toBe(1);
    expect(agents[0].name).toBe("reviewer");
  });

  test("loads several agents, which is how two reviewers run on one PR", () => {
    writeAgent("first", "---\nprovider: claude-cli\nprompt: one\n---\n");
    writeAgent("second", "---\nprovider: codex-cli\nprompt: two\n---\n");

    const agents = loadAgentConfigs(store);

    expect(agents.map((a) => a.name)).toEqual(["first", "second"]);
    expect(agents.map((a) => a.provider)).toEqual(["claude-cli", "codex-cli"]);
  });

  test("the filename wins over a conflicting name field", () => {
    // Two files both claiming name: reviewer would otherwise overwrite each
    // other's findings, since the round file is named r<N>-<agent>.md.
    writeAgent("alpha", "---\nname: reviewer\n---\n");
    writeAgent("beta", "---\nname: reviewer\n---\n");

    expect(loadAgentConfigs(store).map((a) => a.name)).toEqual(["alpha", "beta"]);
  });

  test("loadEnabledAgents drops disabled ones", () => {
    writeAgent("on", "---\nenabled: true\n---\n");
    writeAgent("off", "---\nenabled: false\n---\n");

    expect(loadAgentConfigs(store).length).toBe(2);
    expect(loadEnabledAgents(store).map((a) => a.name)).toEqual(["on"]);
  });
});

describe("parseAgentFile tolerates bad input", () => {
  test("an unknown provider falls back to auto rather than failing", () => {
    const agent = parseAgentFile("---\nprovider: gpt-9000\n---\n", "/x/a.md");
    expect(agent.provider).toBe("auto");
  });


  test("a non-positive timeout falls back to the default", () => {
    expect(parseAgentFile("---\ntimeout: 0\n---\n", "/x/a.md").timeout).toBe(300);
    expect(parseAgentFile("---\ntimeout: -5\n---\n", "/x/a.md").timeout).toBe(300);
    expect(parseAgentFile("---\ntimeout: abc\n---\n", "/x/a.md").timeout).toBe(300);
  });

  test("an empty prompt falls back to the built-in one", () => {
    const agent = parseAgentFile("---\nprompt: '   '\n---\n", "/x/a.md");
    expect(agent.prompt).toBe(defaultAgentConfig().prompt);
  });

  test("model is null unless a non-empty string is given", () => {
    expect(parseAgentFile("---\nmodel: null\n---\n", "/x/a.md").model).toBeNull();
    expect(parseAgentFile("---\nmodel: '  '\n---\n", "/x/a.md").model).toBeNull();
    expect(parseAgentFile("---\nmodel: qwen2.5-coder\n---\n", "/x/a.md").model).toBe("qwen2.5-coder");
  });

  test("a file with no frontmatter at all still yields a usable agent", () => {
    const agent = parseAgentFile("just some notes\n", "/x/scratch.md");

    expect(agent.name).toBe("scratch");
    expect(agent.provider).toBe("auto");
    expect(agent.prompt).toBe(defaultAgentConfig().prompt);
  });
});

describe("meetsSeverity", () => {
  test("keeps findings at or above the floor", () => {
    expect(meetsSeverity("critical", "high")).toBe(true);
    expect(meetsSeverity("high", "high")).toBe(true);
    expect(meetsSeverity("medium", "high")).toBe(false);
    expect(meetsSeverity("low", "low")).toBe(true);
  });
});

describe("DEFAULT_AGENT_FILE", () => {
  test("documents every provider the loader accepts", () => {
    // A provider missing from the table is a provider users will not know about.
    for (const id of ["kiro-cli", "claude-cli", "codex-cli", "openrouter", "ollama"]) {
      expect(DEFAULT_AGENT_FILE).toContain(id);
    }
  });
});

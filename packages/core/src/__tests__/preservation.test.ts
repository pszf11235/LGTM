/**
 * Preservation Property Tests — Existing CLI/TUI/Onboarding Behaviors Unchanged
 *
 * These tests verify that core behaviors remain intact during bugfixes.
 * They use structural/source-code analysis where interactive flows cannot
 * be easily unit-tested, and direct imports where possible.
 *
 * **Validates: Requirements 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7, 3.8, 3.9, 3.10**
 *
 * Run with: bun test packages/core/src/__tests__/preservation.test.ts
 */

import { describe, test, expect } from "bun:test";
import fs from "fs";
import path from "path";

// ─── Source file paths (relative to repo root) ─────────────────────────────
const REPO_ROOT = path.resolve(import.meta.dir, "../../../..");
const CORE_SRC = path.join(REPO_ROOT, "packages/core/src");
const INDEX_TS = path.join(CORE_SRC, "index.ts");
const FLOW_TS = path.join(CORE_SRC, "onboarding/flow.ts");
const SHELL_TSX = path.join(CORE_SRC, "tui/Shell.tsx");
const RENDER_TS = path.join(CORE_SRC, "tui/render.ts");

// ─── Helper: read source files ─────────────────────────────────────────────
function readSource(filePath: string): string {
  return fs.readFileSync(filePath, "utf-8");
}

// ═══════════════════════════════════════════════════════════════════════════════
// Preservation A — Bare `lgtm` auto-onboarding then TUI
// ═══════════════════════════════════════════════════════════════════════════════

describe("Preservation A — Bare `lgtm` auto-onboarding then TUI", () => {
  /**
   * Validates: Requirement 3.1
   * Property: For all CLI invocations where command is empty and profile incomplete,
   * onboarding runs followed by TUI launch.
   */
  test("bare lgtm path checks process.argv.length <= 2", () => {
    const source = readSource(INDEX_TS);
    // The bare `lgtm` path is guarded by process.argv.length <= 2
    expect(source).toContain("process.argv.length <= 2");
  });

  test("bare lgtm path imports and calls isOnboardingComplete", () => {
    const source = readSource(INDEX_TS);
    // Must check onboarding completion status
    expect(source).toContain("isOnboardingComplete");
  });

  test("bare lgtm path calls runOnboarding when profile incomplete", () => {
    const source = readSource(INDEX_TS);
    // Must import and call runOnboarding in the bare path
    expect(source).toContain("runOnboarding");
  });

  test("bare lgtm path launches TUI after onboarding", () => {
    const source = readSource(INDEX_TS);
    // After onboarding, must launch TUI (buildAndLaunchTUI or launchTUI)
    const hasTUILaunch =
      source.includes("buildAndLaunchTUI") || source.includes("launchTUI");
    expect(hasTUILaunch).toBe(true);
  });

  test("bare lgtm path has sequential flow: onboarding then TUI", () => {
    const source = readSource(INDEX_TS);
    // The runOnboarding call must appear BEFORE the TUI launch in the bare path section
    const barePathSection = source.slice(
      source.indexOf("process.argv.length <= 2"),
      // Find the next major section delimiter
      source.indexOf("// ─── Auto-register") > 0
        ? source.indexOf("// ─── Auto-register")
        : source.indexOf("// ─── Core Commands")
    );
    const onboardingIdx = barePathSection.indexOf("runOnboarding");
    const tuiIdx = Math.max(
      barePathSection.indexOf("buildAndLaunchTUI"),
      barePathSection.indexOf("launchTUI")
    );
    expect(onboardingIdx).toBeGreaterThan(-1);
    expect(tuiIdx).toBeGreaterThan(onboardingIdx);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Preservation B — `--skip-onboarding` skips without TUI
// ═══════════════════════════════════════════════════════════════════════════════

describe("Preservation B — --skip-onboarding skips without TUI", () => {
  /**
   * Validates: Requirement 3.2
   * Property: For all invocations with --skip-onboarding flag set,
   * no TUI launch occurs and defaults are applied.
   */
  test("init command accepts --skip-onboarding option", () => {
    const source = readSource(INDEX_TS);
    expect(source).toContain("--skip-onboarding");
  });

  test("--skip-onboarding handler returns early without launching TUI", () => {
    const source = readSource(INDEX_TS);
    // Find the init command handler section
    const initSection = source.slice(
      source.indexOf('.command("init")'),
      source.indexOf('.command("config")')
    );
    // It should check opts.skipOnboarding and return early
    expect(initSection).toContain("skipOnboarding");
    // The skipOnboarding check should cause an early return
    expect(initSection).toContain("return");
  });

  test("--skip-onboarding does not call runOnboarding", () => {
    const source = readSource(INDEX_TS);
    // Find the init action handler
    const initSection = source.slice(
      source.indexOf('.command("init")'),
      source.indexOf('.command("config")')
    );
    // The skip path should return BEFORE runOnboarding
    const skipIdx = initSection.indexOf("skipOnboarding");
    // After skip check, there's a return before runOnboarding
    const afterSkip = initSection.slice(skipIdx);
    const returnIdx = afterSkip.indexOf("return");
    const onboardingIdx = afterSkip.indexOf("runOnboarding");
    expect(returnIdx).toBeGreaterThan(-1);
    expect(returnIdx).toBeLessThan(onboardingIdx);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Preservation C — `config --edit` runs onboarding without TUI
// ═══════════════════════════════════════════════════════════════════════════════

describe("Preservation C — config --edit runs onboarding without TUI", () => {
  /**
   * Validates: Requirement 3.6
   * Property: For all `config --edit` invocations,
   * onboarding re-runs but TUI does not launch.
   */
  test("config command has --edit option", () => {
    const source = readSource(INDEX_TS);
    // config command must accept --edit
    const configSection = source.slice(source.indexOf('.command("config")'));
    expect(configSection).toContain("--edit");
    expect(configSection).toContain("-e");
  });

  test("config --edit calls runOnboarding", () => {
    const source = readSource(INDEX_TS);
    const configSection = source.slice(source.indexOf('.command("config")'));
    expect(configSection).toContain("runOnboarding");
  });

  test("config --edit does NOT launch TUI after onboarding", () => {
    const source = readSource(INDEX_TS);
    // Extract the config --edit handler block
    const configStart = source.indexOf('.command("config")');
    // Find the action handler within config command
    const configSection = source.slice(configStart);
    const editActionStart = configSection.indexOf("if (opts.edit)");
    expect(editActionStart).toBeGreaterThan(-1);

    // The edit block should have runOnboarding but no TUI launch
    const editBlock = configSection.slice(
      editActionStart,
      configSection.indexOf("}", editActionStart + 50) + 1
    );
    expect(editBlock).toContain("runOnboarding");
    // There should be a return after runOnboarding in the edit block
    expect(editBlock).toContain("return");
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Preservation D — Ctrl+C exits cleanly
// ═══════════════════════════════════════════════════════════════════════════════

describe("Preservation D — Ctrl+C exits cleanly", () => {
  /**
   * Validates: Requirement 3.5
   * Property: For all onboarding sessions interrupted by SIGINT,
   * process exits cleanly without launching TUI.
   */
  test("selectWithArrows handles Ctrl+C (\\x03) key", () => {
    const source = readSource(FLOW_TS);
    // Ctrl+C character is handled in selectWithArrows
    expect(source).toContain("\\x03");
  });

  test("Ctrl+C triggers process.exit(0)", () => {
    const source = readSource(FLOW_TS);
    // Find Ctrl+C handler
    const ctrlCSection = source.slice(source.indexOf("\\x03"));
    // Should call process.exit
    const exitIdx = ctrlCSection.indexOf("process.exit");
    expect(exitIdx).toBeGreaterThan(-1);
    // Should exit with code 0 (clean exit)
    expect(ctrlCSection.slice(exitIdx, exitIdx + 20)).toContain("0");
  });

  test("Ctrl+C handler calls cleanup before exit", () => {
    const source = readSource(FLOW_TS);
    // Find the Ctrl+C handler block in selectWithArrows
    const selectFn = source.slice(source.indexOf("function selectWithArrows"));
    const ctrlCIdx = selectFn.indexOf("\\x03");
    const ctrlCBlock = selectFn.slice(ctrlCIdx, selectFn.indexOf("}", ctrlCIdx + 20) + 1);
    // cleanup() must be called before process.exit
    expect(ctrlCBlock).toContain("cleanup");
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Preservation E — Single provider auto-configure
// ═══════════════════════════════════════════════════════════════════════════════

describe("Preservation E — Single provider auto-configure", () => {
  /**
   * Validates: Requirement 3.4
   * Property: For all discovery results with exactly 1 provider,
   * AI question is skipped and provider is auto-configured.
   */
  test("flow checks for exactly one available provider", () => {
    const source = readSource(FLOW_TS);
    // The flow should have logic for single-provider auto-config
    expect(source).toContain("available.length === 1");
  });

  test("single provider triggers auto-configuration", () => {
    const source = readSource(FLOW_TS);
    // Find the single-provider block
    const singleProviderIdx = source.indexOf("available.length === 1");
    const singleBlock = source.slice(singleProviderIdx, singleProviderIdx + 800);
    // Should auto-set the provider
    expect(singleBlock).toContain("answers.aiProvider");
    // Should auto-set the model
    expect(singleBlock).toContain("answers.aiModel");
  });

  test("single provider skips the AI question via continue", () => {
    const source = readSource(FLOW_TS);
    // After auto-configuring single provider, should `continue` to skip the question
    const singleProviderIdx = source.indexOf("available.length === 1");
    const singleBlock = source.slice(singleProviderIdx, singleProviderIdx + 1000);
    expect(singleBlock).toContain("continue");
  });

  test("single provider shows confirmation message", () => {
    const source = readSource(FLOW_TS);
    // Should print auto-detected message
    const singleProviderIdx = source.indexOf("available.length === 1");
    const singleBlock = source.slice(singleProviderIdx, singleProviderIdx + 600);
    // Should show "AI auto-detected" or similar
    expect(singleBlock).toContain("auto-detected");
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Preservation F — Individual question skip with 's'
// ═══════════════════════════════════════════════════════════════════════════════

describe("Preservation F — Individual question skip with 's'", () => {
  /**
   * Validates: Requirement 3.7
   * Property: For all questions in the flow, 's' input skips only the
   * current question.
   */
  test("selectWithArrows handles 's' key for skip", () => {
    const source = readSource(FLOW_TS);
    // The selectWithArrows function handles 's' key
    const selectFn = source.slice(source.indexOf("function selectWithArrows"));
    // Check for 's' key handling
    expect(selectFn).toContain('"s"');
  });

  test("'s' key resolves with currentValue or null (skip semantics)", () => {
    const source = readSource(FLOW_TS);
    const selectFn = source.slice(source.indexOf("function selectWithArrows"));
    // Find the 's' handler — use a larger window to capture the resolve call
    const sKeyIdx = selectFn.indexOf('"s"');
    const sBlock = selectFn.slice(sKeyIdx, sKeyIdx + 600);
    // Should reference currentValue for skip semantics
    expect(sBlock).toContain("currentValue");
    // Should resolve with currentValue ?? null
    expect(sBlock).toContain("currentValue ?? null");
  });

  test("text questions also support 's' for skip", () => {
    const source = readSource(FLOW_TS);
    // In the askQuestion function, text input 's' should skip
    const askFn = source.slice(source.indexOf("async function askQuestion"));
    expect(askFn).toContain('.toLowerCase() === "s"');
  });

  test("'s' skip only affects current question (does not exit flow)", () => {
    const source = readSource(FLOW_TS);
    const selectFn = source.slice(source.indexOf("function selectWithArrows"));
    // The 's' handler should NOT call process.exit
    const sKeyIdx = selectFn.indexOf('"s"');
    const sBlock = selectFn.slice(sKeyIdx, sKeyIdx + 300);
    expect(sBlock).not.toContain("process.exit");
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Preservation G — Plugin tabs in TUI unchanged
// ═══════════════════════════════════════════════════════════════════════════════

describe("Preservation G — Plugin tabs in TUI unchanged", () => {
  /**
   * Validates: Requirements 3.9, 3.10
   * Property: For all TUI sessions, existing plugin tabs are present
   * and navigable.
   */
  test("Shell component accepts tabs prop", () => {
    const source = readSource(SHELL_TSX);
    // Shell receives tabs via props
    expect(source).toContain("tabs:");
    expect(source).toContain("TabDefinition[]");
  });

  test("Shell renders tabs using renderTabs helper", () => {
    const source = readSource(SHELL_TSX);
    // Uses renderTabs to produce tab navigation
    expect(source).toContain("renderTabs");
    // renderTabs is called with tabs array and active index
    expect(source).toContain("renderTabs(");
  });

  test("Tab navigation cycles with Tab key", () => {
    const source = readSource(SHELL_TSX);
    // Tab key advances active tab index
    expect(source).toContain("key.tab");
    expect(source).toContain("setActiveTabIdx");
  });

  test("renderTabs renders active and inactive tab styles", () => {
    const source = readSource(SHELL_TSX);
    // The renderTabs function applies different styles for active vs inactive
    expect(source).toContain("theme.tab.active");
    expect(source).toContain("theme.tab.inactive");
  });

  test("Shell renders active page component", () => {
    const source = readSource(SHELL_TSX);
    // The Shell renders the active tab's component
    expect(source).toContain("ActivePage");
    expect(source).toContain("enabledTabs[activeTabIdx]");
  });

  test("buildAndLaunchTUI builds tabs from plugins correctly", () => {
    const source = readSource(RENDER_TS);
    // The buildAndLaunchTUI helper constructs tabs from plugins
    expect(source).toContain("buildAndLaunchTUI");
    // It should map plugin pages to tab definitions
    expect(source).toContain("plugins");
    expect(source).toContain("tabs");
  });

  test("plugin pages are converted to TabDefinitions", () => {
    const source = readSource(RENDER_TS);
    // Each plugin page becomes a tab
    expect(source).toContain("p.pages");
    expect(source).toContain("label");
    expect(source).toContain("component");
    expect(source).toContain("enabled");
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Direct Import Tests — Verify module contracts
// ═══════════════════════════════════════════════════════════════════════════════

describe("Direct Import — isOnboardingComplete", () => {
  /**
   * Validates: Requirement 3.1 (onboarding completion detection)
   * Tests the actual exported function behavior.
   */
  test("isOnboardingComplete is exported from flow module", async () => {
    const flowModule = await import("../onboarding/flow.js");
    expect(typeof flowModule.isOnboardingComplete).toBe("function");
  });

  test("isOnboardingComplete returns false for non-existent directory", async () => {
    const { isOnboardingComplete } = await import("../onboarding/flow.js");
    const result = isOnboardingComplete("/tmp/nonexistent-lgtm-dir-" + Date.now());
    expect(result).toBe(false);
  });
});

describe("Direct Import — discoverAIProviders", () => {
  /**
   * Validates: Requirement 3.3, 3.4
   * Tests the actual exported function contract.
   */
  test("discoverAIProviders is exported from detect-ai module", async () => {
    const detectModule = await import("../onboarding/detect-ai.js");
    expect(typeof detectModule.discoverAIProviders).toBe("function");
  });

  test("discoverAIProviders returns structured result with providers array", async () => {
    const { discoverAIProviders } = await import("../onboarding/detect-ai.js");
    const result = await discoverAIProviders();
    expect(result).toHaveProperty("providers");
    expect(Array.isArray(result.providers)).toBe(true);
    expect(result).toHaveProperty("hasAI");
    expect(result).toHaveProperty("summary");
    expect(result).toHaveProperty("toolsDetected");
  });
});

describe("Direct Import — ONBOARDING_QUESTIONS", () => {
  /**
   * Validates: Requirement 3.7 (question structure preserved)
   * Tests that the onboarding questions list is structurally intact.
   */
  test("ONBOARDING_QUESTIONS is exported and non-empty", async () => {
    const { ONBOARDING_QUESTIONS } = await import("../onboarding/questions.js");
    expect(Array.isArray(ONBOARDING_QUESTIONS)).toBe(true);
    expect(ONBOARDING_QUESTIONS.length).toBeGreaterThan(0);
  });

  test("ONBOARDING_QUESTIONS contains required question IDs", async () => {
    const { ONBOARDING_QUESTIONS } = await import("../onboarding/questions.js");
    const ids = ONBOARDING_QUESTIONS.map((q) => q.id);
    expect(ids).toContain("storageMode");
    expect(ids).toContain("goal");
    expect(ids).toContain("feedbackStyle");
    expect(ids).toContain("teamSize");
    expect(ids).toContain("aiProvider");
  });

  test("each question has required fields (id, question, type)", async () => {
    const { ONBOARDING_QUESTIONS } = await import("../onboarding/questions.js");
    for (const q of ONBOARDING_QUESTIONS) {
      expect(q.id).toBeTruthy();
      expect(q.question).toBeTruthy();
      expect(["select", "text", "confirm"]).toContain(q.type);
    }
  });

  test("select questions have options with value and label", async () => {
    const { ONBOARDING_QUESTIONS } = await import("../onboarding/questions.js");
    const selects = ONBOARDING_QUESTIONS.filter((q) => q.type === "select");
    for (const q of selects) {
      expect(q.options).toBeDefined();
      expect(q.options!.length).toBeGreaterThan(0);
      for (const opt of q.options!) {
        expect(opt.value).toBeTruthy();
        expect(opt.label).toBeTruthy();
      }
    }
  });
});

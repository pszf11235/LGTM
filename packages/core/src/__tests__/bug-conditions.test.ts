/**
 * Bug Condition Exploration Tests — Init Onboarding Five Defects
 *
 * **Validates: Requirements 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.7**
 *
 * These tests encode the EXPECTED (correct) behavior for each bug.
 * They are written BEFORE implementing fixes and are EXPECTED TO FAIL
 * on the unfixed codebase — failure confirms each bug exists.
 *
 * After the fixes are implemented, these same tests should PASS,
 * confirming the bugs have been resolved.
 *
 * Run with: bun test packages/core/src/__tests__/bug-conditions.test.ts
 */

import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import fs from "fs";
import path from "path";
import os from "os";

describe("Bug Condition Exploration Tests", () => {

  // ─────────────────────────────────────────────────────────────────────────
  // Bug 1 — No TUI Launch After Init
  //
  // Bug condition: isBugCondition_NoTUILaunch(X) = X.command = "init" AND X.onboardingCompleted = true
  // Expected behavior: After init completes, launchTUI() is called
  // ─────────────────────────────────────────────────────────────────────────
  describe("Bug 1: No TUI Launch After Init", () => {
    test("init command handler calls launchTUI after onboarding completes", async () => {
      // Read the source code of the init command handler and verify it contains
      // a call to launchTUI or buildAndLaunchTUI after runOnboarding resolves.
      // This is a structural test — we verify the code contains the expected call.
      const indexSource = fs.readFileSync(
        path.join(__dirname, "..", "index.ts"),
        "utf-8"
      );

      // Find the init command action block
      const initCommandIdx = indexSource.indexOf('.command("init")');
      expect(initCommandIdx).toBeGreaterThan(-1);

      // Find the next command registration after init (to bound the search)
      // Look for the next `program` or `.command(` after init's action
      const actionStart = indexSource.indexOf(".action(", initCommandIdx);
      expect(actionStart).toBeGreaterThan(-1);

      // Find the end of the init command section: the next top-level program/command declaration
      // or the next `// \`lgtm` comment marker
      const nextCommandMarker = indexSource.indexOf("// `lgtm config`", actionStart);
      const initSectionEnd = nextCommandMarker > actionStart ? nextCommandMarker : indexSource.length;

      const initActionSection = indexSource.slice(actionStart, initSectionEnd);

      // The init action handler should call launchTUI or buildAndLaunchTUI after runOnboarding
      // Bug condition: it currently does NOT — so this assertion will FAIL on unfixed code
      const hasLaunchTUI = initActionSection.includes("launchTUI") ||
                           initActionSection.includes("buildAndLaunchTUI");
      expect(hasLaunchTUI).toBe(true);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Bug 2 — No Feedback During Autodiscovery Wait
  //
  // Bug condition: isBugCondition_NoWaitFeedback(X) = X.currentQuestion = "aiProvider" AND X.aiDiscoveryComplete = false
  // Expected behavior: stdout contains spinner or "Detecting" text when discovery is slow
  // ─────────────────────────────────────────────────────────────────────────
  describe("Bug 2: No Feedback During Autodiscovery Wait", () => {
    test("flow.ts contains wait/spinner feedback before awaiting aiDiscoveryPromise", () => {
      // Read the flow source and check that there is a spinner or "Detecting"
      // indicator displayed before awaiting the discovery promise in the
      // aiProvider question handling section (not the skip-all defaults section)
      const flowSource = fs.readFileSync(
        path.join(__dirname, "..", "onboarding", "flow.ts"),
        "utf-8"
      );

      // Find where the aiProvider question handling block is
      // This is where the spinner should be shown when discovery is slow
      const aiProviderBlock = flowSource.indexOf('q.id === "aiProvider"');
      expect(aiProviderBlock).toBeGreaterThan(-1);

      // Find where aiDiscoveryPromise is awaited within the aiProvider block
      // Look for the await in the section after the aiProvider check
      const awaitIdx = flowSource.indexOf("await aiDiscoveryPromise", aiProviderBlock);
      expect(awaitIdx).toBeGreaterThan(-1);

      // Look for feedback text in the aiProvider section (between the check and the await)
      const aiProviderSection = flowSource.slice(aiProviderBlock, awaitIdx + 100);

      // Expected behavior: there should be some kind of feedback output
      // like "Detecting AI providers..." or a spinner character, or Promise.race for timeout
      const hasSpinnerOrFeedback =
        aiProviderSection.includes("Detecting") ||
        aiProviderSection.includes("spinner") ||
        aiProviderSection.includes("⏳") ||
        aiProviderSection.includes("waiting") ||
        aiProviderSection.includes("Promise.race");

      // Bug condition: this will FAIL because no spinner/feedback exists
      expect(hasSpinnerOrFeedback).toBe(true);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Bug 3 — Incomplete Agent Detection (Codex)
  //
  // Bug condition: isBugCondition_MissingAgent(X) = X.codexCLIInstalled AND X.codexAPIKeySet
  // Expected behavior: exists(p IN result.providers WHERE p.detectedVia CONTAINS "Codex")
  // ─────────────────────────────────────────────────────────────────────────
  describe("Bug 3: Incomplete Agent Detection (Codex)", () => {
    const originalEnv: Record<string, string | undefined> = {};

    beforeEach(() => {
      // Save original env vars
      originalEnv.CODEX_API_KEY = process.env.CODEX_API_KEY;
      originalEnv.OPENAI_API_KEY = process.env.OPENAI_API_KEY;
      originalEnv.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
      originalEnv.GEMINI_API_KEY = process.env.GEMINI_API_KEY;
      originalEnv.OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;

      // Clear all AI env vars to isolate this test
      delete process.env.OPENAI_API_KEY;
      delete process.env.ANTHROPIC_API_KEY;
      delete process.env.GEMINI_API_KEY;
      delete process.env.OPENROUTER_API_KEY;
    });

    afterEach(() => {
      // Restore original env vars
      for (const [key, value] of Object.entries(originalEnv)) {
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
    });

    test("CODEX_API_KEY registers a provider with detectedVia containing 'Codex'", async () => {
      // Set the Codex env var
      process.env.CODEX_API_KEY = "sk-test-codex-key";

      // Import and call the discovery function
      const { discoverAIProviders } = await import("../onboarding/detect-ai.js");
      const result = await discoverAIProviders();

      // Bug condition: Codex is only added to toolsDetected, NOT as a provider
      // Expected behavior: result.providers should have an entry with detectedVia containing "Codex"
      const codexProvider = result.providers.find(
        (p) => p.detectedVia.toLowerCase().includes("codex")
      );

      // This will FAIL — confirming the bug: Codex not registered as provider
      expect(codexProvider).toBeDefined();
      expect(codexProvider!.id).toBe("openai");
      expect(codexProvider!.apiKey).toBe("sk-test-codex-key");
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Bug 3b — Incomplete Agent Detection (Claude Code)
  //
  // Bug condition: Claude Code CLI installed but credentials not in expected paths
  // Expected behavior: Claude Code detected via expanded path detection
  // ─────────────────────────────────────────────────────────────────────────
  describe("Bug 3b: Incomplete Agent Detection (Claude Code)", () => {
    let tmpHome: string;
    const originalHome = os.homedir();
    const originalEnv: Record<string, string | undefined> = {};

    beforeEach(() => {
      // Create a temp home directory with a Claude Code config in the newer path
      tmpHome = path.join(os.tmpdir(), `lgtm-claude-test-${Date.now()}`);
      fs.mkdirSync(path.join(tmpHome, ".claude"), { recursive: true });

      // Save original env vars
      originalEnv.HOME = process.env.HOME;
      originalEnv.OPENAI_API_KEY = process.env.OPENAI_API_KEY;
      originalEnv.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
      originalEnv.GEMINI_API_KEY = process.env.GEMINI_API_KEY;
      originalEnv.OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
      originalEnv.CODEX_API_KEY = process.env.CODEX_API_KEY;

      // Clear all AI env vars to isolate this test
      delete process.env.OPENAI_API_KEY;
      delete process.env.ANTHROPIC_API_KEY;
      delete process.env.GEMINI_API_KEY;
      delete process.env.OPENROUTER_API_KEY;
      delete process.env.CODEX_API_KEY;

      // Set HOME to our temp dir so `os.homedir()` resolves to it
      process.env.HOME = tmpHome;
    });

    afterEach(() => {
      // Restore original env vars
      for (const [key, value] of Object.entries(originalEnv)) {
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
      // Cleanup temp directory
      try {
        fs.rmSync(tmpHome, { recursive: true, force: true });
      } catch { /* ignore */ }
    });

    test("Claude Code detected via config.json with claudeApiKey (newer path format)", async () => {
      // Write a Claude Code credential file in the newer format that isn't
      // one of the three hardcoded paths (credentials.json, .credentials, auth.json)
      const configPath = path.join(tmpHome, ".claude", "config.json");
      fs.writeFileSync(
        configPath,
        JSON.stringify({ claudeApiKey: "sk-ant-test-claude-code-key" })
      );

      // Import and call the discovery function
      // We need a fresh import since the module may cache os.homedir()
      const detectAiModule = await import("../onboarding/detect-ai.js");
      const result = await detectAiModule.discoverAIProviders();

      // Bug condition: The current code only checks for { apiKey }, { token }, { access_token }
      // in files named credentials.json, .credentials, auth.json
      // It does NOT check config.json or parse { claudeApiKey }
      const claudeProvider = result.providers.find(
        (p) => p.detectedVia.toLowerCase().includes("claude code") ||
               p.detectedVia.toLowerCase().includes("claude") && p.source === "cli-config"
      );

      // This will FAIL — confirming the bug: Claude Code not detected with newer path format
      expect(claudeProvider).toBeDefined();
      expect(claudeProvider!.id).toBe("anthropic");
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Bug 4 — No Skip Affordance
  //
  // Bug condition: isBugCondition_NoSkipAffordance(X) = X.command = "init" AND X.isInteractive = true AND X.skipAllOptionPresented = false
  // Expected behavior: stdout contains "q" or "Skip" option before first question
  // ─────────────────────────────────────────────────────────────────────────
  describe("Bug 4: No Skip Affordance", () => {
    test("onboarding flow presents a skip-all option (q or 'Skip setup') before first question", () => {
      // Read the flow source to check for skip-all affordance
      const flowSource = fs.readFileSync(
        path.join(__dirname, "..", "onboarding", "flow.ts"),
        "utf-8"
      );

      // The flow should present a "skip all" option before the question loop.
      // We look for text that indicates "press q to skip" or "Skip setup" in the 
      // section between the welcome message and the question loop start.
      
      // Find the welcome message section
      const welcomeIdx = flowSource.indexOf("Welcome to LGTM");
      expect(welcomeIdx).toBeGreaterThan(-1);

      // Find the question loop start (iterating over questions)
      const questionLoopIdx = flowSource.indexOf("for (const q of questionsToAsk)");
      expect(questionLoopIdx).toBeGreaterThan(-1);

      // Extract the section between welcome and question loop
      const preQuestionSection = flowSource.slice(welcomeIdx, questionLoopIdx);

      // Expected behavior: there should be a skip-all affordance presented
      // Look for patterns like "press [q]", "skip setup", "use defaults", "skip all"
      const hasSkipAffordance =
        preQuestionSection.toLowerCase().includes("skip setup") ||
        preQuestionSection.toLowerCase().includes("skip all") ||
        preQuestionSection.toLowerCase().includes("use defaults") ||
        preQuestionSection.includes("[q]") ||
        preQuestionSection.includes("press q");

      // Bug condition: this will FAIL — no skip-all option exists before first question
      expect(hasSkipAffordance).toBe(true);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Bug 5 — No AI Management Screen in TUI
  //
  // Bug condition: isBugCondition_NoAIManagement(X) = X.tuiRunning = true AND X.aiTabExists = false
  // Expected behavior: Shell renders an "AI" tab that is navigable
  // ─────────────────────────────────────────────────────────────────────────
  describe("Bug 5: No AI Management Screen in TUI", () => {
    test("Shell component receives an AI tab in the tabs array from index.ts setup", () => {
      // Read the index.ts source to check if an AI tab is registered
      // in the TUI tab building logic
      const indexSource = fs.readFileSync(
        path.join(__dirname, "..", "index.ts"),
        "utf-8"
      );

      // Find the bare `lgtm` path where tabs are built for TUI launch
      // (The section that builds tabs from plugins for launchTUI)
      const bareLgtmSection = indexSource.indexOf("process.argv.length <= 2");
      expect(bareLgtmSection).toBeGreaterThan(-1);

      // Extract the section from bare lgtm detection to the end of the bare lgtm block
      const launchTUICall = indexSource.indexOf("await launchTUI(", bareLgtmSection);
      expect(launchTUICall).toBeGreaterThan(-1);

      const tuiSetupSection = indexSource.slice(bareLgtmSection, launchTUICall + 200);

      // Expected behavior: an "AI" tab should be added to the tabs array
      // Look for references to an AI tab being pushed or included
      const hasAITab =
        tuiSetupSection.toLowerCase().includes("ai") &&
        (tuiSetupSection.includes("AITab") ||
         tuiSetupSection.includes("ai-tab") ||
         tuiSetupSection.includes('"ai"') ||
         tuiSetupSection.includes("'ai'") ||
         tuiSetupSection.includes("label: \"AI\"") ||
         tuiSetupSection.includes("label: 'AI'"));

      // Bug condition: this will FAIL — no AI tab is registered in the TUI
      expect(hasAITab).toBe(true);
    });

    test("AITab component file exists", () => {
      // The AI management tab component should exist as a file
      const aiTabPath = path.join(__dirname, "..", "tui", "AITab.tsx");
      const exists = fs.existsSync(aiTabPath);

      // Bug condition: this will FAIL — AITab.tsx doesn't exist yet
      expect(exists).toBe(true);
    });
  });
});

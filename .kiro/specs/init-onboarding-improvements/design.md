# Init Onboarding Improvements Bugfix Design

## Overview

The `lgtm init` onboarding flow has five defects that degrade user experience: (1) no automatic TUI launch after init completes, (2) no feedback during AI autodiscovery wait, (3) incomplete AI agent detection (Codex not registered as provider, Claude Code detection fragile), (4) no ability to skip init entirely from within the interactive flow, and (5) no AI management screen in the TUI. This design formalizes each bug condition, hypothesizes root causes based on code analysis, and plans targeted fixes that preserve all existing behaviors documented in the requirements.

## Glossary

- **Bug_Condition (C)**: The set of conditions that trigger one of the five defects — e.g., completing `lgtm init` without TUI launch, reaching AI question while discovery is pending, etc.
- **Property (P)**: The desired correct behavior when each bug condition holds — e.g., TUI launches after init, spinner shown during wait, agents properly detected, skip option presented, AI tab available
- **Preservation**: All existing CLI/TUI behaviors that must remain unchanged — bare `lgtm` auto-onboarding, `--skip-onboarding` flag, Ctrl+C exit, `config --edit` re-run, single-provider auto-configure, etc.
- **`runOnboarding()`**: The function in `packages/core/src/onboarding/flow.ts` that orchestrates the interactive onboarding question flow
- **`discoverAIProviders()`**: The function in `packages/core/src/onboarding/detect-ai.ts` that scans the system for available LLM providers
- **`launchTUI()`**: The function in `packages/core/src/tui/render.ts` that creates and renders the Ink application with Shell and plugin tabs
- **`Shell`**: The top-level Ink component in `packages/core/src/tui/Shell.tsx` that renders tabs, header, and status bar
- **OKF Store**: The Markdown + YAML frontmatter storage layer used for profile and config persistence

## Bug Details

### Bug Condition 1: No TUI Launch After Init

The `lgtm init` command in `src/index.ts` calls `runOnboarding()` and then returns without invoking `launchTUI()`. The bare `lgtm` path (no args) correctly chains onboarding → TUI, but the explicit `init` command does not.

**Formal Specification:**
```
FUNCTION isBugCondition_NoTUILaunch(input)
  INPUT: input of type CLIInvocation
  OUTPUT: boolean
  
  RETURN input.command = "init"
         AND input.skipOnboarding = false
         AND input.onboardingCompleted = true
END FUNCTION
```

### Bug Condition 2: No Feedback During AI Autodiscovery Wait

In `flow.ts`, `aiDiscoveryPromise` is started immediately but when the user reaches the `aiProvider` question, the `await aiDiscoveryPromise` blocks without any visual indicator. If discovery takes >2s (Ollama/LM Studio timeouts), the terminal appears frozen.

**Formal Specification:**
```
FUNCTION isBugCondition_NoWaitFeedback(input)
  INPUT: input of type OnboardingState
  OUTPUT: boolean
  
  RETURN input.currentQuestion = "aiProvider"
         AND input.aiDiscoveryPromise.state = "pending"
         AND input.elapsedSinceDiscoveryStart > 500ms
END FUNCTION
```

### Bug Condition 3: Incomplete AI Agent Detection

In `detect-ai.ts`, when `CODEX_API_KEY` env var is set, only `tools.push("Codex CLI")` is called — no `DetectedProvider` is added to the `providers` array. The Codex API key is never registered as a usable OpenAI-compatible provider. For Claude Code, detection relies on finding credential files in exactly three hardcoded paths (`credentials.json`, `.credentials`, `auth.json`) under `~/.claude/`, which doesn't match newer Claude Code versions that may use different storage.

**Formal Specification:**
```
FUNCTION isBugCondition_MissingAgent(input)
  INPUT: input of type SystemEnvironment
  OUTPUT: boolean
  
  RETURN (input.envVar["CODEX_API_KEY"] EXISTS AND input.envVar["CODEX_API_KEY"] != "")
         OR (input.claudeCodeBinaryOnPATH = true
             AND input.claudeCodeHasValidSession = true
             AND credentialFilesNotInExpectedPaths(input))
END FUNCTION
```

### Bug Condition 4: No Skip Affordance During Init

The `--skip-onboarding` flag exists on the `init` command but is only usable from the CLI. During the interactive flow, users can press 's' to skip individual questions but there is no "skip all and use defaults" option presented at the start. Users who just want to try the tool must either already know about `--skip-onboarding` or press Ctrl+C (which aborts without applying defaults).

**Formal Specification:**
```
FUNCTION isBugCondition_NoSkipAffordance(input)
  INPUT: input of type OnboardingState
  OUTPUT: boolean
  
  RETURN input.command = "init"
         AND input.isInteractive = true
         AND input.flowPhase = "pre-questions"
         AND input.skipAllOptionPresented = false
END FUNCTION
```

### Bug Condition 5: No AI Management Screen in TUI

The `Shell.tsx` displays AI status in the status bar (`AI: ✓ provider` or `AI: ✗ offline`) but provides no interactive tab/screen for managing AI configuration. Users must exit TUI and re-run `lgtm init` or `lgtm config --edit` to change providers or models.

**Formal Specification:**
```
FUNCTION isBugCondition_NoAIManagement(input)
  INPUT: input of type TUISession
  OUTPUT: boolean
  
  RETURN input.tuiRunning = true
         AND input.userAction IN {"changeProvider", "changeModel", "rediscoverProviders", "checkStatus"}
         AND input.aiTabExists = false
END FUNCTION
```

### Examples

- **Bug 1**: User runs `lgtm init`, answers all questions. System prints "You're all set! Run `lgtm --help` to get started." and exits. Expected: TUI launches automatically.
- **Bug 2**: User has Ollama installed but stopped. User answers storage/goal questions quickly (5s total). At the `aiProvider` question, the system silently blocks for 2s waiting for `checkOllama()` timeout. Expected: "Detecting AI providers..." spinner.
- **Bug 3**: User has `CODEX_API_KEY=sk-xxx` set. System shows "Codex CLI" in tools detected but does NOT register it as a provider. User must manually select OpenAI and paste the key again. Expected: Codex auto-registered as OpenAI provider with the existing key.
- **Bug 4**: User runs `lgtm init` for the first time, sees "Welcome to LGTM!" and the first question about storage mode. They just want to try the tool. Expected: Before the first question, a "Press q to skip setup and use defaults" option is shown.
- **Bug 5**: User is in TUI, notices AI is offline (status bar shows `AI: ✗ offline`). They want to switch providers. Must exit TUI, run `lgtm config --edit`. Expected: An "AI" tab in the TUI allows re-discovery, provider switching, model selection.

## Expected Behavior

### Preservation Requirements

**Unchanged Behaviors:**
- Bare `lgtm` (no args) continues to run onboarding if incomplete, then launches TUI (existing `index.ts` behavior)
- `lgtm init --skip-onboarding` continues to skip interactive questions and use defaults without launching TUI
- Ctrl+C during onboarding continues to exit gracefully without launching TUI or corrupting state
- `lgtm config --edit` continues to re-run onboarding questions only (no TUI auto-launch)
- When a single AI provider is auto-detected, it continues to be auto-configured and the AI question is skipped
- When no AI providers are detected, the manual provider selection question continues to appear
- Individual question skip with 's' continues to work for each question
- Profile persistence to OKF store continues unchanged
- All existing CLI commands (`lgtm smoke`, `lgtm ai`, `lgtm auth`, etc.) continue working
- Plugin tab rendering in TUI continues unchanged

**Scope:**
All inputs that do NOT match any of the five bug conditions should produce exactly the same behavior as before. This includes:
- All CLI commands other than `init` (without `--skip-onboarding`)
- All TUI interactions not related to AI management
- All onboarding questions after the user declines the skip option
- All `--skip-onboarding` invocations
- All `config --edit` invocations

## Hypothesized Root Cause

Based on code analysis of the source files:

1. **No TUI Launch After Init**: In `src/index.ts` lines 168-174, the `init` command action calls `runOnboarding()` and returns. The TUI launch logic (lines 48-100) only runs in the bare `lgtm` (no args) path. The `init` action handler was never wired to call `launchTUI()` after successful onboarding.

2. **No Feedback During Autodiscovery Wait**: In `flow.ts`, the `aiDiscoveryPromise` is started at the beginning of the question loop, but when the code reaches `const discovery = await aiDiscoveryPromise` (around the `aiProvider` question handling), there is a bare `await` with no spinner/progress indicator. The readline interface and raw-mode terminal handling make it non-trivial to show async indicators, so this was likely deferred and forgotten.

3. **Incomplete Agent Detection**: In `detect-ai.ts`, the `checkEnvVars()` function has a comment "// Codex (uses OPENAI_API_KEY)" and only adds to `tools` array, not `providers`. This appears intentional to avoid duplication with OPENAI_API_KEY detection, but `CODEX_API_KEY` is a separate env var that should be treated as its own OpenAI-compatible provider entry. For Claude Code, the credential paths are hardcoded to three specific filenames that don't cover all Claude Code versions (e.g., newer versions may use `~/.claude/config.json` or XDG-compliant paths).

4. **No Skip Affordance**: The `--skip-onboarding` flag was added to the CLI command but no equivalent in-flow affordance was implemented. The flow currently shows "Press [s] to skip any question" but there is no "skip all" option presented before questions begin. This was a design gap — the feature was only partially implemented.

5. **No AI Management Screen**: The TUI Shell has tab-based navigation with dynamically loaded plugin pages, and the status bar shows AI status, but no AI management tab/page was ever created. The `lgtm ai` CLI command exists for AI management from the command line, but its functionality was never ported to an interactive TUI page.

## Correctness Properties

Property 1: Bug Condition - TUI Launch After Init Completion

_For any_ CLI invocation where the command is `init`, `--skip-onboarding` is NOT set, and onboarding completes successfully, the fixed `init` command handler SHALL launch the TUI automatically after displaying the setup summary, using the same tab/plugin/aiStatus initialization as the bare `lgtm` path.

**Validates: Requirements 2.1**

Property 2: Bug Condition - Autodiscovery Wait Feedback

_For any_ onboarding state where the current question is `aiProvider` and the `aiDiscoveryPromise` has not yet resolved, the fixed flow SHALL display a spinner or "Detecting AI providers..." message that remains visible until discovery completes, preventing the appearance of a frozen terminal.

**Validates: Requirements 2.2**

Property 3: Bug Condition - Codex and Claude Code Agent Detection

_For any_ system environment where `CODEX_API_KEY` is set (non-empty), the fixed `discoverAIProviders()` SHALL register a `DetectedProvider` with `id: "openai"`, `detectedVia` containing "Codex", `apiKey` set to the env var value, and `defaultModel: "gpt-4o-mini"`. Additionally, _for any_ system where Claude Code CLI binary exists on PATH, the fixed detection SHALL use robust credential discovery (checking `~/.claude/config.json`, XDG config dirs, and `ANTHROPIC_CONFIG_DIR`) to detect it as an Anthropic provider.

**Validates: Requirements 2.3, 2.4, 2.5**

Property 4: Bug Condition - Skip Init Affordance

_For any_ interactive `lgtm init` invocation, the fixed flow SHALL present a prominent "Skip setup, use defaults" option (e.g., pressing 'q' or a clearly labeled menu item) BEFORE the first onboarding question. When selected, it SHALL apply sensible defaults for all settings (storageMode: "repo", goal: "production", feedbackStyle: "direct", teamSize: "solo", AI auto-detected or disabled) and proceed immediately without asking any questions.

**Validates: Requirements 2.6**

Property 5: Bug Condition - AI Management Screen in TUI

_For any_ TUI session, the fixed Shell SHALL include an "AI" tab accessible via standard tab navigation that allows the user to: trigger AI provider re-discovery, view all detected providers with connection status, select the active model, switch the active provider, and see real-time connection status. Changes SHALL be persisted to the profile.

**Validates: Requirements 2.7**

Property 6: Preservation - Unchanged Behaviors

_For any_ input where none of the five bug conditions hold (non-init commands, `--skip-onboarding` invocations, `config --edit` re-runs, bare `lgtm` with complete profile, Ctrl+C exits, individual question skips with 's'), the fixed code SHALL produce exactly the same behavior as the original code, preserving all existing CLI, onboarding, and TUI functionality.

**Validates: Requirements 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7, 3.8, 3.9, 3.10**

## Fix Implementation

### Changes Required

Assuming our root cause analysis is correct:

**File**: `packages/core/src/index.ts`

**Function**: `init` command action handler (line ~168)

**Specific Changes for Bug 1 (TUI Launch After Init)**:
1. **Add TUI launch after onboarding**: After `runOnboarding()` resolves in the `init` action, call `launchTUI()` with the same tab/plugin/aiStatus initialization used in the bare `lgtm` path
2. **Extract shared TUI launch logic**: Refactor the TUI launch code (lines 48-100) into a reusable `buildAndLaunchTUI(ctx, plugins)` helper to avoid duplication
3. **Respect `--skip-onboarding`**: When `--skip-onboarding` is set, do NOT launch TUI (preserves requirement 3.2)
4. **Respect `config --edit` context**: Add an `options.source` parameter to distinguish `init` from `config --edit`. Only launch TUI from `init` (preserves requirement 3.6)

---

**File**: `packages/core/src/onboarding/flow.ts`

**Function**: `runOnboarding()` — the `aiProvider` question handling block

**Specific Changes for Bug 2 (Autodiscovery Wait Feedback)**:
1. **Add spinner before await**: Before `const discovery = await aiDiscoveryPromise`, check if the promise is still pending. If so, write a "⏳ Detecting AI providers..." message to stdout
2. **Use `Promise.race` with timer**: Race the discovery promise against a 500ms timer. If the timer fires first, display the spinner message, then await the full discovery
3. **Clear spinner on resolve**: Once discovery completes, clear the spinner line and proceed with displaying results
4. **Implementation approach**: Use `process.stdout.write` with `\r` to overwrite the spinner line, compatible with the existing readline-based flow

---

**File**: `packages/core/src/onboarding/detect-ai.ts`

**Function**: `checkEnvVars()` and `checkClaudeCode()`

**Specific Changes for Bug 3 (Incomplete Agent Detection)**:
1. **Register Codex as provider**: In `checkEnvVars()`, when `CODEX_API_KEY` is set, push a full `DetectedProvider` with `id: "openai"`, `name: "Codex CLI (OpenAI)"`, `detectedVia: "CODEX_API_KEY env var"`, `apiKey: process.env.CODEX_API_KEY`, `defaultModel: "gpt-4o-mini"`. Use a distinct `detectedVia` to distinguish from plain `OPENAI_API_KEY`
2. **Avoid duplication with OPENAI_API_KEY**: If both `OPENAI_API_KEY` and `CODEX_API_KEY` are set and equal, only register once (prefer the OPENAI_API_KEY entry). If different, register both (deduplication by `id` will keep the first)
3. **Robust Claude Code detection**: Expand `checkClaudeCode()` credential paths to include:
   - `~/.claude/config.json` (newer versions)
   - `~/.config/claude/credentials.json` (XDG-compliant)
   - `~/.claude/settings.local.json`
   - Parse multiple JSON structures: `{ apiKey }`, `{ claudeApiKey }`, `{ oauth: { access_token } }`, `{ credentials: { apiKey } }`
4. **Claude Code session detection**: If credential file parsing fails, check if `claude --version` succeeds and the binary reports an authenticated session (some versions store credentials in OS keychain)

---

**File**: `packages/core/src/onboarding/flow.ts`

**Function**: `runOnboarding()` — before the question loop

**Specific Changes for Bug 4 (Skip Affordance)**:
1. **Add skip prompt before first question**: After printing the welcome message and before entering the question loop, present: "Press [q] to skip setup and use defaults, or [Enter] to continue"
2. **Implement skip logic**: If user presses 'q', apply sensible defaults:
   - `storageMode: "repo"`
   - `goal: "production"`
   - `feedbackStyle: "direct"`
   - `teamSize: "solo"`
   - AI: run autodiscovery, auto-configure if found, else disable
3. **Save and return**: Call `saveProgress()` with defaults applied, print a brief summary ("Using defaults. Run `lgtm config --edit` to customize."), and return the profile
4. **Only show on fresh start**: Only present the skip option when `existingProfile` is null (fresh start). Don't show when resuming or editing

---

**File**: `packages/core/src/tui/AITab.tsx` (new file)

**Specific Changes for Bug 5 (AI Management Screen)**:
1. **Create AITab component**: A new Ink component that renders the AI management interface with sections:
   - **Status**: Current provider, model, connection status (reachable/offline)
   - **Providers**: List of all detected providers with status indicators
   - **Actions**: Keyboard shortcuts for: [r] Re-discover providers, [s] Switch provider, [m] Change model, [t] Test connection
2. **Provider re-discovery**: Invoke `discoverAIProviders()` and update the display
3. **Provider switching**: Show a selection menu of available providers, update config/profile on selection
4. **Model selection**: Show model suggestions for current provider, accept text input for model name
5. **Persist changes**: Write updates to profile via OKF store, update the running config

**File**: `packages/core/src/tui/Shell.tsx`

**Specific Changes**:
1. **Accept AI tab**: Ensure the tab array can include the AI management tab
2. **Pass AI context**: Thread config/store references to the AI tab component via props or context

**File**: `packages/core/src/index.ts`

**Specific Changes**:
1. **Register AI tab**: Add the AI tab to the `tabs` array when building TUI tabs, alongside plugin-derived tabs. Position it after all plugin tabs.

## Testing Strategy

### Validation Approach

The testing strategy follows a two-phase approach: first, surface counterexamples that demonstrate each bug on unfixed code, then verify the fixes work correctly and preserve existing behavior.

### Exploratory Bug Condition Checking

**Goal**: Surface counterexamples that demonstrate the bugs BEFORE implementing fixes. Confirm or refute the root cause analysis.

**Test Plan**: Write unit tests using `bun:test` that exercise each bug condition against the unfixed code.

**Test Cases**:
1. **Init No TUI Test**: Call the `init` action handler, verify it returns without calling `launchTUI()` (will pass — confirming the bug exists)
2. **Autodiscovery Wait Test**: Mock `discoverAIProviders()` to take 3s, run onboarding flow programmatically, verify no spinner output occurs before the await (will confirm no feedback)
3. **Codex Detection Test**: Set `CODEX_API_KEY` env var, call `discoverAIProviders()`, verify no provider with `detectedVia` containing "Codex" exists in result (will confirm missing detection)
4. **Claude Code Robust Path Test**: Mock `~/.claude/config.json` with `{ claudeApiKey: "sk-ant-xxx" }`, call `checkClaudeCode()`, verify no provider detected (will confirm fragile detection)
5. **Skip Affordance Test**: Run `runOnboarding()` programmatically with stdin mock, verify no skip-all prompt appears before first question (will confirm missing affordance)
6. **AI Tab Test**: Render `Shell` with standard tabs, verify no "AI" tab exists in rendered output (will confirm missing tab)

**Expected Counterexamples**:
- `init` action handler has no call to `launchTUI`
- No stdout output containing "Detecting" or spinner chars before `aiProvider` question
- `discoverAIProviders()` result has empty provider for Codex despite `CODEX_API_KEY` being set
- No "q" or "Skip" prompt in onboarding flow output

### Fix Checking

**Goal**: Verify that for all inputs where each bug condition holds, the fixed functions produce the expected behavior.

**Pseudocode:**
```
// Bug 1: TUI launch
FOR ALL input WHERE isBugCondition_NoTUILaunch(input) DO
  result := lgtmInit_fixed(input)
  ASSERT result.tuiLaunched = true
  ASSERT result.tabsInitialized = true
END FOR

// Bug 2: Wait feedback
FOR ALL input WHERE isBugCondition_NoWaitFeedback(input) DO
  result := showAIQuestion_fixed(input)
  ASSERT result.spinnerDisplayed = true
  ASSERT result.spinnerClearedAfterResolve = true
END FOR

// Bug 3: Agent detection
FOR ALL input WHERE isBugCondition_MissingAgent(input) DO
  result := discoverAIProviders_fixed(input)
  ASSERT (input.codexAPIKeySet) IMPLIES
         EXISTS p IN result.providers WHERE p.detectedVia CONTAINS "Codex"
  ASSERT (input.claudeCodeInstalled AND input.hasCredentials) IMPLIES
         EXISTS p IN result.providers WHERE p.detectedVia CONTAINS "Claude"
END FOR

// Bug 4: Skip affordance
FOR ALL input WHERE isBugCondition_NoSkipAffordance(input) DO
  result := runOnboarding_fixed(input)
  ASSERT result.skipOptionPresented = true
  ASSERT (input.userPressedQ) IMPLIES result.defaultsApplied = true
END FOR

// Bug 5: AI management
FOR ALL input WHERE isBugCondition_NoAIManagement(input) DO
  result := tuiWithAITab_fixed(input)
  ASSERT result.aiTabExists = true
  ASSERT result.aiTabFunctional = true
END FOR
```

### Preservation Checking

**Goal**: Verify that for all inputs where none of the bug conditions hold, the fixed functions produce the same result as the original functions.

**Pseudocode:**
```
FOR ALL input WHERE NOT (isBugCondition_NoTUILaunch(input)
                     OR isBugCondition_NoWaitFeedback(input)
                     OR isBugCondition_MissingAgent(input)
                     OR isBugCondition_NoSkipAffordance(input)
                     OR isBugCondition_NoAIManagement(input)) DO
  ASSERT F_original(input) = F_fixed(input)
END FOR
```

**Testing Approach**: Property-based testing is recommended for preservation checking because:
- It generates many random CLI invocation configurations automatically
- It catches edge cases in config loading, profile parsing, and question flow
- It provides strong guarantees that non-bugfix paths are unchanged

**Test Plan**: Observe behavior on UNFIXED code first for non-buggy inputs, then write property-based tests capturing that behavior.

**Test Cases**:
1. **Bare `lgtm` Preservation**: Verify that bare `lgtm` with complete profile still launches TUI directly (no re-onboarding)
2. **`--skip-onboarding` Preservation**: Verify that `--skip-onboarding` flag still skips without launching TUI
3. **`config --edit` Preservation**: Verify that `config --edit` still runs onboarding without launching TUI afterward
4. **Ctrl+C Preservation**: Verify that Ctrl+C during onboarding still exits cleanly without TUI launch
5. **Single Provider Auto-Configure Preservation**: Verify that single detected provider is still auto-configured without asking
6. **Individual Skip Preservation**: Verify that pressing 's' on individual questions still skips just that question
7. **Plugin Tab Preservation**: Verify that existing plugin tabs (review, specify, learn) continue rendering correctly

### Unit Tests

- Test `buildAndLaunchTUI()` helper initializes tabs/aiStatus correctly
- Test spinner display/clear lifecycle during AI discovery wait
- Test `checkEnvVars()` registers Codex as provider when `CODEX_API_KEY` is set
- Test `checkClaudeCode()` finds credentials in expanded path list
- Test deduplication when both `OPENAI_API_KEY` and `CODEX_API_KEY` are set
- Test skip option presentation and default application logic
- Test `AITab` component renders provider list, status, and action shortcuts
- Test `AITab` persists provider/model changes to profile

### Property-Based Tests

- Generate random environment variable combinations and verify `discoverAIProviders()` always registers Codex when `CODEX_API_KEY` is present
- Generate random onboarding answer sequences and verify that 'q' at the skip prompt always produces valid defaults
- Generate random provider lists and verify AITab always shows all providers with correct status
- Generate random CLI invocation configs and verify preservation: non-init commands produce unchanged behavior

### Integration Tests

- Test full `lgtm init` flow end-to-end: fresh start → skip with 'q' → defaults applied → TUI launches
- Test full `lgtm init` flow end-to-end: answer all questions → summary shown → TUI launches
- Test AI discovery with mocked slow provider → spinner appears → resolves → results shown
- Test TUI with AI tab: navigate to AI tab → trigger re-discovery → switch provider → verify persistence
- Test `lgtm init` then Ctrl+C at skip prompt → clean exit, no TUI, no partial state

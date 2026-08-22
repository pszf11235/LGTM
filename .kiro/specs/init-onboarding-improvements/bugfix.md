# Bugfix Requirements Document

## Introduction

The `lgtm init` onboarding flow has five defects that degrade the user experience:

1. **No TUI launch after init** — After `lgtm init` completes, it prints a summary message and exits. The user must manually run `lgtm` again to start the TUI. It should automatically launch the TUI upon successful completion so users can immediately begin reviewing.

2. **AI autodiscovery race condition** — The AI provider autodiscovery runs as a background promise (`aiDiscoveryPromise`) that starts while the user answers early questions. If the user reaches the `aiProvider` question before discovery finishes, the `await` will block — but if discovery finishes with no results yet when control flow reaches it, it may not wait adequately. More critically, if autodiscovery is slow (e.g., pinging local servers with 2s timeouts), the flow should show a clear "waiting for AI detection..." indicator rather than appearing frozen.

3. **Incomplete AI agent detection** — The autodiscovery currently only adds "Codex CLI" to the `toolsDetected` array when `CODEX_API_KEY` env var exists, but it does NOT register Codex as a proper provider with credentials. Similarly, Claude Code CLI detection exists but is fragile (checks specific credential file paths that may not match current Claude Code versions). The system should robustly detect multiple AI coding agents (at minimum Claude Code and Codex CLI) as distinct available providers.

4. **No ability to skip init entirely** — The `--skip-onboarding` flag exists but is not discoverable during the interactive init flow itself. Users who want to skip setup and use sensible defaults must already know about the CLI flag. There is no prominent "skip" affordance (e.g., pressing 'q' or a "Skip setup, use defaults" option) presented at the start of the interactive onboarding, forcing users to sit through multiple questions even if they just want to try the tool immediately.

5. **No AI management screen in the TUI** — After init is complete, there is no way to manage AI provider settings from within the TUI. Users must re-run `lgtm init` or `lgtm config --edit` to change AI configuration. The TUI Shell already displays AI status in the status bar (available/offline + provider name) but provides no interactive screen to re-discover providers, view their connection status, switch the active model, or change the provider without leaving the TUI.

## Bug Analysis

### Current Behavior (Defect)

1.1 WHEN the user runs `lgtm init` and completes all onboarding questions THEN the system prints a summary and exits without launching the TUI

1.2 WHEN AI autodiscovery takes longer than expected (e.g., network timeouts on localhost pings) and the user reaches the AI provider question THEN the system appears to freeze with no feedback indicating it is waiting for detection to complete

1.3 WHEN the Codex CLI is installed and `CODEX_API_KEY` is set THEN the system only notes "Codex CLI" in `toolsDetected` but does not register it as a usable AI provider with credentials

1.4 WHEN Claude Code CLI is installed (`claude` binary exists) but its credential files are not in the exact expected paths (`credentials.json`, `.credentials`, or `auth.json` under `~/.claude/`) THEN the system fails to detect Claude Code as an available provider

1.5 WHEN multiple AI coding agents are installed (e.g., both Claude Code and Codex) THEN the system may only detect one or neither as a proper provider, preventing the user from seeing and selecting among all available options

1.6 WHEN the user runs `lgtm init` and does not want to answer onboarding questions THEN the system provides no prominent skip affordance during the interactive flow itself, requiring the user to already know about `--skip-onboarding` or press Ctrl+C (which aborts without applying defaults)

1.7 WHEN the user is in the TUI and wants to change AI provider settings (e.g., switch model, re-discover providers, check connection status) THEN the system provides no management screen or tab for AI configuration, requiring the user to exit the TUI and re-run `lgtm init` or `lgtm config --edit`

### Expected Behavior (Correct)

2.1 WHEN the user runs `lgtm init` and completes all onboarding questions THEN the system SHALL launch the TUI automatically after displaying the setup summary

2.2 WHEN AI autodiscovery is still in progress and the user reaches the AI provider question THEN the system SHALL display a spinner or "Detecting AI providers..." message while waiting for discovery to complete

2.3 WHEN the Codex CLI is installed and `CODEX_API_KEY` is set THEN the system SHALL register Codex as a proper AI provider (mapped to the OpenAI provider backend) with its API key and a sensible default model

2.4 WHEN Claude Code CLI is installed (`claude` binary exists on PATH) THEN the system SHALL detect it as an available Anthropic provider using robust credential discovery (checking current Claude Code credential storage conventions)

2.5 WHEN multiple AI coding agents are installed (e.g., both Claude Code and Codex) THEN the system SHALL detect all of them and present them as distinct selectable providers during onboarding

2.6 WHEN the user runs `lgtm init` and the interactive onboarding begins THEN the system SHALL present a prominent "Skip setup, use defaults" option (e.g., pressing 'q' or a clearly labeled menu item) before the first question, which applies sensible defaults for all settings and proceeds immediately

2.7 WHEN the user is in the TUI THEN the system SHALL provide an "AI" tab/screen accessible via the standard tab navigation that allows the user to:
- Trigger AI provider re-discovery manually
- View all detected providers with their connection status (reachable/offline)
- Select the active model from a list of available models for the current provider
- Switch the active provider without re-running full init
- See real-time connection status for the active provider

### Unchanged Behavior (Regression Prevention)

3.1 WHEN the user runs bare `lgtm` (no args) and onboarding is not complete THEN the system SHALL CONTINUE TO run onboarding first, then launch the TUI (existing behavior in index.ts)

3.2 WHEN the user runs `lgtm init --skip-onboarding` THEN the system SHALL CONTINUE TO skip interactive questions and use defaults without launching TUI

3.3 WHEN no AI providers are detected (no env vars, no CLI tools, no local servers) THEN the system SHALL CONTINUE TO show the manual provider selection question and allow the user to choose "None"

3.4 WHEN a single AI provider is auto-detected THEN the system SHALL CONTINUE TO auto-configure it and skip the AI provider question (existing fast-path behavior)

3.5 WHEN the user presses Ctrl+C during onboarding THEN the system SHALL CONTINUE TO exit gracefully without launching TUI or corrupting partial state

3.6 WHEN `lgtm config --edit` is used to re-run onboarding THEN the system SHALL CONTINUE TO only re-run the onboarding questions without automatically launching TUI afterward

3.7 WHEN the user does not press 'q' or select "Skip setup, use defaults" during init THEN the system SHALL CONTINUE TO present all onboarding questions in the existing sequential order with skip-per-question ('s') support

3.8 WHEN the user skips init with defaults THEN the system SHALL CONTINUE TO allow later reconfiguration via `lgtm config --edit` or the TUI AI management screen

3.9 WHEN the user is in the TUI AI management screen and changes the active provider or model THEN the system SHALL CONTINUE TO persist those changes to the profile (profile.md) so they survive TUI restarts

3.10 WHEN the TUI launches without AI configured (provider = "none") THEN the system SHALL CONTINUE TO function normally for non-AI features (manual review, specify, learn tabs) and the AI tab SHALL show a helpful "No provider configured" state with a prompt to run detection

---

## Bug Condition (Formal)

### Bug Condition 1: No TUI Launch After Init

```pascal
FUNCTION isBugCondition_NoTUILaunch(X)
  INPUT: X of type CLIInvocation
  OUTPUT: boolean
  
  // Returns true when lgtm init completes successfully
  RETURN X.command = "init" AND X.onboardingCompleted = true
END FUNCTION
```

```pascal
// Property: Fix Checking — TUI Launch After Init
FOR ALL X WHERE isBugCondition_NoTUILaunch(X) DO
  result ← lgtmInit'(X)
  ASSERT result.tuiLaunched = true
END FOR
```

### Bug Condition 2: No Feedback During Autodiscovery Wait

```pascal
FUNCTION isBugCondition_NoWaitFeedback(X)
  INPUT: X of type OnboardingState
  OUTPUT: boolean
  
  // Returns true when user reaches AI question while discovery is pending
  RETURN X.currentQuestion = "aiProvider" AND X.aiDiscoveryComplete = false
END FUNCTION
```

```pascal
// Property: Fix Checking — Wait Feedback
FOR ALL X WHERE isBugCondition_NoWaitFeedback(X) DO
  result ← showAIQuestion'(X)
  ASSERT result.displayedWaitIndicator = true AND result.awaitedDiscovery = true
END FOR
```

### Bug Condition 3: Incomplete Agent Detection

```pascal
FUNCTION isBugCondition_MissingAgent(X)
  INPUT: X of type SystemEnvironment
  OUTPUT: boolean
  
  // Returns true when Codex or Claude Code is installed but not detected as provider
  RETURN (X.codexCLIInstalled AND X.codexAPIKeySet) OR
         (X.claudeCodeCLIInstalled AND X.hasClaudeCredentials)
END FUNCTION
```

```pascal
// Property: Fix Checking — Agent Detection
FOR ALL X WHERE isBugCondition_MissingAgent(X) DO
  result ← discoverAIProviders'(X)
  ASSERT (X.codexCLIInstalled AND X.codexAPIKeySet) IMPLIES 
         exists(p IN result.providers WHERE p.detectedVia CONTAINS "Codex")
  ASSERT (X.claudeCodeCLIInstalled AND X.hasClaudeCredentials) IMPLIES
         exists(p IN result.providers WHERE p.detectedVia CONTAINS "Claude Code")
END FOR
```

### Bug Condition 4: No Skip Affordance During Init

```pascal
FUNCTION isBugCondition_NoSkipAffordance(X)
  INPUT: X of type OnboardingState
  OUTPUT: boolean
  
  // Returns true when user is in interactive init and wants to skip all questions
  RETURN X.command = "init" AND X.isInteractive = true AND X.userWantsToSkipAll = true
END FUNCTION
```

```pascal
// Property: Fix Checking — Skip Init Affordance
FOR ALL X WHERE isBugCondition_NoSkipAffordance(X) DO
  result ← lgtmInit'(X)
  ASSERT result.skipOptionPresented = true
  ASSERT result.defaultsApplied = true
  ASSERT result.onboardingQuestionsAsked = 0
END FOR
```

### Bug Condition 5: No AI Management Screen in TUI

```pascal
FUNCTION isBugCondition_NoAIManagement(X)
  INPUT: X of type TUISession
  OUTPUT: boolean
  
  // Returns true when user is in TUI and wants to manage AI settings
  RETURN X.tuiRunning = true AND X.userAction IN {"changeProvider", "changeModel", "rediscoverProviders", "checkStatus"}
END FUNCTION
```

```pascal
// Property: Fix Checking — AI Management Screen
FOR ALL X WHERE isBugCondition_NoAIManagement(X) DO
  result ← tuiAIManagement'(X)
  ASSERT result.aiTabAvailable = true
  ASSERT (X.userAction = "rediscoverProviders") IMPLIES result.discoveryTriggered = true
  ASSERT (X.userAction = "changeProvider") IMPLIES result.providerChanged = true
  ASSERT (X.userAction = "changeModel") IMPLIES result.modelChanged = true
  ASSERT (X.userAction = "checkStatus") IMPLIES result.statusDisplayed = true
  ASSERT result.changesPersisted = true
END FOR
```

### Preservation Property

```pascal
// Property: Preservation Checking
FOR ALL X WHERE NOT (isBugCondition_NoTUILaunch(X) OR isBugCondition_NoWaitFeedback(X) OR isBugCondition_MissingAgent(X) OR isBugCondition_NoSkipAffordance(X) OR isBugCondition_NoAIManagement(X)) DO
  ASSERT F(X) = F'(X)
END FOR
```

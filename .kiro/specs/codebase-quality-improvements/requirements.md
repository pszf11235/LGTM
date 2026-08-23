# Requirements Document

## Introduction

This document defines requirements for a comprehensive quality improvement effort across the LGTM codebase. The effort spans three phases: (1) architecture and code quality refactoring to reduce file complexity and improve modularity, (2) testing infrastructure to improve reliability and confidence, and (3) TUI UX improvements for a more polished and consistent terminal experience. The tech stack is Bun, TypeScript strict, Ink (React for terminals), OKF storage, and bun:test.

## Glossary

- **CLI_Entry**: The main CLI entry point module (`packages/core/src/index.ts`) responsible for bootstrapping commands and launching the TUI.
- **Onboarding_Orchestrator**: The module (`packages/core/src/onboarding/flow.ts`) that coordinates the interactive onboarding flow, prompt rendering, profile building, and AI configuration.
- **AI_Discovery_Engine**: The module (`packages/core/src/onboarding/detect-ai.ts`) responsible for scanning the system for available AI/LLM providers.
- **TUI_Shell**: The top-level Ink component that renders the header, tab navigation, page content, and status bar.
- **OKF_Store**: The Open Knowledge Format storage layer that persists data as Markdown files with YAML frontmatter.
- **LGTMContext**: The context object providing plugins access to core services (store, LLM, config, logger).
- **Event_Bus**: A publish/subscribe messaging system for decoupled communication between TUI components.
- **Credential_Manager**: A unified module responsible for all API key resolution, storage, and retrieval operations.
- **Terminal_Abstraction**: A module encapsulating all raw stdout/stdin operations (cursor movement, raw mode, ANSI escape sequences).
- **Webapp_Server**: The embedded HTTP server that serves a web-based interface alongside the TUI.
- **Ink_Testing_Library**: A testing utility for rendering and asserting Ink (React TUI) components in isolation.
- **Spinner_Component**: A shared React component displaying a rotating braille-dot animation for loading states.
- **Help_Overlay**: A modal-style overlay displaying keyboard shortcuts relevant to the currently active tab.

## Requirements

### Requirement 1: CLI Entry Point Decomposition

**User Story:** As a developer, I want the CLI entry point split into focused command modules, so that each command is independently maintainable and the main file remains a thin orchestrator.

#### Acceptance Criteria

1. THE CLI_Entry SHALL delegate init command handling to a dedicated `commands/init.ts` module.
2. THE CLI_Entry SHALL delegate config command handling to a dedicated `commands/config.ts` module.
3. THE CLI_Entry SHALL delegate plugins command handling to a dedicated `commands/plugins.ts` module.
4. THE CLI_Entry SHALL delegate TUI launch logic to a dedicated `commands/tui.ts` module.
5. WHEN the CLI_Entry bootstraps, THE CLI_Entry SHALL contain fewer than 80 lines of orchestration logic excluding imports.
6. THE CLI_Entry SHALL preserve all existing command behavior after decomposition.

### Requirement 2: Onboarding Flow Decomposition

**User Story:** As a developer, I want the onboarding flow split into focused modules, so that prompt UI logic, profile construction, and AI configuration are independently testable.

#### Acceptance Criteria

1. THE Onboarding_Orchestrator SHALL delegate all interactive prompt rendering to a `prompt-ui.ts` module.
2. THE Onboarding_Orchestrator SHALL delegate profile data assembly to a `profile-builder.ts` module.
3. THE Onboarding_Orchestrator SHALL delegate AI provider configuration logic to an `ai-config.ts` module.
4. THE Onboarding_Orchestrator SHALL serve as a thin orchestrator coordinating the three extracted modules.
5. WHEN the onboarding flow completes, THE Onboarding_Orchestrator SHALL produce the same profile.md output as the pre-refactor implementation.

### Requirement 3: AI Discovery Engine Decomposition

**User Story:** As a developer, I want the AI discovery engine split into per-source detector files, so that each detection strategy is isolated and new providers can be added without modifying a monolithic file.

#### Acceptance Criteria

1. THE AI_Discovery_Engine SHALL delegate environment variable scanning to a `detectors/env-vars.ts` module.
2. THE AI_Discovery_Engine SHALL delegate Claude Code credential detection to a `detectors/claude-code.ts` module.
3. THE AI_Discovery_Engine SHALL delegate Ollama detection to a `detectors/ollama.ts` module.
4. THE AI_Discovery_Engine SHALL delegate LM Studio detection to a `detectors/lm-studio.ts` module.
5. THE AI_Discovery_Engine SHALL delegate config file scanning to a `detectors/config-files.ts` module.
6. THE AI_Discovery_Engine SHALL delegate saved credential scanning to a `detectors/credentials.ts` module.
7. THE AI_Discovery_Engine SHALL replace all `require()` calls with top-level ES module imports.
8. WHEN a new detector module is added, THE AI_Discovery_Engine SHALL discover the provider without modifications to existing detector modules.

### Requirement 4: React Context for Dependency Injection

**User Story:** As a developer, I want TUI pages to receive LGTMContext via React Context, so that event handlers do not rely on dynamic imports for core services.

#### Acceptance Criteria

1. THE TUI_Shell SHALL provide LGTMContext to all child page components via a React Context provider.
2. WHEN a TUI page component needs access to the OKF_Store, THE TUI page component SHALL consume it from React Context.
3. WHEN a TUI page component needs access to the LLM provider, THE TUI page component SHALL consume it from React Context.
4. THE TUI_Shell SHALL eliminate all dynamic `import()` calls within event handler functions in page components.

### Requirement 5: Event Bus for Cross-Tab Communication

**User Story:** As a developer, I want an event bus for publishing state changes between tabs, so that configuration changes propagate without tight coupling.

#### Acceptance Criteria

1. THE Event_Bus SHALL support publishing events with a typed event name and payload.
2. THE Event_Bus SHALL support subscribing to events with typed callback handlers.
3. WHEN the AI provider configuration changes, THE Event_Bus SHALL emit a `config:changed` event.
4. WHEN AI provider discovery completes, THE Event_Bus SHALL emit a `providers:updated` event.
5. THE Event_Bus SHALL allow subscribers to unsubscribe to prevent memory leaks.

### Requirement 6: Opt-in Webapp Server

**User Story:** As a user, I want the webapp server to start only when explicitly requested, so that bare TUI usage does not open unnecessary network ports.

#### Acceptance Criteria

1. WHEN the `--webapp` flag is passed to the TUI launch command, THE Webapp_Server SHALL start on the configured port.
2. WHEN the lgtm configuration contains `webapp.enabled: true`, THE Webapp_Server SHALL start on the configured port.
3. WHEN neither the `--webapp` flag nor the configuration option is present, THE Webapp_Server SHALL remain stopped.
4. WHEN the Webapp_Server is stopped, THE TUI_Shell SHALL omit the webapp URL from the status bar.

### Requirement 7: Graceful Shutdown Orchestration

**User Story:** As a developer, I want a shutdown orchestration mechanism with cleanup hooks, so that resources are released reliably when the TUI exits.

#### Acceptance Criteria

1. THE LGTMContext SHALL expose an `onShutdown(callback)` method for registering cleanup hooks.
2. WHEN the TUI exits normally, THE LGTMContext SHALL invoke all registered shutdown callbacks in reverse registration order.
3. WHEN a shutdown callback throws an error, THE LGTMContext SHALL continue invoking remaining callbacks and log the error.
4. WHEN the Webapp_Server is running, THE Webapp_Server SHALL register a shutdown hook to stop the HTTP server.

### Requirement 8: Unified Credential Management

**User Story:** As a developer, I want a single credential management module, so that API key resolution logic is not duplicated across detect-ai, provider, and auth modules.

#### Acceptance Criteria

1. THE Credential_Manager SHALL provide a `resolveKey(provider)` function that checks config, environment variables, and saved credentials in priority order.
2. THE Credential_Manager SHALL provide a `saveKey(provider, key)` function that persists credentials to `~/.lgtm-credentials`.
3. THE Credential_Manager SHALL provide a `listSavedProviders()` function that returns all providers with stored keys.
4. WHEN the LLM provider needs an API key, THE LLM provider SHALL delegate resolution to the Credential_Manager.
5. WHEN the AI_Discovery_Engine finds a credential, THE AI_Discovery_Engine SHALL delegate storage to the Credential_Manager.

### Requirement 9: Terminal Abstraction

**User Story:** As a developer, I want a terminal abstraction module encapsulating raw stdout operations, so that ANSI escape sequences and cursor manipulation are centralized.

#### Acceptance Criteria

1. THE Terminal_Abstraction SHALL expose functions for cursor movement (up, down, to column).
2. THE Terminal_Abstraction SHALL expose functions for screen clearing (line, below cursor, entire screen).
3. THE Terminal_Abstraction SHALL expose a function for setting raw mode on stdin with automatic restoration.
4. WHEN onboarding prompt UI renders interactive selectors, THE onboarding prompt UI SHALL use the Terminal_Abstraction instead of direct `process.stdout.write` with escape sequences.

### Requirement 10: Typed Error Classes

**User Story:** As a developer, I want typed error classes for common failure categories, so that error handling can distinguish between authentication, network, and configuration failures.

#### Acceptance Criteria

1. THE LGTM codebase SHALL define an `LGTMAuthError` class for authentication and credential failures.
2. THE LGTM codebase SHALL define an `LGTMNetworkError` class for network connectivity and timeout failures.
3. THE LGTM codebase SHALL define an `LGTMConfigError` class for configuration parsing and validation failures.
4. WHEN the LLM provider receives a 401 or 403 response, THE LLM provider SHALL throw an `LGTMAuthError`.
5. WHEN the LLM provider encounters a timeout or connection refused error, THE LLM provider SHALL throw an `LGTMNetworkError`.
6. IF a configuration file contains invalid YAML or missing required fields, THEN THE config loader SHALL throw an `LGTMConfigError`.

### Requirement 11: Constants Extraction

**User Story:** As a developer, I want magic strings extracted into named constants, so that provider identifiers, question IDs, and config keys are defined once and referenced consistently.

#### Acceptance Criteria

1. THE LGTM codebase SHALL define provider identifiers (`openai`, `anthropic`, `ollama`, `gemini`, `openrouter`) as exported constants.
2. THE LGTM codebase SHALL define onboarding question IDs as exported constants.
3. THE LGTM codebase SHALL define configuration keys (`storageMode`, `ai.enabled`, `ai.provider`) as exported constants.
4. WHEN code references a provider identifier, THE code SHALL use the constant instead of a string literal.

### Requirement 12: AITab State Persistence

**User Story:** As a user, I want AI provider and model changes made in the TUI to persist, so that my selections are remembered across restarts.

#### Acceptance Criteria

1. WHEN the user switches the active AI provider in the AITab, THE AITab SHALL write the updated provider selection to the OKF_Store profile.
2. WHEN the user changes the AI model in the AITab, THE AITab SHALL write the updated model to the OKF_Store profile.
3. WHEN the TUI restarts, THE AITab SHALL load the previously persisted provider and model from the OKF_Store profile.

### Requirement 13: TUI Component Tests

**User Story:** As a developer, I want TUI components tested using ink-testing-library, so that rendering behavior and keyboard interactions are verified in isolation.

#### Acceptance Criteria

1. THE test suite SHALL include behavioral tests for the AITab component verifying provider list rendering and keyboard navigation.
2. THE test suite SHALL include behavioral tests for the TUI_Shell component verifying tab switching via keyboard input.
3. THE test suite SHALL include behavioral tests for the ReviewTab component verifying page navigation between queue and review views.
4. THE test suite SHALL include behavioral tests for the DashboardPage component verifying item selection and dismissal.
5. THE test suite SHALL use stdin/stdout mocking for keyboard interaction tests instead of structural assertions.

### Requirement 14: LLM Test Determinism

**User Story:** As a developer, I want LLM tests to reset the response cache before each test, so that test results are deterministic regardless of execution order.

#### Acceptance Criteria

1. THE LLM test suite SHALL call cache reset before each test case in a `beforeEach` hook.
2. WHEN tests run in any order, THE LLM test suite SHALL produce identical results.

### Requirement 15: AI Discovery Performance Budget

**User Story:** As a developer, I want a performance test for AI discovery, so that provider scanning does not introduce noticeable startup delays.

#### Acceptance Criteria

1. THE test suite SHALL include a test verifying that `discoverAIProviders()` completes within 5000 milliseconds.
2. WHEN a local provider (Ollama, LM Studio) is unreachable, THE AI_Discovery_Engine SHALL time out individual checks within 2000 milliseconds.

### Requirement 16: Edge Case and Chaos Tests

**User Story:** As a developer, I want tests covering corrupt data and permission failures, so that the system handles real-world filesystem anomalies gracefully.

#### Acceptance Criteria

1. THE test suite SHALL verify that a corrupt (unparseable) `profile.md` file does not crash the application.
2. THE test suite SHALL verify that a permission-denied error on the OKF_Store directory is handled gracefully with a descriptive error message.
3. THE test suite SHALL verify that concurrent write operations to the OKF_Store do not corrupt stored data.

### Requirement 17: Shared Spinner Component

**User Story:** As a user, I want a consistent loading animation across all TUI pages, so that the interface feels cohesive during async operations.

#### Acceptance Criteria

1. THE Spinner_Component SHALL render a rotating braille-dot animation.
2. THE Spinner_Component SHALL accept an optional label prop displayed beside the animation.
3. WHEN a TUI page initiates an asynchronous operation, THE TUI page SHALL display the Spinner_Component until the operation completes.

### Requirement 18: AITab Provider List Scroll and Pagination

**User Story:** As a user, I want the AITab provider list to support scrolling, so that many detected providers can be navigated without overflowing the terminal viewport.

#### Acceptance Criteria

1. WHEN the provider list exceeds the visible viewport height, THE AITab SHALL display a scrollable viewport with j/k navigation.
2. THE AITab SHALL indicate available scroll direction (up/down) when the list is partially hidden.
3. WHEN the user presses `j`, THE AITab SHALL move the selection cursor down one item.
4. WHEN the user presses `k`, THE AITab SHALL move the selection cursor up one item.

### Requirement 19: Destructive Action Confirmation

**User Story:** As a user, I want confirmation prompts before destructive actions, so that accidental key presses do not trigger irreversible operations.

#### Acceptance Criteria

1. WHEN the user initiates a provider switch in the AITab, THE AITab SHALL display a confirmation prompt before applying the change.
2. WHEN the user approves a PR in the ReviewTab, THE ReviewTab SHALL display a confirmation prompt before submitting the approval.
3. WHEN the user flags a PR in the ReviewTab, THE ReviewTab SHALL display a confirmation prompt before submitting the flag.
4. WHEN the user selects "no" at a confirmation prompt, THE system SHALL cancel the pending action and return to the previous state.

### Requirement 20: Persistent Tab Selection

**User Story:** As a user, I want my last-used tab remembered across TUI restarts, so that I return to the context I was working in.

#### Acceptance Criteria

1. WHEN the user switches tabs in the TUI_Shell, THE TUI_Shell SHALL persist the active tab identifier to the OKF_Store.
2. WHEN the TUI launches without an explicit `--tab` argument, THE TUI_Shell SHALL restore the last persisted tab as the initial active tab.
3. IF the persisted tab identifier refers to a tab that no longer exists, THEN THE TUI_Shell SHALL fall back to the first available tab.

### Requirement 21: ReviewTab Breadcrumb Navigation

**User Story:** As a user, I want a breadcrumb bar in the ReviewTab, so that I always know my position within the navigation hierarchy.

#### Acceptance Criteria

1. WHEN the user is on the queue page, THE ReviewTab SHALL display a breadcrumb showing "Review > Queue".
2. WHEN the user is reviewing a specific PR, THE ReviewTab SHALL display a breadcrumb showing "Review > Queue > PR #N".
3. THE ReviewTab breadcrumb SHALL be rendered above the page content area.

### Requirement 22: Inline Text Input for Model Change

**User Story:** As a user, I want to change the AI model inline in the AITab, so that I do not need to exit the TUI and run a CLI command.

#### Acceptance Criteria

1. WHEN the user presses `m` in the AITab, THE AITab SHALL activate an inline text input field pre-filled with the current model name.
2. WHEN the user confirms the text input, THE AITab SHALL update the active model and persist the change to the OKF_Store.
3. WHEN the user presses Escape during text input, THE AITab SHALL cancel the edit and restore the previous model value.

### Requirement 23: Help Overlay

**User Story:** As a user, I want a `?` shortcut to display all available keyboard shortcuts, so that I can discover functionality without memorizing keybindings.

#### Acceptance Criteria

1. WHEN the user presses `?` on any tab, THE TUI_Shell SHALL display the Help_Overlay showing shortcuts for the active tab.
2. THE Help_Overlay SHALL display shortcuts grouped by action category (navigation, actions, global).
3. WHEN the user presses `?` or Escape while the Help_Overlay is visible, THE TUI_Shell SHALL dismiss the overlay and return to normal view.

### Requirement 24: Standardized Empty States

**User Story:** As a user, I want consistent empty state displays across all pages, so that I always receive clear guidance when no data is available.

#### Acceptance Criteria

1. WHEN a TUI page has no items to display, THE TUI page SHALL render an icon, a descriptive message, and an action hint.
2. THE empty state format SHALL be consistent across all TUI pages (DashboardPage, QueuePage, AITab provider list).
3. THE action hint SHALL describe a specific command or keystroke the user can take to populate the page.

### Requirement 25: Responsive Layout with Min-Width Check

**User Story:** As a user, I want the TUI to degrade gracefully on narrow terminals, so that content remains readable regardless of window size.

#### Acceptance Criteria

1. WHEN the terminal width is below 60 columns, THE TUI_Shell SHALL display a warning message indicating the minimum recommended width.
2. WHILE the terminal width is below 60 columns, THE TUI_Shell SHALL hide non-essential UI elements (webapp URL, AI status indicator) from the status bar.
3. WHEN the terminal is resized above 60 columns, THE TUI_Shell SHALL restore the full layout.

### Requirement 26: Split Status Bar on Tall Terminals

**User Story:** As a user, I want the status bar to expand into two lines on tall terminals, so that keybinding hints and system status are easier to read.

#### Acceptance Criteria

1. WHILE the terminal height exceeds 30 rows, THE TUI_Shell SHALL render the status bar as two lines: keybinding hints on the first line and system status (AI status, webapp URL, tab position) on the second line.
2. WHILE the terminal height is 30 rows or fewer, THE TUI_Shell SHALL render the status bar as a single line with all information combined.
3. WHEN the terminal is resized, THE TUI_Shell SHALL re-evaluate the layout and switch between single-line and two-line status bar formats.

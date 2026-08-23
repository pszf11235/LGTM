# Implementation Plan: Codebase Quality Improvements

## Overview

This plan implements 26 requirements across three phases: architecture/code quality refactoring (Phase 1), testing infrastructure (Phase 2), and TUI UX improvements (Phase 3). The project uses TypeScript strict, Bun runtime, Ink for terminal UI, and bun:test for testing. Each phase builds on the previous — Phase 2 validates Phase 1 changes, and Phase 3 leverages Phase 1 infrastructure.

## Tasks

### Phase 1 — Architecture & Code Quality

- [ ] 1. Create foundational infrastructure modules
  - [ ] 1.1 Create typed error classes in `packages/core/src/errors.ts`
    - Implement `LGTMAuthError`, `LGTMNetworkError`, `LGTMConfigError` with typed properties (statusCode, provider, cause, endpoint, filePath, field)
    - Export all three classes
    - _Requirements: 10.1, 10.2, 10.3_

  - [ ] 1.2 Create constants module in `packages/core/src/constants.ts`
    - Define provider identifiers: `PROVIDER_OPENAI`, `PROVIDER_ANTHROPIC`, `PROVIDER_OLLAMA`, `PROVIDER_GEMINI`, `PROVIDER_OPENROUTER`
    - Define onboarding question IDs: `Q_STORAGE_MODE`, `Q_GOAL`, `Q_QUALITY_REFS`, `Q_FEEDBACK_STYLE`, `Q_TEAM_SIZE`, `Q_AI_PROVIDER`, `Q_AI_MODEL`, `Q_AI_KEY`
    - Define configuration keys: `CONFIG_STORAGE_MODE`, `CONFIG_AI_ENABLED`, `CONFIG_AI_PROVIDER`, `CONFIG_AI_MODEL`, `CONFIG_WEBAPP_ENABLED`
    - _Requirements: 11.1, 11.2, 11.3_

  - [ ] 1.3 Create terminal abstraction in `packages/core/src/terminal.ts`
    - Implement `moveCursorUp`, `moveCursorDown`, `moveCursorToColumn`, `clearLine`, `clearBelow`, `clearScreen`
    - Implement `setRawMode` with automatic restoration function
    - Implement `showSpinner` with braille-dot frames and label support
    - _Requirements: 9.1, 9.2, 9.3_

  - [ ] 1.4 Create event bus in `packages/core/src/event-bus.ts`
    - Implement typed `EventMap` interface with events: `config:changed`, `providers:updated`, `tab:switched`, `shutdown`
    - Implement `createEventBus()` factory returning `emit`, `on`, `off` methods
    - Use `Map<string, Set<EventHandler>>` for O(1) subscribe/unsubscribe
    - _Requirements: 5.1, 5.2, 5.5_

  - [ ] 1.5 Create shutdown manager in `packages/core/src/shutdown.ts`
    - Implement `createShutdownManager()` with `onShutdown(callback)` registration
    - Implement `runShutdown(logger)` executing callbacks in LIFO order
    - Ensure individual callback failures don't prevent remaining callbacks from running
    - _Requirements: 7.1, 7.2, 7.3_

  - [ ] 1.6 Create unified credential manager in `packages/core/src/auth/credentials.ts`
    - Implement `createCredentialManager()` factory with `resolveKey`, `saveKey`, `listSavedProviders`
    - Resolution priority: config.apiKey > environment variable > saved credential
    - Save to `~/.lgtm-credentials` with 0o600 permissions
    - _Requirements: 8.1, 8.2, 8.3_

- [ ] 2. Checkpoint — Verify foundational modules compile
  - Ensure all new modules in step 1 compile with `bun build` (no type errors), ask the user if questions arise.

- [ ] 3. CLI entry point decomposition
  - [ ] 3.1 Create `packages/core/src/commands/init.ts` — extract `lgtm init` command logic
    - Export `registerInitCommand(program, ctx, plugins)` function
    - Move onboarding launch and post-onboarding TUI launch logic here
    - _Requirements: 1.1, 1.6_

  - [ ] 3.2 Create `packages/core/src/commands/config.ts` — extract `lgtm config` command logic
    - Export `registerConfigCommand(program, ctx)` function
    - Move config display and `--edit` re-onboarding logic here
    - _Requirements: 1.2, 1.6_

  - [ ] 3.3 Create `packages/core/src/commands/plugins.ts` — extract `lgtm plugins` command logic
    - Export `registerPluginsCommand(program, ctx, plugins)` function
    - Move plugins list, enable, disable logic and `persistPluginState` helper here
    - _Requirements: 1.3, 1.6_

  - [ ] 3.4 Create `packages/core/src/commands/tui.ts` — extract TUI launch logic
    - Export `registerTUICommand(program, ctx, plugins)` and `launchBareTUI(ctx, plugins)` functions
    - Move `lgtm tui [plugin]` command and bare invocation TUI launch here
    - _Requirements: 1.4, 1.6_

  - [ ] 3.5 Rewrite `packages/core/src/index.ts` as thin orchestrator
    - Import and call all four `register*Command` functions
    - Handle bare invocation by delegating to `launchBareTUI`
    - Target: <80 lines excluding imports
    - _Requirements: 1.5, 1.6_

- [ ] 4. Onboarding flow decomposition
  - [ ] 4.1 Create `packages/core/src/onboarding/prompt-ui.ts`
    - Extract `selectWithArrows`, `waitForSkipOrContinue`, `prompt` functions from `flow.ts`
    - Use terminal abstraction (`packages/core/src/terminal.ts`) instead of raw escape sequences
    - _Requirements: 2.1, 9.4_

  - [ ] 4.2 Create `packages/core/src/onboarding/profile-builder.ts`
    - Extract `saveProgress` and `generateProfileBody` functions from `flow.ts`
    - Accept answers map + repoRoot + existingProfile and produce `SaveProgressResult`
    - _Requirements: 2.2, 2.5_

  - [ ] 4.3 Create `packages/core/src/onboarding/ai-config.ts`
    - Extract AI provider auto-configuration logic (single provider, multiple providers, no providers)
    - Accept discovery promise and `pickProviderPriority` callback, return `AIConfigResult`
    - _Requirements: 2.3_

  - [ ] 4.4 Refactor `packages/core/src/onboarding/flow.ts` into thin orchestrator
    - Import and delegate to `prompt-ui.ts`, `profile-builder.ts`, `ai-config.ts`
    - Target: ~100 lines of orchestration logic
    - Verify same profile.md output as before
    - _Requirements: 2.4, 2.5_

- [ ] 5. AI discovery engine decomposition
  - [ ] 5.1 Create `packages/core/src/onboarding/detectors/types.ts`
    - Define `Detector` interface with `name` and `detect()` method
    - Define `DetectorResult` type with `providers` and `toolsDetected`
    - _Requirements: 3.8_

  - [ ] 5.2 Create `packages/core/src/onboarding/detectors/env-vars.ts`
    - Extract `checkEnvVars` logic into a `Detector` implementation
    - Use constants from `packages/core/src/constants.ts` for provider IDs
    - _Requirements: 3.1, 11.4_

  - [ ] 5.3 Create `packages/core/src/onboarding/detectors/claude-code.ts`
    - Extract `checkClaudeCode` logic into a `Detector` implementation
    - Use Credential_Manager for key storage instead of inline `saveToken`
    - Replace `require("child_process")` with top-level ES import
    - _Requirements: 3.2, 3.7, 8.5_

  - [ ] 5.4 Create `packages/core/src/onboarding/detectors/ollama.ts`
    - Extract `checkOllama` logic into a `Detector` implementation
    - Replace `require("child_process")` with top-level ES import
    - _Requirements: 3.3, 3.7_

  - [ ] 5.5 Create `packages/core/src/onboarding/detectors/lm-studio.ts`
    - Extract `checkLMStudio` logic into a `Detector` implementation
    - _Requirements: 3.4_

  - [ ] 5.6 Create `packages/core/src/onboarding/detectors/config-files.ts`
    - Extract `checkConfigFiles`, `checkContinueDev`, `checkAider`, `checkCursor`, `checkGitHubCopilot` logic
    - _Requirements: 3.5_

  - [ ] 5.7 Create `packages/core/src/onboarding/detectors/credentials.ts`
    - Extract `checkLGTMCredentials` logic into a `Detector` implementation
    - Delegate to Credential_Manager
    - _Requirements: 3.6, 8.5_

  - [ ] 5.8 Refactor `packages/core/src/onboarding/detect-ai.ts` into coordinator
    - Import all detector modules, iterate through `DETECTORS` array
    - Add `buildDiscoveryResult` helper for deduplication and recommendation
    - New detectors added by creating a file + adding to array (no existing file modifications)
    - _Requirements: 3.8_

- [ ] 6. React Context for dependency injection
  - [ ] 6.1 Create `packages/core/src/tui/LGTMProvider.tsx`
    - Implement `LGTMProvider` component wrapping children with React Context
    - Context provides `ctx: LGTMContext` and `eventBus: EventBus`
    - Export `useLGTMContext()` hook with error on missing provider
    - _Requirements: 4.1_

  - [ ] 6.2 Update `packages/core/src/tui/Shell.tsx` to wrap content in `<LGTMProvider>`
    - Accept `ctx` and `eventBus` as props
    - Wrap all children (page content area) with `<LGTMProvider>`
    - _Requirements: 4.1_

  - [ ] 6.3 Update `packages/core/src/tui/AITab.tsx` to use `useLGTMContext()`
    - Replace dynamic `import("../onboarding/detect-ai.js")` in event handlers with context-provided services
    - Access store and LLM from context instead of inline imports
    - _Requirements: 4.2, 4.3, 4.4_

  - [ ] 6.4 Update `packages/core/src/tui/render.ts` to pass context and event bus to Shell
    - Create event bus instance in `launchTUI` / `buildAndLaunchTUI`
    - Pass `ctx` and `eventBus` to Shell component
    - _Requirements: 4.1_

- [ ] 7. Integrate typed errors into LLM provider
  - [ ] 7.1 Update `packages/core/src/llm/provider.ts` to use Credential_Manager
    - Replace `loadSavedKey` with `credentialManager.resolveKey()`
    - Import and use credential manager from `packages/core/src/auth/credentials.ts`
    - _Requirements: 8.4_

  - [ ] 7.2 Update `packages/core/src/llm/provider.ts` to throw typed errors
    - Throw `LGTMAuthError` on 401/403 responses
    - Throw `LGTMNetworkError` on timeout/ECONNREFUSED (after retry exhaustion)
    - Import error classes from `packages/core/src/errors.ts`
    - _Requirements: 10.4, 10.5_

- [ ] 8. Opt-in webapp server and shutdown wiring
  - [ ] 8.1 Update `packages/core/src/commands/tui.ts` to make webapp opt-in
    - Check `--webapp` flag OR `ctx.config.webapp?.enabled === true`
    - Only call `startWebappServer()` when opted in
    - Register webapp shutdown hook via shutdown manager
    - Pass `webappUrl` as `undefined` to Shell when server not started
    - _Requirements: 6.1, 6.2, 6.3, 6.4, 7.4_

  - [ ] 8.2 Wire shutdown manager into TUI render lifecycle
    - Call `shutdownManager.runShutdown(ctx.logger)` after `waitUntilExit()` resolves
    - Register webapp server stop as shutdown hook
    - _Requirements: 7.2, 7.4_

- [ ] 9. AITab state persistence
  - [ ] 9.1 Add persistence logic to `packages/core/src/tui/AITab.tsx`
    - On provider switch: write updated provider/model to OKF store via `useLGTMContext()`
    - On mount: read persisted provider/model from store and initialize state
    - Emit `config:changed` event on provider change via event bus
    - _Requirements: 12.1, 12.2, 12.3, 5.3_

- [ ] 10. Checkpoint — Phase 1 complete
  - Ensure all tests pass, ask the user if questions arise.
  - Verify `bun build` compiles without errors
  - Verify existing functionality is preserved (all commands still work)

### Phase 2 — Testing Infrastructure

- [ ] 11. LLM test determinism
  - [ ] 11.1 Update/create `packages/core/src/__tests__/llm-provider.test.ts`
    - Add `beforeEach` hook that calls cache reset (import `createCache` and verify reset behavior)
    - Verify tests produce identical results regardless of execution order
    - _Requirements: 14.1, 14.2_

  - [ ]* 11.2 Write property test for LLM cache isolation
    - **Property 11: LLM Test Determinism via Cache Isolation**
    - **Validates: Requirements 14.2**

- [ ] 12. AI discovery performance budget
  - [ ] 12.1 Create `packages/core/src/__tests__/performance.test.ts`
    - Test that `discoverAIProviders()` completes within 5000ms
    - Verify individual provider checks timeout within 2000ms when unreachable
    - Use `performance.now()` or bun:test timeout features
    - _Requirements: 15.1, 15.2_

- [ ] 13. Edge case and chaos tests
  - [ ] 13.1 Create `packages/core/src/__tests__/chaos.test.ts`
    - Test corrupt profile.md (random bytes, malformed YAML, binary data) → `loadProfile` returns null
    - Test permission-denied on store directory → graceful error with descriptive message
    - Test concurrent write operations → final file is valid OKF document
    - _Requirements: 16.1, 16.2, 16.3_

  - [ ]* 13.2 Write property test for corrupt profile resilience
    - **Property 12: Corrupt Profile Resilience**
    - **Validates: Requirements 16.1**

  - [ ]* 13.3 Write property test for concurrent write integrity
    - **Property 13: Concurrent Write Integrity**
    - **Validates: Requirements 16.3**

- [ ] 14. Event bus and credential manager property tests
  - [ ]* 14.1 Write property tests for event bus in `packages/core/src/__tests__/event-bus.test.ts`
    - **Property 2: Event Bus Delivery Contract** — N subscribers all receive payload exactly once
    - **Property 3: Event Bus Unsubscribe Isolation** — unsubscribed handler not called
    - **Validates: Requirements 5.1, 5.2, 5.5**

  - [ ]* 14.2 Write property tests for credential manager in `packages/core/src/__tests__/credentials.test.ts`
    - **Property 5: Credential Resolution Priority** — config > env > saved
    - **Property 6: Credential Save/Load Round-Trip** — save then load returns same key
    - **Validates: Requirements 8.1, 8.2, 8.3**

  - [ ]* 14.3 Write property tests for shutdown manager in `packages/core/src/__tests__/shutdown.test.ts`
    - **Property 4: Shutdown Callback Reverse Order** — LIFO execution, failures don't stop remaining
    - **Validates: Requirements 7.2, 7.3**

- [ ] 15. Error classification property tests
  - [ ]* 15.1 Write property tests for typed errors in `packages/core/src/__tests__/errors.test.ts`
    - **Property 7: Auth Error Classification** — 401/403 → LGTMAuthError
    - **Property 8: Network Error Classification** — timeout/ECONNREFUSED → LGTMNetworkError
    - **Property 9: Config Error on Invalid Input** — invalid YAML → LGTMConfigError
    - **Validates: Requirements 10.4, 10.5, 10.6**

- [ ] 16. TUI component behavioral tests
  - [ ] 16.1 Create `packages/core/src/__tests__/tui-components.test.tsx`
    - Test AITab: provider list renders, keyboard navigation (j/k/r/s/t), discovery integration
    - Test Shell: tab switching via Tab key, correct page rendering
    - Use `ink-testing-library` `render()` and `stdin.write()` for keyboard simulation
    - _Requirements: 13.1, 13.2, 13.5_

  - [ ] 16.2 Add ReviewTab behavioral tests to `packages/core/src/__tests__/tui-components.test.tsx`
    - Test page navigation between queue and review views
    - Verify breadcrumb updates on navigation
    - Use `ink-testing-library` for rendering and keyboard interaction
    - _Requirements: 13.3_

  - [ ] 16.3 Add DashboardPage behavioral tests to `packages/core/src/__tests__/tui-components.test.tsx`
    - Test item selection and dismissal keyboard flows
    - Verify empty state rendering when no items
    - _Requirements: 13.4_

- [ ] 17. Checkpoint — Phase 2 complete
  - Ensure all tests pass, ask the user if questions arise.
  - Verify test coverage captures all 17 correctness properties

### Phase 3 — TUI UX Improvements

- [ ] 18. Create shared TUI components
  - [ ] 18.1 Create `packages/core/src/tui/components/Spinner.tsx`
    - Rotating braille-dot animation (⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏) at 80ms interval
    - Accept optional `label` prop displayed beside animation
    - _Requirements: 17.1, 17.2_

  - [ ] 18.2 Create `packages/core/src/tui/components/EmptyState.tsx`
    - Accept `icon`, `message`, `actionHint` props
    - Center vertically with margin, gray message, cyan action hint
    - _Requirements: 24.1, 24.2, 24.3_

  - [ ] 18.3 Create `packages/core/src/tui/components/Breadcrumb.tsx`
    - Accept `segments: string[]` prop
    - Render with ` › ` separator, last segment bold, earlier segments gray
    - _Requirements: 21.3_

  - [ ] 18.4 Create `packages/core/src/tui/components/Confirmation.tsx`
    - Accept `message`, `onConfirm`, `onCancel` props
    - Listen for y/Enter (confirm) and n/Escape (cancel)
    - Display yellow warning icon + message + [y/n] hint
    - _Requirements: 19.4_

  - [ ] 18.5 Create `packages/core/src/tui/components/HelpOverlay.tsx`
    - Accept `groups: ShortcutGroup[]` prop (category + shortcuts array)
    - Render in bordered box with category headers and key/description columns
    - Show dismiss hint at bottom
    - _Requirements: 23.1, 23.2_

  - [ ]* 18.6 Write property test for EmptyState completeness
    - **Property 17: Empty State Completeness**
    - **Validates: Requirements 24.1**

- [ ] 19. AITab scroll/pagination and inline model input
  - [ ] 19.1 Add viewport scrolling to AITab provider list in `packages/core/src/tui/AITab.tsx`
    - Calculate `VIEWPORT_SIZE` from terminal height
    - Track `cursorIdx` and `scrollOffset` state
    - Implement j/k navigation with bounds checking
    - Show scroll indicators when list is partially hidden
    - _Requirements: 18.1, 18.2, 18.3, 18.4_

  - [ ]* 19.2 Write property test for cursor navigation bounds
    - **Property 14: Cursor Navigation Bounds**
    - **Validates: Requirements 18.3, 18.4**

  - [ ] 19.3 Add inline text input for model change in `packages/core/src/tui/AITab.tsx`
    - On `m` press: activate input mode, pre-fill current model
    - On Enter: persist new model to OKF store, update state
    - On Escape: cancel and restore previous value
    - _Requirements: 22.1, 22.2, 22.3_

- [ ] 20. Destructive action confirmations
  - [ ] 20.1 Add confirmation to AITab provider switch in `packages/core/src/tui/AITab.tsx`
    - Show `<Confirmation>` before applying provider switch
    - On cancel: restore previous state unchanged
    - _Requirements: 19.1, 19.4_

  - [ ]* 20.2 Write property test for confirmation cancel preserves state
    - **Property 15: Confirmation Cancel Preserves State**
    - **Validates: Requirements 19.4**

  - [ ] 20.3 Add confirmation to ReviewTab approve/flag actions
    - Show `<Confirmation>` before submitting PR approval
    - Show `<Confirmation>` before submitting PR flag
    - On cancel: return to previous state
    - _Requirements: 19.2, 19.3, 19.4_

- [ ] 21. Persistent tab selection
  - [ ] 21.1 Add tab persistence to `packages/core/src/tui/Shell.tsx`
    - On tab switch: write tab identifier to OKF store (`ui-state.md`)
    - On mount (no `--tab` arg): read last tab from store, set as initial
    - If stored tab not found in enabled tabs: fall back to index 0
    - _Requirements: 20.1, 20.2, 20.3_

  - [ ]* 21.2 Write property test for tab persistence round-trip
    - **Property 16: Tab Persistence Round-Trip**
    - **Validates: Requirements 20.1, 20.2, 20.3**

- [ ] 22. ReviewTab breadcrumb navigation
  - [ ] 22.1 Integrate `<Breadcrumb>` into ReviewTab
    - Queue view: show "Review › Queue"
    - PR review view: show "Review › Queue › PR #N"
    - Render above page content area
    - _Requirements: 21.1, 21.2, 21.3_

- [ ] 23. Help overlay integration
  - [ ] 23.1 Wire `?` shortcut into `packages/core/src/tui/Shell.tsx`
    - Toggle `showHelp` state on `?` press
    - Dismiss on `?` or Escape when overlay visible
    - Render `<HelpOverlay>` instead of page content when active
    - Define shortcut groups per tab (navigation, actions, global)
    - _Requirements: 23.1, 23.2, 23.3_

- [ ] 24. Empty state standardization
  - [ ] 24.1 Add `<EmptyState>` to AITab when no providers detected
    - Icon: 🤖, message: "No AI providers detected", hint: "[r] to re-discover or set API keys"
    - _Requirements: 24.1, 24.2, 24.3_

  - [ ] 24.2 Add `<EmptyState>` to DashboardPage and QueuePage when no items
    - DashboardPage: appropriate icon + "No items" + action hint
    - QueuePage: appropriate icon + "No PRs in queue" + action hint
    - _Requirements: 24.1, 24.2, 24.3_

- [ ] 25. Responsive layout and split status bar
  - [ ] 25.1 Add responsive layout to `packages/core/src/tui/Shell.tsx`
    - Detect `isNarrow` (width < 60) and `isTall` (height > 30)
    - Show min-width warning when narrow
    - Hide webapp URL and AI status from status bar when narrow
    - _Requirements: 25.1, 25.2, 25.3_

  - [ ] 25.2 Implement split status bar in `packages/core/src/tui/Shell.tsx`
    - When height > 30: render two-line status bar (hints line 1, system status line 2)
    - When height ≤ 30: render single-line combined status bar
    - Re-evaluate on terminal resize
    - _Requirements: 26.1, 26.2, 26.3_

- [ ] 26. Use Spinner in async operations
  - [ ] 26.1 Integrate `<Spinner>` into AITab during discovery
    - Show `<Spinner label="Discovering providers..." />` during `runDiscovery()`
    - Replace text-based "⏳ Discovering providers..." with Spinner component
    - _Requirements: 17.3_

- [ ] 27. Final checkpoint — All phases complete
  - Ensure all tests pass, ask the user if questions arise.
  - Verify full build compiles with no type errors
  - Verify all 26 requirements have implementing tasks

## Notes

- Tasks marked with `*` are optional and can be skipped for faster MVP
- Each task references specific requirements for traceability
- Checkpoints ensure incremental validation between phases
- Property tests validate universal correctness properties from the design document (17 properties total)
- Unit tests validate specific examples and edge cases
- TUI component tests use `ink-testing-library` for behavioral assertions
- All property tests should use `fast-check` with minimum 100 iterations
- Phase 1 must complete before Phase 2 (tests validate Phase 1 code)
- Phase 3 depends on Phase 1 infrastructure (React Context, event bus, credential manager)

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1", "1.2", "1.3", "1.4", "1.5", "1.6"] },
    { "id": 1, "tasks": ["3.1", "3.2", "3.3", "3.4", "4.1", "5.1"] },
    { "id": 2, "tasks": ["3.5", "4.2", "4.3", "5.2", "5.3", "5.4", "5.5", "5.6", "5.7"] },
    { "id": 3, "tasks": ["4.4", "5.8", "6.1", "7.1", "7.2"] },
    { "id": 4, "tasks": ["6.2", "6.3", "6.4", "8.1", "8.2"] },
    { "id": 5, "tasks": ["9.1"] },
    { "id": 6, "tasks": ["11.1", "11.2", "12.1", "13.1", "14.1", "14.2", "14.3", "15.1"] },
    { "id": 7, "tasks": ["13.2", "13.3", "16.1", "16.2", "16.3"] },
    { "id": 8, "tasks": ["18.1", "18.2", "18.3", "18.4", "18.5"] },
    { "id": 9, "tasks": ["18.6", "19.1", "19.3", "21.1", "22.1", "23.1", "25.1"] },
    { "id": 10, "tasks": ["19.2", "20.1", "20.3", "21.2", "24.1", "24.2", "25.2", "26.1"] },
    { "id": 11, "tasks": ["20.2"] }
  ]
}
```

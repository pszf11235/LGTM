# Technical Design Document

## Introduction

This document defines the architecture and implementation plan for the LGTM codebase quality improvement effort. It covers decomposition of monolithic modules into focused units, introduction of shared infrastructure (event bus, credential manager, terminal abstraction, typed errors, constants), TUI component library enhancements, and a comprehensive testing strategy. All code is TypeScript strict, runs on Bun, uses Ink for terminal UI, and targets bun:test with ink-testing-library for component tests.

---

## Architecture Overview

The refactoring introduces a layered architecture with clear separation of concerns:

```
┌─────────────────────────────────────────────────────────┐
│  CLI Layer (commands/)                                    │
│  init.ts │ config.ts │ plugins.ts │ tui.ts              │
├─────────────────────────────────────────────────────────┤
│  TUI Layer (tui/)                                        │
│  Shell.tsx → LGTMProvider (React Context)                │
│  Components: Spinner, HelpOverlay, EmptyState, etc.      │
├─────────────────────────────────────────────────────────┤
│  Core Services                                           │
│  EventBus │ CredentialManager │ TerminalAbstraction      │
│  Errors   │ Constants         │ OKFStore                 │
├─────────────────────────────────────────────────────────┤
│  Onboarding (onboarding/)                                │
│  flow.ts → prompt-ui.ts │ profile-builder.ts │ ai-config │
├─────────────────────────────────────────────────────────┤
│  AI Discovery (onboarding/detectors/)                    │
│  env-vars │ claude-code │ ollama │ lm-studio │ etc.      │
├─────────────────────────────────────────────────────────┤
│  LLM Provider (llm/)                                     │
│  provider.ts → CredentialManager for key resolution      │
└─────────────────────────────────────────────────────────┘
```

---

## Component Design

### 1. CLI Entry Point Decomposition

**Current:** `packages/core/src/index.ts` (~230 lines) handles all commands inline.

**Target:** A thin orchestrator (~60 lines) that imports and delegates to command modules.

#### New File Structure

```
packages/core/src/
├── index.ts                 # Thin orchestrator (<80 lines)
├── commands/
│   ├── init.ts              # `lgtm init` command
│   ├── config.ts            # `lgtm config` command
│   ├── plugins.ts           # `lgtm plugins` + enable/disable
│   └── tui.ts               # `lgtm tui [plugin]` + bare launch
```

#### Interface: Command Module Pattern

```typescript
// packages/core/src/commands/init.ts
import type { Command } from "commander";
import type { LGTMContext } from "../plugin.js";
import type { LGTMPlugin } from "../plugin.js";

export function registerInitCommand(
  program: Command,
  ctx: LGTMContext,
  plugins: LGTMPlugin[]
): void {
  program
    .command("init")
    .description("Initialize LGTM in this project")
    .option("--skip-onboarding", "Skip interactive questions, use defaults")
    .action(async (opts: { skipOnboarding?: boolean }) => {
      // ... init logic extracted from index.ts
    });
}
```

Each command module exports a single `register*Command` function. The main `index.ts` imports all four and calls them in sequence.

#### Orchestrator Pattern (index.ts)

```typescript
#!/usr/bin/env bun
import { Command } from "commander";
import { buildBootstrapContext, discoverPlugins, resolvePluginsDir } from "./cli/program.js";
import { registerInitCommand } from "./commands/init.js";
import { registerConfigCommand } from "./commands/config.js";
import { registerPluginsCommand } from "./commands/plugins.js";
import { registerTUICommand, launchBareTUI } from "./commands/tui.js";

async function main() {
  const program = new Command();
  program.name("lgtm").version("0.1.0");

  const ctx = buildBootstrapContext();
  const plugins = await discoverPlugins(resolvePluginsDir());

  // Bare invocation: launch TUI directly
  if (process.argv.length <= 2) {
    await launchBareTUI(ctx, plugins);
    return;
  }

  // Register commands
  registerInitCommand(program, ctx, plugins);
  registerConfigCommand(program, ctx);
  registerPluginsCommand(program, ctx, plugins);
  registerTUICommand(program, ctx, plugins);

  await program.parseAsync(process.argv);
}

main().catch((err) => { process.exit(1); });
```

---

### 2. Onboarding Flow Decomposition

**Current:** `packages/core/src/onboarding/flow.ts` (~450 lines) handles prompts, profile building, and AI config inline.

**Target:** Thin orchestrator delegating to three focused modules.

#### New File Structure

```
packages/core/src/onboarding/
├── flow.ts                  # Orchestrator (~100 lines)
├── prompt-ui.ts             # Interactive prompt helpers
├── profile-builder.ts       # Profile construction and serialization
├── ai-config.ts             # AI discovery integration and provider ranking
├── detect-ai.ts             # Discovery coordinator
├── detectors/
│   ├── env-vars.ts
│   ├── claude-code.ts
│   ├── ollama.ts
│   ├── lm-studio.ts
│   ├── config-files.ts
│   └── credentials.ts
├── detect.ts                # Tech stack detection (existing)
└── questions.ts             # Question definitions (existing)
```

#### Interface: prompt-ui.ts

```typescript
// packages/core/src/onboarding/prompt-ui.ts
import type readline from "readline";

export interface SelectOption {
  value: string;
  label: string;
  description?: string;
}

/** Arrow-key selector. Returns selected value or null if skipped. */
export function selectWithArrows(
  question: string,
  options: SelectOption[],
  defaultIdx: number,
  currentValue?: string
): Promise<string | null>;

/** Wait for user to press 'q' (skip) or Enter (continue). */
export function waitForSkipOrContinue(): Promise<boolean>;

/** Prompt for text input via readline. */
export function prompt(rl: readline.Interface, question: string): Promise<string>;
```

#### Interface: profile-builder.ts

```typescript
// packages/core/src/onboarding/profile-builder.ts
import type { ProjectProfile } from "../plugin.js";
import type { BootstrapConfig } from "../config/loader.js";

export interface SaveProgressResult {
  profile: ProjectProfile;
  bootstrap: BootstrapConfig;
  lgtmDir: string;
  detectedStack: string[];
}

/** Build profile from answers and persist to OKF store. */
export async function saveProgress(
  answers: Record<string, string>,
  repoRoot: string,
  existingProfile?: ProjectProfile | null
): Promise<SaveProgressResult>;

/** Generate markdown body for profile.md. */
export function generateProfileBody(profile: ProjectProfile): string;
```

#### Interface: ai-config.ts

```typescript
// packages/core/src/onboarding/ai-config.ts
import type { DetectedProvider, AIDiscoveryResult } from "./detect-ai.js";

export interface AIConfigResult {
  provider: string;
  model: string;
  fallback?: Array<{ provider: string; model: string; baseUrl?: string }>;
  skipped: boolean;
}

/** Run AI auto-discovery and configure based on results. */
export async function configureAI(
  discoveryPromise: Promise<AIDiscoveryResult | null>,
  pickProviderPriority: (providers: DetectedProvider[]) => Promise<DetectedProvider[]>
): Promise<AIConfigResult>;
```

---

### 3. AI Discovery Engine Decomposition

**Current:** `detect-ai.ts` (~450 lines) contains all detection logic inline.

**Target:** A coordinator that imports and runs detector modules from a registry.

#### Interface: Detector Contract

```typescript
// packages/core/src/onboarding/detectors/types.ts
import type { DetectedProvider } from "../detect-ai.js";

export interface DetectorResult {
  providers: DetectedProvider[];
  toolsDetected: string[];
}

export interface Detector {
  name: string;
  detect(): Promise<DetectorResult> | DetectorResult;
}
```

#### Coordinator Pattern (detect-ai.ts)

```typescript
// packages/core/src/onboarding/detect-ai.ts
import { envVarsDetector } from "./detectors/env-vars.js";
import { claudeCodeDetector } from "./detectors/claude-code.js";
import { ollamaDetector } from "./detectors/ollama.js";
import { lmStudioDetector } from "./detectors/lm-studio.js";
import { configFilesDetector } from "./detectors/config-files.js";
import { credentialsDetector } from "./detectors/credentials.js";
import type { Detector } from "./detectors/types.js";

const DETECTORS: Detector[] = [
  envVarsDetector,
  credentialsDetector,
  claudeCodeDetector,
  ollamaDetector,
  lmStudioDetector,
  configFilesDetector,
];

export async function discoverAIProviders(): Promise<AIDiscoveryResult> {
  const allProviders: DetectedProvider[] = [];
  const allTools: string[] = [];

  for (const detector of DETECTORS) {
    const result = await detector.detect();
    allProviders.push(...result.providers);
    allTools.push(...result.toolsDetected);
  }

  return buildDiscoveryResult(allProviders, allTools);
}
```

New detectors are added by creating a new file in `detectors/` and adding it to the `DETECTORS` array. Existing detector modules never need modification.

---

### 4. React Context for Dependency Injection

#### LGTMProvider

```typescript
// packages/core/src/tui/LGTMProvider.tsx
import React, { createContext, useContext } from "react";
import type { LGTMContext } from "../plugin.js";
import type { EventBus } from "../event-bus.js";

interface TUIContext {
  ctx: LGTMContext;
  eventBus: EventBus;
}

const LGTMReactContext = createContext<TUIContext | null>(null);

export function LGTMProvider({
  ctx,
  eventBus,
  children,
}: {
  ctx: LGTMContext;
  eventBus: EventBus;
  children: React.ReactNode;
}) {
  return (
    <LGTMReactContext.Provider value={{ ctx, eventBus }}>
      {children}
    </LGTMReactContext.Provider>
  );
}

export function useLGTMContext(): TUIContext {
  const value = useContext(LGTMReactContext);
  if (!value) {
    throw new Error("useLGTMContext must be used within LGTMProvider");
  }
  return value;
}
```

The Shell component wraps all children in `<LGTMProvider>`. Page components call `useLGTMContext()` instead of using dynamic imports for store/LLM access.

---

### 5. Event Bus

```typescript
// packages/core/src/event-bus.ts
type EventHandler<T = unknown> = (payload: T) => void;

export interface EventMap {
  "config:changed": { key: string; value: unknown };
  "providers:updated": { providers: string[] };
  "tab:switched": { tabId: string };
  "shutdown": undefined;
}

export interface EventBus {
  emit<K extends keyof EventMap>(event: K, payload: EventMap[K]): void;
  on<K extends keyof EventMap>(event: K, handler: EventHandler<EventMap[K]>): void;
  off<K extends keyof EventMap>(event: K, handler: EventHandler<EventMap[K]>): void;
}

export function createEventBus(): EventBus {
  const handlers = new Map<string, Set<EventHandler>>();

  return {
    emit(event, payload) {
      const set = handlers.get(event);
      if (set) {
        for (const handler of set) handler(payload);
      }
    },
    on(event, handler) {
      if (!handlers.has(event)) handlers.set(event, new Set());
      handlers.get(event)!.add(handler as EventHandler);
    },
    off(event, handler) {
      handlers.get(event)?.delete(handler as EventHandler);
    },
  };
}
```

---

### 6. Opt-in Webapp Server

The `launchTUI` function in `commands/tui.ts` checks for the `--webapp` CLI flag OR `ctx.config.webapp?.enabled`. Only if one is truthy does it call `startWebappServer()`. The Shell receives `webappUrl` as `undefined` when the server is not started, causing the status bar to omit the URL.

```typescript
// In commands/tui.ts
const shouldStartWebapp = opts.webapp || ctx.config.webapp?.enabled === true;
const webappServer = shouldStartWebapp
  ? await startWebappServer(projectRoot)
  : null;
```

---

### 7. Graceful Shutdown Orchestration

Shutdown hooks are stored on the LGTMContext and executed on TUI exit.

```typescript
// packages/core/src/shutdown.ts
export interface ShutdownManager {
  onShutdown(callback: () => void | Promise<void>): void;
  runShutdown(logger: { error(msg: string): void }): Promise<void>;
}

export function createShutdownManager(): ShutdownManager {
  const callbacks: Array<() => void | Promise<void>> = [];

  return {
    onShutdown(callback) {
      callbacks.push(callback);
    },
    async runShutdown(logger) {
      // Reverse order (LIFO)
      for (let i = callbacks.length - 1; i >= 0; i--) {
        try {
          await callbacks[i]();
        } catch (err) {
          logger.error(`Shutdown hook failed: ${(err as Error).message}`);
        }
      }
    },
  };
}
```

The TUI render loop calls `shutdownManager.runShutdown(ctx.logger)` after `waitUntilExit()` resolves.

---

### 8. Unified Credential Management

```typescript
// packages/core/src/auth/credentials.ts
import fs from "fs";
import path from "path";
import os from "os";

const CRED_FILE = path.join(os.homedir(), ".lgtm-credentials");

export interface CredentialManager {
  resolveKey(provider: string, config?: { apiKey?: string }): string | null;
  saveKey(provider: string, key: string): void;
  listSavedProviders(): string[];
}

export function createCredentialManager(): CredentialManager {
  function resolveKey(provider: string, config?: { apiKey?: string }): string | null {
    // Priority 1: explicit config
    if (config?.apiKey) return config.apiKey;

    // Priority 2: environment variable
    const envMap: Record<string, string> = {
      openai: "OPENAI_API_KEY",
      anthropic: "ANTHROPIC_API_KEY",
      gemini: "GEMINI_API_KEY",
      openrouter: "OPENROUTER_API_KEY",
    };
    const envKey = envMap[provider];
    if (envKey && process.env[envKey]) return process.env[envKey]!;

    // Priority 3: saved credentials
    return loadSaved(provider);
  }

  function saveKey(provider: string, key: string): void {
    let creds: Record<string, string> = {};
    try {
      creds = JSON.parse(fs.readFileSync(CRED_FILE, "utf-8"));
    } catch { /* new file */ }
    creds[provider] = key;
    fs.writeFileSync(CRED_FILE, JSON.stringify(creds, null, 2), { mode: 0o600 });
  }

  function listSavedProviders(): string[] {
    try {
      const creds = JSON.parse(fs.readFileSync(CRED_FILE, "utf-8"));
      return Object.keys(creds).filter((k) => !!creds[k]);
    } catch {
      return [];
    }
  }

  function loadSaved(provider: string): string | null {
    try {
      const creds = JSON.parse(fs.readFileSync(CRED_FILE, "utf-8"));
      return creds[provider] ?? creds[provider === "anthropic" ? "claude" : ""] ?? null;
    } catch {
      return null;
    }
  }

  return { resolveKey, saveKey, listSavedProviders };
}
```

The LLM provider and AI discovery engine both import `createCredentialManager()` instead of duplicating key resolution logic.

---

### 9. Terminal Abstraction

```typescript
// packages/core/src/terminal.ts

/** Move cursor up N lines */
export function moveCursorUp(n: number): void {
  process.stdout.write(`\x1b[${n}A`);
}

/** Move cursor down N lines */
export function moveCursorDown(n: number): void {
  process.stdout.write(`\x1b[${n}B`);
}

/** Move cursor to specific column */
export function moveCursorToColumn(col: number): void {
  process.stdout.write(`\x1b[${col}G`);
}

/** Clear current line */
export function clearLine(): void {
  process.stdout.write("\r\x1b[2K");
}

/** Clear from cursor to end of screen */
export function clearBelow(): void {
  process.stdout.write("\x1b[0J");
}

/** Clear entire screen */
export function clearScreen(): void {
  process.stdout.write("\x1b[2J\x1b[H");
}

/** Set raw mode, returns a restore function */
export function setRawMode(stdin: NodeJS.ReadStream): () => void {
  const wasRaw = stdin.isRaw;
  try {
    stdin.setRawMode(true);
  } catch {
    return () => {};
  }
  stdin.resume();
  stdin.setEncoding("utf-8");
  return () => {
    stdin.setRawMode(wasRaw ?? false);
    stdin.resume();
  };
}

/** Display a spinner with optional label. Returns a stop function. */
export function showSpinner(label?: string): () => void {
  const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
  let i = 0;
  const interval = setInterval(() => {
    clearLine();
    process.stdout.write(`  ${frames[i % frames.length]} ${label ?? ""}`);
    i++;
  }, 80);
  return () => {
    clearInterval(interval);
    clearLine();
  };
}
```

---

### 10. Typed Error Classes

```typescript
// packages/core/src/errors.ts

export class LGTMAuthError extends Error {
  public readonly statusCode?: number;
  public readonly provider?: string;

  constructor(message: string, opts?: { statusCode?: number; provider?: string }) {
    super(message);
    this.name = "LGTMAuthError";
    this.statusCode = opts?.statusCode;
    this.provider = opts?.provider;
  }
}

export class LGTMNetworkError extends Error {
  public readonly cause?: string;
  public readonly endpoint?: string;

  constructor(message: string, opts?: { cause?: string; endpoint?: string }) {
    super(message);
    this.name = "LGTMNetworkError";
    this.cause = opts?.cause;
    this.endpoint = opts?.endpoint;
  }
}

export class LGTMConfigError extends Error {
  public readonly filePath?: string;
  public readonly field?: string;

  constructor(message: string, opts?: { filePath?: string; field?: string }) {
    super(message);
    this.name = "LGTMConfigError";
    this.filePath = opts?.filePath;
    this.field = opts?.field;
  }
}
```

Usage in provider.ts:

```typescript
if (res.status === 401 || res.status === 403) {
  throw new LGTMAuthError(`Authentication failed: ${res.status}`, {
    statusCode: res.status,
    provider: config.provider,
  });
}
if (message.includes("timeout") || message.includes("ECONNREFUSED")) {
  throw new LGTMNetworkError(`Connection failed: ${message}`, {
    cause: message,
    endpoint: baseUrl,
  });
}
```

---

### 11. Constants

```typescript
// packages/core/src/constants.ts

// Provider identifiers
export const PROVIDER_OPENAI = "openai" as const;
export const PROVIDER_ANTHROPIC = "anthropic" as const;
export const PROVIDER_OLLAMA = "ollama" as const;
export const PROVIDER_GEMINI = "gemini" as const;
export const PROVIDER_OPENROUTER = "openrouter" as const;

// Onboarding question IDs
export const Q_STORAGE_MODE = "storageMode" as const;
export const Q_GOAL = "goal" as const;
export const Q_QUALITY_REFS = "qualityReferences" as const;
export const Q_FEEDBACK_STYLE = "feedbackStyle" as const;
export const Q_TEAM_SIZE = "teamSize" as const;
export const Q_AI_PROVIDER = "aiProvider" as const;
export const Q_AI_MODEL = "aiModel" as const;
export const Q_AI_KEY = "aiApiKey" as const;

// Configuration keys
export const CONFIG_STORAGE_MODE = "storageMode" as const;
export const CONFIG_AI_ENABLED = "ai.enabled" as const;
export const CONFIG_AI_PROVIDER = "ai.provider" as const;
export const CONFIG_AI_MODEL = "ai.model" as const;
export const CONFIG_WEBAPP_ENABLED = "webapp.enabled" as const;
```

---

### 12. AITab State Persistence

The AITab uses `useLGTMContext()` to access the OKF store and persists provider/model changes:

```typescript
// Inside AITab component
const { ctx } = useLGTMContext();

async function persistSelection(provider: string, model: string) {
  const profile = await ctx.store.read("profile.md");
  if (profile) {
    const updatedData = {
      ...profile.data,
      ai: { ...profile.data.ai as object, provider, model, enabled: true },
    };
    await ctx.store.write("profile.md", updatedData, profile.content);
  }
}
```

On mount, AITab reads the persisted provider/model from the store and initializes state accordingly.

---

### 13. TUI Component Library

#### Spinner Component

```typescript
// packages/core/src/tui/components/Spinner.tsx
import React, { useState, useEffect } from "react";
import { Text } from "ink";

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

interface SpinnerProps {
  label?: string;
}

export function Spinner({ label }: SpinnerProps) {
  const [frame, setFrame] = useState(0);

  useEffect(() => {
    const timer = setInterval(() => {
      setFrame((f) => (f + 1) % FRAMES.length);
    }, 80);
    return () => clearInterval(timer);
  }, []);

  return (
    <Text>
      <Text color="cyan">{FRAMES[frame]}</Text>
      {label ? <Text> {label}</Text> : null}
    </Text>
  );
}
```

#### HelpOverlay Component

```typescript
// packages/core/src/tui/components/HelpOverlay.tsx
import React from "react";
import { Box, Text } from "ink";

interface ShortcutGroup {
  category: string;
  shortcuts: Array<{ key: string; description: string }>;
}

interface HelpOverlayProps {
  groups: ShortcutGroup[];
}

export function HelpOverlay({ groups }: HelpOverlayProps) {
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="gray" padding={1}>
      <Text bold>Keyboard Shortcuts</Text>
      {groups.map((group) => (
        <Box key={group.category} flexDirection="column" marginTop={1}>
          <Text bold underline>{group.category}</Text>
          {group.shortcuts.map((s) => (
            <Text key={s.key}>
              <Text color="cyan">{s.key.padEnd(12)}</Text>
              <Text>{s.description}</Text>
            </Text>
          ))}
        </Box>
      ))}
      <Box marginTop={1}>
        <Text color="gray">Press ? or Esc to close</Text>
      </Box>
    </Box>
  );
}
```

#### EmptyState Component

```typescript
// packages/core/src/tui/components/EmptyState.tsx
import React from "react";
import { Box, Text } from "ink";

interface EmptyStateProps {
  icon: string;
  message: string;
  actionHint: string;
}

export function EmptyState({ icon, message, actionHint }: EmptyStateProps) {
  return (
    <Box flexDirection="column" alignItems="center" marginY={2}>
      <Text>{icon}</Text>
      <Text color="gray">{message}</Text>
      <Text color="cyan" dimColor>{actionHint}</Text>
    </Box>
  );
}
```

#### Breadcrumb Component

```typescript
// packages/core/src/tui/components/Breadcrumb.tsx
import React from "react";
import { Box, Text } from "ink";

interface BreadcrumbProps {
  segments: string[];
}

export function Breadcrumb({ segments }: BreadcrumbProps) {
  return (
    <Box marginBottom={1}>
      {segments.map((seg, i) => (
        <Text key={i}>
          {i > 0 ? <Text color="gray"> › </Text> : null}
          {i === segments.length - 1 ? (
            <Text bold>{seg}</Text>
          ) : (
            <Text color="gray">{seg}</Text>
          )}
        </Text>
      ))}
    </Box>
  );
}
```

#### Confirmation Component

```typescript
// packages/core/src/tui/components/Confirmation.tsx
import React from "react";
import { Box, Text, useInput } from "ink";

interface ConfirmationProps {
  message: string;
  onConfirm: () => void;
  onCancel: () => void;
}

export function Confirmation({ message, onConfirm, onCancel }: ConfirmationProps) {
  useInput((input, key) => {
    if (input === "y" || input === "Y" || key.return) onConfirm();
    if (input === "n" || input === "N" || key.escape) onCancel();
  });

  return (
    <Box>
      <Text color="yellow">⚠ {message} </Text>
      <Text color="gray">[y/n]</Text>
    </Box>
  );
}
```

---

### 14. AITab Scrolling and Keyboard Navigation

The AITab provider list uses a viewport pattern with `j`/`k` navigation:

```typescript
const VIEWPORT_SIZE = Math.max(termHeight - 15, 5);
const [cursorIdx, setCursorIdx] = useState(0);
const [scrollOffset, setScrollOffset] = useState(0);

useInput((input) => {
  if (input === "j") {
    setCursorIdx((prev) => Math.min(prev + 1, providers.length - 1));
    // Adjust scroll if cursor moves below viewport
    if (cursorIdx - scrollOffset >= VIEWPORT_SIZE - 1) {
      setScrollOffset((prev) => prev + 1);
    }
  }
  if (input === "k") {
    setCursorIdx((prev) => Math.max(prev - 1, 0));
    if (cursorIdx - scrollOffset <= 0 && scrollOffset > 0) {
      setScrollOffset((prev) => prev - 1);
    }
  }
});

// Render only visible slice
const visibleProviders = providers.slice(scrollOffset, scrollOffset + VIEWPORT_SIZE);
```

---

### 15. Destructive Action Confirmation

Before executing destructive actions, components display the `<Confirmation>` component:

```typescript
const [pendingAction, setPendingAction] = useState<(() => void) | null>(null);
const [confirmMessage, setConfirmMessage] = useState("");

function initiateProviderSwitch(provider: DetectedProvider) {
  setConfirmMessage(`Switch to ${provider.name}?`);
  setPendingAction(() => () => applyProviderSwitch(provider));
}

// In render:
{pendingAction ? (
  <Confirmation
    message={confirmMessage}
    onConfirm={() => { pendingAction(); setPendingAction(null); }}
    onCancel={() => setPendingAction(null)}
  />
) : (
  // ... normal content
)}
```

---

### 16. Persistent Tab Selection

The Shell persists the active tab to OKF store on every tab switch:

```typescript
// In Shell.tsx
const { ctx } = useLGTMContext();

useEffect(() => {
  const tabId = enabledTabs[activeTabIdx]?.name;
  if (tabId) {
    ctx.store.write("ui-state.md", { lastTab: tabId }, "# UI State\n\nPersisted TUI state.");
  }
}, [activeTabIdx]);

// On mount: restore from store
useEffect(() => {
  ctx.store.read("ui-state.md").then((doc) => {
    if (doc?.data?.lastTab) {
      const idx = enabledTabs.findIndex((t) => t.name === doc.data.lastTab);
      if (idx >= 0) setActiveTabIdx(idx);
      // If not found, stays at 0 (fallback to first tab)
    }
  });
}, []);
```

---

### 17. ReviewTab Breadcrumb Navigation

```typescript
// In ReviewTab.tsx
import { Breadcrumb } from "./components/Breadcrumb.js";

function ReviewTab() {
  const [view, setView] = useState<"queue" | "review">("queue");
  const [currentPR, setCurrentPR] = useState<number | null>(null);

  const segments = view === "queue"
    ? ["Review", "Queue"]
    : ["Review", "Queue", `PR #${currentPR}`];

  return (
    <Box flexDirection="column">
      <Breadcrumb segments={segments} />
      {/* ... page content */}
    </Box>
  );
}
```

---

### 18. Inline Text Input for Model Change

```typescript
// In AITab.tsx
const [editingModel, setEditingModel] = useState(false);
const [modelInput, setModelInput] = useState("");

useInput((input, key) => {
  if (!editingModel && input === "m") {
    setEditingModel(true);
    setModelInput(state.currentModel);
    return;
  }
  if (editingModel) {
    if (key.escape) {
      setEditingModel(false);
      return;
    }
    if (key.return) {
      // Confirm: update model and persist
      setState((prev) => ({ ...prev, currentModel: modelInput }));
      persistSelection(state.currentProvider?.id ?? "", modelInput);
      setEditingModel(false);
      return;
    }
    // Handle text input characters
    if (key.backspace || key.delete) {
      setModelInput((prev) => prev.slice(0, -1));
    } else if (input && !key.ctrl && !key.meta) {
      setModelInput((prev) => prev + input);
    }
  }
});
```

---

### 19. Help Overlay Integration

```typescript
// In Shell.tsx
const [showHelp, setShowHelp] = useState(false);

useInput((input, key) => {
  if (input === "?") {
    setShowHelp((prev) => !prev);
    return;
  }
  if (key.escape && showHelp) {
    setShowHelp(false);
    return;
  }
});

// In render:
{showHelp ? (
  <HelpOverlay groups={getShortcutsForTab(enabledTabs[activeTabIdx]?.name)} />
) : (
  <ActivePage onStatusHint={setStatusHint} />
)}
```

---

### 20. Responsive Layout

```typescript
// In Shell.tsx
const isNarrow = termWidth < 60;
const isTall = termHeight > 30;

// Warning for narrow terminals
{isNarrow && (
  <Text color="yellow">⚠ Terminal too narrow ({termWidth} cols). Minimum recommended: 60.</Text>
)}

// Status bar: hide non-essential elements when narrow
<Box justifyContent="space-between" width={termWidth}>
  <Text color="gray">{statusHint}</Text>
  {!isNarrow && (
    <Text color="gray">
      {webappUrl ? `🌐 ${webappUrl}` : ""}
      {aiStatus?.available ? ` AI: ✓` : ""}
    </Text>
  )}
</Box>

// Two-line status bar when tall
{isTall ? (
  <Box flexDirection="column">
    <Text color="gray">{statusHint}</Text>
    <Text color="gray">{systemStatus}</Text>
  </Box>
) : (
  <Text color="gray">{statusHint} │ {systemStatus}</Text>
)}
```

---

## Data Models

### EventMap (typed events)

| Event | Payload | Trigger |
|-------|---------|---------|
| `config:changed` | `{ key: string; value: unknown }` | AI provider/model changed |
| `providers:updated` | `{ providers: string[] }` | Discovery completes |
| `tab:switched` | `{ tabId: string }` | User switches tab |
| `shutdown` | `undefined` | TUI exit initiated |

### UI State (persisted in OKF store as `ui-state.md`)

```yaml
---
lastTab: "review-queue"
---
# UI State
Persisted TUI state.
```

---

## Error Handling Strategy

| Error Type | Trigger | Recovery |
|------------|---------|----------|
| `LGTMAuthError` | 401/403 from LLM API | Show "Run `lgtm auth login <provider>`" hint |
| `LGTMNetworkError` | Timeout, ECONNREFUSED | Retry with backoff (existing), show offline status |
| `LGTMConfigError` | Invalid YAML, missing fields | Show file path + specific parse error |
| Corrupt profile.md | Unparseable frontmatter | Return null from loadProfile, trigger re-onboarding |
| Permission denied | EACCES on store dir | Log error, suggest `chmod` fix |

---

## Testing Strategy

### Test File Organization

```
packages/core/src/__tests__/
├── tui-components.test.tsx    # Ink component behavioral tests
├── performance.test.ts        # AI discovery performance budget
├── chaos.test.ts              # Corrupt data, permissions, concurrency
├── event-bus.test.ts          # Event bus contract tests
├── credentials.test.ts        # Credential manager tests
├── errors.test.ts             # Typed error classification tests
├── shutdown.test.ts           # Shutdown orchestration tests
├── bug-conditions.test.ts     # (existing)
└── preservation.test.ts       # (existing)
```

### Testing Tools

- **bun:test** — test runner with `describe`/`it`/`expect`
- **ink-testing-library** — render Ink components, simulate keyboard input via `stdin.write()`
- **Property testing** — use `fast-check` for property-based tests with minimum 100 iterations

---

## Correctness Properties

*A property is a characteristic or behavior that should hold true across all valid executions of a system—essentially, a formal statement about what the system should do. Properties serve as the bridge between human-readable specifications and machine-verifiable correctness guarantees.*

### Property 1: Profile Generation Equivalence

*For any* valid set of onboarding answers (goal, feedbackStyle, teamSize, aiProvider, aiModel, qualityReferences), the `generateProfileBody` function SHALL produce a markdown string containing all provided fields in the expected format, and parsing that markdown with `gray-matter` SHALL recover the original field values.

**Validates: Requirements 2.5**

### Property 2: Event Bus Delivery Contract

*For any* typed event name E and payload P, and for any set of N subscribers registered for E, emitting E with P SHALL invoke all N subscriber callbacks exactly once with the payload P.

**Validates: Requirements 5.1, 5.2**

### Property 3: Event Bus Unsubscribe Isolation

*For any* subscriber that calls `off(event, handler)`, subsequent `emit(event, payload)` calls SHALL NOT invoke that handler, while other subscribers for the same event continue to receive events.

**Validates: Requirements 5.5**

### Property 4: Shutdown Callback Reverse Order

*For any* sequence of N callbacks registered via `onShutdown`, invoking `runShutdown` SHALL call them in reverse registration order (LIFO), and if any callback throws, all remaining callbacks SHALL still be invoked.

**Validates: Requirements 7.2, 7.3**

### Property 5: Credential Resolution Priority

*For any* provider name where credentials exist in multiple sources (config, environment variable, saved file), `resolveKey(provider, config)` SHALL return the highest-priority source's value, following the order: config.apiKey > environment variable > saved credential.

**Validates: Requirements 8.1**

### Property 6: Credential Save/Load Round-Trip

*For any* provider name (non-empty alphanumeric string) and API key string, calling `saveKey(provider, key)` followed by `resolveKey(provider)` (with no config or env var set) SHALL return the identical key string.

**Validates: Requirements 8.2, 8.3**

### Property 7: Auth Error Classification

*For any* LLM API call that receives an HTTP response with status 401 or 403, the provider SHALL throw an instance of `LGTMAuthError` with the corresponding status code.

**Validates: Requirements 10.4**

### Property 8: Network Error Classification

*For any* LLM API call that encounters a timeout error or connection refused error (after exhausting retries), the provider SHALL throw an instance of `LGTMNetworkError`.

**Validates: Requirements 10.5**

### Property 9: Config Error on Invalid Input

*For any* string that is not valid YAML, or is valid YAML but missing required fields (storageMode), the config loader SHALL throw an instance of `LGTMConfigError` with a descriptive message.

**Validates: Requirements 10.6**

### Property 10: AITab State Persistence Round-Trip

*For any* valid provider identifier and model string, persisting them via the AITab (write to OKF store), then reloading the AITab (read from OKF store), SHALL restore the same provider and model values.

**Validates: Requirements 12.1, 12.2, 12.3**

### Property 11: LLM Test Determinism via Cache Isolation

*For any* ordering of LLM test cases, when each test resets the cache in `beforeEach`, the result of each individual test SHALL be identical regardless of execution order.

**Validates: Requirements 14.2**

### Property 12: Corrupt Profile Resilience

*For any* random byte sequence written to `profile.md` (including valid YAML with unexpected types, binary data, empty strings, and malformed frontmatter), `loadProfile` SHALL return `null` without throwing an unhandled exception.

**Validates: Requirements 16.1**

### Property 13: Concurrent Write Integrity

*For any* N concurrent write operations to the same OKF store file, the final file content SHALL be a complete, parseable OKF document (valid frontmatter + content) — never a partial mix of two concurrent writes.

**Validates: Requirements 16.3**

### Property 14: Cursor Navigation Bounds

*For any* list of N providers (N ≥ 1) and any current cursor position P (0 ≤ P < N), pressing `j` SHALL set the cursor to `min(P + 1, N - 1)` and pressing `k` SHALL set the cursor to `max(P - 1, 0)`.

**Validates: Requirements 18.3, 18.4**

### Property 15: Confirmation Cancel Preserves State

*For any* destructive action that triggers a confirmation prompt, selecting "no" (or pressing Escape) SHALL result in the application state being identical to the state before the action was initiated.

**Validates: Requirements 19.4**

### Property 16: Tab Persistence Round-Trip

*For any* valid tab identifier in the enabled tabs list, persisting it to the OKF store and then launching the TUI without a `--tab` argument SHALL result in the Shell initializing with that tab active. If the persisted identifier does not exist in the current tab list, the Shell SHALL fall back to index 0.

**Validates: Requirements 20.1, 20.2, 20.3**

### Property 17: Empty State Completeness

*For any* TUI page rendered with an empty data set, the rendered output SHALL contain at least one icon character, a non-empty descriptive message, and a non-empty action hint containing a keystroke or command reference.

**Validates: Requirements 24.1**

# Design: LGTM Platform

## Architecture Overview

Yak is a monorepo with a thin core and domain-specific plugins.

```
┌─────────────────────────────────────────────────────────────┐
│                         CLI Entry                             │
│              lgtm → TUI | lgtm <plugin> <cmd> → CLI            │
└──────────────────────────┬──────────────────────────────────┘
                           │
┌──────────────────────────┴──────────────────────────────────┐
│                      Core (packages/core)                     │
│                                                              │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────────┐   │
│  │  Plugin  │ │   TUI    │ │   LLM    │ │   Storage    │   │
│  │  Loader  │ │  Shell   │ │ Provider │ │  (OKF/md)    │   │
│  └────┬─────┘ └──────────┘ └──────────┘ └──────────────┘   │
│       │        ┌──────────┐ ┌──────────┐                    │
│       │        │  Config  │ │Onboarding│                    │
│       │        └──────────┘ └──────────┘                    │
└───────┼──────────────────────────────────────────────────────┘
        │
        │  Plugin Interface
        │
┌───────┼──────────────────────────────────────────────────────┐
│       ▼                                                      │
│              Plugins (packages/plugins/*)                     │
│                                                              │
│  ┌─────────────────┐  ┌──────────────┐  ┌──────────────┐   │
│  │  review          │  │  specify     │  │  learn       │   │
│  │  ─────────────── │  │  (stub)      │  │  (stub)      │   │
│  │  commands/       │  │              │  │              │   │
│  │  pages/          │  │              │  │              │   │
│  │  domain/         │  │              │  │              │   │
│  │  onboarding.ts   │  │              │  │              │   │
│  └─────────────────┘  └──────────────┘  └──────────────┘   │
│                                                              │
└──────────────────────────────────────────────────────────────┘
```

---

## Tech Stack

| Layer | Choice | Rationale |
|-------|--------|-----------|
| Runtime | Bun | Native TS, fast, built-in test/bundle |
| Structure | Bun workspace monorepo | Shared deps, plugin isolation |
| CLI | Commander.js | Simple, extensible, plugin-friendly |
| TUI | Ink 5 (React for CLI) | Component-based, evaluate OpenTUI later |
| Storage | Markdown + YAML frontmatter (OKF) | Human/agent readable, git-friendly |
| LLM | Raw fetch (no SDKs) | Minimal deps, full control |
| Config | cosmiconfig | Standard pattern, layered |
| Git | simple-git | Lightweight |
| GitHub | Octokit REST | Typed, official |
| Frontmatter | gray-matter | Parse/stringify YAML frontmatter |

---

## Plugin Interface

```typescript
// packages/core/src/plugin.ts

interface LGTMPlugin {
  name: string;                              // e.g., "review"
  description: string;                       // shown in `lgtm plugins`
  version: string;

  // Commands this plugin registers
  registerCommands(program: Command): void;

  // TUI pages this plugin provides (optional)
  pages?: TUIPage[];

  // Plugin-specific onboarding questions (optional)
  // Pre-filled from global profile, always skippable
  onboarding?: OnboardingStep[];

  // Called once when plugin is first enabled
  initialize?(ctx: LGTMContext): Promise<void>;
}

interface LGTMContext {
  config: PRRConfig;
  profile: ProjectProfile;
  store: OKFStore;
  llm: LLMProvider | null;          // null if AI disabled
  logger: Logger;
}

interface OnboardingStep {
  id: string;
  question: string;
  type: 'select' | 'multiselect' | 'text' | 'confirm';
  options?: string[];
  default?: string;                  // can reference profile values
  skipIf?: (profile: ProjectProfile) => boolean;
}
```

---

## Onboarding Flow

### Generic (Core) — on `lgtm init`

```typescript
interface ProjectProfile {
  project: string;                   // auto-detected from directory name
  goal: 'vibed' | 'production' | 'enterprise' | 'learning' | string;
  qualityReferences: string[];       // GitHub repo URLs
  feedbackStyle: 'direct' | 'gentle' | 'socratic' | 'minimal';
  techStack: string[];               // auto-detected + confirmed
  teamSize: 'solo' | 'small' | 'large';
  ai: {
    enabled: boolean;
    provider?: 'openai' | 'anthropic' | 'ollama';
    model?: string;
    baseUrl?: string;
  };
  createdAt: string;
}
```

### Plugin Override — on first plugin use

Each plugin can define additional questions. They:
- Are pre-filled from the global profile (e.g., review depth inherits from project goal)
- Are always skippable (`--skip-onboarding` or `s` key)
- Are stored in `.lgtm/plugins/<name>/config.md`

### Config Resolution Order

```
1. Built-in defaults (hardcoded)
2. Central or repo config (chosen on first start: ~/.lgtm/ or .lgtm/)
3. Global profile (profile.md in chosen config location)
4. Plugin config (.lgtm/plugins/<name>/config.md)
5. Repo override (.lgtmrc.yaml in repo root — always checked)
6. CLI flags (highest priority)
```

On first `lgtm init`, user chooses config location:
- **Central** (`~/.lgtm/`) — shared across all repos, good for solo devs
- **Per-repo** (`.lgtm/` in repo root) — committed to git, good for teams

Choice stored in `~/.lgtmrc` bootstrap file. Per-repo `.lgtmrc.yaml` always overrides regardless of mode.

---

## Project Structure

```
lgtm/
├── package.json                         # workspace root
├── bunfig.toml
├── tsconfig.json                        # base config
├── README.md
├── LICENSE
│
├── packages/
│   ├── core/
│   │   ├── package.json                 # @lgtm/core
│   │   ├── tsconfig.json
│   │   └── src/
│   │       ├── index.ts                 # main entry: CLI bootstrap
│   │       ├── plugin.ts                # Plugin interface + loader
│   │       ├── cli/
│   │       │   ├── program.ts           # Commander setup + plugin registration
│   │       │   └── commands/
│   │       │       ├── init.ts          # lgtm init (onboarding)
│   │       │       ├── config.ts        # lgtm config
│   │       │       ├── profile.ts       # lgtm profile
│   │       │       └── plugins.ts       # lgtm plugins list/enable/disable
│   │       ├── tui/
│   │       │   ├── Shell.tsx            # TUI shell (wraps plugin pages)
│   │       │   ├── components/
│   │       │   │   ├── StatusBar.tsx
│   │       │   │   ├── Header.tsx
│   │       │   │   └── Select.tsx       # reusable select input
│   │       │   └── theme.ts            # OpenCode-style colors/spacing
│   │       ├── onboarding/
│   │       │   ├── flow.ts             # generic onboarding runner
│   │       │   ├── questions.ts        # default questions
│   │       │   └── detect.ts           # auto-detect tech stack
│   │       ├── llm/
│   │       │   ├── provider.ts         # LLMProvider interface + factory
│   │       │   ├── openai.ts
│   │       │   ├── anthropic.ts
│   │       │   ├── ollama.ts
│   │       │   └── cache.ts            # content-hash based caching
│   │       ├── store/
│   │       │   ├── okf.ts             # readOKF / writeOKF
│   │       │   └── paths.ts           # resolve .lgtm/ directory paths
│   │       ├── config/
│   │       │   ├── loader.ts          # cosmiconfig + layered resolution
│   │       │   └── schema.ts          # config types + validation
│   │       └── utils/
│   │           ├── logger.ts
│   │           └── git.ts             # shared git utilities
│   │
│   └── plugins/
│       ├── review/
│       │   ├── package.json            # @lgtm/plugin-review
│       │   ├── tsconfig.json
│       │   └── src/
│       │       ├── index.ts            # plugin registration
│       │       ├── onboarding.ts       # review-specific questions
│       │       ├── commands/
│       │       │   ├── add.ts
│       │       │   ├── status.ts
│       │       │   ├── review.ts       # launches TUI
│       │       │   ├── approve.ts
│       │       │   ├── flag.ts
│       │       │   ├── rule.ts
│       │       │   ├── scan.ts
│       │       │   └── history.ts
│       │       ├── pages/
│       │       │   ├── QueuePage.tsx
│       │       │   └── ReviewPage.tsx
│       │       ├── components/
│       │       │   ├── DiffView.tsx
│       │       │   ├── CommentList.tsx
│       │       │   ├── CommentInput.tsx
│       │       │   ├── SummaryBanner.tsx
│       │       │   ├── FeatureGroups.tsx
│       │       │   └── RuleViolation.tsx
│       │       └── domain/
│       │           ├── types.ts
│       │           ├── queue.ts
│       │           ├── review-session.ts
│       │           ├── rules.ts
│       │           ├── grouping.ts
│       │           ├── patterns.ts
│       │           └── diff-parser.ts
│       │
│       ├── specify/
│       │   ├── package.json            # @lgtm/plugin-specify
│       │   └── src/
│       │       └── index.ts            # stub: registers name + description
│       │
│       └── learn/
│           ├── package.json            # @lgtm/plugin-learn
│           └── src/
│               └── index.ts            # stub
│
├── .lgtm/                               # runtime data (gitignored partially)
│   ├── profile.md                      # project profile
│   ├── plugins/
│   │   └── review/
│   │       └── config.md
│   ├── rules/                          # rules (committed to repo)
│   ├── sessions/                       # review sessions (gitignored)
│   └── learnings/                      # future: learning notes
│
└── .kiro/
    └── specs/
        └── lgtm/
            ├── requirements.md
            ├── design.md
            └── tasks.md
```

---

## Storage: OKF Format

All data uses Markdown + YAML frontmatter. See previous design doc for detailed format examples (profile.md, session index, PR review, rules).

Key principle: **every file in `.lgtm/` is browsable as markdown** — in GitHub, Obsidian, or just `cat`.

---

## TUI Design

OpenCode-style: full-screen, vertical scroll, minimal chrome, keyboard-driven.

**Entry point:** Just run `lgtm` — opens the TUI. `lgtm tui review` jumps directly to a tab.

Core provides the shell (header with plugin tabs, status bar, page routing). Plugins provide pages rendered inside their tab.

```
┌─────────────────────────────────────────────────────────────┐
│  👍 lgtm                          [ Review | Specify | Learn ]│  ← Header + tabs
├─────────────────────────────────────────────────────────────┤
│                                                              │
│           (Active plugin tab content renders here)           │  ← Plugin page
│                                                              │
├─────────────────────────────────────────────────────────────┤
│  [keys] context-sensitive help                    : command  │  ← StatusBar + command palette
└─────────────────────────────────────────────────────────────┘
```

All CLI commands are also executable within the TUI via a command palette (`:` to open, type command). This ensures feature parity between CLI and TUI.

---

## LLM Integration

Same as before — see review plugin design for enforcement details (regex + LLM hybrid, scoped to changed files, repo-wide on-demand).

Provider interface lives in core. Plugins call it through `LGTMContext.llm`.

---

## Hackathon MVP Scope

**Core:** CLI bootstrap, plugin loader, config, OKF store, onboarding flow
**Review plugin:** Queue, TUI (diff + comments), rules (hybrid), feature grouping
**Stubs:** specify + learn plugins (registered but not implemented)

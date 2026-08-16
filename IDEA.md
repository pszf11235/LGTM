# 🦬 Yak — Stop Shaving, Start Shipping

> A personal dev productivity platform with plugins. The tool that eliminates yak shaving.

## What Is Yak?

Yak is a **CLI + TUI platform** for developer productivity — a single tool with an extensible plugin system that grows with your workflow. Instead of cobbling together 10 different tools, you have one coherent system that shares context, rules, and intelligence across everything you do.

## Why "Yak"?

**Yak shaving** = the endless chain of prerequisite tasks before you can do what you actually want. Yak is the tool that breaks that chain.

```
Without Yak:  "I need to review 5 PRs" → open GitHub → context switch × 5 → forget what PR #2 did → yak shave
With Yak:     "yak review add 101-105" → structured review → rules accumulate → less yak shaving over time
```

## Architecture: Core + Plugins

```
┌─────────────────────────────────────────────┐
│               🦬 Yak                         │
│       Dev Productivity Platform              │
├─────────────────────────────────────────────┤
│                                              │
│  Core:                                       │
│    CLI framework + plugin loader             │
│    TUI shell (OpenCode-style)                │
│    LLM provider abstraction                  │
│    OKF-style storage (markdown + frontmatter)│
│    Config system + onboarding                │
│                                              │
│  Plugins:                                    │
│    ✅ review  — PR review harness            │
│    ○  specify — codebase analysis + diagrams │
│    ○  learn   — interactive learning paths   │
│    ○  brain   — second brain / knowledge OS  │
│                                              │
└─────────────────────────────────────────────┘
```

### What the core provides (shared by all plugins):
- CLI framework with plugin auto-discovery
- TUI shell (OpenCode-style, full-screen, keyboard-driven)
- LLM provider abstraction (OpenAI / Anthropic / Ollama)
- OKF-style storage (Markdown + YAML frontmatter — human & agent readable)
- Config system (global → plugin → per-repo → CLI flags)
- Onboarding flow (generic, overrideable per plugin)

### What plugins provide:
- Their own commands (namespaced: `yak review add`, `yak specify analyze`)
- Their own TUI pages (registered into the shell)
- Their own domain logic, rules, and storage
- Access to all core services

## Onboarding

On first run, Yak asks questions to understand your project context:

```
┌─────────────────────────────────────────────────────────────┐
│  🦬 Welcome to Yak! Let's set up your workspace.            │
│                                                              │
│  1/6  What are this project's goals?                         │
│                                                              │
│  ○ Vibed — exploring/prototyping, speed over quality         │
│  ● Production — shipping to real users, reliability matters  │
│  ○ Enterprise — compliance, audit trails, team standards     │
│  ○ Learning — building to understand a tech stack            │
│                                                              │
├─────────────────────────────────────────────────────────────┤
│  [↑↓] select  [enter] confirm  [s] skip  [q] quit          │
└─────────────────────────────────────────────────────────────┘
```

Questions:
1. **Project goals** — vibed/production/enterprise/learning
2. **Quality references** — repos you aspire to code-quality wise
3. **Feedback style** — direct/gentle/socratic/minimal
4. **Tech stack** — auto-detected, confirm/adjust
5. **Team size** — solo/small/large
6. **LLM preference** — provider + model

This creates a **project profile** that all plugins use. Plugins can extend with their own questions (pre-filled from the profile, always skippable).

### Override Chain

```
Generic profile → Plugin config → Per-repo .yakrc.yaml → CLI flags
```

## CLI Usage

```bash
# First time setup
yak init                           # interactive onboarding

# Plugin management
yak plugins                        # list plugins + status
yak plugins enable specify         # enable a plugin
yak plugins disable learn          # disable

# Review plugin (first shipping plugin)
yak review add 101 102 103         # queue PRs
yak review status                  # show queue with feature groups
yak review tui                     # open TUI for review session
yak review approve 101             # mark approved
yak review flag 103 --reason "..." # flag with reason
yak review rule add "..."          # create review rule
yak review scan                    # repo-wide rule check

# Future plugins
yak specify analyze ./src          # codebase analysis
yak specify focus ./src/auth       # zoom into a module
yak learn start --topic "Rust"     # start learning path

# Global
yak config                         # view/edit config
yak profile                        # view/edit project profile
```

## First Plugin: Review

The PR review harness. Full details in `.kiro/specs/yak/requirements.md`.

Key features:
- **Queue & workflow** — structured review of multiple PRs
- **OpenCode-style TUI** — full-screen diff view with inline comments
- **Feature grouping** — auto-detect related PRs (shared endpoints, files)
- **Ruleify** — capture review patterns as enforceable rules (regex + LLM)
- **Hybrid enforcement** — regex for obvious patterns, LLM for conceptual rules
- **Comment pattern analysis** — mine your review history, suggest rules
- **Dual mode** — local (markdown) or GitHub (post reviews to PRs)

## Tech Stack

- **Runtime:** Bun
- **Language:** TypeScript (strict)
- **TUI:** Ink (OpenCode-style) — evaluate OpenTUI migration post-hackathon
- **Storage:** OKF-inspired (Markdown + YAML frontmatter)
- **LLM:** Raw fetch to OpenAI/Anthropic/Ollama (no heavy SDKs)
- **Structure:** Bun workspace monorepo (packages/core + packages/plugins/*)

## Design Principles

1. **Not an LLM wrapper** — core functionality works with zero tokens
2. **Token efficient** — LLM called sparingly, results cached aggressively
3. **Persistent** — everything saved to readable markdown files
4. **Plugin-first** — core is thin, plugins carry the domain logic
5. **Human-in-the-loop** — AI assists, human decides
6. **Local-first** — works offline, data stays on your machine

## Status

🚧 **In Development** — Hackathon project (Ready, Spec, Ship — Aug 23, 2026)

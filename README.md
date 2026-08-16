# 🦬 Yak — Stop Shaving, Start Shipping

> AI coding agents let you generate 5 PRs in an hour. But now **you** need to review them. Yak is the structured review environment that breaks the bottleneck.

**Yak** is a developer productivity platform with a plugin architecture. It provides a CLI + TUI for structured PR review with rules, auto-grouping, pattern analysis, and persistent review history — all stored as human-readable markdown.

## The Problem

```
Before AI agents:  Write 1-2 PRs/day → review naturally → manageable
After AI agents:   5+ PRs in an hour → review in one chat window → chaos
```

Current tools review PRs in isolation. But you're juggling related PRs, repeating the same feedback, and losing context between sessions. Yak fixes this.

## What Yak Does That an LLM Cannot

| Capability | LLM alone | With Yak |
|---|---|---|
| Persist reviews across sessions | ❌ Stateless | ✅ Saved as markdown |
| Enforce rules automatically | ❌ Forgets | ✅ Regex + LLM enforcement |
| Detect PR relationships | ❌ No context | ✅ Auto-grouping by shared files |
| Track review patterns | ❌ No memory | ✅ Suggests rules from your behavior |
| Navigate diffs in terminal | ❌ Text only | ✅ Full TUI with cursor + comments |
| Post reviews to GitHub | ❌ Can't call APIs | ✅ Native integration |

## Quick Start

```bash
# Install
git clone https://github.com/pszf11235/yak.git && cd yak
bun install

# First-time setup (interactive)
bun run yak init

# Add PRs to review queue (demo mode for testing)
bun run yak review add 101 102 103 --demo

# Open the TUI
bun run yak

# Or use CLI directly
bun run yak review status
bun run yak review approve 101
```

## Features

### 📋 Review Queue & Workflow
```bash
yak review add 101 102 103    # Queue PRs
yak review status              # See queue with states + groups
yak review approve 101         # Approve
yak review flag 102 -r "..."   # Flag with reason
```

### ⚡ Feature Grouping
PRs that touch the same directories or files are automatically grouped:
```
Feature Groups:
⚡ Auth changes — PRs #101, #103
   PRs share directory: src/auth/
```

### 📺 Full-Screen TUI
```
🦬 yak                                    [ Review | Specify | Learn ]
reviewing: my-project  /path/to/repo
──────────────────────────────────────────────────────────────────────
  PR #101: Add OAuth
  +5 -2  2 file(s)  [group-auth]

  ── src/auth/login.ts ──
  @@ -1,8 +1,12 @@ export function login
▶  1  import { hash } from './crypto';
   2 +import { validateInput } from './validation';
   ...

  j/k move  n/N file  h/H hunk  c comment  a approve  f flag  q back
```

### 🔒 Rules Engine (Ruleify)
Create rules from review patterns — enforced automatically on future PRs:

```bash
# Create a rule (regex enforcement — zero tokens)
yak review rule add "No hardcoded secrets" \
  --pattern '(api_key|secret)\s*=\s*"[^"]{8,}"' \
  --category security --severity error

# Or import from existing docs
yak review rule import CLAUDE.md

# Scan entire repo
yak review scan

# Export as git hook / AI steering / ESLint
yak review rule export --format hook -o .git/hooks/pre-commit
```

Rules support **hybrid enforcement**:
- **Regex**: instant, zero tokens, pattern matching
- **LLM**: conceptual rules with examples, scoped to changed files only

### 🤖 AI Features (Optional, Token-Efficient)
```bash
yak ai test                    # Verify AI connection
yak ai model llama3.2          # Set model
yak review rule suggest        # Mine your comments for patterns
```

- Works with: OpenAI, Anthropic, **Ollama (local/private)**
- Auto-starts `ollama serve` if local LLM selected
- All AI features are optional — tool works fully without them
- Aggressive caching (never re-calls for same input)

### 💾 OKF Storage (Human + Agent Readable)
All data stored as Markdown + YAML frontmatter:
```yaml
---
type: yak/review
pr: 101
title: "Add OAuth2 PKCE flow"
state: approved
comments_count: 3
---
# Review: PR #101 — Add OAuth2 PKCE flow

## Comments
### src/auth/oauth.ts
- **L14:** Why not use passport.js?
- **L38:** MUST be env var. Never hardcode secrets.
```

Browsable in GitHub, Obsidian, or any markdown viewer.

## Architecture

```
yak/
├── packages/core/          # CLI, TUI, LLM, OKF store, onboarding
└── packages/plugins/
    ├── review/             # PR review (active)
    ├── specify/            # Codebase analysis (planned)
    └── learn/              # Learning paths (planned)
```

**Plugin-first**: thin core, domain logic in plugins. Add a folder = add a plugin.

## Configuration

```bash
yak init                   # Interactive setup
yak config                 # View current config
yak config --edit          # Re-run setup to change
yak ai model <name>       # Switch model
```

Storage modes (chosen during init):
- **Per-repo** (`.yak/`): committed to git, shared with team
- **Yak-farm** (`~/.yak-farm/`): central location, cross-repo queries

## Commands Reference

| Command | Description |
|---------|-------------|
| `yak` | Open TUI (or run onboarding if first time) |
| `yak init` | Interactive setup |
| `yak config` | View/edit configuration |
| `yak ai test` | Test AI connection |
| `yak ai model [name]` | Show/set AI model |
| `yak plugins` | List plugins |
| `yak review add <prs...>` | Queue PRs for review |
| `yak review status` | Show queue |
| `yak review approve <pr>` | Approve a PR |
| `yak review flag <pr> -r "..."` | Flag with reason |
| `yak review rule add "..."` | Create a rule |
| `yak review rule list` | List rules |
| `yak review rule import [file]` | Import from CLAUDE.md etc. |
| `yak review rule export -f hook` | Export as git hook |
| `yak review rule suggest` | AI suggests rules from patterns |
| `yak review scan` | Check whole repo against rules |

## Development

```bash
bun install              # Install deps
bun run yak              # Run CLI
bun test                 # Run tests
task check               # Lint + test + build
task slaughter           # 🪓 Full cleanup (fresh start)
task info                # Show yak state
```

## Tech Stack

- **Runtime**: Bun
- **Language**: TypeScript (strict)
- **TUI**: Ink (React for terminals)
- **Storage**: OKF-inspired (Markdown + YAML frontmatter)
- **LLM**: Raw fetch (OpenAI/Anthropic/Ollama — no heavy SDKs)
- **Git**: simple-git
- **GitHub**: REST API via fetch

## Roadmap

- [ ] Learnify — learning notes from wrong assumptions during review
- [ ] Specify plugin — codebase analysis + mermaid diagrams
- [ ] Learn plugin — AI-generated curricula for new tech stacks
- [ ] Multi-repo review (owner/repo#PR format)
- [ ] Side-by-side diff view
- [ ] Task-to-model routing (different LLMs for different tasks)
- [ ] OpenTUI migration (Zig-powered rendering)

## License

MIT

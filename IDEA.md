# PRR — PR Review Harness

> A structured review environment for developers who generate PRs faster than they can review them.

## The Problem

AI coding agents (Claude Code, Codex, Kiro Autonomous) let you kick off 5+ PRs in an hour. But now **you** need to review your own AI-generated code. Current workflow:

- Open Claude Code → "review PR #123" → wall of text in the same chat window
- No history — review is lost when you scroll up or start a new session
- No separation — reviewing 5 PRs in one chat = context soup, agent clobbers its own analysis
- No persistence — can't refer back to what you found in PR #2 when reviewing PR #4
- No workflow — no approve/flag/comment flow, just vibes
- No learning — same mistakes repeat because nothing is captured as rules

**The bottleneck has moved from writing code to reviewing code.**

## The Solution

PRR is a **structured review workspace** — a TUI + CLI tool that provides workflow, persistence, and structure around the review process. The LLM is an optional helper (summary, pattern detection), not the product.

## Core Principles

1. **Not an LLM wrapper** — 80% of functionality works with zero tokens
2. **Token efficient** — LLM is called sparingly for summaries and pattern detection, not for every action
3. **Persistent** — every review, comment, and rule is saved to disk
4. **Structured** — clear workflow states (queued → reviewing → approved/flagged)
5. **Configurable** — local-only mode (markdown files) OR full GitHub integration

## Features

### 1. Review Queue & Workflow
```bash
prr add 101 102 103 104 105      # queue PRs for review
prr status                        # see all PRs, their state, AI summaries
prr review 101                    # enter focused review mode
prr approve 101                   # mark reviewed
prr flag 103 --reason "breaks API contract"
```

### 2. TUI (Split Pane Review)
```
┌────────────────────────────────┬────────────────────────────────────┐
│  PR #101: Add OAuth flow       │  💬 Your Comments                  │
│  ─────────────────────────     │                                    │
│  📋 AI Summary:                │  L14: why not use passport.js?     │
│  Adds OAuth2 PKCE flow.        │                                    │
│  Touches 4 files.              │  L38: this should be env var       │
│  ⚠️ No tests added.            │                                    │
│                                │  L52: [rule] always validate       │
│  --- src/auth/oauth.ts ---     │      redirect_uri → create hook    │
│  @@ -1,4 +1,28 @@              │                                    │
│  + import { PKCE } from ...    │                                    │
│  + export async function       │                                    │
│  +   initiateOAuth(...)        │                                    │
├────────────────────────────────┴────────────────────────────────────┤
│ [n]ext PR  [c]omment  [a]pprove  [f]lag  [r]ule  [q]uit     1/5   │
└─────────────────────────────────────────────────────────────────────┘
```

- Left pane: scrollable diff with AI summary at top
- Right pane: your comments (linked to line numbers)
- Keyboard-driven navigation

### 3. Dual Mode (Local / GitHub)
- **Local mode:** Reviews saved as markdown files. Comments stay local. Good for personal review before pushing feedback.
- **GitHub mode:** Comments posted as PR review via GitHub API. Approve/request-changes mapped to GitHub review states.
- Configurable per session or globally.

### 4. Ruleify (🔥 Key Differentiator)
When you notice patterns during review — the AI keeps making the same mistake, or you keep writing the same comment — capture it as a rule:

```bash
prr rule add "Always use environment variables for secrets"
prr rule add "New endpoints require integration tests"
prr rule add "Prefer named exports over default exports"
```

Rules are then:
- **Enforced in future reviews** — PRR flags violations automatically (no LLM needed for exact matches, regex/AST for patterns)
- **Exportable** as enforcement mechanisms:
  ```bash
  prr rule export --format hook      # → pre-commit/pre-push hook
  prr rule export --format test      # → test template
  prr rule export --format steering  # → .kiro/steering rule
  prr rule export --format eslint    # → ESLint rule config
  ```

The feedback loop:
```
Review PR → Notice pattern → Create rule → Rule prevents issue in future → Better AI output
```

### 5. AI Summary (Token-Efficient)
- One-shot summary per PR when first queued (~500-1000 tokens)
- Highlights: files changed, potential risks, test coverage, rule violations
- Optional — tool works fully without it
- Cached — never re-summarizes the same diff

### 6. Cross-PR Awareness
- Detects file overlap between queued PRs (algorithmic, no LLM)
- Flags potential conflicts or ordering dependencies
- Shows which PRs touch the same modules

### 7. Review History
- Every review session persisted to disk
- Searchable: "what did I flag last week about auth?"
- Stats: review velocity, common flags, rule effectiveness

## Output Structure

```
.prr/
  config.yaml                 # mode (local/github), LLM provider, preferences
  rules/
    rules.yaml                # your accumulated review rules
    hooks/                    # exported pre-commit hooks
  sessions/
    2026-08-15/
      pr-101.review.md        # structured findings + comments
      pr-102.review.md
      pr-103.review.md
      correlation.md          # cross-PR analysis
      session-summary.md      # what you reviewed, decisions made
  history/
    index.json                # searchable review history
```

## Tech Stack

- **Language:** TypeScript (Node.js)
- **TUI:** Ink (React for terminals) — component-based, testable
- **CLI:** Commander.js (for non-TUI commands)
- **Git/Diff:** simple-git + diff-parse (structured diff parsing)
- **GitHub:** Octokit (REST API for posting reviews)
- **LLM:** Provider abstraction (OpenAI/Anthropic/Ollama) — optional
- **Storage:** Flat files (YAML + Markdown) — no database needed
- **Config:** cosmiconfig (.prrrc pattern)

## Token Budget

| Feature | Tokens | When |
|---|---|---|
| PR Summary | ~500-1000 | Once per PR, on queue |
| Pattern detection | ~200-500 | After review, if rules mode enabled |
| Everything else | 0 | Diff parsing, TUI, persistence, rules, GitHub |

**Total per review session (5 PRs):** ~3,000-7,500 tokens (≈ $0.01-0.03)
**Without LLM:** Fully functional, just no upfront summary.

## What PRR Does That An LLM Cannot

1. **Persist** — Reviews survive across sessions (LLMs are stateless)
2. **Structure** — Workflow states, queues, approval flow (LLMs don't track state)
3. **Render** — Split-pane TUI with navigation (LLMs output text only)
4. **Enforce** — Rules applied to future PRs automatically (LLMs don't have memory)
5. **Integrate** — Post to GitHub API, export hooks (LLMs can't call APIs)
6. **Correlate** — Detect file overlap across PRs algorithmically (no tokens needed)
7. **Accumulate** — Review history, stats, rule library (grows over time)

## Target Users

- Solo devs using AI agents who review their own PRs
- Small teams (2-5 devs) with high PR velocity from AI tooling
- Tech leads who review across multiple team members' AI-generated PRs
- Anyone frustrated with unstructured, ephemeral AI code reviews

## Status

🚧 **In Development** — Hackathon project (Ready, Spec, Ship — Aug 23, 2026)

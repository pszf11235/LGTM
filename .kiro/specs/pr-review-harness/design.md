# Design: PR Review Harness (PRR)

## Architecture Overview

PRR follows a **layered architecture** with clear separation between CLI/TUI presentation, domain logic, and infrastructure (git, GitHub, LLM, filesystem).

```
┌─────────────────────────────────────────────────────────────┐
│                    Presentation Layer                         │
│                                                              │
│  ┌──────────────┐    ┌──────────────────────────────────┐   │
│  │   CLI        │    │       TUI (OpenCode-style)        │   │
│  │ (Commander)  │    │  ┌────────────────────────────┐   │   │
│  │              │    │  │      Main Content Area      │   │   │
│  │ add/status/  │    │  │  (diff view / PR list /     │   │   │
│  │ approve/flag │    │  │   review details)           │   │   │
│  │ rule/history │    │  ├────────────────────────────┤   │   │
│  └──────┬───────┘    │  │      Input / Command Bar    │   │   │
│         │            │  └────────────────────────────┘   │   │
│         │            │  ┌────────────────────────────┐   │   │
│         │            │  │      Status / Breadcrumb    │   │   │
│         │            │  └────────────────────────────┘   │   │
│         │            └──────────────┬───────────────────┘   │
│         │                           │                        │
└─────────┼───────────────────────────┼────────────────────────┘
          │                           │
┌─────────┼───────────────────────────┼────────────────────────┐
│         ▼                           ▼                        │
│                    Domain Layer                               │
│                                                              │
│  ┌────────────┐  ┌────────────┐  ┌────────────┐            │
│  │   Queue    │  │  Review    │  │   Rules    │            │
│  │  Manager   │  │  Session   │  │   Engine   │            │
│  └─────┬──────┘  └─────┬──────┘  └─────┬──────┘            │
│        │               │               │                    │
│  ┌─────┴───────────────┴───────────────┴──────┐            │
│  │              State Manager                   │            │
│  │  (tracks PR states, session lifecycle)       │            │
│  └──────────────────────┬───────────────────────┘            │
│                         │                                    │
└─────────────────────────┼────────────────────────────────────┘
                          │
┌─────────────────────────┼────────────────────────────────────┐
│                         ▼                                    │
│                 Infrastructure Layer                          │
│                                                              │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐   │
│  │   Git    │  │  GitHub  │  │   LLM    │  │  Store   │   │
│  │ Adapter  │  │ Adapter  │  │ Adapter  │  │(OKF/md)  │   │
│  └──────────┘  └──────────┘  └──────────┘  └──────────┘   │
│                                                              │
└──────────────────────────────────────────────────────────────┘
```

---

## Tech Stack Decisions

| Layer | Choice | Rationale |
|-------|--------|-----------|
| Language | TypeScript (strict mode) | Type safety, user wants to learn TS |
| Runtime | Bun | Fast startup, built-in TS execution, test runner, great DX |
| Package manager | Bun (built-in) | No separate package manager needed |
| CLI framework | Commander.js | Simple, well-documented, zero magic |
| TUI framework | OpenTUI (Zig core + TS bindings) | OpenCode-style UX, high performance, React component model. Fallback: Ink 5 if OpenTUI proves too bleeding-edge |
| Diff parsing | parse-diff | Structured diff parsing from git output |
| Git operations | simple-git | Lightweight git wrapper, no binary deps |
| GitHub API | Octokit (REST) | Official, typed, well-maintained |
| LLM integration | Custom provider abstraction (raw fetch) | Token-efficient, no heavy SDK deps |
| Config | cosmiconfig | Standard `.prrrc` / `prr.config.yaml` pattern |
| Storage | **OKF-inspired** (Markdown + YAML frontmatter) | Human-readable, agent-readable, git-friendly — see Storage section |
| Build | Bun (native bundler) | Zero-config for CLIs, fast |
| Testing | Bun test (built-in) | Fast, TS-native, no extra deps |

### Why Bun over Node/pnpm?
- Native TypeScript execution (no build step for dev)
- Built-in test runner (no Vitest/Jest dependency)
- Built-in bundler for production
- Faster dependency install
- Single tool instead of Node + pnpm + tsup + vitest

### TUI Framework Decision: OpenTUI vs Ink

OpenCode uses [OpenTUI](https://github.com/anomalyco/opentui) — a Zig-powered core with TypeScript bindings that provides the polished, responsive feel we want. Key advantages:

- React component model (familiar, composable)
- High performance rendering (native Zig core)
- Runs on Bun natively
- Powers OpenCode in production (proven)

**Risk:** OpenTUI is relatively new. If integration proves problematic in the hackathon timeframe, we fall back to Ink 5 (React for CLI) which has the same component model but is pure JS.

---

## TUI Design: OpenCode-Style

Inspired by OpenCode's clean, minimal terminal UI:

### Main Layout

```
┌─────────────────────────────────────────────────────────────────────┐
│  PRR ─ review session                              pr-review-harness │
├─────────────────────────────────────────────────────────────────────┤
│                                                                      │
│  📋 PR #101: Add OAuth2 PKCE flow                                   │
│  ──────────────────────────────────────────────────────────────────  │
│                                                                      │
│  Summary: Adds OAuth2 PKCE flow to auth module. Touches 4 files.    │
│  ⚠️  No tests added. 1 rule violation (security).                    │
│                                                                      │
│  ── src/auth/oauth.ts ──────────────────────────────────────────── │
│                                                                      │
│   12 │   import { generateCodeVerifier } from './crypto';            │
│   13 │                                                               │
│   14 │ + export async function initiateOAuth(                        │
│   15 │ +   clientId: string,                                         │
│   16 │ +   redirectUri: string,                                      │
│   17 │ +   clientSecret: string = "sk_live_abc123"  ⚠️ [r-001]       │
│   18 │ + ) {                                                         │
│   19 │ +   const verifier = generateCodeVerifier();                  │
│   20 │ +   const challenge = await sha256(verifier);                 │
│                                                                      │
│  💬 Comments (2)                                                     │
│  ├─ L14: Why not use passport.js? Reinventing auth here.            │
│  └─ L17: MUST be env var. Never hardcode secrets. → rule created    │
│                                                                      │
├─────────────────────────────────────────────────────────────────────┤
│  > c comment  r rule  n next file  a approve  f flag  ? help   1/4  │
└─────────────────────────────────────────────────────────────────────┘
```

### Key UI Principles (from OpenCode):
1. **Full-screen, single-page focus** — one PR at a time, no split panes fighting for space
2. **Content flows vertically** — summary → diff → comments, natural reading order
3. **Command bar at bottom** — keyboard shortcuts always visible
4. **Minimal chrome** — header shows context, footer shows actions, middle is content
5. **Scrollable body** — entire middle area scrolls as one unit
6. **Inline decorations** — rule violations, comments shown in-context, not in separate panes

### Navigation Model

| Mode | What's Shown | How to Enter |
|------|---|---|
| **Queue** | List of all PRs with states, summaries | `prr tui` or default on launch |
| **Review** | Single PR: summary → diff → comments | Select PR from queue or `prr review <n>` |
| **Comment** | Text input overlay | `c` in review mode |
| **Rule** | Rule creation form | `r` in review mode |
| **History** | Past sessions, searchable | `h` from queue |

---

## Storage Format: OKF-Inspired

### Why OKF over YAML?

After evaluating [Google's Open Knowledge Format](https://cloud.google.com/blog/products/data-analytics/how-the-open-knowledge-format-can-improve-data-sharing):

| Factor | Plain YAML | OKF-Inspired (Markdown + YAML frontmatter) |
|--------|-----------|----------------------------------------------|
| Human-readable | 🟡 Okay for simple data | 🟢 Excellent — it's just markdown |
| Agent-readable | 🟡 Needs YAML parser | 🟢 Any LLM can read it raw |
| Git-friendly | 🟢 Yes | 🟢 Yes, even better diffs |
| Rich content (comments, analysis) | 🔴 Awkward in YAML | 🟢 Natural in markdown body |
| Structured metadata | 🟢 Native | 🟢 YAML frontmatter |
| Cross-linking | 🔴 Manual references | 🟢 Markdown links between files |
| Tool ecosystem | 🟡 Custom parsers | 🟢 Any markdown renderer, Obsidian, GitHub, etc. |

### Decision: **Markdown files with YAML frontmatter (OKF-style)**

This means:
- Each PR review = one `.md` file with structured frontmatter
- Queue state = one index file with frontmatter listing PRs
- Rules = one file per rule OR one consolidated rules file with frontmatter
- Everything is browsable in GitHub, Obsidian, any markdown viewer
- LLMs can consume the entire `.prr/` directory without parsing

### Storage Structure

```
.prr/
├── index.md                          # session index (OKF-style)
├── config.md                         # configuration with frontmatter
├── rules/
│   ├── index.md                      # rule registry
│   └── r-001-no-hardcoded-secrets.md # individual rule files
├── sessions/
│   └── 2026-08-15/
│       ├── index.md                  # session summary + queue state
│       ├── pr-101.md                 # review for PR #101
│       ├── pr-102.md                 # review for PR #102
│       └── analysis.md              # cross-PR analysis (feature grouping)
└── learnings/                        # (future) learnify notes
    └── ...
```

### File Formats

#### Session Index (`sessions/2026-08-15/index.md`)

```markdown
---
type: prr/session
date: 2026-08-15
status: in-progress
prs:
  - number: 101
    title: "Add OAuth2 PKCE flow"
    state: approved
    files_changed: 4
    group: auth-feature
  - number: 102
    title: "Fix rate limiter edge case"
    state: reviewing
    files_changed: 2
    group: performance
  - number: 103
    title: "Add /users endpoint"
    state: queued
    files_changed: 3
    group: auth-feature
feature_groups:
  - id: auth-feature
    label: "Authentication overhaul"
    prs: [101, 103]
    reason: "Both touch src/auth/ and /users endpoint depends on OAuth"
  - id: performance
    label: "Performance fixes"
    prs: [102]
---

# Review Session: August 15, 2026

## Feature Groups

PRs #101 and #103 both modify the authentication subsystem and share the 
`/users` endpoint. Recommend reviewing together for the next release.

## Progress

- ✅ PR #101 — Approved (3 comments, 1 rule violation fixed)
- 🔄 PR #102 — In review
- ⏳ PR #103 — Queued
```

#### PR Review (`sessions/2026-08-15/pr-101.md`)

```markdown
---
type: prr/review
pr: 101
title: "Add OAuth2 PKCE flow"
state: approved
reviewed_at: "2026-08-15T10:15:00Z"
files_changed: 4
comments_count: 3
rule_violations: 1
feature_group: auth-feature
---

# PR #101: Add OAuth2 PKCE flow

## Summary

Adds OAuth2 PKCE flow to auth module. New `initiateOAuth()` function handles
code verifier generation and token exchange. Touches auth controller, routes,
and adds new OAuth service module. No tests included.

## Feature Context

This PR is part of the **auth-feature** group along with PR #103 (Add /users 
endpoint). Both touch `src/auth/` — review for interactions.

## Rule Violations

- ⚠️ **[r-001 / security / error]** `src/auth/oauth.ts:17`
  Pattern matched: `clientSecret = "sk_live_abc123"`
  Rule: Always use environment variables for secrets, never hardcode

## Comments

### src/auth/oauth.ts

- **L14:** Why not use passport.js? Reinventing auth here.
- **L17:** MUST be env var. Never hardcode secrets. → Created rule r-001
- **L52:** Always validate redirect_uri against allowlist.

### src/routes/auth.ts

- **L8:** Missing rate limiting on this endpoint.

## Decision

✅ **Approved** — Issues noted are non-blocking. Rules created for future enforcement.
```

#### Rule File (`rules/r-001-no-hardcoded-secrets.md`)

```markdown
---
type: prr/rule
id: r-001
description: "Always use environment variables for secrets, never hardcode"
category: security
severity: error
enforcement: llm
pattern: null
file_pattern: "**/*.{ts,js,py}"
examples:
  bad:
    - 'const apiKey = "sk_live_abc123"'
    - 'password: "hunter2"'
  good:
    - 'const apiKey = process.env.API_KEY'
    - 'password: process.env.DB_PASSWORD'
created_at: "2026-08-15T10:15:00Z"
created_from: pr-101
enabled: true
times_triggered: 0
---

# Rule: No Hardcoded Secrets

## Description

Always use environment variables for secrets, API keys, tokens, and passwords.
Never hardcode sensitive values in source code.

## Examples

### ❌ Bad

```typescript
const apiKey = "sk_live_abc123";
const dbPassword = "hunter2";
```

### ✅ Good

```typescript
const apiKey = process.env.API_KEY;
const dbPassword = process.env.DB_PASSWORD;
```

## Enforcement

This rule uses **LLM-based enforcement** — the diff is sent to the LLM with this
rule description and examples to identify violations. This catches patterns that
simple regex cannot (e.g., secrets assigned via function calls, template literals).

## Origin

Created during review of PR #101 (Add OAuth2 PKCE flow) on 2026-08-15.
```

---

## Rule Enforcement: Hybrid Approach

### Two Enforcement Modes

| Mode | When Used | Token Cost | Accuracy |
|------|-----------|-----------|----------|
| **Regex** | Rule has an obvious pattern (e.g., `console.log`) | 0 tokens | Lower (false positives) |
| **LLM** | Rule is conceptual or needs context (e.g., "new endpoints need tests") | ~200-500 tokens per file | Higher (understands intent) |

### LLM Enforcement Design

```typescript
interface RuleEnforcementResult {
  ruleId: string;
  violations: {
    file: string;
    line: number;
    explanation: string;      // why this violates the rule
    suggestion?: string;      // how to fix it
  }[];
}
```

**LLM prompt structure for enforcement:**

```
You are reviewing code changes for rule violations.

Rule: {rule.description}
Examples of violations: {rule.examples.bad}
Examples of correct code: {rule.examples.good}

Changed files (diff):
{diff of changed files only}

Identify any violations of this rule. For each violation, specify:
- File path and line number
- Brief explanation of why it violates the rule
- Suggested fix

If no violations found, respond with empty array.
Respond in JSON format only.
```

### Scope Strategy

| Scope | When | What's scanned | Token budget |
|-------|------|---------------|--------------|
| **Direct** (changed files only) | During review | Only files in the PR diff | ~200-500 tokens per rule per PR |
| **Repo-wide** (alerting) | On-demand (`prr scan`) | Whole repo, but user-triggered | Higher budget, with user consent |

**Direct scope:** For immediate review feedback. Fast, cheap, focused.
**Repo-wide scope:** When a rule is created and user wants to check existing code. Results in:
- Alert to user: "Found 12 existing violations of rule r-001 in the repo"
- Option to: file as issue, create new PR to fix, or acknowledge and move on

---

## PR Ingestion & Feature Grouping

### Automatic Feature Analysis

When PRs are added to the queue, PRR performs a lightweight analysis to group related PRs:

```typescript
interface FeatureGroup {
  id: string;
  label: string;                    // human-readable: "Authentication overhaul"
  prs: number[];                    // which PRs belong
  reason: string;                   // why grouped: "Both touch src/auth/ and share /users endpoint"
  reviewTogether: boolean;          // recommendation
}
```

### Grouping Signals (Algorithmic, No LLM)

1. **Shared file paths** — PRs modifying same files/directories
2. **Endpoint overlap** — Detected via route file patterns (e.g., both touch `routes/auth.ts`)
3. **Import chain** — If PR #1 modifies module A and PR #2 imports from module A
4. **Branch naming** — `feature/auth-*` branches grouped together

### Enhancement (LLM, optional)

If AI is enabled, a short prompt analyzes PR titles + changed file lists:

```
Given these PRs queued for review:
- #101: "Add OAuth2 PKCE flow" (files: src/auth/oauth.ts, src/routes/auth.ts, ...)
- #103: "Add /users endpoint" (files: src/routes/users.ts, src/auth/middleware.ts, ...)

Which PRs should be reviewed together and why? 
Consider: shared subsystems, data dependencies, release readiness.
```

**Token budget:** ~300 tokens total for grouping analysis (runs once on `prr add`)

### Output in Session

Feature groups are:
- Shown in `prr status` output
- Displayed in TUI queue view
- Written to session index.md
- Used to suggest review order

---

## Ruleify: Pattern Analysis from Comments

### Automatic Rule Suggestions (from reviewer behavior)

PRR tracks all comments across sessions. When patterns emerge, it suggests rules:

**Trigger:** After 3+ reviews, OR on `prr rules suggest`

**Analysis (LLM-powered):**

```
Here are the last 20 review comments made across different PRs:

PR #101 L17: "MUST be env var. Never hardcode secrets."
PR #103 L44: "This API key should come from environment"
PR #107 L8: "Don't put credentials in code, use env"
PR #102 L55: "Missing error handling for this async call"
PR #104 L22: "No try/catch around this API call"
PR #108 L19: "Wrap external calls in try/catch"

Identify patterns where the reviewer made essentially the same comment 3+ times.
For each pattern, suggest a rule with:
- description
- category 
- example violations and corrections
- suggested enforcement type (regex or llm)
```

**Token budget:** ~500 tokens per suggestion run

**User flow:**
1. PRR notices pattern after several reviews
2. Prompts user: "You've commented about error handling 3 times. Create a rule?"
3. User confirms/edits → rule created with examples from their actual comments
4. Future reviews auto-flag this pattern

---

## Learnify (Follow-up Feature — Post-Hackathon)

> **Note:** This is documented as a future feature, not MVP.

### Concept

When a reviewer makes a comment based on a wrong assumption and the LLM (or later, the PR author) corrects them, PRR offers to create a **learning note**.

### Example Flow

```
Reviewer comments: "This should use useState, React re-renders on prop changes"
LLM/correction: "Actually this is a server component — no useState here. 
                  Server components don't re-render, they only run on the server."

PRR prompt: "💡 Learning opportunity detected. Create a note about 
             Server Components vs Client Components?"

User: "yes"

PRR creates: .prr/learnings/react-server-components.md
  - What I assumed vs what's correct
  - Links to relevant docs (React Server Components RFC, Next.js docs)
  - Example code showing the difference
```

### Learning Note Format

```markdown
---
type: prr/learning
topic: "React Server Components"
created_at: "2026-08-20T14:30:00Z"
context: "PR #205 — assumed useState works in server components"
confidence_before: low
tags: [react, server-components, nextjs]
---

# Learning: React Server Components vs Client Components

## What I Assumed

Server components re-render like client components when props change,
so they need `useState` for local state.

## What's Actually True

Server components only execute on the server and never re-render on the client.
They cannot use hooks like `useState` or `useEffect`. For interactive state,
you need to mark a component as `"use client"`.

## Resources

- [React Server Components RFC](https://github.com/reactjs/rfcs/pull/188)
- [Next.js Server Components docs](https://nextjs.org/docs/app/building-your-application/rendering/server-components)

## Example

```tsx
// ❌ Won't work — server component can't use hooks
export default function UserList({ users }) {
  const [filter, setFilter] = useState('');  // ERROR
  ...
}

// ✅ Correct — separate into server + client components
// ServerComponent.tsx (data fetching)
export default async function UserList() {
  const users = await db.users.findMany();
  return <UserFilter users={users} />;  
}

// ClientComponent.tsx (interactivity)
"use client"
export function UserFilter({ users }) {
  const [filter, setFilter] = useState('');
  ...
}
```
```

### Status: 📋 Documented for V2 (post-hackathon feature)

---

## Project Structure

```
pr-review-harness/
├── package.json
├── tsconfig.json
├── bunfig.toml                      # Bun configuration
├── .prrrc.yaml.example              # example config
├── src/
│   ├── index.ts                     # entry point — CLI setup
│   ├── cli/
│   │   ├── commands/
│   │   │   ├── init.ts              # prr init
│   │   │   ├── add.ts              # prr add <PRs>
│   │   │   ├── status.ts           # prr status
│   │   │   ├── review.ts           # prr review <PR> → launches TUI
│   │   │   ├── approve.ts          # prr approve <PR>
│   │   │   ├── flag.ts             # prr flag <PR>
│   │   │   ├── rule.ts             # prr rule add/list/export/suggest
│   │   │   ├── scan.ts             # prr scan (repo-wide rule check)
│   │   │   └── history.ts          # prr history
│   │   └── index.ts                # commander program setup
│   ├── tui/
│   │   ├── App.tsx                  # root TUI component
│   │   ├── pages/
│   │   │   ├── QueuePage.tsx        # PR list view
│   │   │   ├── ReviewPage.tsx       # single PR review
│   │   │   └── HistoryPage.tsx      # past sessions
│   │   ├── components/
│   │   │   ├── DiffView.tsx         # scrollable diff with line numbers
│   │   │   ├── CommentList.tsx      # comments section
│   │   │   ├── CommentInput.tsx     # text input overlay
│   │   │   ├── SummaryBanner.tsx    # AI summary + rule violations
│   │   │   ├── StatusBar.tsx        # bottom bar: keybindings, position
│   │   │   ├── FeatureGroups.tsx    # grouped PR display
│   │   │   └── RuleViolation.tsx    # inline rule violation marker
│   │   ├── hooks/
│   │   │   ├── useNavigation.ts     # page/scroll navigation
│   │   │   ├── useKeyboard.ts       # keyboard shortcut handling
│   │   │   └── useComments.ts       # comment CRUD state
│   │   └── theme.ts                 # colors, borders, spacing
│   ├── domain/
│   │   ├── queue.ts                 # QueueManager
│   │   ├── review.ts               # ReviewSession
│   │   ├── rules.ts                # RulesEngine (regex + LLM hybrid)
│   │   ├── grouping.ts             # FeatureGrouping (PR analysis)
│   │   ├── patterns.ts             # PatternAnalysis (comment mining)
│   │   └── types.ts                # shared domain types
│   ├── infra/
│   │   ├── git.ts                   # GitAdapter: get diff, branches, log
│   │   ├── github.ts               # GitHubAdapter: fetch PR, post review
│   │   ├── llm/
│   │   │   ├── provider.ts         # LLMProvider interface + factory
│   │   │   ├── openai.ts           # OpenAI implementation
│   │   │   ├── anthropic.ts        # Anthropic implementation
│   │   │   └── ollama.ts           # Ollama implementation
│   │   ├── store.ts                # FileStore: OKF-style markdown read/write
│   │   └── config.ts               # ConfigLoader (cosmiconfig)
│   └── utils/
│       ├── diff-parser.ts           # parse unified diff → structured data
│       ├── markdown.ts              # generate/parse OKF markdown files
│       └── logger.ts                # structured logging
├── tests/
│   ├── domain/
│   │   ├── queue.test.ts
│   │   ├── rules.test.ts
│   │   └── grouping.test.ts
│   └── fixtures/
│       └── sample-diffs/            # test diff files
└── .kiro/
    └── specs/
        └── pr-review-harness/
            ├── requirements.md
            ├── design.md
            └── tasks.md
```

---

## Data Models

### PR in Queue

```typescript
interface QueuedPR {
  number: number;
  title: string;
  state: 'queued' | 'reviewing' | 'approved' | 'flagged';
  addedAt: string;                   // ISO timestamp
  reviewedAt?: string;
  flagReason?: string;
  summary?: string;                  // AI-generated (cached)
  summaryHash?: string;              // commit SHA for cache invalidation
  filesChanged: string[];            // list of file paths (not just count)
  source: 'github' | 'local';
  featureGroup?: string;             // group ID if grouped
}
```

### Feature Group

```typescript
interface FeatureGroup {
  id: string;                        // e.g., "auth-feature"
  label: string;                     // "Authentication overhaul"
  prs: number[];
  reason: string;                    // why they're grouped
  sharedPaths: string[];             // files/dirs they have in common
  reviewTogether: boolean;
}
```

### Review Comment

```typescript
interface ReviewComment {
  id: string;
  file: string;
  line: number;
  side: 'added' | 'removed' | 'context';
  text: string;
  createdAt: string;
  ruleId?: string;                   // if auto-generated from rule enforcement
}
```

### Rule

```typescript
interface Rule {
  id: string;
  description: string;
  category: 'security' | 'style' | 'testing' | 'architecture' | 'performance' | 'general';
  severity: 'warn' | 'error';
  enforcement: 'regex' | 'llm';     // how to check violations
  pattern?: string;                  // regex (only for enforcement: 'regex')
  filePattern?: string;              // glob for which files to check
  examples: {
    bad: string[];                   // code that violates
    good: string[];                  // code that's correct
  };
  createdAt: string;
  createdFrom?: string;              // PR number where originated
  enabled: boolean;
  timesTriggered: number;
}

interface RuleViolation {
  ruleId: string;
  file: string;
  line: number;
  explanation: string;               // why this is a violation
  suggestion?: string;               // how to fix
  matchedText?: string;              // for regex matches
}
```

### Config

```typescript
interface PRRConfig {
  mode: 'local' | 'github';
  github?: {
    owner: string;
    repo: string;
  };
  ai?: {
    enabled: boolean;
    provider: 'openai' | 'anthropic' | 'ollama';
    model?: string;
    baseUrl?: string;
    apiKey?: string;                 // prefer env vars
  };
  rules?: {
    enabled: boolean;
    enforcement: 'regex-only' | 'hybrid';  // hybrid = regex + LLM
    autoSuggest: boolean;
    repoScanOnNewRule: boolean;      // scan whole repo when new rule created?
  };
  grouping?: {
    enabled: boolean;
    aiEnhanced: boolean;             // use LLM for grouping analysis
  };
}
```

---

## LLM Integration: Token Budget

| Operation | Scope | Max Tokens | Trigger |
|-----------|-------|-----------|---------|
| PR Summary | Per PR | ~1000 | On `prr add --ai` |
| Rule Enforcement (LLM rules) | Changed files only | ~500/rule/PR | On review start |
| Feature Grouping | PR metadata only | ~300 | On `prr add` (batch) |
| Rule Suggestions | Last N comments | ~500 | On `prr rules suggest` or after 5+ reviews |
| Repo-wide Scan | Whole repo files matching rule pattern | ~2000/rule | On `prr scan` (user-triggered) |

**Total per typical review session (5 PRs, AI enabled):**
- Summaries: ~5000 tokens
- Rule enforcement (3 LLM rules): ~7500 tokens  
- Grouping: ~300 tokens
- **Total: ~12,800 tokens ≈ $0.02-0.05**

**Without AI:** Tool is fully functional. Rules use regex-only, no summaries, grouping is algorithmic.

---

## Error Handling

| Scenario | Handling |
|----------|----------|
| GitHub API rate limit | Graceful message, suggest local mode |
| LLM unavailable/timeout | Skip AI features, show "AI unavailable", continue |
| PR not found | Clear error: "PR #X not found. Check repo config?" |
| Invalid diff | Show raw text fallback |
| Rule regex invalid | Warn on creation, skip during enforcement |
| No git repo | Error on init: "Not in a git repository" |
| OpenTUI not available | Fall back to Ink renderer |
| OKF parse error | Reconstruct from raw markdown content |

---

## Security Considerations

- **No secrets in storage** — API keys only in env vars, never in `.prr/` files
- **LLM scope limits** — only changed files sent for direct enforcement, never entire repo unless user explicitly triggers `prr scan`
- **Local mode default** — never sends code externally unless configured
- **GitHub token** — auto-detected from `gh auth` or `GITHUB_TOKEN` env
- **Rule examples** — sanitized (no real secrets in example code)

---

## MVP Build Order

1. **Project scaffold** — Bun, TypeScript, folder structure
2. **Domain types + OKF store** — data models, markdown read/write with frontmatter
3. **Git adapter + diff parser** — fetch diffs, parse into structured data
4. **Queue manager + CLI commands** — add, status, approve, flag
5. **Feature grouping** — algorithmic PR analysis on ingestion
6. **TUI (OpenCode-style)** — full-screen review interface
7. **Rules engine (hybrid)** — regex + LLM enforcement
8. **Rule suggestions from comments** — pattern mining
9. **GitHub adapter** — fetch PRs, post reviews
10. **AI summary** — optional enhancement on queue

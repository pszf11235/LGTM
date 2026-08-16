# Design: PR Review Harness (PRR)

## Architecture Overview

PRR follows a **layered architecture** with clear separation between CLI/TUI presentation, domain logic, and infrastructure (git, GitHub, LLM, filesystem).

```
┌─────────────────────────────────────────────────────────────┐
│                    Presentation Layer                         │
│                                                              │
│  ┌──────────────┐    ┌──────────────────────────────────┐   │
│  │   CLI        │    │            TUI (Ink)              │   │
│  │ (Commander)  │    │  ┌────────────┐ ┌─────────────┐  │   │
│  │              │    │  │ Diff Pane  │ │Comment Pane │  │   │
│  │ add/status/  │    │  │ (scrollable│ │(linked to   │  │   │
│  │ approve/flag │    │  │  diff view)│ │ line nums)  │  │   │
│  │ rule/history │    │  └────────────┘ └─────────────┘  │   │
│  └──────┬───────┘    │  ┌────────────────────────────┐  │   │
│         │            │  │      Status Bar             │  │   │
│         │            │  └────────────────────────────┘  │   │
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
│  │ Adapter  │  │ Adapter  │  │ Adapter  │  │(fs/yaml) │   │
│  └──────────┘  └──────────┘  └──────────┘  └──────────┘   │
│                                                              │
└──────────────────────────────────────────────────────────────┘
```

---

## Tech Stack Decisions

| Layer | Choice | Rationale |
|-------|--------|-----------|
| Language | TypeScript (strict mode) | Type safety, good for CLI tools, user wants to learn TS |
| Runtime | Node.js 22 | LTS, stable, good ecosystem |
| Package manager | pnpm | Fast, disk-efficient, lockfile is reliable |
| CLI framework | Commander.js | Simple, well-documented, zero magic |
| TUI framework | Ink 5 (React for CLI) | Component-based, testable, handles layout/input well |
| Diff parsing | diff2html / parse-diff | Structured diff parsing from git output |
| Git operations | simple-git | Lightweight git wrapper, no binary deps |
| GitHub API | Octokit (REST) | Official, typed, well-maintained |
| LLM integration | Custom provider abstraction | Keep it simple — just HTTP calls, no heavy SDK |
| Config | cosmiconfig | Standard `.prrrc` / `prr.config.yaml` pattern |
| Storage | YAML (config/rules) + Markdown (reviews) | Human-readable, git-friendly, no DB needed |
| Build | tsup | Fast TS bundler, zero-config for CLIs |
| Testing | Vitest | Fast, TS-native, compatible with Ink testing |

---

## Project Structure

```
pr-review-harness/
├── package.json
├── tsconfig.json
├── tsup.config.ts
├── .prrrc.yaml.example          # example config
├── src/
│   ├── index.ts                 # entry point — CLI setup
│   ├── cli/
│   │   ├── commands/
│   │   │   ├── init.ts          # prr init
│   │   │   ├── add.ts           # prr add <PRs>
│   │   │   ├── status.ts        # prr status
│   │   │   ├── review.ts        # prr review <PR> → launches TUI
│   │   │   ├── approve.ts       # prr approve <PR>
│   │   │   ├── flag.ts          # prr flag <PR>
│   │   │   ├── rule.ts          # prr rule add/list/export
│   │   │   └── history.ts       # prr history
│   │   └── index.ts             # commander program setup
│   ├── tui/
│   │   ├── App.tsx              # root Ink component
│   │   ├── components/
│   │   │   ├── DiffPane.tsx     # left pane: scrollable diff
│   │   │   ├── CommentPane.tsx  # right pane: comments
│   │   │   ├── StatusBar.tsx    # bottom bar: keybindings, position
│   │   │   ├── SummaryHeader.tsx# AI summary at top
│   │   │   └── RuleWarning.tsx  # inline rule violation warnings
│   │   ├── hooks/
│   │   │   ├── useKeyboard.ts   # keyboard navigation logic
│   │   │   ├── useScroll.ts     # scroll state management
│   │   │   └── useComments.ts   # comment CRUD
│   │   └── theme.ts             # colors, styles
│   ├── domain/
│   │   ├── queue.ts             # QueueManager: add, remove, get, state transitions
│   │   ├── review.ts            # ReviewSession: create, add comment, finalize
│   │   ├── rules.ts             # RulesEngine: load, match, create, export
│   │   ├── correlation.ts       # cross-PR file overlap detection
│   │   └── types.ts             # shared domain types
│   ├── infra/
│   │   ├── git.ts               # GitAdapter: get diff, branches, log
│   │   ├── github.ts            # GitHubAdapter: fetch PR, post review
│   │   ├── llm/
│   │   │   ├── provider.ts      # LLMProvider interface
│   │   │   ├── openai.ts        # OpenAI implementation
│   │   │   ├── anthropic.ts     # Anthropic implementation
│   │   │   └── ollama.ts        # Ollama implementation
│   │   ├── store.ts             # FileStore: read/write YAML, markdown
│   │   └── config.ts            # ConfigLoader (cosmiconfig)
│   └── utils/
│       ├── diff-parser.ts       # parse unified diff into structured data
│       ├── markdown.ts          # generate review markdown
│       └── logger.ts            # structured logging
├── tests/
│   ├── domain/
│   │   ├── queue.test.ts
│   │   ├── rules.test.ts
│   │   └── review.test.ts
│   └── fixtures/
│       └── sample-diffs/        # test diff files
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
  number: number;                    // PR number or local branch ID
  title: string;                     // PR title
  state: 'queued' | 'reviewing' | 'approved' | 'flagged';
  addedAt: string;                   // ISO timestamp
  reviewedAt?: string;               // when review was completed
  flagReason?: string;               // if flagged, why
  summary?: string;                  // AI-generated summary (cached)
  summaryHash?: string;              // commit SHA used for summary (cache key)
  filesChanged: number;              // count of files in diff
  source: 'github' | 'local';       // where the diff comes from
}
```

### Review Comment

```typescript
interface ReviewComment {
  id: string;                        // uuid
  file: string;                      // relative file path
  line: number;                      // line number in diff
  side: 'added' | 'removed' | 'context'; // which side of the diff
  text: string;                      // comment content
  createdAt: string;                 // ISO timestamp
  ruleId?: string;                   // if this was auto-generated from a rule
}
```

### Review Session

```typescript
interface ReviewSession {
  id: string;                        // uuid
  date: string;                      // YYYY-MM-DD
  prNumber: number;
  prTitle: string;
  state: 'in-progress' | 'approved' | 'flagged';
  comments: ReviewComment[];
  ruleViolations: RuleViolation[];
  summary?: string;
  startedAt: string;
  completedAt?: string;
}
```

### Rule

```typescript
interface Rule {
  id: string;                        // uuid
  description: string;               // human-readable description
  category: 'security' | 'style' | 'testing' | 'architecture' | 'general';
  severity: 'warn' | 'error';
  pattern?: string;                  // regex to match in diff lines
  filePattern?: string;              // glob for which files this applies to
  createdAt: string;
  createdFrom?: string;              // PR number where this rule originated
  enabled: boolean;
}

interface RuleViolation {
  ruleId: string;
  file: string;
  line: number;
  matchedText: string;
}
```

### Config

```typescript
interface PRRConfig {
  mode: 'local' | 'github';
  github?: {
    owner: string;
    repo: string;
    // token auto-detected from gh CLI or GITHUB_TOKEN env
  };
  ai?: {
    enabled: boolean;
    provider: 'openai' | 'anthropic' | 'ollama';
    model?: string;                  // defaults per provider
    baseUrl?: string;                // for ollama or custom endpoints
    apiKey?: string;                 // or use env vars
  };
  rules?: {
    enabled: boolean;
    autoSuggest: boolean;            // AI suggests rules after review
  };
}
```

---

## Key Data Flows

### Flow 1: Add PRs to Queue

```
User runs: prr add 101 102 103
    │
    ▼
CLI (add.ts) parses args
    │
    ▼
ConfigLoader resolves mode (local/github)
    │
    ├─── GitHub mode ──► GitHubAdapter.fetchPR(101) → title, files count
    │
    └─── Local mode ──► GitAdapter.getBranchInfo() → title, files count
    │
    ▼
QueueManager.add(pr) → validates, deduplicates
    │
    ▼
[Optional] If AI enabled: LLMProvider.summarize(diff) → cache summary
    │
    ▼
FileStore.saveQueue(session/queue.yaml)
```

### Flow 2: Enter Review (TUI)

```
User runs: prr review 101
    │
    ▼
CLI (review.ts) resolves PR from queue
    │
    ▼
GitAdapter.getDiff(101) or GitHubAdapter.getDiff(101)
    │
    ▼
DiffParser.parse(rawDiff) → structured: files[], hunks[], lines[]
    │
    ▼
RulesEngine.check(parsedDiff) → violations[]
    │
    ▼
Ink render: App.tsx
    ├── SummaryHeader (cached AI summary)
    ├── DiffPane (parsed diff, violations inline)
    ├── CommentPane (empty initially)
    └── StatusBar (keybindings, position)
    │
    ▼
User navigates, adds comments, creates rules
    │
    ▼
On exit (q): ReviewSession.finalize()
    │
    ▼
FileStore.saveReview(session/pr-101.review.md)
    │
    ▼
Prompt: [a]pprove / [f]lag / [s]kip
    │
    ▼
QueueManager.updateState(101, 'approved'|'flagged')
```

### Flow 3: Rule Enforcement

```
New PR queued or review started
    │
    ▼
RulesEngine.loadRules(.prr/rules/rules.yaml)
    │
    ▼
For each rule with pattern:
    │
    ├── regex.test(line.content) for each diff line
    │
    └── If filePattern: glob.match(file.path)
    │
    ▼
Violations collected → displayed inline in TUI as ⚠️ warnings
    │
    ▼
Violations also written to review markdown
```

### Flow 4: Rule Export

```
User runs: prr rule export --format hook
    │
    ▼
RulesEngine.loadRules()
    │
    ▼
For each rule with regex pattern:
    │
    ▼
Generate git hook script:
    #!/bin/sh
    # Rule: {description}
    if git diff --cached | grep -qE '{pattern}'; then
      echo "Rule violation: {description}"
      exit 1
    fi
    │
    ▼
Write to .git/hooks/pre-commit (or .prr/exports/pre-commit.sh)
```

---

## LLM Integration Design

### Provider Interface

```typescript
interface LLMProvider {
  summarize(diff: string, context?: string): Promise<string>;
  suggestRules(comments: ReviewComment[]): Promise<SuggestedRule[]>;
}
```

### Token Efficiency Strategy

| Operation | Max Input | Max Output | Strategy |
|-----------|-----------|-----------|----------|
| PR Summary | Diff truncated to 4000 chars | 200 tokens | One-shot, cached by commit SHA |
| Rule Suggestion | Last N comments (not full diff) | 300 tokens | Triggered manually, uses comments only |

### Caching

```typescript
// Cache key = SHA of PR head commit + diff content hash
const cacheKey = `${prNumber}-${commitSha}`;
const cached = store.getSummaryCache(cacheKey);
if (cached) return cached; // no LLM call
```

### Provider Selection

```typescript
// Factory pattern — no heavy SDKs, just fetch()
function createProvider(config: AIConfig): LLMProvider {
  switch (config.provider) {
    case 'openai': return new OpenAIProvider(config);
    case 'anthropic': return new AnthropicProvider(config);
    case 'ollama': return new OllamaProvider(config);
  }
}
```

All providers use raw `fetch()` to their respective APIs — no `openai` or `@anthropic-ai/sdk` packages needed. Keeps dependencies minimal.

---

## TUI Component Design (Ink)

### Layout

```tsx
// App.tsx — root component
<Box flexDirection="column" height="100%">
  <SummaryHeader summary={summary} violations={violations.length} />
  <Box flexDirection="row" flexGrow={1}>
    <DiffPane 
      diff={parsedDiff} 
      scrollOffset={scroll} 
      violations={violations}
      width="60%" 
    />
    <CommentPane 
      comments={comments} 
      currentLine={currentLine}
      width="40%" 
    />
  </Box>
  <StatusBar 
    prTitle={pr.title} 
    position={`${currentFile}/${totalFiles}`}
    keys={keybindings} 
  />
</Box>
```

### Keyboard Handling

| Key | Action |
|-----|--------|
| `j` / `↓` | Scroll down one line |
| `k` / `↑` | Scroll up one line |
| `n` | Next file |
| `N` | Previous file |
| `h` | Next hunk |
| `H` | Previous hunk |
| `c` | Add comment at current line |
| `r` | Create rule from current context |
| `a` | Approve PR and exit |
| `f` | Flag PR (prompts for reason) and exit |
| `q` | Exit (prompts: approve/flag/skip) |
| `?` | Show help |

---

## Storage Format

### Queue File (`.prr/sessions/2026-08-15/queue.yaml`)

```yaml
session: 2026-08-15
prs:
  - number: 101
    title: "Add OAuth2 PKCE flow"
    state: approved
    addedAt: "2026-08-15T10:00:00Z"
    reviewedAt: "2026-08-15T10:15:00Z"
    filesChanged: 4
    source: github
  - number: 102
    title: "Fix rate limiter edge case"
    state: reviewing
    addedAt: "2026-08-15T10:00:00Z"
    filesChanged: 2
    source: github
```

### Review File (`.prr/sessions/2026-08-15/pr-101.review.md`)

```markdown
# Review: PR #101 — Add OAuth2 PKCE flow

**Reviewed:** 2026-08-15T10:15:00Z
**State:** Approved
**Files:** 4 changed

## AI Summary

Adds OAuth2 PKCE flow to auth module. New `initiateOAuth()` function handles
code verifier generation and token exchange. Touches auth controller, routes,
and adds new OAuth service module. No tests included.

## Rule Violations

- ⚠️ **[security]** src/auth/oauth.ts:38 — "Always use environment variables for secrets" (matched: `clientSecret = "sk_live_..."`)

## Comments

### src/auth/oauth.ts

- **L14:** Why not use passport.js here? Seems like reinventing the wheel.
- **L38:** This should be an env var, not hardcoded. Security risk.
- **L52:** Always validate redirect_uri against allowlist. → Created rule #r-003.

### src/routes/auth.ts

- **L8:** Missing rate limiting on this endpoint.

## Decision

✅ Approved — issues noted are non-blocking for this PR, rules created for future enforcement.
```

### Rules File (`.prr/rules/rules.yaml`)

```yaml
rules:
  - id: r-001
    description: "Always use environment variables for secrets, never hardcode"
    category: security
    severity: error
    pattern: "(api[_-]?key|secret|token|password)\\s*[=:]\\s*[\"'][^\"']{8,}"
    filePattern: "**/*.{ts,js}"
    createdAt: "2026-08-15T10:15:00Z"
    createdFrom: "101"
    enabled: true
    
  - id: r-002
    description: "New API endpoints require integration tests"
    category: testing
    severity: warn
    pattern: "router\\.(get|post|put|delete|patch)\\("
    filePattern: "**/routes/**"
    createdAt: "2026-08-15T10:20:00Z"
    enabled: true
```

---

## Error Handling Strategy

| Scenario | Handling |
|----------|----------|
| GitHub API rate limit | Graceful message, suggest local mode |
| LLM unavailable/timeout | Skip summary, show "AI unavailable", continue without |
| PR not found | Clear error: "PR #X not found. Is the repo configured?" |
| Invalid diff | Show raw text fallback instead of structured view |
| Rule regex invalid | Warn on creation, skip during enforcement |
| No git repo | Error on init: "Not in a git repository" |

---

## Security Considerations

- **No secrets in storage:** API keys only in env vars or OS keychain, never in `.prr/` files
- **Config gitignore:** `.prrrc.yaml` should NOT contain secrets; document that keys go in env vars
- **Local mode default:** Never sends code externally unless explicitly configured
- **GitHub token:** Auto-detected from `gh auth` or `GITHUB_TOKEN` env — never stored in config files

---

## MVP Build Order (Maps to tasks.md)

1. **Project scaffold** — package.json, tsconfig, tsup, folder structure
2. **Domain types + store** — data models, YAML/MD read/write
3. **Git adapter + diff parser** — fetch diffs, parse into structured data
4. **Queue manager + CLI commands** — add, status, approve, flag
5. **TUI (Ink)** — split pane, diff rendering, scroll, comment input
6. **Rules engine** — create, load, match against diffs
7. **GitHub adapter** — fetch PR metadata, post reviews (nice-to-have)
8. **LLM integration** — summary on queue (nice-to-have)

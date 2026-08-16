# Tasks: PR Review Harness (PRR)

## Implementation Plan (Revised)

Reflects design changes: Bun runtime, OKF-style storage, OpenCode-style TUI, hybrid rule enforcement (regex + LLM), feature grouping on ingestion, and comment pattern analysis.

Tasks are ordered by dependency. MVP tasks marked 🏆.

---

## Phase 1: Foundation (Day 1-2)

### Task 1: Project Scaffold 🏆
**Branch:** `feat/task-01-scaffold`

- [ ] Initialize Bun project: `bun init`
- [ ] Configure `tsconfig.json` (strict, ES2022, NodeNext)
- [ ] Add `bunfig.toml` for Bun-specific config
- [ ] Add dependencies:
  - `commander` (CLI)
  - `ink` + `react` (TUI — start with Ink, evaluate OpenTUI later)
  - `simple-git` (git operations)
  - `yaml` (YAML frontmatter parsing)
  - `chalk` (colors)
  - `gray-matter` (markdown frontmatter parse/stringify — OKF support)
  - `minimatch` (glob matching for rules)
  - `uuid` (or `crypto.randomUUID()` via Bun)
- [ ] Create full folder structure per design.md
- [ ] Add `bin` field in package.json → `./src/index.ts` (Bun runs TS directly)
- [ ] Add scripts: `dev`, `build`, `test`, `lint`
- [ ] Create `.gitignore` (node_modules, dist, .prr/sessions)
- [ ] Create README.md stub with project description
- [ ] Verify: `bun run src/index.ts --help` shows CLI help

**PR deliverable:** Buildable project, all deps installed, folder structure, CLI prints help.

---

### Task 2: Domain Types & OKF Store 🏆
**Branch:** `feat/task-02-types-store`

- [ ] Create `src/domain/types.ts` — all TypeScript interfaces:
  - `QueuedPR`, `FeatureGroup`, `ReviewComment`, `ReviewSession`
  - `Rule`, `RuleViolation`, `PRRConfig`
- [ ] Create `src/infra/store.ts` — OKF-style markdown persistence:
  - `ensureDir(path)` — create `.prr/` structure
  - `writeOKF(path, frontmatter, body)` — write markdown with YAML frontmatter
  - `readOKF(path)` → `{ frontmatter, body }` — parse using gray-matter
  - `saveSession(session)` — writes session index.md
  - `loadSession(date)` — reads session
  - `saveReview(review)` — writes pr-{n}.md
  - `loadReview(date, prNumber)` — reads review
  - `saveRules(rules)` — writes rule files
  - `loadRules()` — reads all rule .md files from rules/
- [ ] Create `src/infra/config.ts`:
  - `loadConfig()` — cosmiconfig for `.prrrc.yaml`
  - `getDefaultConfig()` — sensible defaults
- [ ] Create `.prrrc.yaml.example`
- [ ] Write tests: OKF round-trip (write → read → verify)
- [ ] Verify: can write and read OKF-style markdown files correctly

**PR deliverable:** All types defined, OKF store reads/writes correctly, config loads.

---

### Task 3: Git Adapter & Diff Parser 🏆
**Branch:** `feat/task-03-git-diff`

- [ ] Create `src/infra/git.ts`:
  - `getDiff(target)` — `git diff main...<branch>` or fetch from ref
  - `getBranches()` — list local branches
  - `getCurrentRepo()` — parse owner/repo from git remote URL
  - `isGitRepo(path)` — validates git repo
  - `getChangedFiles(branch)` — just file paths (for grouping)
- [ ] Create `src/utils/diff-parser.ts`:
  - `parseDiff(raw: string): ParsedDiff`
  - Types: `ParsedDiff`, `DiffFile`, `DiffHunk`, `DiffLine`
  - Each line has: type (add/remove/context), content, oldLine, newLine
  - Handle: binary files, renames, new/deleted files
- [ ] Create test fixtures: `tests/fixtures/sample-diffs/` (3-4 sample diffs)
- [ ] Write tests: multi-file diff parsing, edge cases
- [ ] Verify: can fetch diff for a local branch and parse it structurally

**PR deliverable:** Can extract and parse diffs from any branch.

---

## Phase 2: Queue & Grouping (Day 2-3)

### Task 4: Queue Manager 🏆
**Branch:** `feat/task-04-queue`

- [ ] Create `src/domain/queue.ts`:
  - `createSession(date)` — initializes session directory + index.md
  - `addToQueue(prNumbers[], config)` — validate, fetch metadata, persist
  - `getQueue(date)` — load current queue from session index
  - `updateState(prNumber, newState, reason?)` — state machine transitions
  - `removeFromQueue(prNumber)`
- [ ] State machine: `queued` → `reviewing` → `approved` | `flagged`
- [ ] Auto-create today's session on first operation
- [ ] Write tests: state transitions, duplicates, persistence round-trip

**PR deliverable:** Queue lifecycle works, sessions persist as OKF markdown.

---

### Task 5: Feature Grouping (PR Analysis) 🏆
**Branch:** `feat/task-05-grouping`

- [ ] Create `src/domain/grouping.ts`:
  - `analyzeGroups(prs: QueuedPR[], fileLists: Map<number, string[]>): FeatureGroup[]`
  - Grouping signals (no LLM):
    - Shared directory paths (e.g., both touch `src/auth/`)
    - Shared file modifications (same file in multiple PRs)
    - Route/endpoint detection (grep for route patterns in changed files)
  - `formatGroupReason(group)` — human-readable explanation
- [ ] Integrate into `addToQueue()` — groups computed on ingestion
- [ ] Groups written to session index.md frontmatter
- [ ] Write tests: various overlap scenarios

**PR deliverable:** PRs auto-grouped on add, groups shown in session.

---

### Task 6: CLI Commands (Core) 🏆
**Branch:** `feat/task-06-cli`

- [ ] Create `src/cli/index.ts` — Commander program
- [ ] `src/cli/commands/init.ts`:
  - Creates `.prr/` structure (rules/, sessions/, config)
  - Detects git remote, pre-fills config
  - Writes default `.prrrc.yaml`
- [ ] `src/cli/commands/add.ts`:
  - Parse PR numbers from args
  - Fetch metadata (title, file list) from git or GitHub
  - Run feature grouping
  - Print: "Added 3 PRs. Grouped: #101 + #103 (both touch auth)"
- [ ] `src/cli/commands/status.ts`:
  - Table: #, Title, State, Group, Files
  - Show feature groups with rationale
  - Color-coded states
- [ ] `src/cli/commands/approve.ts` / `flag.ts`:
  - State transitions + persist
- [ ] Wire entry point `src/index.ts`
- [ ] Verify: full CLI flow works (init → add → status → approve)

**PR deliverable:** Working CLI — init, add (with grouping), status, approve, flag.

---

## Phase 3: TUI (Day 3-5)

### Task 7: TUI Shell (OpenCode-style) 🏆
**Branch:** `feat/task-07-tui-shell`

- [ ] Create `src/tui/App.tsx` — root component with page routing
- [ ] Create `src/tui/pages/QueuePage.tsx`:
  - Lists queued PRs with states, feature groups
  - Arrow keys to select, Enter to open review
  - Shows group badges next to related PRs
- [ ] Create `src/tui/components/StatusBar.tsx`:
  - Bottom bar with keybindings, current context
- [ ] Create `src/tui/theme.ts` — OpenCode-inspired colors:
  - Minimal borders, clean layout
  - Accent colors for states (green=approved, red=flagged, yellow=reviewing)
- [ ] Wire `prr review <n>` → launches TUI in review mode
- [ ] Wire `prr tui` → launches TUI in queue mode
- [ ] Handle terminal resize
- [ ] Verify: TUI launches, shows queue, can select a PR, exits with `q`

**PR deliverable:** TUI shell with queue page, clean OpenCode-style layout.

---

### Task 8: Review Page (Diff View) 🏆
**Branch:** `feat/task-08-diff-view`

- [ ] Create `src/tui/pages/ReviewPage.tsx`:
  - Full-screen layout: header → summary → diff → comments → status bar
  - Vertically scrollable (entire page scrolls, not split panes)
- [ ] Create `src/tui/components/DiffView.tsx`:
  - File headers (bold path)
  - Hunk headers (@@...@@ in cyan)
  - Lines: green (+), red (-), grey (context)
  - Line numbers in gutter
  - Inline rule violations (⚠️ markers)
- [ ] Create `src/tui/components/SummaryBanner.tsx`:
  - PR title, AI summary (if available), rule violation count
  - Feature group info: "Part of: auth-feature (with PR #103)"
- [ ] Create `src/tui/hooks/useNavigation.ts`:
  - `j/k` scroll, `n/N` next/prev file, `h/H` next/prev hunk
  - Tracks current position (file index, line index)
- [ ] Verify: can scroll through a multi-file diff in the TUI

**PR deliverable:** Full diff viewing experience in TUI.

---

### Task 9: Comments & Review Finalization 🏆
**Branch:** `feat/task-09-comments`

- [ ] Create `src/tui/components/CommentList.tsx`:
  - Shows comments for current file below the diff section
  - Format: `L{line}: {comment text}`
- [ ] Create `src/tui/components/CommentInput.tsx`:
  - Overlay text input triggered by `c`
  - Auto-fills file and line from current scroll position
  - Enter submits, Escape cancels
- [ ] Create `src/tui/hooks/useComments.ts`:
  - `addComment(file, line, text)`, `editComment()`, `deleteComment()`
- [ ] Review finalization:
  - `a` → approve (saves + updates queue state)
  - `f` → flag (prompts reason, saves + updates)
  - `q` → prompts: approve/flag/save-for-later
  - Generates OKF review markdown on exit
- [ ] Verify: full review flow — open → scroll → comment → approve → saved as markdown

**PR deliverable:** Complete review lifecycle with comments and persistence.

---

## Phase 4: Rules Engine (Day 5-6)

### Task 10: Rules Engine — Regex Mode 🏆
**Branch:** `feat/task-10-rules-regex`

- [ ] Create `src/domain/rules.ts`:
  - `createRule(opts)` — generates rule, writes OKF rule file
  - `loadRules()` — reads all `.prr/rules/*.md` files
  - `matchRegex(rules, parsedDiff)` → `RuleViolation[]`
  - Only matches against rules with `enforcement: 'regex'`
  - Respects `filePattern` (minimatch glob on file paths)
- [ ] Create `src/cli/commands/rule.ts`:
  - `prr rule add "desc" [--pattern "regex"] [--category security] [--enforcement regex]`
  - `prr rule list` — table of rules
  - `prr rule disable/enable <id>`
- [ ] Integrate into review flow: violations shown in TUI diff view
- [ ] `r` key in TUI: create rule from current line context
- [ ] Write tests: regex matching against sample diffs
- [ ] Verify: create regex rule → review PR → violations flagged inline

**PR deliverable:** Regex-based rules with TUI integration.

---

### Task 11: Rules Engine — LLM Mode 🏆
**Branch:** `feat/task-11-rules-llm`

- [ ] Create `src/infra/llm/provider.ts`:
  - `LLMProvider` interface: `checkRule(rule, diff): Promise<RuleViolation[]>`
  - `createProvider(config)` — factory
- [ ] Create `src/infra/llm/openai.ts` — raw fetch implementation
- [ ] Create `src/infra/llm/anthropic.ts` — raw fetch implementation  
- [ ] Create `src/infra/llm/ollama.ts` — raw fetch implementation
- [ ] Implement LLM rule enforcement:
  - Sends: rule description + examples + changed files (scope: diff only)
  - Expects: JSON array of violations with file, line, explanation
  - Scope limit: only files in the PR diff (direct enforcement)
  - Timeout: 30s with graceful fallback
- [ ] Cache enforcement results by `{ruleId}-{diffHash}`
- [ ] Integrate into review flow alongside regex rules
- [ ] Verify: LLM rule detects conceptual violations (e.g., "endpoints need tests")

**PR deliverable:** LLM-powered rule enforcement scoped to changed files.

---

### Task 12: Repo-Wide Scan (Alerting)
**Branch:** `feat/task-12-repo-scan`

- [ ] Create `src/cli/commands/scan.ts`:
  - `prr scan` — runs all enabled rules against entire repo
  - `prr scan --rule <id>` — single rule check
  - Scope: files matching rule's `filePattern` in whole repo
  - Uses LLM for `enforcement: 'llm'` rules, regex for regex rules
- [ ] Output: alert with violation count and options
  - "Found 12 violations of r-001 in the repo. [f]ile issue / [p]r to fix / [i]gnore"
- [ ] For LLM rules: processes files in batches to manage token budget
  - Progress indicator: "Scanning... 15/47 files checked"
- [ ] Results saved to `.prr/scans/scan-{date}.md`
- [ ] Verify: scan finds violations across repo, presents options

**PR deliverable:** On-demand repo-wide rule scanning with user-controlled actions.

---

### Task 13: Rule Export
**Branch:** `feat/task-13-rule-export`

- [ ] `prr rule export --format hook` → git pre-commit hook script
  - For regex rules: grep-based checks
  - For LLM rules: generates a hook that calls `prr scan --rule <id> --staged`
- [ ] `prr rule export --format steering` → `.kiro/steering/prr-rules.md`
  - Formats rules as AI-agent-readable guidelines with examples
- [ ] `prr rule export --format eslint` → JSON config (where applicable)
- [ ] Each export includes rule description + examples as comments
- [ ] Verify: exported hook catches violations on commit

**PR deliverable:** Rules become upstream enforcement mechanisms.

---

## Phase 5: Pattern Intelligence (Day 6-7)

### Task 14: Comment Pattern Analysis (Ruleify from Behavior) 🏆
**Branch:** `feat/task-14-pattern-analysis`

- [ ] Create `src/domain/patterns.ts`:
  - `analyzeComments(sessions: ReviewSession[]): SuggestedRule[]`
  - Collects all comments from last N sessions
  - Sends to LLM: "find repeated themes, suggest rules with examples"
  - Returns: suggested rules (description, category, examples)
- [ ] Create `prr rules suggest` command:
  - Runs pattern analysis on review history
  - Presents suggestions one by one
  - User: confirm (create rule) / edit / skip
- [ ] Trigger condition: after 5+ reviews, offer to run suggestions
- [ ] Token budget: ~500 tokens per analysis
- [ ] Verify: after several reviews with repeated comments, suggestions appear

**PR deliverable:** AI mines your review patterns and proposes rules.

---

### Task 15: AI Summary on Queue
**Branch:** `feat/task-15-ai-summary`

- [ ] Implement summary generation in LLM provider:
  - Input: truncated diff (max 4000 chars), file list
  - Output: 2-3 sentence summary + risk flags
  - System prompt: brief, actionable, highlight risks
- [ ] Cache by `{prNumber}-{commitSha}` — never regenerate
- [ ] Wire into `prr add --ai`:
  - Generates summary for each PR on add
  - Summary stored in session index frontmatter
- [ ] Show in: `prr status`, TUI queue page, TUI review summary banner
- [ ] Graceful fallback: "Summary unavailable" if LLM fails
- [ ] Verify: summaries appear in status and TUI

**PR deliverable:** Optional AI summaries on PR ingestion.

---

## Phase 6: GitHub Integration (Day 7)

### Task 16: GitHub Adapter
**Branch:** `feat/task-16-github`

- [ ] Create `src/infra/github.ts`:
  - `fetchPR(owner, repo, number)` — title, body, files, diff
  - `fetchDiff(owner, repo, number)` — raw unified diff
  - `postReview(owner, repo, number, state, body)` — APPROVE/REQUEST_CHANGES
  - `postInlineComments(owner, repo, number, comments[])` — line-level comments
- [ ] Auth: `GITHUB_TOKEN` env or `gh auth token` detection
- [ ] Wire into existing commands:
  - `prr add` (GitHub mode) → fetches from API
  - `prr approve/flag` (GitHub mode) → posts review to PR
- [ ] Error handling: 404, 401, 403, rate limits
- [ ] Verify: can fetch real PR and post a review

**PR deliverable:** Full GitHub read/write integration.

---

### Task 17: Cross-PR Overlap Detection
**Branch:** `feat/task-17-overlap`

- [ ] Enhance `src/domain/grouping.ts`:
  - `detectConflicts(prs, diffs)` — same line modified in multiple PRs
  - `suggestReviewOrder(groups)` — dependency-based ordering
- [ ] Add to `prr status`: "⚠️ PR #101 and #103 modify src/auth/middleware.ts L15-30"
- [ ] Add `prr compare <PR1> <PR2>`:
  - Side-by-side display of conflicting changes
  - Algorithmic (no LLM) — file path + line range comparison
- [ ] Verify: overlapping PRs show warnings

**PR deliverable:** Automatic conflict detection between queued PRs.

---

## Phase 7: Polish & Submit (Day 8)

### Task 18: History & Search
**Branch:** `feat/task-18-history`

- [ ] Create `src/cli/commands/history.ts`:
  - `prr history` — list past sessions
  - `prr history --search "keyword"` — grep through OKF review files
  - `prr history --pr <n>` — all reviews for a specific PR
- [ ] Scan `.prr/sessions/*/` directories
- [ ] Parse frontmatter for quick metadata without reading full files
- [ ] Verify: can find past reviews by keyword

**PR deliverable:** Searchable review archive.

---

### Task 19: README & Documentation
**Branch:** `feat/task-19-docs`

- [ ] Comprehensive README.md:
  - Problem statement + positioning
  - Screenshots/GIF of TUI
  - Quick start (install → init → add → review)
  - Command reference
  - Rules system explanation (regex vs LLM, ruleify)
  - Configuration guide
  - Storage format explanation (OKF-inspired)
  - Architecture overview
- [ ] LICENSE (MIT)
- [ ] CONTRIBUTING.md
- [ ] ROADMAP.md (learnify, team sharing, etc.)
- [ ] Verify: fresh clone → bun install → bun run src/index.ts works

**PR deliverable:** Hackathon-ready documentation.

---

### Task 20: Demo & Submission
**Branch:** `feat/task-20-demo`

- [ ] Create demo scenario: seed a repo with branches that produce interesting diffs
- [ ] Record terminal session / create demo GIF
- [ ] Write submission description (hackathon-specific)
- [ ] Tag release `v0.1.0`
- [ ] Verify everything end-to-end

**PR deliverable:** Submission-ready.

---

## Task Dependency Graph

```
Task 1 (scaffold)
  └── Task 2 (types + OKF store)
       ├── Task 3 (git + diff parser)
       │    └── Task 4 (queue manager)
       │         ├── Task 5 (feature grouping)
       │         │    └── Task 6 (CLI commands)
       │         │         └── Task 7 (TUI shell)
       │         │              └── Task 8 (diff view)
       │         │                   └── Task 9 (comments + finalization)
       │         │
       │         └── Task 16 (GitHub adapter)
       │              └── Task 17 (overlap detection)
       │
       ├── Task 10 (rules - regex)
       │    └── Task 11 (rules - LLM)
       │         ├── Task 12 (repo scan)
       │         └── Task 13 (rule export)
       │
       ├── Task 14 (pattern analysis from comments)
       │
       └── Task 15 (AI summary)

Task 18 (history) — independent, needs store only
Task 19 (docs) — after all features
Task 20 (demo) — final
```

---

## Day-by-Day Schedule

| Day | Date | Tasks | Milestone |
|-----|------|-------|-----------|
| 1 | Aug 15-16 | 1, 2 | Project builds, OKF store works |
| 2 | Aug 16-17 | 3, 4 | Can fetch diffs, queue PRs |
| 3 | Aug 17-18 | 5, 6 | CLI works with feature grouping |
| 4 | Aug 18-19 | 7, 8 | TUI shows diff in OpenCode style |
| 5 | Aug 19-20 | 9, 10 | Full review flow + regex rules |
| 6 | Aug 20-21 | 11, 14 | LLM rules + comment pattern analysis |
| 7 | Aug 21-22 | 12, 13, 15, 16 | Scan, export, AI summary, GitHub |
| 8 | Aug 22-23 | 17, 18, 19, 20 | Overlap, history, docs, submit |

---

## Post-Hackathon Backlog

| Feature | Description | Effort |
|---------|-------------|--------|
| **Learnify** | Learning notes from wrong assumptions corrected during review | 2 weeks |
| **Team rules sharing** | Sync rules across team members | 1 week |
| **OpenTUI migration** | Move from Ink to OpenTUI for better perf | 1 week |
| **PR dependency graph** | Visual graph of PR relationships | 1 week |
| **AI-enhanced grouping** | LLM analyzes PR semantics for better groups | 3 days |
| **Webhook mode** | Auto-add PRs when they're opened | 1 week |
| **VS Code extension** | Review from editor sidebar | 2-3 weeks |

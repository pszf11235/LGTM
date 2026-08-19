# Tasks: LGTM Platform + Review Plugin

## Implementation Plan

20 tasks across 7 phases. MVP marked 🏆. Each task = one feature branch + one PR.

---

## Phase 1: Foundation (Day 1-2)

### Task 1: Monorepo Scaffold 🏆
**Branch:** `feat/task-01-scaffold`

Set up Bun workspace monorepo with core + plugin structure.

- [ ] Initialize workspace: root package.json with `workspaces`
- [ ] `packages/core/` — package.json (@lgtm/core), tsconfig
- [ ] `packages/plugins/review/` — package.json (@lgtm/plugin-review), tsconfig
- [ ] `packages/plugins/specify/` — stub package
- [ ] `packages/plugins/learn/` — stub package
- [ ] Root: bunfig.toml, tsconfig.json (base), .gitignore
- [ ] Add shared deps to core: commander, ink, react, chalk, gray-matter, simple-git, cosmiconfig, minimatch
- [ ] Entry point: `packages/core/src/index.ts` → `lgtm --help` works
- [ ] bin in root package.json → runs core entry
- [ ] Scripts: `dev`, `build`, `test`
- [ ] Verify: `bun run packages/core/src/index.ts --help` prints usage

---

### Task 2: Plugin Interface & Loader 🏆
**Branch:** `feat/task-02-plugin-system`

Define the plugin contract and auto-discovery.

- [ ] `packages/core/src/plugin.ts` — LGTMPlugin interface, LGTMContext type
- [ ] `packages/core/src/cli/program.ts` — Commander setup that loads plugins
- [ ] Plugin discovery: scan `packages/plugins/*/` for valid plugins
- [ ] Register plugin commands under namespace: `lgtm <plugin.name> <command>`
- [ ] `lgtm plugins` command — lists all discovered plugins + enabled status
- [ ] Plugin enable/disable state stored in `.lgtm/plugins.yaml`
- [ ] Stub plugins (specify, learn) register with name + description only
- [ ] Review plugin registers with placeholder commands
- [ ] Verify: `lgtm plugins` shows all 3, `lgtm review --help` shows subcommands

---

### Task 3: OKF Store & Config 🏆
**Branch:** `feat/task-03-store-config`

Persistence layer and configuration system.

- [ ] `packages/core/src/store/okf.ts`:
  - `readOKF(path)` → `{ data (frontmatter), content (body) }`
  - `writeOKF(path, data, content)` → formatted markdown file
  - Uses gray-matter for parsing/stringifying
- [ ] `packages/core/src/store/paths.ts`:
  - `getYakDir()` → resolves `.lgtm/` relative to git root
  - `ensureDir(subpath)` → creates directory structure
  - `getSessionDir(date)`, `getRulesDir()`, `getPluginDir(name)`
- [ ] `packages/core/src/config/loader.ts`:
  - cosmiconfig with `.lgtmrc.yaml`, `.lgtm/config.yaml`
  - `loadConfig()` → resolved config (merged layers)
  - `getProfile()` → reads `.lgtm/profile.md` frontmatter
- [ ] `packages/core/src/config/schema.ts` — TypeScript types for config + profile
- [ ] Tests: OKF round-trip, config resolution
- [ ] Verify: can write/read OKF files, config loads with defaults

---

### Task 4: Onboarding Flow 🏆
**Branch:** `feat/task-04-onboarding`

Interactive first-time setup.

- [ ] `packages/core/src/onboarding/questions.ts` — default question set:
  - Project goals (select: vibed/production/enterprise/learning/custom)
  - Quality references (text: comma-separated repo URLs)
  - Feedback style (select: direct/gentle/socratic/minimal)
  - Tech stack (auto-detect + confirm)
  - Team size (select: solo/small/large)
  - LLM preference (select: openai/anthropic/ollama/none)
- [ ] `packages/core/src/onboarding/detect.ts`:
  - Scan for package.json, Cargo.toml, go.mod, pyproject.toml, etc.
  - Return detected tech stack
- [ ] `packages/core/src/onboarding/flow.ts`:
  - Runs questions sequentially (Ink-based or readline prompts)
  - Each question skippable with `s`
  - Entire flow skippable with Ctrl+C (saves what was answered)
  - Saves result to `.lgtm/profile.md`
- [ ] `packages/core/src/cli/commands/init.ts`:
  - `lgtm init` — runs onboarding, creates .lgtm/ structure
  - If `.lgtm/profile.md` exists, asks to overwrite
- [ ] Plugin onboarding hook: called on first plugin use (pre-filled from profile)
- [ ] Verify: `lgtm init` walks through questions, saves profile.md

---

## Phase 2: Review Plugin — Core (Day 2-3)

### Task 5: Git Adapter & Diff Parser 🏆
**Branch:** `feat/task-05-git-diff`

- [ ] `packages/core/src/utils/git.ts`:
  - `getDiff(target)`, `getBranches()`, `getCurrentRepo()`, `isGitRepo()`
  - `getChangedFiles(branch)` — just paths (for grouping)
- [ ] `packages/plugins/review/src/domain/diff-parser.ts`:
  - `parseDiff(raw)` → `ParsedDiff { files: DiffFile[] }`
  - Handle: binary, renames, new/deleted
  - Line numbering (old + new)
- [ ] Test fixtures + tests
- [ ] Verify: parse complex multi-file diffs

---

### Task 6: Queue Manager & Feature Grouping 🏆
**Branch:** `feat/task-06-queue-grouping`

- [ ] `packages/plugins/review/src/domain/queue.ts`:
  - `addToQueue()`, `getQueue()`, `updateState()`, `removeFromQueue()`
  - State machine: queued → reviewing → approved | flagged
  - Persists to session index.md (OKF)
- [ ] `packages/plugins/review/src/domain/grouping.ts`:
  - `analyzeGroups(prs, fileLists)` → FeatureGroup[]
  - Signals: shared dirs, shared files, endpoint detection
  - `formatGroupReason(group)` → human explanation
- [ ] Grouping runs on `addToQueue()` automatically
- [ ] Tests: state machine, grouping scenarios
- [ ] Verify: add PRs → groups detected → persisted

---

### Task 7: Review Plugin CLI Commands 🏆
**Branch:** `feat/task-07-review-cli`

- [ ] `lgtm review add <numbers...>` — queue with grouping
- [ ] `lgtm review status` — table with groups, states
- [ ] `lgtm review approve <n>` / `lgtm review flag <n> --reason "..."`
- [ ] Wire commands into plugin registration
- [ ] Verify: full CLI flow (add → status → approve/flag)

---

## Phase 3: TUI (Day 3-5)

### Task 8: TUI Shell & Queue Page 🏆
**Branch:** `feat/task-08-tui-shell`

- [ ] `packages/core/src/tui/Shell.tsx` — header with plugin tabs + page area + status bar
- [ ] Tab bar: enabled plugins as tabs, switch with Tab/number keys
- [ ] `packages/core/src/tui/theme.ts` — OpenCode colors
- [ ] `packages/plugins/review/src/pages/QueuePage.tsx`:
  - PR list with states, groups
  - Arrow keys to select, Enter to review
  - Feature group badges
- [ ] `lgtm` (bare command) launches TUI on first enabled tab
- [ ] `lgtm tui review` opens directly on review tab
- [ ] Command palette (`:` key) — execute CLI commands within TUI
- [ ] All CLI commands accessible via TUI (feature parity)
- [ ] Verify: TUI opens with tabs, shows queue, exits cleanly

---

### Task 9: Review Page — Diff View 🏆
**Branch:** `feat/task-09-diff-view`

- [ ] `packages/plugins/review/src/pages/ReviewPage.tsx`:
  - Vertical layout: summary → diff → comments
  - Full-screen scrollable
- [ ] `packages/plugins/review/src/components/DiffView.tsx`:
  - File headers, hunk headers, colored lines, line numbers
  - Inline rule violation markers
- [ ] Navigation hooks: j/k scroll, n/N files, h/H hunks
- [ ] Verify: scroll through multi-file diff smoothly

---

### Task 10: Comments & Finalization 🏆
**Branch:** `feat/task-10-comments`

- [ ] CommentList, CommentInput components
- [ ] useComments hook (CRUD)
- [ ] `c` → add comment at current line
- [ ] Finalization: `a`/`f`/`q` → save review as OKF markdown
- [ ] Verify: full review flow end-to-end

---

## Phase 4: Rules Engine (Day 5-6)

### Task 11: Rules — Regex Enforcement 🏆
**Branch:** `feat/task-11-rules-regex`

- [ ] `packages/plugins/review/src/domain/rules.ts`:
  - `createRule()`, `loadRules()`, `matchRegex(rules, diff)`
  - Rules as individual OKF markdown files with examples
- [ ] `lgtm review rule add`, `lgtm review rule list`
- [ ] `r` in TUI → create rule from context
- [ ] Violations shown inline in diff view
- [ ] Tests: regex matching
- [ ] Verify: create rule → violations appear in next review

---

### Task 12: Rules — LLM Enforcement 🏆
**Branch:** `feat/task-12-rules-llm`

- [ ] `packages/core/src/llm/provider.ts` — interface + factory
- [ ] `packages/core/src/llm/openai.ts`, `anthropic.ts`, `ollama.ts`
- [ ] `packages/core/src/llm/cache.ts` — content-hash caching
- [ ] LLM rule enforcement: rule description + examples + diff → violations
- [ ] Scope: only changed files
- [ ] Integrate alongside regex rules in review flow
- [ ] Verify: LLM catches conceptual violations

---

### Task 13: Repo-Wide Scan
**Branch:** `feat/task-13-scan`

- [ ] `lgtm review scan` — all rules against whole repo
- [ ] Batch processing with progress indicator
- [ ] Results with action options (issue/PR/fold/ignore)
- [ ] Verify: finds existing violations

---

### Task 14: Rule Export
**Branch:** `feat/task-14-rule-export`

- [ ] `lgtm review rule export --format hook|steering|eslint`
- [ ] Generate appropriate output for each format
- [ ] Verify: exported hook catches violations

---

## Phase 5: Intelligence (Day 6-7)

### Task 15: Comment Pattern Analysis
**Branch:** `feat/task-15-patterns`

- [ ] `packages/plugins/review/src/domain/patterns.ts`
- [ ] `lgtm review rules suggest` — mine comment history for repeated themes
- [ ] LLM analysis: identify patterns, suggest rules with examples
- [ ] Interactive confirm/edit/reject flow
- [ ] Verify: repeated comments → rule suggestion

---

### Task 16: AI Summary
**Branch:** `feat/task-16-ai-summary`

- [ ] Summary generation on `lgtm review add --ai`
- [ ] Cached by commit SHA
- [ ] Shown in status + TUI
- [ ] Graceful fallback
- [ ] Verify: summaries appear

---

## Phase 6: GitHub (Day 7)

### Task 17: GitHub Integration
**Branch:** `feat/task-17-github`

- [ ] `packages/plugins/review/src/infra/github.ts`
- [ ] Fetch PR, post review, post inline comments
- [ ] Wire into add (GitHub mode) and approve/flag
- [ ] Verify: fetch real PR, post review

---

### Task 18: Cross-PR Overlap
**Branch:** `feat/task-18-overlap`

- [ ] Detect file/line conflicts between queued PRs
- [ ] Show in status, `lgtm review compare` command
- [ ] Verify: overlapping PRs trigger warnings

---

## Phase 7: Polish (Day 8)

### Task 19: README & Docs
**Branch:** `feat/task-19-docs`

- [ ] Comprehensive README: problem, install, quickstart, commands, architecture
- [ ] LICENSE (MIT), CONTRIBUTING.md, ROADMAP.md
- [ ] Verify: fresh clone → bun install → works

---

### Task 20: Demo & Submission
**Branch:** `feat/task-20-demo`

- [ ] Demo scenario with seed data
- [ ] Terminal recording / GIF
- [ ] Submission writeup
- [ ] Tag v0.1.0
- [ ] Verify: end-to-end

---

## Day-by-Day Schedule

| Day | Tasks | Milestone |
|-----|-------|-----------|
| 1 | 1, 2 | Monorepo builds, plugin system works |
| 2 | 3, 4 | OKF store + onboarding flow |
| 3 | 5, 6, 7 | Git/diff parsing, queue, CLI commands |
| 4 | 8, 9 | TUI shell + diff view |
| 5 | 10, 11 | Comments, finalization, regex rules |
| 6 | 12, 15 | LLM rules + pattern analysis |
| 7 | 13, 14, 16, 17 | Scan, export, AI summary, GitHub |
| 8 | 18, 19, 20 | Overlap, docs, demo, submit |

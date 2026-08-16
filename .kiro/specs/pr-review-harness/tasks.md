# Tasks: PR Review Harness (PRR)

## Implementation Plan

Tasks are ordered by dependency and priority. Each task is self-contained and results in a working (if incomplete) tool. MVP tasks are marked with 🏆.

---

## Phase 1: Foundation (Day 1-2)

### Task 1: Project Scaffold 🏆
**Implements:** Infrastructure setup
**Depends on:** Nothing

- [ ] Initialize npm project with `pnpm init`
- [ ] Configure `tsconfig.json` (strict mode, ES2022 target, NodeNext module)
- [ ] Configure `tsup.config.ts` (bundle to `dist/`, CLI entry point)
- [ ] Add dependencies:
  - `commander` (CLI framework)
  - `ink` + `ink-text-input` + `react` (TUI)
  - `simple-git` (git operations)
  - `yaml` (YAML read/write)
  - `chalk` (terminal colors)
  - `uuid` (ID generation)
  - `cosmiconfig` (config loading)
  - `minimatch` (glob matching for rules)
- [ ] Add dev dependencies: `typescript`, `tsup`, `vitest`, `@types/react`, `@types/node`
- [ ] Create folder structure per design.md
- [ ] Add `bin` field in package.json pointing to `dist/index.js`
- [ ] Add scripts: `build`, `dev`, `test`, `lint`
- [ ] Create `.gitignore` (node_modules, dist, .prr cache)
- [ ] Verify: `pnpm build` succeeds with empty entry point

**Output:** Buildable TypeScript project with all dependencies, folder structure, and CLI entry point.

---

### Task 2: Domain Types & Config 🏆
**Implements:** Data models, config loading
**Depends on:** Task 1

- [ ] Create `src/domain/types.ts` with all interfaces:
  - `QueuedPR`, `ReviewComment`, `ReviewSession`, `Rule`, `RuleViolation`, `PRRConfig`
- [ ] Create `src/infra/config.ts`:
  - `loadConfig()` — uses cosmiconfig to find `.prrrc.yaml` or `.prr/config.yaml`
  - `getDefaultConfig()` — sensible defaults (local mode, AI disabled)
  - `resolveConfig(cliFlags, fileConfig)` — merges CLI overrides
- [ ] Create `.prrrc.yaml.example` with documented options
- [ ] Verify: types compile cleanly, config loads from example file

**Output:** All TypeScript types defined, config loading works.

---

### Task 3: File Store (YAML + Markdown) 🏆
**Implements:** Persistence layer
**Depends on:** Task 2

- [ ] Create `src/infra/store.ts`:
  - `ensureSessionDir(date)` — creates `.prr/sessions/YYYY-MM-DD/`
  - `saveQueue(session, queue)` — writes queue.yaml
  - `loadQueue(session)` — reads queue.yaml
  - `saveReview(session, review)` — writes pr-{n}.review.md
  - `loadReview(session, prNumber)` — reads review markdown
  - `saveRules(rules)` — writes `.prr/rules/rules.yaml`
  - `loadRules()` — reads rules
- [ ] Create `src/utils/markdown.ts`:
  - `generateReviewMarkdown(session: ReviewSession)` — produces the review.md format
  - `parseReviewMarkdown(content: string)` — reads back (for history search)
- [ ] Write tests: `tests/domain/store.test.ts` — round-trip save/load
- [ ] Verify: can write and read queue, review, and rules files

**Output:** Complete persistence layer — data survives across sessions.

---

## Phase 2: Git & Diff (Day 2-3)

### Task 4: Git Adapter 🏆
**Implements:** Fetch diffs from local git
**Depends on:** Task 2

- [ ] Create `src/infra/git.ts`:
  - `getDiff(prNumber | branchName)` — runs `git diff` or `git log --patch`
  - `getBranches()` — list local branches
  - `getCurrentRepo()` — returns owner/repo from remote URL
  - `isGitRepo(path)` — validates we're in a git repo
  - `getMergeBase(branch, target)` — find common ancestor for proper diff
- [ ] Handle: detached HEAD, no remote, uncommitted changes
- [ ] Verify: can extract diff for a branch vs main

**Output:** Can fetch raw unified diffs from any local git repo.

---

### Task 5: Diff Parser 🏆
**Implements:** Structured diff parsing
**Depends on:** Task 4

- [ ] Create `src/utils/diff-parser.ts`:
  - `parseDiff(raw: string): ParsedDiff`
  - `ParsedDiff` = `{ files: DiffFile[] }`
  - `DiffFile` = `{ path, hunks: DiffHunk[] }`
  - `DiffHunk` = `{ header, startLine, lines: DiffLine[] }`
  - `DiffLine` = `{ type: 'add'|'remove'|'context', content, lineNumber }`
- [ ] Handle edge cases: binary files, renames, new files, deleted files
- [ ] Add line numbering (both old and new line numbers)
- [ ] Write tests with fixture diffs: `tests/fixtures/sample-diffs/`
- [ ] Verify: complex multi-file diffs parse correctly

**Output:** Raw diff strings become structured, navigable data.

---

## Phase 3: Queue & CLI (Day 3-4)

### Task 6: Queue Manager 🏆
**Implements:** PR queue lifecycle
**Depends on:** Task 3, Task 4

- [ ] Create `src/domain/queue.ts`:
  - `addToQueue(prNumbers[], config)` — validate, fetch metadata, add
  - `getQueue(session)` — return current queue state
  - `updateState(prNumber, newState, reason?)` — state transitions
  - `removeFromQueue(prNumber)` — remove a PR
- [ ] State machine: `queued` → `reviewing` → `approved` | `flagged`
- [ ] Validation: no duplicates, PR must exist (git branch or GH PR)
- [ ] Auto-create session directory if first operation of the day
- [ ] Write tests: state transitions, duplicate handling, persistence

**Output:** Queue management with state machine and persistence.

---

### Task 7: CLI Commands (Core) 🏆
**Implements:** `prr init`, `prr add`, `prr status`, `prr approve`, `prr flag`
**Depends on:** Task 6

- [ ] Create `src/cli/index.ts` — Commander program setup with version, description
- [ ] Create `src/cli/commands/init.ts`:
  - Creates `.prr/` directory structure
  - Writes default config from template
  - Detects GitHub remote and pre-fills owner/repo
- [ ] Create `src/cli/commands/add.ts`:
  - Parses PR numbers from args
  - Calls QueueManager.addToQueue()
  - Prints confirmation with PR titles
- [ ] Create `src/cli/commands/status.ts`:
  - Loads queue, displays table (chalk-formatted)
  - Columns: #, Title, State, Files, Summary (truncated)
  - Color-coded states: queued=grey, reviewing=yellow, approved=green, flagged=red
- [ ] Create `src/cli/commands/approve.ts`:
  - Validates PR is in queue and state is reviewing
  - Updates state to approved
- [ ] Create `src/cli/commands/flag.ts`:
  - `--reason` flag required
  - Updates state to flagged with reason
- [ ] Wire up `src/index.ts` entry point
- [ ] Verify: `pnpm build && node dist/index.js status` works end-to-end

**Output:** Working CLI — can init, add PRs, check status, approve/flag.

---

## Phase 4: TUI (Day 4-6)

### Task 8: TUI Shell & Layout 🏆
**Implements:** Basic Ink app with split panes
**Depends on:** Task 5, Task 7

- [ ] Create `src/tui/App.tsx` — root component, accepts ReviewSession data
- [ ] Create `src/tui/components/StatusBar.tsx`:
  - Shows: PR title, current file, position (1/N), keybinding hints
  - Fixed at bottom
- [ ] Create layout: `<Box flexDirection="row">` with two panes
- [ ] Left pane placeholder (will become DiffPane)
- [ ] Right pane placeholder (will become CommentPane)
- [ ] Wire `prr review <n>` command to launch Ink app with diff data
- [ ] Handle terminal resize gracefully
- [ ] Verify: `prr review 1` opens a split-pane TUI that can be exited with `q`

**Output:** TUI launches, shows layout structure, exits cleanly.

---

### Task 9: Diff Pane (Scrollable) 🏆
**Implements:** Left pane — scrollable, syntax-colored diff display
**Depends on:** Task 8

- [ ] Create `src/tui/components/DiffPane.tsx`:
  - Receives `ParsedDiff` and `scrollOffset`
  - Renders file headers (bold, with path)
  - Renders hunk headers (@@...@@) in cyan
  - Renders lines: green (+), red (-), grey (context)
  - Shows line numbers in gutter
  - Clips to visible terminal height
- [ ] Create `src/tui/hooks/useScroll.ts`:
  - Tracks scroll position (line index)
  - Exposes: `scrollUp()`, `scrollDown()`, `jumpToFile(n)`, `jumpToHunk(n)`
  - Bounds checking (can't scroll past start/end)
- [ ] Create `src/tui/hooks/useKeyboard.ts`:
  - Maps `j/k/↑/↓` to scroll
  - Maps `n/N` to next/prev file
  - Maps `h/H` to next/prev hunk
  - Maps `q` to exit
- [ ] Verify: can scroll through a multi-file diff smoothly

**Output:** Fully navigable diff viewer in the terminal.

---

### Task 10: Comment Pane & Input 🏆
**Implements:** Right pane — add/view comments linked to lines
**Depends on:** Task 9

- [ ] Create `src/tui/components/CommentPane.tsx`:
  - Shows list of comments for current file
  - Each comment shows: line number, text (truncated to pane width)
  - Highlights comment for current line (if any)
  - Scrolls to follow the diff pane's current position
- [ ] Create `src/tui/hooks/useComments.ts`:
  - `addComment(file, line, text)` — creates ReviewComment
  - `editComment(id, newText)` — updates
  - `deleteComment(id)` — removes
  - `getCommentsForFile(file)` — filtered list
- [ ] Implement comment input:
  - `c` key enters comment mode (shows text input at bottom of right pane)
  - Auto-fills file and line from current scroll position
  - Enter submits, Escape cancels
  - Comment immediately appears in right pane
- [ ] Verify: can add comments, see them in right pane, they persist to review markdown on exit

**Output:** Full review flow — read diff, add comments, save on exit.

---

### Task 11: Review Finalization 🏆
**Implements:** Save review on TUI exit, prompt for decision
**Depends on:** Task 10

- [ ] On `q` or `a` or `f` keypress, exit TUI and prompt:
  - `a` → approve immediately
  - `f` → prompt for flag reason (text input), then flag
  - `q` → ask: "[a]pprove / [f]lag / [s]kip for later"
- [ ] Call `ReviewSession.finalize()`:
  - Set completedAt timestamp
  - Generate review markdown via `generateReviewMarkdown()`
  - Save to `.prr/sessions/<date>/pr-<n>.review.md`
  - Update queue state
- [ ] Print summary to terminal after exit:
  - "✅ PR #101 approved (3 comments)"
  - "🚩 PR #103 flagged: breaks API contract (5 comments)"
- [ ] Verify: full flow from `prr add` → `prr review` → exit → markdown saved

**Output:** Complete review lifecycle works end-to-end.

---

## Phase 5: Rules Engine (Day 6-7)

### Task 12: Rules Engine (Create & Match) 🏆
**Implements:** Rule CRUD and pattern matching against diffs
**Depends on:** Task 5, Task 3

- [ ] Create `src/domain/rules.ts`:
  - `createRule(description, options)` — generates Rule object, saves
  - `loadRules()` — reads from `.prr/rules/rules.yaml`
  - `matchRules(rules, parsedDiff)` → `RuleViolation[]`
  - Matching logic: for each rule with `pattern`, test regex against each added line
  - Respect `filePattern` (minimatch glob)
- [ ] Create `src/cli/commands/rule.ts`:
  - `prr rule add "description" [--pattern "regex"] [--category security] [--severity warn] [--file-pattern "**/*.ts"]`
  - `prr rule list` — table of all rules
  - `prr rule disable <id>` — toggles enabled
  - `prr rule delete <id>` — removes rule
- [ ] Write tests: rule matching against sample diffs, glob filtering
- [ ] Verify: create rule → add PR → violations detected in TUI

**Output:** Rules can be created, persisted, and enforced against diffs.

---

### Task 13: Rules in TUI 🏆
**Implements:** Show rule violations inline in diff pane
**Depends on:** Task 12, Task 9

- [ ] Create `src/tui/components/RuleWarning.tsx`:
  - Inline warning rendered after the violating line in diff pane
  - Format: `⚠️ [category] rule description`
  - Colored: yellow for warn, red for error
- [ ] Run `RulesEngine.matchRules()` when review starts
- [ ] Violations passed to DiffPane as overlay data
- [ ] `r` key in TUI: create new rule from current context
  - Pre-fills the matched line as suggested pattern
  - Prompts: description, category, severity
  - Saves rule immediately
- [ ] Verify: violations appear inline, new rules can be created during review

**Output:** Rules are visible during review, new rules created from context.

---

### Task 14: Rule Export
**Implements:** Export rules as hooks/steering/eslint config
**Depends on:** Task 12

- [ ] Add `prr rule export --format <hook|steering|eslint>`:
  - **hook**: Generates shell script that greps staged changes for rule patterns
  - **steering**: Generates `.kiro/steering/prr-rules.md` with rules as guidelines
  - **eslint**: Generates JSON config with `no-restricted-syntax` rules (where applicable)
- [ ] Each export format includes rule description as comments
- [ ] Export to stdout by default, `--output <file>` to write to file
- [ ] Verify: exported hook actually catches violations on `git commit`

**Output:** Rules become upstream enforcement mechanisms.

---

## Phase 6: Enhancements (Day 7-8)

### Task 15: GitHub Adapter
**Implements:** Fetch PR metadata and post reviews via GitHub API
**Depends on:** Task 7

- [ ] Create `src/infra/github.ts`:
  - `fetchPR(owner, repo, number)` — returns title, body, files, diff URL
  - `fetchDiff(owner, repo, number)` — returns raw unified diff
  - `postReview(owner, repo, number, review)` — posts APPROVE or REQUEST_CHANGES
  - `postComments(owner, repo, number, comments[])` — inline review comments
- [ ] Auth: auto-detect from `GITHUB_TOKEN` env or `gh auth token`
- [ ] Error handling: 404 (PR not found), 401 (bad token), 403 (rate limit)
- [ ] Wire into `prr add` (GitHub mode) and `prr approve/flag` (post review)
- [ ] Verify: can fetch a real PR diff and post a review comment

**Output:** Full GitHub integration — fetch PRs, post structured reviews.

---

### Task 16: Cross-PR File Overlap
**Implements:** Detect shared files between queued PRs
**Depends on:** Task 6, Task 5

- [ ] Add `correlation.ts` to domain:
  - `detectOverlap(queue: QueuedPR[], diffs: Map<number, ParsedDiff>)` → overlap report
  - Returns: pairs of PRs with shared file paths
- [ ] Add to `prr status` output: `⚠️ PR #101 and #103 both modify src/auth/`
- [ ] Add `prr compare <PR1> <PR2>`:
  - Shows files that appear in both diffs
  - Highlights conflicting changes to same lines
- [ ] No LLM needed — pure file path comparison
- [ ] Verify: queuing 2 PRs that touch same file shows warning

**Output:** Automatic conflict detection between queued PRs.

---

### Task 17: AI Summary Integration
**Implements:** Optional LLM-generated PR summary on queue
**Depends on:** Task 7

- [ ] Create `src/infra/llm/provider.ts` — interface + factory
- [ ] Create `src/infra/llm/openai.ts` — raw fetch to OpenAI API
- [ ] Create `src/infra/llm/anthropic.ts` — raw fetch to Anthropic API
- [ ] Create `src/infra/llm/ollama.ts` — raw fetch to local Ollama
- [ ] Implement summary prompt:
  - Input: truncated diff (max 4000 chars), file list
  - Output: 2-3 sentence summary + risk flags
  - System prompt emphasizes brevity and token efficiency
- [ ] Cache: store summary keyed by `{prNumber}-{commitSha}`
- [ ] Wire into `prr add --ai` — generates summary after adding
- [ ] Display in `prr status` and TUI SummaryHeader
- [ ] Graceful fallback: if LLM fails, show "Summary unavailable" and continue
- [ ] Verify: summary appears in status and TUI, is cached on second view

**Output:** AI summaries available with minimal token usage.

---

### Task 18: Review History & Search
**Implements:** Search past reviews
**Depends on:** Task 3

- [ ] Create `src/cli/commands/history.ts`:
  - `prr history` — lists sessions (date, PR count, approved/flagged counts)
  - `prr history --search "keyword"` — greps through review markdown files
  - `prr history --pr <n>` — finds all reviews for a specific PR
- [ ] Build index from session directories (scan `.prr/sessions/*/`)
- [ ] Output: table with date, PR#, title, state, comment count
- [ ] Verify: can find past reviews by keyword

**Output:** Searchable review archive.

---

## Phase 7: Polish (Day 8)

### Task 19: README & Documentation
**Implements:** User-facing docs for hackathon submission
**Depends on:** All above

- [ ] Write comprehensive README.md:
  - Problem statement (the review bottleneck)
  - Demo GIF or screenshots of TUI
  - Installation instructions
  - Quick start guide
  - Full command reference
  - Configuration docs
  - Rules system explanation
  - Architecture overview (brief)
- [ ] Add CONTRIBUTING.md (for post-hackathon)
- [ ] Add LICENSE (MIT)
- [ ] Ensure `npm install -g prr` works (package.json bin config)

**Output:** Hackathon-ready repo with clear docs.

---

### Task 20: Demo & Submission Prep
**Implements:** Hackathon deliverables
**Depends on:** Task 19

- [ ] Create sample demo scenario (seed PRs for demo)
- [ ] Record terminal session or create GIF showing full flow
- [ ] Write hackathon submission description (concise, compelling)
- [ ] Verify: fresh `git clone` → `pnpm install` → `pnpm build` → works
- [ ] Tag release: `v0.1.0`

**Output:** Submitted to hackathon.

---

## Task Dependency Graph

```
Task 1 (scaffold)
  └── Task 2 (types/config)
       ├── Task 3 (store)
       │    ├── Task 6 (queue) ──► Task 7 (CLI) ──► Task 15 (GitHub)
       │    │                                   ──► Task 16 (overlap)
       │    │                                   ──► Task 17 (AI)
       │    ├── Task 12 (rules) ──► Task 13 (rules TUI) ──► Task 14 (export)
       │    └── Task 18 (history)
       └── Task 4 (git adapter)
            └── Task 5 (diff parser)
                 └── Task 8 (TUI shell)
                      └── Task 9 (diff pane)
                           └── Task 10 (comment pane)
                                └── Task 11 (finalization)
```

---

## Day-by-Day Schedule (Aggressive but achievable)

| Day | Date | Tasks | Milestone |
|-----|------|-------|-----------|
| 1 | Aug 15 | 1, 2 | Project builds, types defined |
| 2 | Aug 16 | 3, 4, 5 | Can fetch and parse diffs |
| 3 | Aug 17 | 6, 7 | CLI works: add, status, approve, flag |
| 4 | Aug 18 | 8, 9 | TUI shows scrollable diff |
| 5 | Aug 19 | 10, 11 | Full review flow works end-to-end |
| 6 | Aug 20 | 12, 13 | Rules engine with TUI integration |
| 7 | Aug 21 | 14, 15, 16 | Rule export, GitHub mode, overlap |
| 8 | Aug 22 | 17, 18, 19, 20 | AI, history, docs, submission |

**Hard deadline:** August 23 (submissions close)

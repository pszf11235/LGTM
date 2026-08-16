# Requirements: PR Review Harness (PRR)

## Overview

PRR is a structured review workspace for developers who generate PRs faster than they can review them. It provides workflow, persistence, and a TUI around the code review process, with optional LLM enhancement for summaries and pattern detection.

---

## User Stories & Acceptance Criteria

### Epic 1: Review Queue & Workflow

#### US-1.1: Queue PRs for Review
**As a** developer with multiple AI-generated PRs,
**I want to** add PRs to a review queue,
**So that** I can work through them systematically instead of context-switching.

**Acceptance Criteria:**
- [ ] `prr add <PR numbers...>` adds one or more PRs to the queue
- [ ] PRs are validated (exist on GitHub or local git) before being added
- [ ] Duplicate PRs are rejected with a message
- [ ] Queue is persisted to `.prr/sessions/<date>/queue.yaml`
- [ ] Works with PR numbers (GitHub mode) or branch names (local mode)

#### US-1.2: View Review Status
**As a** developer managing multiple reviews,
**I want to** see the status of all queued PRs at a glance,
**So that** I know what's reviewed, flagged, or still pending.

**Acceptance Criteria:**
- [ ] `prr status` shows a table: PR number, title, state (queued/reviewing/approved/flagged), files changed count
- [ ] States: `queued` → `reviewing` → `approved` | `flagged`
- [ ] If AI summary is enabled, shows one-line summary per PR
- [ ] Sorted by queue order (oldest first)

#### US-1.3: Approve or Flag a PR
**As a** reviewer finishing a PR,
**I want to** mark it as approved or flagged with a reason,
**So that** I have a clear record of my decision.

**Acceptance Criteria:**
- [ ] `prr approve <PR>` moves PR to `approved` state
- [ ] `prr flag <PR> --reason "..."` moves PR to `flagged` state with reason
- [ ] In GitHub mode, `approve` posts an approving review; `flag` posts a request-changes review
- [ ] In local mode, state change is recorded in session markdown
- [ ] Cannot approve/flag a PR that hasn't been reviewed (must enter review first)

---

### Epic 2: TUI Review Interface

#### US-2.1: Enter Focused Review Mode
**As a** developer reviewing a PR,
**I want to** enter a focused TUI showing the diff and a comment panel,
**So that** I can read code and add comments without leaving my terminal.

**Acceptance Criteria:**
- [ ] `prr review <PR>` opens the TUI
- [ ] Left pane: scrollable diff (syntax-highlighted if possible)
- [ ] Right pane: comment list (linked to line numbers)
- [ ] AI summary displayed at top of left pane (if enabled)
- [ ] Status bar at bottom showing PR title, file count, current position, keybindings

#### US-2.2: Navigate the Diff
**As a** reviewer reading code changes,
**I want to** scroll through files and hunks with keyboard shortcuts,
**So that** I can efficiently move through the diff.

**Acceptance Criteria:**
- [ ] `j/k` or arrow keys scroll line by line
- [ ] `n/N` jump to next/previous file
- [ ] `h/H` jump to next/previous hunk
- [ ] Shows file path header between files
- [ ] Shows hunk context (unchanged lines around changes)
- [ ] `+` lines highlighted green, `-` lines highlighted red

#### US-2.3: Add Comments During Review
**As a** reviewer who notices issues,
**I want to** add comments linked to specific lines,
**So that** my feedback is precise and actionable.

**Acceptance Criteria:**
- [ ] `c` on a line opens a comment input
- [ ] Comment is stored with: file path, line number, text, timestamp
- [ ] Comments appear in right pane, anchored to their line
- [ ] Can edit or delete existing comments
- [ ] Comments persist when navigating between files

#### US-2.4: Exit Review with Summary
**As a** reviewer finishing a PR,
**I want to** exit the TUI and have my review saved automatically,
**So that** I never lose work.

**Acceptance Criteria:**
- [ ] `q` exits the TUI
- [ ] All comments saved to `.prr/sessions/<date>/pr-<number>.review.md`
- [ ] Review markdown includes: PR title, summary, all comments with line refs, timestamp
- [ ] Prompted to approve/flag/skip on exit

---

### Epic 3: Dual Mode (Local / GitHub)

#### US-3.1: Local Mode (Default)
**As a** developer who wants to review privately first,
**I want to** save all reviews as local markdown files,
**So that** I can review without immediately pushing feedback to GitHub.

**Acceptance Criteria:**
- [ ] Default mode is `local`
- [ ] All reviews saved as markdown in `.prr/sessions/`
- [ ] Comments stored locally, never posted to GitHub
- [ ] Can later `prr push <PR>` to post local comments to GitHub
- [ ] Diffs fetched via `git` (local repo) or GitHub API (remote)

#### US-3.2: GitHub Mode
**As a** developer ready to share feedback,
**I want to** post my review comments directly to GitHub,
**So that** my team can see my review inline on the PR.

**Acceptance Criteria:**
- [ ] `prr review <PR> --mode github` or configured globally
- [ ] On approve: posts GitHub "APPROVE" review with summary
- [ ] On flag: posts GitHub "REQUEST_CHANGES" review with comments
- [ ] Comments posted as inline review comments at correct file/line
- [ ] Requires GitHub token (auto-detects from `gh auth` or env var)

#### US-3.3: Configuration
**As a** user with preferences,
**I want to** configure PRR globally and per-project,
**So that** defaults match my workflow.

**Acceptance Criteria:**
- [ ] Config file: `.prrrc.yaml` or `.prr/config.yaml`
- [ ] Configurable: mode (local/github), LLM provider, LLM enabled (bool), default rules, GitHub owner/repo
- [ ] CLI flags override config values
- [ ] `prr init` creates a default config file

---

### Epic 4: Ruleify (Learn from Reviews)

#### US-4.1: Create Rules from Review Patterns
**As a** reviewer who notices repeated issues,
**I want to** capture patterns as rules during review,
**So that** the same issue is flagged automatically in future PRs.

**Acceptance Criteria:**
- [ ] `r` in TUI or `prr rule add "description"` from CLI creates a rule
- [ ] Rules stored in `.prr/rules/rules.yaml`
- [ ] Rule has: id, description, category (security/style/testing/architecture), severity (warn/error), optional pattern (regex or glob)
- [ ] Rules can have optional file patterns (e.g., "only applies to `*.ts` files")

#### US-4.2: Enforce Rules in Future Reviews
**As a** reviewer who has defined rules,
**I want** PRR to automatically check new PRs against my rules,
**So that** known issues are flagged without me remembering them.

**Acceptance Criteria:**
- [ ] When a PR is queued/reviewed, rules are checked against the diff
- [ ] Pattern-based rules (regex) flag matching lines
- [ ] Description-only rules shown as reminders during review
- [ ] Violations shown in TUI as warnings (distinct from your comments)
- [ ] Rule violations included in review markdown

#### US-4.3: Export Rules as Enforcement Mechanisms
**As a** developer who wants to prevent issues upstream,
**I want to** export rules as hooks, tests, or steering files,
**So that** the AI agents don't make the same mistakes.

**Acceptance Criteria:**
- [ ] `prr rule export --format hook` generates a git pre-commit hook script
- [ ] `prr rule export --format steering` generates a `.kiro/steering/*.md` file
- [ ] `prr rule export --format eslint` generates ESLint rule config (for applicable rules)
- [ ] Export includes rule description as comments for context
- [ ] Exported files are ready to use (no manual editing required for basic cases)

---

### Epic 5: AI Summary (Optional, Token-Efficient)

#### US-5.1: Generate PR Summary on Queue
**As a** reviewer starting a session,
**I want** a brief AI-generated summary of each PR,
**So that** I can prioritize and understand scope before diving into diffs.

**Acceptance Criteria:**
- [ ] When `--ai` flag is set (or config enabled), summary generated on `prr add`
- [ ] Summary includes: what changed (1-2 sentences), files affected, risk areas, test coverage note
- [ ] Summary cached — never re-generated for same PR/commit SHA
- [ ] Token budget: max ~1000 tokens per PR
- [ ] Works with OpenAI, Anthropic, or Ollama
- [ ] Graceful degradation if LLM unavailable (shows "no summary" instead of error)

#### US-5.2: AI Pattern Detection (Rule Suggestions)
**As a** reviewer who keeps flagging similar issues,
**I want** the AI to notice patterns in my comments and suggest rules,
**So that** I can formalize them without thinking about it.

**Acceptance Criteria:**
- [ ] After 3+ reviews in a session, AI analyzes comments for patterns (if enabled)
- [ ] Suggests rules based on repeated themes (e.g., "you commented about env vars 3 times")
- [ ] User confirms/rejects/edits suggested rules
- [ ] Token budget: max ~500 tokens per session
- [ ] Runs only when explicitly triggered (`prr rules suggest`) or at session end

---

### Epic 6: Cross-PR Awareness

#### US-6.1: Detect File Overlap
**As a** developer reviewing related PRs,
**I want** PRR to flag when multiple queued PRs modify the same files,
**So that** I can review them in the right order and spot conflicts.

**Acceptance Criteria:**
- [ ] On `prr status`, shows overlap indicators (e.g., "⚠️ PR #101 and #103 both touch src/auth/")
- [ ] `prr compare <PR1> <PR2>` shows shared files and conflicting changes
- [ ] Algorithmic (no LLM) — just file path comparison from diffs
- [ ] Suggests review order based on dependency (file overlap graph)

---

### Epic 7: Review History

#### US-7.1: Searchable Review History
**As a** developer who reviews regularly,
**I want to** search past reviews by keyword, PR number, or date,
**So that** I can find previous decisions and context.

**Acceptance Criteria:**
- [ ] `prr history` shows recent review sessions
- [ ] `prr history --search "auth"` finds reviews mentioning "auth"
- [ ] `prr history --pr 101` shows all reviews for PR #101
- [ ] Output shows: date, PR, state (approved/flagged), comment count, one-line summary
- [ ] History built from session markdown files (no separate database)

---

## Non-Functional Requirements

### NFR-1: Performance
- TUI renders in < 100ms for diffs up to 2000 lines
- Queue operations (add/status/approve) complete in < 500ms
- AI summary call should timeout after 30s with graceful fallback

### NFR-2: Token Efficiency
- Full review session (5 PRs) uses < 7,500 tokens total (with AI enabled)
- Tool is fully functional with AI disabled (zero tokens)
- All LLM calls are cached by content hash (never repeat for same input)

### NFR-3: Portability
- Works on macOS and Linux
- No system dependencies beyond Node.js 18+
- Flat file storage (no database server required)
- Git and `gh` CLI optional (only needed for GitHub mode)

### NFR-4: Privacy
- Local mode never sends code to external services
- AI features require explicit opt-in
- No telemetry or analytics
- Rules and review history stay on disk

---

## MVP Scope (Hackathon — 8 days)

**Must have (ship by Aug 23):**
- [ ] CLI: `prr init`, `prr add`, `prr status`, `prr review`, `prr approve`, `prr flag`
- [ ] TUI: split-pane (diff left, comments right), keyboard navigation, comment on lines
- [ ] Local mode with markdown persistence
- [ ] Basic rule creation and enforcement (regex pattern matching)
- [ ] Review session saved as markdown

**Nice to have (if time allows):**
- [ ] GitHub mode (post reviews via API)
- [ ] AI summary on queue
- [ ] Rule export (hooks/steering)
- [ ] Cross-PR file overlap detection
- [ ] Search history

**Post-hackathon:**
- [ ] AI pattern detection / rule suggestions
- [ ] Full ESLint/hook export
- [ ] Team shared rules
- [ ] PR dependency graph visualization

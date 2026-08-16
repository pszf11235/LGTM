# Requirements: Yak Platform + Review Plugin

## Overview

Yak is a dev productivity platform (CLI + TUI) with a plugin architecture. The core provides shared infrastructure (CLI, TUI, LLM, storage, config, onboarding) and the first plugin (`review`) implements a structured PR review workflow.

---

## Epic 0: Core Platform

### US-0.1: Plugin Architecture
**As a** developer extending Yak,
**I want** a clear plugin interface,
**So that** I can add new capabilities without modifying core.

**Acceptance Criteria:**
- [ ] Plugin interface defines: name, commands, TUI pages, onboarding (optional)
- [ ] Core auto-discovers plugins from `packages/plugins/*/`
- [ ] Plugins register commands under their namespace (`yak <plugin> <command>`)
- [ ] Plugins can access core services (LLM, store, config)
- [ ] `yak plugins` lists all plugins with enabled/disabled status
- [ ] Plugins can be enabled/disabled via `yak plugins enable/disable <name>`

### US-0.2: Generic Onboarding
**As a** first-time user,
**I want** an interactive setup that asks about my project,
**So that** all plugins can calibrate to my context without asking again.

**Acceptance Criteria:**
- [ ] `yak init` launches interactive onboarding (TUI or inline prompts)
- [ ] Questions: project goals, quality references, feedback style, tech stack, team size, LLM preference
- [ ] Auto-detects tech stack from repo (package.json, Cargo.toml, go.mod, etc.)
- [ ] Skippable at any point (Ctrl+C or `--skip-onboarding`)
- [ ] Results saved to `.yak/profile.md` (OKF format)
- [ ] Profile accessible to all plugins via core API
- [ ] Re-runnable: `yak init` overwrites existing profile (with confirmation)

### US-0.3: Config System
**As a** user with preferences,
**I want** a layered config system with configurable storage location,
**So that** I can choose between central config or per-repo config and override as needed.

**Acceptance Criteria:**
- [ ] On first start, user chooses config location: central (`~/.yak/`) or per-repo (`.yak/`)
- [ ] Choice stored in a bootstrap file (`~/.yakrc` or env var)
- [ ] Per-project overrides always possible via `.yakrc.yaml` in repo root
- [ ] Override chain: defaults → central/repo config → plugin config → .yakrc.yaml (repo) → CLI flags
- [ ] `yak config` shows current resolved config + config location
- [ ] `yak config set <key> <value>` updates config
- [ ] Plugins can define their own config keys (namespaced)

### US-0.4: LLM Provider Abstraction
**As a** plugin developer,
**I want** a unified LLM interface,
**So that** I can call any LLM without provider-specific code.

**Acceptance Criteria:**
- [ ] Supports: OpenAI, Anthropic, Ollama (local)
- [ ] Raw fetch (no heavy SDKs)
- [ ] Provider resolved from config (profile.md or env vars)
- [ ] Graceful fallback if LLM unavailable (features degrade, never crash)
- [ ] Token tracking: each call reports tokens used
- [ ] Caching: same input → cached result (keyed by content hash)

### US-0.5: OKF Storage
**As a** user and plugin developer,
**I want** all data stored as readable markdown with structured frontmatter,
**So that** data is browsable, git-friendly, and agent-readable.

**Acceptance Criteria:**
- [ ] All persisted data uses markdown + YAML frontmatter (OKF-style)
- [ ] `readOKF(path)` → `{ frontmatter, body }`
- [ ] `writeOKF(path, frontmatter, body)` → writes formatted file
- [ ] Files are valid markdown (renderable in GitHub, Obsidian, etc.)
- [ ] Cross-links between files use relative markdown links

---

## Epic 1: Review Plugin — Queue & Workflow

### US-1.1: Queue PRs for Review
**As a** developer with multiple AI-generated PRs,
**I want to** add PRs to a review queue,
**So that** I can work through them systematically.

**Acceptance Criteria:**
- [ ] `yak review add <PR numbers...>` adds PRs to queue
- [ ] PRs validated (exist on GitHub or local git)
- [ ] Duplicate rejection
- [ ] Queue persisted to `.yak/sessions/<date>/index.md`
- [ ] Works with PR numbers (GitHub) or branch names (local)

### US-1.2: Feature Grouping on Ingestion
**As a** developer reviewing related PRs,
**I want** Yak to auto-detect which PRs are related,
**So that** I can review them together and catch interaction issues.

**Acceptance Criteria:**
- [ ] On `yak review add`, analyzes file lists for overlap
- [ ] Groups PRs that share: directories, files, endpoints, import chains
- [ ] Groups shown in `yak review status` output
- [ ] Suggests review order based on dependencies
- [ ] Group info persisted in session index frontmatter
- [ ] Works without LLM (algorithmic file path analysis)

### US-1.3: View Review Status
**Acceptance Criteria:**
- [ ] `yak review status` shows table: #, Title, State, Group, Files
- [ ] Feature groups displayed with rationale
- [ ] Color-coded states
- [ ] AI summary shown if available

### US-1.4: Approve or Flag
**Acceptance Criteria:**
- [ ] `yak review approve <PR>` → approved state
- [ ] `yak review flag <PR> --reason "..."` → flagged state
- [ ] In GitHub mode: posts review to PR
- [ ] Cannot approve unfreviewed PR

---

## Epic 2: Review Plugin — TUI (OpenCode-style)

### US-2.1: TUI Review Interface
**Acceptance Criteria:**
- [ ] `yak` (bare command) opens full-screen TUI with tabs for each enabled plugin
- [ ] `yak tui review` opens TUI directly on the review tab
- [ ] TUI has tab navigation: Review | Specify | Learn (disabled tabs greyed out)
- [ ] All CLI commands are also executable within the TUI (command palette or hotkeys)
- [ ] Queue page: list PRs, select to review
- [ ] Review page: summary → diff → comments (vertical scroll)
- [ ] Status bar with keybindings
- [ ] Minimal chrome, content-focused (OpenCode-style)

### US-2.2: Diff Navigation
**Acceptance Criteria:**
- [ ] j/k scroll, n/N files, h/H hunks
- [ ] Syntax coloring (green/red/grey)
- [ ] Line numbers in gutter
- [ ] File headers between files
- [ ] Rule violations shown inline (⚠️ markers)

### US-2.3: Add Comments
**Acceptance Criteria:**
- [ ] `c` opens comment input at current line
- [ ] Comment stored with file, line, timestamp
- [ ] Comments shown below their section
- [ ] Edit/delete existing comments

### US-2.4: Review Finalization
**Acceptance Criteria:**
- [ ] `a` approve, `f` flag, `q` exit (prompts decision)
- [ ] Review saved as OKF markdown
- [ ] Queue state updated

---

## Epic 3: Review Plugin — Rules (Hybrid Enforcement)

### US-3.1: Create Rules with Examples
**Acceptance Criteria:**
- [ ] `yak review rule add "desc" --enforcement regex|llm`
- [ ] Rules include examples (bad code + good code)
- [ ] Rules saved as individual OKF markdown files
- [ ] Categories: security/style/testing/architecture/performance/general
- [ ] File pattern (glob) to scope rule to certain files

### US-3.2: Regex Enforcement
**Acceptance Criteria:**
- [ ] Rules with `enforcement: regex` matched via pattern against diff lines
- [ ] Zero tokens used
- [ ] Violations shown inline in TUI

### US-3.3: LLM Enforcement
**Acceptance Criteria:**
- [ ] Rules with `enforcement: llm` sent to LLM with examples + diff
- [ ] Scope: only changed files in the PR (direct enforcement)
- [ ] Returns: file, line, explanation, suggestion
- [ ] Cached by rule + diff hash
- [ ] Max ~500 tokens per rule per PR

### US-3.4: Repo-Wide Scan (On-Demand)
**Acceptance Criteria:**
- [ ] `yak review scan` checks whole repo against enabled rules
- [ ] User-triggered only (never automatic)
- [ ] Results presented with options: file issue / open PR / fold into current / ignore
- [ ] Progress indicator during scan
- [ ] Respects file patterns

### US-3.5: Rule Export
**Acceptance Criteria:**
- [ ] `yak review rule export --format hook|steering|eslint`
- [ ] Hook: shell script for pre-commit
- [ ] Steering: .kiro/steering markdown
- [ ] ESLint: JSON config (where applicable)

---

## Epic 4: Review Plugin — Pattern Intelligence

### US-4.1: Comment Pattern Analysis (Ruleify)
**Acceptance Criteria:**
- [ ] After 5+ reviews (or `yak review rules suggest`): LLM analyzes comment history
- [ ] Identifies repeated themes (same feedback across different PRs)
- [ ] Suggests rules with examples extracted from actual comments
- [ ] User confirms/edits/rejects each suggestion
- [ ] ~500 tokens per analysis

### US-4.2: AI Summary on Queue
**Acceptance Criteria:**
- [ ] When AI enabled: summary generated on `yak review add`
- [ ] ~1000 tokens per PR, cached by commit SHA
- [ ] Shown in status + TUI
- [ ] Graceful fallback if LLM unavailable

---

## Epic 5: Review Plugin — GitHub Integration

### US-5.1: GitHub Mode
**Acceptance Criteria:**
- [ ] Git and GitHub integration is native — no LLM needed to fetch repos/PRs
- [ ] Given a repo URL and PR number, tool can init repo and pull PR diff without AI
- [ ] Fetch PR metadata + diff from GitHub API (Octokit REST)
- [ ] Post reviews (APPROVE / REQUEST_CHANGES)
- [ ] Post inline comments at correct file/line
- [ ] Auth via GITHUB_TOKEN env or `gh auth`
- [ ] Works with `simple-git` for local operations (clone, fetch, diff)

### US-5.2: Cross-PR Overlap Detection
**Acceptance Criteria:**
- [ ] Detect same-file and same-line conflicts across queued PRs
- [ ] Show in status: "⚠️ PR #101 and #103 modify src/auth/middleware.ts"
- [ ] `yak review compare <PR1> <PR2>` for detailed comparison
- [ ] Algorithmic (no LLM)

---

## Non-Functional Requirements

### Performance
- TUI renders < 100ms for diffs up to 2000 lines
- CLI commands complete < 500ms (non-AI operations)
- AI calls timeout at 30s with graceful fallback

### Token Efficiency
- Full review session (5 PRs, AI enabled): < 15,000 tokens (~$0.05)
- Fully functional with AI disabled (zero tokens)
- All LLM results cached by content hash

### Portability
- macOS and Linux
- Only Bun 1.1+ required
- Flat file storage (no database)
- Git + gh CLI optional (only for GitHub mode)

### Privacy
- Local mode by default — never sends code externally unless configured
- AI features require explicit opt-in (onboarding question)
- No telemetry

---

## MVP Scope (Hackathon — 8 days)

**Must ship:**
- [ ] Core: CLI framework, plugin loader, config, OKF store, onboarding
- [ ] Review plugin: add, status, review (TUI), approve/flag, feature grouping
- [ ] Review plugin: rules (regex + LLM hybrid), inline violations
- [ ] Local mode with markdown persistence

**Nice to have:**
- [ ] GitHub integration (post reviews)
- [ ] AI summary
- [ ] Comment pattern analysis / rule suggestions
- [ ] Rule export
- [ ] Cross-PR overlap detection
- [ ] History/search

**Post-hackathon:**
- [ ] Learnify (learning notes from wrong assumptions)
- [ ] Specify plugin
- [ ] Learn plugin
- [ ] Brain plugin
- [ ] OpenTUI migration
- [ ] VS Code extension

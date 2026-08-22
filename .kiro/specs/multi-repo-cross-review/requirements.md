# Multi-Repo Cross-Review — Requirements

## Overview

Enable reviewing PRs across multiple repositories in a single LGTM session. Instead of switching context between repos, users add PRs from any repo (e.g., `frontend/app#42`, `backend/api#108`, `shared/lib#5`) to one queue and review them together — with cross-repo overlap detection and shared rules.

## User Stories

### US-1: Add PRs from multiple repos
**As a** developer working across a microservices architecture,
**I want to** add PRs from different repos to the same review queue,
**So that** I can review related changes together without switching tools.

**Acceptance Criteria:**
- `lgtm review add owner/repo#42` adds a PR from a specific repo
- `lgtm review add repo-name#42` resolves the repo from the registry (short form)
- `lgtm review add 42` still works for the current repo (backward compatible)
- Mixed formats in one command: `lgtm review add 10 other-repo#5 org/service#20`
- Error message if repo not found in registry or GitHub

### US-2: Cross-repo overlap detection
**As a** reviewer handling coordinated changes across services,
**I want** LGTM to detect when PRs in different repos touch related files (e.g., shared types, API contracts),
**So that** I review them in the right order and catch integration issues.

**Acceptance Criteria:**
- Detect shared file patterns across repos (e.g., `types/`, `proto/`, `openapi.yaml`)
- Show cross-repo dependency warnings: "PR #42 in `frontend` uses types changed by PR #108 in `backend`"
- Suggest review order: "Review `backend#108` first (it defines the contract)"
- Works with the existing grouping engine (extends it to cross-repo)

### US-3: Cross-repo rules
**As a** team lead enforcing standards across multiple services,
**I want** rules that apply across all repos in my queue,
**So that** I don't have to duplicate rules per-repo.

**Acceptance Criteria:**
- Global rules stored in `~/.lgtm-farm/rules/` (or configurable)
- Per-repo rules still work (`.lgtm/rules/`)
- Rule priority: per-repo overrides global (same rule ID)
- `lgtm review rule add --global "..."` creates a global rule
- `lgtm review rule list` shows both global and local rules with source indicator

### US-4: Cross-repo status view
**As a** developer reviewing across repos,
**I want** `lgtm review status` to show the repo for each PR,
**So that** I can tell which PR belongs where.

**Acceptance Criteria:**
- Status table shows a `Repo` column when queue has multi-repo PRs
- PRs grouped by repo in the TUI queue page
- Color coding or icons to distinguish repos

### US-5: Cross-repo PR report
**As a** tech lead running daily standups,
**I want** `lgtm review report` to aggregate across all watched repos,
**So that** I get one unified view of PR health across the org.

**Acceptance Criteria:**
- Report shows PRs grouped by repo
- Summary stats per-repo and total
- Supports `--repo <filter>` to narrow down

## Non-Functional Requirements

- **Storage**: All data persisted in OKF format (YAML frontmatter + markdown body) — same as existing LGTM storage. Global rules, queue sessions, and cross-repo config all use `.md` files readable by humans and parseable by tools.
- **Performance**: Adding a cross-repo PR should not add more than 2s latency (GitHub API call)
- **Offline**: Cross-repo features that require GitHub should degrade gracefully (show "offline" status)
- **Backward compatible**: All existing single-repo flows must continue working unchanged

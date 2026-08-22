# Auto-Ingest Repos — Requirements

## Overview

Automatically discover git repositories on the local machine and let the user interactively add or deny them for the LGTM watcher. Instead of manually running `lgtm review watch add owner/repo` for every repo, the tool scans common project directories, presents what it finds, and the user picks which to watch — like a setup wizard for multi-repo monitoring.

## User Stories

### US-1: Scan for git repos
**As a** developer with many repos on my machine,
**I want** LGTM to find all my git repositories automatically,
**So that** I don't have to remember and type each one manually.

**Acceptance Criteria:**
- `lgtm discover --ingest` scans default locations (`~/projects`, `~/dev`, `~/code`, `~/repos`, `~/src`, `~/work`, `~/<Desktop,Documents>`)
- `lgtm discover --ingest <path>` scans a specific directory
- Finds all directories containing `.git/`
- Extracts repo name, remote URL, last commit date
- Ignores: `node_modules`, `vendor`, `.cache`, archived/bare repos
- Scan depth configurable (default: 4 levels deep)
- Shows progress: "Scanning... found 23 repos"

### US-2: Interactive accept/deny
**As a** user reviewing discovered repos,
**I want** an interactive picker to accept or skip each repo,
**So that** I only watch repos I care about.

**Acceptance Criteria:**
- After scan, show repos grouped by directory (~/projects/..., ~/work/...)
- Each repo shows: name, remote (GitHub/GitLab), last activity, language (if detectable)
- User can: `[a]` accept, `[s]` skip, `[A]` accept all remaining, `[S]` skip all remaining
- Accepted repos are added to the watcher (`watch.md`)
- Accepted repos are registered in `~/.lgtm-registry.md`
- Final summary: "Added 8 repos to watcher. Skipping 15."

### US-3: Smart suggestions
**As a** user who doesn't want to review 50 repos individually,
**I want** LGTM to suggest which repos to watch based on activity,
**So that** I can quickly accept the recommendation and move on.

**Acceptance Criteria:**
- Repos sorted by relevance: recent activity first, GitHub repos prioritized over local-only
- "Recommended" badge on repos with activity in last 7 days
- "Stale" badge on repos with no commits in 90+ days
- Option to auto-accept all recommended: `lgtm discover --ingest --recommended`

### US-4: Re-run and diff
**As a** user who gets new repos over time,
**I want** to re-run ingest and only see new/changed repos,
**So that** I don't re-review repos I already accepted or denied.

**Acceptance Criteria:**
- `lgtm discover --ingest` on subsequent runs only shows NEW repos (not already in registry)
- `--all` flag to re-show everything (including previously denied)
- Previously denied repos stored in `~/.lgtm-registry.md` with `status: denied`

### US-5: TUI integration
**As a** user who prefers the TUI,
**I want** to manage discovered repos from the Dashboard tab,
**So that** I can accept/deny without leaving the TUI.

**Acceptance Criteria:**
- Dashboard tab shows "New repos found" notification if scan detects unregistered repos
- Drill-down shows the accept/deny picker
- Accepted repos immediately appear in the watch list

## Non-Functional Requirements

- **Performance**: Scan should complete within 10s for typical developer machines (~100 repos)
- **Privacy**: Never sends repo paths or names to any remote service
- **Safe**: Read-only scan — never modifies the discovered repos
- **Idempotent**: Running multiple times doesn't duplicate entries

# Auto-Ingest Repos — Requirements

## Overview

Automatically discover git repositories on the local machine and let the user interactively add or deny them for the LGTM watcher. Instead of manually running `lgtm review watch add owner/repo` for every repo, the tool scans common project directories, presents what it finds, and the user picks which to watch — like a setup wizard for multi-repo monitoring.

The ingest can be triggered at any time (not just first-run). It always reflects the current state of the filesystem: new repos appear, deleted repos are pruned, and already-watched repos are clearly marked.

## User Stories

### US-1: Scan for git repos
**As a** developer with many repos on my machine,
**I want** LGTM to find all my git repositories automatically,
**So that** I don't have to remember and type each one manually.

**Acceptance Criteria:**
- `lgtm discover --ingest` scans default locations (`~/projects`, `~/dev`, `~/code`, `~/repos`, `~/src`, `~/work`, `~/<Desktop,Documents>`)
- `lgtm discover --ingest <path>` scans a specific directory
- Can be triggered at any time — not just on first run
- Finds all directories containing `.git/`
- Extracts repo name, remote URL, last commit date
- Ignores: `node_modules`, `vendor`, `.cache`, archived/bare repos
- Scan depth configurable (default: 4 levels deep)
- Shows progress: "Scanning... found 23 repos"

### US-2: Interactive accept/deny with watched status
**As a** user reviewing discovered repos,
**I want** an interactive picker that shows which repos I'm already watching,
**So that** I know my current state and only need to decide on new ones.

**Acceptance Criteria:**
- After scan, show repos grouped by directory (~/projects/..., ~/work/...)
- Each repo shows: name, remote (GitHub/GitLab), last activity, language (if detectable)
- **Watched repos are marked**: `👁 watching` indicator next to already-watched repos
- **New repos are highlighted**: clearly distinguished from already-managed ones
- User can: `[a]` accept (add to watch), `[s]` skip, `[w]` unwatch (remove from watch), `[A]` accept all remaining, `[q]` quit
- Accepted repos are added to the watcher (`watch.md`)
- Accepted repos are registered in `~/.lgtm-registry.md`
- Final summary: "Watching 12 repos. Added 3 new. Skipping 8."

### US-3: Smart suggestions
**As a** user who doesn't want to review 50 repos individually,
**I want** LGTM to suggest which repos to watch based on activity,
**So that** I can quickly accept the recommendation and move on.

**Acceptance Criteria:**
- Repos sorted by relevance: recent activity first, GitHub repos prioritized over local-only
- "Recommended" badge on repos with activity in last 7 days
- "Stale" badge on repos with no commits in 90+ days
- Option to auto-accept all recommended: `lgtm discover --ingest --recommended`

### US-4: Prune deleted repos
**As a** user who removes/moves/archives repos over time,
**I want** LGTM to detect repos that no longer exist on disk and remove them,
**So that** my watch list stays clean and doesn't show ghosts.

**Acceptance Criteria:**
- On every ingest run, check all registered repos — if the path no longer exists, mark as `removed`
- Show removed repos: "⚠ 2 repos no longer found on disk: old-project, archived-thing"
- Auto-remove from watch list (they can't be monitored anyway)
- Auto-remove from registry (or mark `status: removed`)
- `--prune` flag to only do the cleanup without the full scan/picker

### US-5: Re-run shows full picture
**As a** user running ingest again after some time,
**I want** to see the complete state — what's watched, what's new, what's gone,
**So that** I have a clear overview and can adjust.

**Acceptance Criteria:**
- `lgtm discover --ingest` always shows the full inventory with status:
  - `👁 watching` — already in watch list
  - `✦ new` — found but not yet watched or denied
  - `○ skipped` — previously denied
  - `⚠ removed` — was registered but path no longer exists
- New repos are presented for accept/deny decision
- `--new-only` flag to only show repos that need a decision (skip already-managed)
- Previously denied repos can be re-accepted (status changes from denied → active)

### US-6: TUI integration
**As a** user who prefers the TUI,
**I want** to manage discovered repos from the Dashboard tab,
**So that** I can accept/deny without leaving the TUI.

**Acceptance Criteria:**
- Dashboard tab shows "New repos found" notification if scan detects unregistered repos
- Drill-down shows the accept/deny picker
- Accepted repos immediately appear in the watch list
- Removed repos show a warning

## Non-Functional Requirements

- **Always triggerable**: Can be run at any point, not gated behind first-run or onboarding
- **Performance**: Scan should complete within 10s for typical developer machines (~100 repos)
- **Privacy**: Never sends repo paths or names to any remote service
- **Safe**: Read-only scan — never modifies the discovered repos themselves
- **Idempotent**: Running multiple times doesn't duplicate entries
- **Reflects reality**: Deleted repos are pruned, moved repos are detected, state is always current

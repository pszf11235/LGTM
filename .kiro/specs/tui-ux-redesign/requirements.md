# TUI UX Redesign — Requirements

## Overview

Redesign the TUI interaction model to fix the 12 identified UX issues (see `docs/TUI-UX-ANALYSIS.md`) and add the new Repos discovery page. The goal is a consistent, predictable keyboard-driven interface inspired by vim/htop/lazygit.

## Core Principles

1. **No surprise exits** — `q` never kills the app without warning; Ctrl+C is the only hard quit
2. **Visible feedback** — every action shows confirmation in the status bar
3. **Everything scrolls** — no content hidden beyond viewport
4. **Keys always work** — status bar only shows shortcuts that are actually functional
5. **Consistent navigation** — same keys mean the same thing on every page

## User Stories

### US-1: Consistent quit/back behavior
**As a** user navigating the TUI,
**I want** `q` to mean "go back one level" (not kill the app),
**So that** I never accidentally lose my place.

**Acceptance Criteria:**
- `q` on a tab-level page: does nothing (you're already at top level)
- `q` inside a drill-down (e.g., review diff, session detail): goes back to parent
- `Ctrl+C`: always quits the entire TUI (hard exit)
- `Esc`: same as `q` (alternative back key)
- No confirmation prompt needed — `q` is non-destructive because it's just "back"

### US-2: Scrollable lists with viewport clipping
**As a** user with many items (PRs, rules, repos, history),
**I want** lists to scroll when they exceed the terminal height,
**So that** I can see and navigate all items.

**Acceptance Criteria:**
- All list pages clip to viewport height
- Selected item always visible (auto-scroll follows cursor)
- Scroll indicator shows position: "12/47" or scrollbar
- Page up/down with `d`/`u` (half-page scroll, vim-style)
- `g`/`G` for jump to top/bottom

### US-3: Truthful status hints
**As a** user looking at the status bar,
**I want** it to only show shortcuts that actually work right now,
**So that** I trust the interface.

**Acceptance Criteria:**
- Status bar shows ONLY keys that have handlers on the current page/state
- Context-sensitive: different hints when item is selected vs. not
- Tab navigation hint always visible (right-aligned): "Tab: next"
- Format: `key action` pairs separated by spaces, gray color

### US-4: Action feedback in status bar
**As a** user performing actions (accept, deny, approve, flag),
**I want** to see instant visual feedback that the action succeeded,
**So that** I know it worked without checking files.

**Acceptance Criteria:**
- After any mutation: show green flash message in status bar (e.g., "✓ PR #42 approved")
- Errors show red: "✗ Failed to save: disk full"
- Messages auto-clear after 3 seconds (or on next keypress)
- Loading states show spinner or "..." indicator

### US-5: Repos discovery page
**As a** user managing my watched repos,
**I want** a "Repos" tab in the TUI that shows discovered repos with status,
**So that** I can accept/deny/unwatch without leaving the TUI.

**Acceptance Criteria:**
- New tab: "Repos" (between Rules and History)
- On open: runs background scan (shows loading spinner)
- Displays repos with columns: Status | Name | Remote | Activity | Language
- Status icons: 👁 watching, ✦ new, ○ skipped
- Sort: new first → watching → denied; then by activity (recent first)
- Keys: `a` accept, `s` skip, `w` unwatch, `A` accept all new, `r` rescan
- Removed repos shown as ⚠ warning at top
- Counts in header: "23 repos (12 watching, 3 new, 8 skipped)"

### US-6: Loading indicators
**As a** user triggering async actions (open PR, fetch diff, scan repos),
**I want** to see that something is happening,
**So that** I don't think the app froze.

**Acceptance Criteria:**
- When opening a PR diff: show "Loading diff..." before transition
- When scanning repos: show "Scanning..." with count
- When fetching attention items: show spinner
- Loading text replaces content area (not overlay)

### US-7: Persistent tab indicator
**As a** user who might forget how to switch tabs,
**I want** the tab-switch shortcut to always be visible,
**So that** I can always navigate without memorizing.

**Acceptance Criteria:**
- Right side of status bar always shows: "←→ tabs"
- Left/right arrow keys switch tabs (in addition to Tab/Shift+Tab)
- Active tab highlighted in tab bar (current behavior — keep)
- Tabs are left-aligned on their own line (below the tool name/version)
- Tool name + version on a separate line above the tabs: `👍 lgtm v0.1.0`

## Keyboard Map (Redesigned)

### Global (Shell level — always active)
| Key | Action |
|-----|--------|
| `Tab` / `→` | Next tab |
| `Shift+Tab` / `←` | Previous tab |
| `Ctrl+C` | Quit TUI |

### Page level (applies to ALL tab pages)
| Key | Action |
|-----|--------|
| `j` / `↓` | Cursor down |
| `k` / `↑` | Cursor up |
| `d` | Page down (half screen) |
| `u` | Page up (half screen) |
| `g` | Jump to top |
| `G` | Jump to bottom |
| `Enter` | Open/drill-down selected item |
| `Esc` / `q` | Back (from drill-down) / no-op (at top level) |

### Page-specific actions
| Page | Keys | Actions |
|------|------|---------|
| Dashboard | `x` dismiss, `r` refresh | — |
| Queue | `a` approve, `f` flag | Open PR with Enter |
| Review (diff) | `c` comment, `n/N` file nav, `h/H` hunk nav, `v` visual select, `a` approve, `f` flag | — |
| Rules | `Enter` toggle enable/disable, `d` detail view | — |
| **Repos** | `a` accept, `s` skip, `w` unwatch, `A` accept all new, `r` rescan | — |
| History | `Enter` view session detail | — |
| Config | (read-only) | — |

## Non-Functional Requirements

- **Responsiveness**: No action should block the render loop for >100ms
- **Terminal compatibility**: Works in terminals ≥60 columns wide; shows warning if smaller
- **Accessibility**: Bold/dim used alongside color for diff lines (colorblind-friendly)
- **Consistency**: Same patterns as lazygit/htop/vim (standard terminal UX expectations)

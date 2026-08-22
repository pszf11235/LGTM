# Auto-Ingest — TUI Page Plan

## Overview

Add a "Repos" tab to the TUI that shows all discovered repos with their status,
supports inline accept/deny/unwatch, and runs a background scan on tab open.

## TUI Layout

```
👍 lgtm v0.1.0
[Dashboard] [Review] [Rules] [Repos] [History] [Config]
reviewing: my-project  /Users/pascal/projects/my-project
──────────────────────────────────────────────────────────────────────

  👍 Repos — 23 discovered (12 watching, 3 new, 8 skipped)

  Status  Name                Remote                    Activity    Lang
  ─────────────────────────────────────────────────────────────────────────
  👁      frontend-app        github:org/frontend       2d ago      typescript
  👁      backend-api         github:org/backend        5h ago      go
▸ ✦      new-service         github:org/new-svc        1d ago      rust
  ✦      another-new         gitlab:team/another       3d ago      python
  ○      mobile-app          github:org/mobile         3mo ago     swift
  ○      archived-thing      (local)                   1y ago      —

  ⚠ 2 repos removed (no longer on disk)

──────────────────────────────────────────────────────────────────────
↑↓ navigate  a accept  s skip  w unwatch  r rescan  A all new    ←→ tabs
```

## Sort Order (applies to both CLI and TUI)

Priority:
1. **Status**: new (needs decision) first → watching → denied
2. **Activity**: most recent commit first within each status group
3. **Platform**: github > gitlab > bitbucket > local (no remote)
4. **Name**: alphabetical tiebreaker

This ensures repos that need action are always at the top, and within those,
the most active/relevant ones come first.

## Keyboard Controls

| Key | Action |
|-----|--------|
| `↑`/`k` | Move cursor up |
| `↓`/`j` | Move cursor down |
| `a` | Accept highlighted repo (add to watch) |
| `s` | Skip/deny highlighted repo |
| `w` | Unwatch highlighted repo (remove from watch) |
| `A` | Accept ALL new repos at once |
| `r` | Re-scan (refresh from filesystem) |
| `q` | Back to previous tab / quit |

## Behavior

- **On tab open**: runs a background scan (non-blocking, shows spinner)
- **After scan**: reconciles and displays full list with current status
- **Actions are immediate**: accept/deny updates registry + watch in real-time
- **Status updates live**: after accepting, the row changes from ✦ to 👁
- **Removed repos**: shown as warning at bottom, auto-pruned on refresh

## Component: `DiscoverPage.tsx`

Location: `packages/plugins/review/src/pages/DiscoverPage.tsx`

Registered as the "Repos" tab in the plugin pages array.

Props: `{ onStatusHint: (hint: string) => void }`

State:
- `repos: Array<ScannedRepo & { status: RepoStatus }>` — the displayed list
- `selectedIdx: number` — cursor position
- `loading: boolean` — scan in progress
- `counts: { watching, new, denied, removed }` — summary stats
- `removedRepos: IngestRegistryEntry[]` — for warning display

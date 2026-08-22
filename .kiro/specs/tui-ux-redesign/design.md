# TUI UX Redesign — Design

## Layout Structure

```
┌─────────────────────────────────────────────────────────────────────────┐
│ 👍 lgtm   [Dashboard] [Review] [Rules] [Repos] [History] [Config]       │ ← Header
│ reviewing: my-project  ~/projects/my-project                            │ ← Context
├─────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│  (Page Content — scrollable viewport)                                    │ ← Content
│                                                                          │
│  ▸ selected item here                                                    │
│    other items...                                                         │
│                                                                          │
│                                                                          │
├─────────────────────────────────────────────────────────────────────────┤
│ ↑↓ navigate  a accept  s skip  r rescan           12/47  Tab ›          │ ← Status
└─────────────────────────────────────────────────────────────────────────┘
```

### Zones

1. **Header** (2 lines): Logo + tabs + context line (repo name, path)
2. **Content** (variable, fills remaining): Page-specific scrollable content
3. **Status** (1 line): Left = contextual shortcuts, Right = position + tab hint

## Scrolling Architecture

All list pages use a shared `useScrollableList` hook:

```tsx
function useScrollableList<T>(items: T[], termHeight: number) {
  const [selectedIdx, setSelectedIdx] = useState(0);
  const [scrollOffset, setScrollOffset] = useState(0);

  // Visible items = items.slice(scrollOffset, scrollOffset + viewportHeight)
  const viewportHeight = termHeight - 5; // header(3) + status(1) + padding(1)
  const visibleItems = items.slice(scrollOffset, scrollOffset + viewportHeight);

  // Auto-scroll to keep selection visible
  useEffect(() => {
    if (selectedIdx < scrollOffset) setScrollOffset(selectedIdx);
    if (selectedIdx >= scrollOffset + viewportHeight) {
      setScrollOffset(selectedIdx - viewportHeight + 1);
    }
  }, [selectedIdx]);

  const moveDown = () => setSelectedIdx(i => Math.min(i + 1, items.length - 1));
  const moveUp = () => setSelectedIdx(i => Math.max(i - 1, 0));
  const pageDown = () => setSelectedIdx(i => Math.min(i + Math.floor(viewportHeight / 2), items.length - 1));
  const pageUp = () => setSelectedIdx(i => Math.max(i - Math.floor(viewportHeight / 2), 0));
  const goTop = () => setSelectedIdx(0);
  const goBottom = () => setSelectedIdx(items.length - 1);

  return { selectedIdx, visibleItems, scrollOffset, moveDown, moveUp, pageDown, pageUp, goTop, goBottom };
}
```

## Status Bar Architecture

The status bar has three sections:

```
[page shortcuts]                                    [position]  [tab hint]
↑↓ navigate  a accept  s skip  r rescan            12/47       Tab ›
```

### Flash Messages

When an action completes, the left section temporarily shows a flash:

```
✓ PR #42 approved                                    12/47       Tab ›
```

After 3 seconds (or next keypress), it reverts to the shortcuts.

Implementation:
```tsx
const [flash, setFlash] = useState<{ text: string; color: string } | null>(null);

function showFlash(text: string, color = "green") {
  setFlash({ text, color });
  setTimeout(() => setFlash(null), 3000);
}

// In status bar render:
flash ? <Text color={flash.color}>{flash.text}</Text> : <Text color="gray">{hints}</Text>
```

## Pages Design

### Repos Page (New)

```
  👍 Repos — 23 discovered (12 watching, 3 new, 8 skipped)

  Stat  Name                  Remote                      Activity   Lang
  ─────────────────────────────────────────────────────────────────────────
  👁    frontend-app          github:org/frontend         2d ago     ts
  👁    backend-api           github:org/backend          5h ago     go
▸ ✦    new-service           github:org/new-svc          1d ago     rust
  ✦    another-new           gitlab:team/another         3d ago     py
  ○    mobile-app            github:org/mobile           3mo ago    swift
  ○    archived              (local)                     1y ago     —
  ─────────────────────────────────────────────────────────────────────────
  ⚠ 2 repos no longer on disk (auto-pruned)
```

**Sort order:**
1. Status: ✦ new first (needs action) → 👁 watching → ○ denied
2. Activity: most recent commit first within each group
3. Platform: github > gitlab > bitbucket > local
4. Name: alphabetical tiebreaker

**Interactions:**
- `a` on ✦ new → accepts (becomes 👁), flash: "✓ repo-name watching"
- `s` on ✦ new → skips (becomes ○), flash: "○ repo-name skipped"
- `w` on 👁 watching → unwatches (becomes ○), flash: "⊘ repo-name unwatched"
- `a` on ○ denied → re-accepts (becomes 👁), flash: "✓ repo-name watching"
- `A` → accepts ALL ✦ new repos at once
- `r` → re-scans filesystem (shows loading, refreshes list)

### Dashboard Page (Updated)

Fix: `d` → `x` for dismiss (avoid conflict with page-down)

### Queue Page (Updated)

Fix: Show loading when opening PR diff. Add `a`/`f` handlers that work.

### All List Pages (Updated)

Add: `useScrollableList` hook, viewport clipping, position indicator.

## Component Hierarchy

```
Shell (handles Tab, Ctrl+C)
├── Header (logo, tabs, context)
├── ActivePage (one of:)
│   ├── DashboardPage (useScrollableList, flash messages)
│   ├── ReviewTab → QueuePage → ReviewPage (drill-down)
│   ├── RulesPage (useScrollableList, toggle on Enter)
│   ├── DiscoverPage (useScrollableList, accept/deny/unwatch)
│   ├── HistoryPage (useScrollableList, drill-down to detail)
│   └── ConfigPage (read-only, no list)
└── StatusBar (left: hints/flash, right: position + "Tab ›")
```

## Implementation Approach

1. Create shared `hooks/useScrollableList.ts` and `hooks/useFlash.ts`
2. Update Shell.tsx: always show "Tab ›" in status bar right side
3. Fix `q` behavior in all pages (no-op at top level, back in drill-down)
4. Apply `useScrollableList` to Dashboard, Queue, Rules, History, Scan, Discover
5. Build DiscoverPage with full keyboard interactions
6. Fix misleading status hints (audit each page)
7. Add loading states where async operations occur

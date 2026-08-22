# TUI UX Redesign — Implementation Tasks

## Task 1: Shared hooks (useScrollableList, useFlash)
- [ ] Create `packages/core/src/tui/hooks/useScrollableList.ts`
  - Takes items array + terminal height
  - Returns: selectedIdx, visibleItems, scrollOffset, nav functions
  - Auto-scrolls to keep selection in viewport
  - Supports: moveDown, moveUp, pageDown, pageUp, goTop, goBottom
- [ ] Create `packages/core/src/tui/hooks/useFlash.ts`
  - Flash message state with auto-clear after 3s
  - Returns: flash, showFlash(text, color)
  - Clears on manual dismiss or next action
- [ ] Export from `packages/core/src/tui/hooks/index.ts`
- [ ] Tests: scroll boundary behavior, auto-scroll follows cursor

## Task 2: Fix Shell — quit behavior and persistent tab hint
- [ ] Remove `q` handler from Shell (let pages handle it)
- [ ] Always show "Tab ›" on right side of status bar
- [ ] Show position indicator (page number: "3/6") next to tab hint
- [ ] Keep Ctrl+C as the only hard quit (already works)
- [ ] `q` at top-level pages: no-op (don't exit)
- [ ] `q` in drill-downs (ReviewPage, HistoryDetail): go back

## Task 3: Apply scrolling to all list pages
- [ ] DashboardPage: useScrollableList for attention items
- [ ] QueuePage: useScrollableList for PR list
- [ ] RulesPage: useScrollableList for rules list
- [ ] HistoryPage: useScrollableList for session list
- [ ] ScanResultsPage: useScrollableList for violations list
- [ ] Add position indicator to each page: "N/total" in status area
- [ ] Add `d` (page down) and `u` (page up) to all pages
- [ ] Add `g` (top) and `G` (bottom) to all pages

## Task 4: Fix status hints and add flash messages
- [ ] Audit each page: remove non-functional keys from hints
- [ ] DashboardPage: change `d` dismiss to `x`, update hint
- [ ] QueuePage: implement `a` (approve) and `f` (flag) inline actions
- [ ] Add useFlash to pages that perform mutations
- [ ] Show flash on: accept, deny, approve, flag, dismiss, toggle
- [ ] Show error flash on failures (red)
- [ ] Flash auto-clears after 3s

## Task 5: Add loading indicators
- [ ] QueuePage: show "Loading diff..." when Enter pressed (before transition)
- [ ] DashboardPage: show spinner during attention item fetch
- [ ] DiscoverPage: show "Scanning..." during repo scan
- [ ] RulesPage: show brief loading on initial load
- [ ] Use consistent loading component: `<Text color="gray">  Loading...</Text>`

## Task 6: Build DiscoverPage (Repos tab)
- [ ] Create `packages/plugins/review/src/pages/DiscoverPage.tsx`
- [ ] Register as "Repos" tab (between Rules and History)
- [ ] On mount: trigger background scan via scanAllRepos()
- [ ] Display with useScrollableList (sort: new → watching → denied)
- [ ] Columns: Status icon | Name | Remote | Activity | Language
- [ ] Keyboard: `a` accept, `s` skip, `w` unwatch, `A` accept all new, `r` rescan
- [ ] Flash messages for each action
- [ ] Show removed repos warning
- [ ] Show counts in page header
- [ ] Update list in-place after accept/deny (no full rescan)

## Task 7: Terminal size and accessibility
- [ ] Check terminal width on TUI launch: warn if < 60 columns
- [ ] Add bold to added diff lines (alongside green color)
- [ ] Add dim to removed diff lines (alongside red color)
- [ ] Ensure all status icons have text fallback for non-unicode terminals

# LGTM TUI — UI/UX Analysis

> Analysis of all TUI page components, navigation flows, and interaction patterns.
> Based on static code analysis of all Ink/React components.

---

## Executive Summary

The TUI is functional and well-structured, but has **5 critical UX issues** that would frustrate users:

1. **`q` quits the entire app** on most pages (should go back one level)
2. **No scrolling** on list pages (items beyond viewport are invisible)
3. **Misleading status hints** (advertise keys that don't work)
4. **No save confirmation** after approve/flag actions
5. **Missing loading indicators** when fetching diffs

---

## Critical Issues

### 🔴 Issue 1: `q` Kills the App (Inconsistent Quit Behavior)

| Page | `q` Behavior |
|------|-------------|
| Dashboard | `exit()` — **kills TUI** |
| Queue | `exit()` — **kills TUI** |
| Rules | `exit()` — **kills TUI** |
| History | `exit()` — **kills TUI** |
| Config | `exit()` — **kills TUI** |
| Scan | `exit()` — **kills TUI** |
| ReviewPage | `onExit("back")` — **goes back** ✓ |

**Problem**: On every tab-level page, pressing `q` immediately terminates the entire TUI process with no confirmation. Users expect `q` to mean "go back" (like vim, less, htop). Only ReviewPage gets this right.

**Fix**: On tab-level pages, either:
- Remove `q` binding (Tab is for navigation, Ctrl+C is for quit)
- Add a confirmation prompt: "Quit LGTM? (y/n)"
- Change `q` to do nothing (let Shell's Ctrl+C handle quit)

---

### 🔴 Issue 2: No Scrolling on List Pages

| Page | Has Scrolling? | Items Visible |
|------|:---:|:---:|
| Dashboard | ❌ | ~4-5 items (3-4 lines each) |
| Queue | ❌ | ~8-10 PRs (1 line each) |
| Rules | ❌ | ~10 rules |
| History | ❌ | ~12 sessions |
| Scan Results | ❌ | ~10 violations |
| ReviewPage | ✓ | Full viewport scrolling |

**Problem**: If you have 20+ attention items on the Dashboard, or 30+ rules, items beyond the terminal viewport are rendered but **invisible**. The cursor can navigate to them (j/k works) but the user can't see them.

**Fix**: Implement viewport clipping like ReviewPage does:
```typescript
const visible = items.slice(scrollOffset, scrollOffset + termHeight);
```
With auto-scroll to keep the selected item in view.

---

### 🔴 Issue 3: Misleading Status Hints

| Page | Status Hint Shows | Actually Works? |
|------|------------------|:---:|
| Queue | "a approve  f flag" | ❌ Not handled |
| History | "enter view" | ❌ Fixed in PR #104 |
| Scan Results | "enter open" | ❌ Not handled |
| Rules | "enter toggle  d detail" | ❌ Not handled |

**Problem**: The status bar advertises keyboard shortcuts that do nothing when pressed. This breaks user trust — they try a shortcut, nothing happens, and they lose confidence in the tool.

**Fix**: Either implement the advertised actions, or remove them from the hint text.

---

### 🟡 Issue 4: Silent Actions (No Feedback)

**Approve/Flag in ReviewPage:**
- User presses `a` to approve → immediately returns to queue
- No flash message, no confirmation, no sound
- If the save fails (OKF store error), it's caught silently: `catch (err) { /* Silent failure */ }`
- User has no idea if their review was saved

**Dismiss in DashboardPage:**
- Item silently disappears from the list
- No "dismissed" confirmation
- No undo capability

**Fix**: After approve/flag, show a brief status message:
```
  ✓ PR #42 approved — review saved
```
For save failures, show an error in the status bar.

---

### 🟡 Issue 5: No Loading State When Opening a PR

In QueuePage, pressing Enter on a PR calls `loadDiffAndOpen()`:
1. Fetches diff from cache/git/GitHub
2. Parses it
3. Transitions to ReviewPage

Steps 1-2 can take 1-3 seconds (especially for GitHub fetch), but there's **no loading indicator**. The user presses Enter and nothing visible happens until the diff loads.

**Fix**: Set a loading state before the async call:
```typescript
setLoading(true); // shows "Loading diff..."
const diff = await loadDiffAndOpen(pr);
```

---

## Medium Issues

### 🟡 Issue 6: `d` Key Conflict

- **DashboardPage**: `d` = dismiss item (destructive action!)
- **ReviewPage**: `d` = page down (harmless navigation)

A user who gets comfortable with `d` for scrolling in ReviewPage may accidentally dismiss items on the Dashboard.

**Fix**: Use `x` for dismiss on Dashboard (more intuitive for "remove/close").

---

### 🟡 Issue 7: Tab Navigation Undiscoverable

The initial Shell hint shows "ctrl+c quit  tab switch" — but as soon as any page sets its own `onStatusHint`, the tab-switching instruction disappears. Users on the Dashboard see:
```
↑↓ navigate  enter open  d dismiss  r refresh  q quit
```
...with no mention of how to switch tabs.

**Fix**: Always append "| Tab: switch tabs" to the right side of the status bar (Shell-level, not page-level).

---

### 🟡 Issue 8: CommentInput is Primitive

The comment input in ReviewPage:
- Single-line only (Enter submits immediately)
- No cursor movement (← → don't work)
- No paste (Ctrl+V doesn't work)
- No multi-line comments (Shift+Enter not supported)
- No cancel shortcut other than Escape

For a code review tool where comments are the primary output, this is severely limiting.

**Fix (short-term)**: Support Ctrl+V paste and Shift+Enter for newlines.
**Fix (long-term)**: Use a proper text editor widget (like micro/nano embedded, or at minimum a multi-line Ink TextInput).

---

## Minor Issues

### Issue 9: No Minimum Terminal Size Check

If the terminal is very small (< 40 columns), the header bar, tab labels, and status hints will be garbled or overlapping. No warning is shown.

**Fix**: Check `stdout.columns < 60` on launch and suggest resizing.

---

### Issue 10: Color Accessibility

- Red/green for diff lines is problematic for colorblind users (~8% of males)
- The `+`/`-` prefixes help, but bold/underline would provide a non-color signal
- Gray text (`color="gray"`) is low contrast on light terminal themes

**Fix**: Add bold to added lines and dim to removed lines as additional signals.

---

### Issue 11: GlobalThis Hack in ReviewPage

```typescript
(globalThis as any).__lgtmCommentRange = { startLine, endLine, file };
```

This passes range data from visual selection to the comment handler via a global variable. It's fragile (race conditions possible) and not testable.

**Fix**: Use React state or a ref to pass range data.

---

### Issue 12: Dynamic Import Cold-Start

Every page uses `await import(...)` inside event handlers. The first interaction on each page has a noticeable cold-start delay as modules load.

**Fix**: Pre-import critical modules at page mount (inside `useEffect`), not on first keystroke.

---

## Keyboard Shortcut Map

| Key | Shell | Dashboard | Queue | Review | Rules | History | Config | Scan |
|-----|:---:|:---:|:---:|:---:|:---:|:---:|:---:|:---:|
| Tab | switch → | — | — | — | — | — | — | — |
| Shift+Tab | switch ← | — | — | — | — | — | — | — |
| Ctrl+C | quit | quit | quit | quit | quit | quit | quit | quit |
| q | — | exit! | exit! | back | exit! | exit! | exit! | exit! |
| j/↓ | — | nav↓ | nav↓ | scroll↓ | nav↓ | nav↓ | nav↓ | nav↓ |
| k/↑ | — | nav↑ | nav↑ | scroll↑ | nav↑ | nav↑ | nav↑ | nav↑ |
| Enter | — | — | open PR | — | — | drill-in | — | — |
| d | — | dismiss | — | page↓ | — | — | — | — |
| u | — | — | — | page↑ | — | — | — | — |
| n/N | — | — | — | file→/← | — | — | — | — |
| h/H | — | — | — | hunk→/← | — | — | — | — |
| c | — | — | — | comment | — | — | — | — |
| v | — | — | — | visual sel | — | — | — | — |
| l | — | — | — | show comments | — | — | — | — |
| a | — | — | — | approve | — | — | — | — |
| f | — | — | — | flag | — | — | — | — |
| r | — | refresh | — | — | — | — | — | — |
| Esc | — | — | — | back/desel | — | back | — | — |
| b | — | — | — | — | — | back | — | — |

---

## Recommendations (Priority Order)

| # | Issue | Effort | Impact |
|---|-------|--------|--------|
| 1 | Fix `q` to not kill app | Low | Critical — prevents data loss |
| 2 | Add scrolling to list pages | Medium | Critical — items invisible |
| 3 | Fix misleading status hints | Low | High — trust |
| 4 | Add save confirmation flash | Low | Medium — feedback |
| 5 | Add loading indicator for PR open | Low | Medium — perceived speed |
| 6 | Fix `d` key conflict | Low | Low — edge case |
| 7 | Persistent tab-switch hint | Low | Medium — discoverability |
| 8 | Multi-line comments | Medium | Medium — feature completeness |
| 9 | Terminal size check | Low | Low — edge case |
| 10 | Colorblind indicators | Low | Low — accessibility |

---

## Note on Screenshots

The TUI is an Ink-based terminal application that requires an interactive TTY with stdin/stdout connected. In this sandbox environment:
- No proper TTY is available for rendering the TUI
- The headless browser cannot reach localhost services (network isolation)
- Terminal screenshot tools (asciinema, termshot) are not installed

The webapp was successfully loaded via `file://` protocol but rendered with an empty body due to Chromium's security restrictions on inline scripts in file: URLs.

**Recommendation**: To take TUI screenshots for marketing/docs, use:
```bash
# Option 1: asciinema (record + render as SVG)
asciinema rec --command "bun run lgtm" demo.cast
svg-term --in demo.cast --out demo.svg

# Option 2: termshot (static screenshot)
termshot -- bun run lgtm

# Option 3: VHS (declarative terminal recordings)
vhs < demo.tape
```

---

*Analysis performed August 2026*

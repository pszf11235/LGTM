# Implementation Plan: #52 — Attention Dashboard

## Overview

A live status page showing everything that needs the user's attention: PRs awaiting review, replies to respond to, activity on your PRs, and overdue tasks. Accessible both as a CLI command and as a TUI tab.

## Architecture

```
lgtm dashboard
    │
    ▼
┌─────────────────────────────────────────────┐
│  Data Sources:                               │
│  ├── GitHub API (PRs, comments, CI status)   │
│  ├── Watch config (which repos to check)     │
│  ├── Registry (known repos)                  │
│  └── Review history (.lgtm/sessions/)        │
│                                              │
│  Processing:                                 │
│  ├── Fetch open PRs needing my review        │
│  ├── Fetch comment threads mentioning me     │
│  ├── Check CI status on my PRs              │
│  └── Identify overdue items                  │
│                                              │
│  Output:                                     │
│  ├── CLI: formatted terminal output          │
│  ├── TUI: Dashboard tab in shell             │
│  └── Each item has: summary, link, action    │
└─────────────────────────────────────────────┘
```

## Implementation Tasks

### Phase 1: Data Collection Layer (2-3 days)

1. **`packages/plugins/review/src/domain/attention.ts`**
   - `collectAttentionItems(config, github)` → unified attention items
   - Sources: PRs needing review, replies awaiting, activity on my work
   - Each item: `{ type, title, repo, url, age, urgency, context }`

2. **PR Reviews Needed**
   - Fetch from watched repos (watcher config)
   - Filter: review_requested for me, or assigned
   - Enrich: age (how long waiting), CI status, merge conflicts

3. **Replies Awaiting**
   - Fetch PR comment threads where I'm mentioned or last commenter isn't me
   - Extract the "why" (what's being asked)
   - Generate draft reply suggestion (LLM, using user's tone)

4. **Activity on My Work**
   - PRs I authored: new comments, CI changes, approvals
   - Issues assigned to me: recently updated

### Phase 2: CLI Output (1 day)

5. **`lgtm dashboard` command**
   - Formatted output grouped by section
   - Direct links (clickable in modern terminals)
   - Color-coded urgency (overdue = red, today = yellow, fresh = green)
   - `--json` flag for scripting

6. **Dismiss/Snooze**
   - `lgtm dashboard dismiss <id>` — don't show again
   - Dismissed items stored in `.lgtm/dismissed.md`
   - Auto-undismiss if new activity on dismissed item

### Phase 3: TUI Tab (2-3 days)

7. **`packages/plugins/review/src/pages/DashboardPage.tsx`**
   - New TUI tab: `[ Dashboard | Review | Specify | Learn ]`
   - Sections: PRs to review, Replies, Activity, Tasks
   - Navigate with arrows, Enter to open link/draft reply
   - `d` to dismiss, `r` to draft reply

8. **Draft Reply Feature**
   - LLM generates a reply based on thread context + user's tone
   - Shows in TUI: "Suggested reply: ..."
   - User can: accept (post to GitHub), edit, dismiss
   - Tone config: direct, no em dashes, no semicolons

### Phase 4: Live Updates (1 day)

9. **Polling / Refresh**
   - `lgtm dashboard --watch` — polls every 60s
   - TUI: auto-refresh in background (configurable interval)
   - Terminal bell on new high-urgency items
   - Badge count updates in shell header

### Phase 5: "Why" Context (1 day)

10. **Context Generation**
    - Every item has a "why" explaining what's needed
    - If no summary available: LLM generates from thread/PR context
    - Never show "(no summary generated)" — always have context
    - Cached (don't re-generate for same content)

## Data Model

```typescript
interface AttentionItem {
  id: string;
  type: "review_needed" | "reply_awaiting" | "activity" | "task";
  title: string;
  repo: string;
  url: string;
  age: number;        // hours since created/updated
  urgency: "high" | "medium" | "low";
  context: string;    // "why" — what's needed from you
  draftReply?: string; // LLM-generated suggestion
  dismissed?: boolean;
}
```

## TUI Layout

```
👍 lgtm  📬 5 items                 [ Dashboard | Review | Specify | Learn ]
reviewing: my-project
──────────────────────────────────────────────────────────────────────────────

📬 PRs Needing Review (2)

❯ #42 Add payment flow — open 4 days, CI ✓
  team/api · ready to review
  https://github.com/team/api/pull/42

  #18 Fix auth bug — open 1 day, CI pending
  team/web
  https://github.com/team/web/pull/18

💬 Replies Awaiting (2)

  @teammate on PR #45: "Redis or Memcached for sessions?"
  Why: Architecture decision blocks merge
  [Draft: "Redis — we need persistence and pub/sub for invalidation..."]

  @lead on PR #38: "Can you add a migration for the schema change?"
  Why: Requested change before approval

🔔 Activity on Your Work (1)

  PR #50 approved by @reviewer — ready to merge
  your/repo

──────────────────────────────────────────────────────────────────────────────
  ↑↓ navigate  enter open  d dismiss  r reply  q quit        AI: ✓ anthropic
```

## Dependencies

- Task 17: GitHub adapter ✅
- Task 26: Watcher ✅ (knows which repos)
- Task 12: LLM provider ✅ (for draft replies + context generation)
- Profile: feedbackStyle ✅ (for tone)

## Token Budget

| Operation | Tokens | Frequency |
|-----------|--------|-----------|
| Generate "why" context | ~200 | Per item (cached) |
| Draft reply | ~300 | Per reply request |
| Context refresh | ~500 | Per poll cycle |

## Estimated Effort

- Phase 1: 2-3 days (data collection)
- Phase 2: 1 day (CLI output)
- Phase 3: 2-3 days (TUI tab)
- Phase 4: 1 day (polling/refresh)
- Phase 5: 1 day (context generation)
- **Total: 7-9 days**

## Relationship to #51

#51 (AI Review) and #52 (Dashboard) complement each other:
- Dashboard shows what needs attention → user picks a PR
- AI Review does the actual review work
- Dashboard shows results of AI reviews (posted comments)
- Both use the same GitHub adapter, watcher, and LLM provider

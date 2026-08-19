# Implementation Plan: #51 — AI-Powered PR Review Delegation

## Overview

Automated PR review using LLM to analyze diffs and post structured feedback directly to GitHub PRs. Uses the user's configured tone/voice, focuses on high-severity issues only.

## Architecture

```
lgtm review auto [--repo owner/repo] [--pr number]
    │
    ▼
┌─────────────────────────────────────────────┐
│  1. Fetch PR diff (via GitHub adapter)       │
│  2. Load rules (regex + LLM)                 │
│  3. Run rule enforcement on diff             │
│  4. LLM review pass (high/critical only)     │
│  5. Format comments using user's tone        │
│  6. Post to GitHub with delay between posts  │
└─────────────────────────────────────────────┘
```

## Implementation Tasks

### Phase 1: Core Review Engine (3-4 days)

1. **`packages/plugins/review/src/domain/auto-review.ts`**
   - `generateAutoReview(diff, rules, profile, llm)` → structured findings
   - Severity filter: only HIGH and CRITICAL
   - Deduplication against existing PR comments (don't repeat)
   - Respects profile.feedbackStyle for tone

2. **LLM Prompt Design**
   - System prompt: "You are reviewing code. Be {feedbackStyle}. Focus on high-impact issues only."
   - Formatting rules from config: no em dashes, no semicolons, no severity labels
   - Input: diff + rules + context
   - Output: JSON array of `{file, line, comment, severity}`

3. **Comment Formatting**
   - Apply tone from profile (direct, gentle, socratic, minimal)
   - Strip severity labels from body text
   - Natural language, dev-to-dev

### Phase 2: GitHub Posting (2 days)

4. **`packages/plugins/review/src/domain/post-review.ts`**
   - Posts inline comments at correct file/line positions
   - Configurable delay between posts (20s-90s, avoid spam detection)
   - Batch as single review (COMMENT event) or individual comments
   - Dry-run mode: show what would be posted without actually posting

5. **Rate Limiting**
   - `comment_delay: [20, 90]` — random delay in range between posts
   - GitHub API rate limit awareness (check X-RateLimit-Remaining)
   - Pause and resume if approaching limit

### Phase 3: Commands & Config (1 day)

6. **`lgtm review auto` command**
   - `--repo owner/repo` — target repo (default: current)
   - `--pr number` — specific PR (default: all open)
   - `--dry-run` — show comments without posting
   - `--severity high|critical` — filter threshold

7. **Config (.lgtmrc.yaml)**
   ```yaml
   review:
     ai_review:
       severity_threshold: high
       comment_delay: [20, 90]
       formatting:
         no_em_dashes: true
         no_semicolons: true
         no_severity_labels: true
   ```

### Phase 4: PR Status Report (1 day)

8. **`lgtm review report` command**
   - Lists all open PRs across watched repos
   - Shows: age, CI status, review status, merge conflicts
   - Highlights: overdue (>3 days), failing CI
   - Recommendation: which are ready to merge

### Phase 5: Daily Standup (stretch)

9. **`lgtm review standup` command**
   - Summarizes yesterday's activity (merged, reviewed, commented)
   - Suggests today's priorities
   - Markdown output (paste into Slack/standup tool)

## Dependencies

- Task 17: GitHub adapter ✅ (done)
- Task 12: LLM provider ✅ (done)
- Task 26: Watcher ✅ (done — knows which repos to check)
- Profile: feedbackStyle ✅ (done — from onboarding)

## Token Budget

| Operation | Tokens | Frequency |
|-----------|--------|-----------|
| Review one PR diff | ~2000-4000 | Per PR |
| Format comment tone | ~200 | Per comment |
| Status report | ~500 | Per run |
| Standup summary | ~300 | Daily |

## Estimated Effort

- Phase 1: 3-4 days
- Phase 2: 2 days
- Phase 3: 1 day
- Phase 4: 1 day
- Phase 5: 1 day (stretch)
- **Total: 8-9 days**

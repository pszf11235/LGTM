# AI-Powered PR Review Delegation

> **Status:** Implemented (Issue #51)
> **Entry point:** `lgtm review auto --pr <number>`
> **Source:** `packages/plugins/review/src/`

## Overview

Automated PR review using LLM to analyze diffs and post structured feedback directly to GitHub PRs. Uses the user's configured tone/voice, focuses on high-severity issues only, and respects formatting preferences.

## Architecture

```
lgtm review auto --pr 42 [--repo owner/repo] [--dry-run] [--severity high]
    │
    ▼
┌──────────────────────────────────────────────────────────────┐
│  commands/auto.ts — CLI orchestrator                         │
│                                                              │
│  1. Resolve repo (from flag or git remote)                   │
│  2. Validate AI availability                                 │
│  3. Fetch PR diff via GitHub adapter                         │
│  4. Parse diff into structured data                          │
│  5. Load rules from .lgtm/rules/                             │
│  6. Fetch existing PR comments (dedup)                       │
│  7. Call generateAutoReview() — core engine                   │
│  8. Call postReviewFindings() — GitHub posting                │
└──────────────────────────────────────────────────────────────┘
         │                              │
         ▼                              ▼
┌─────────────────────┐    ┌───────────────────────────┐
│  domain/auto-review │    │  domain/post-review       │
│                     │    │                           │
│  • Regex rules      │    │  • Batch mode (1 review)  │
│  • LLM rules        │    │  • Individual mode        │
│  • LLM holistic     │    │  • Dry-run mode           │
│  • Severity filter  │    │  • Rate limit awareness   │
│  • Deduplication    │    │  • Configurable delays    │
│  • Tone formatting  │    │                           │
└─────────────────────┘    └───────────────────────────┘
```

## File Map

| File | Role |
|------|------|
| `src/commands/auto.ts` | CLI command registration and orchestration |
| `src/domain/auto-review.ts` | Core review engine — generates findings |
| `src/domain/post-review.ts` | Posts findings to GitHub with rate limiting |
| `src/domain/rules.ts` | Rules engine (pre-existing, used by auto-review) |
| `src/domain/diff-parser.ts` | Parses unified diff format (pre-existing) |
| `src/infra/github.ts` | GitHub REST API adapter (pre-existing) |
| `packages/core/src/config/schema.ts` | AIReviewConfig type + defaults |
| `.lgtmrc.yaml.example` | Config file template with ai_review section |

## Data Flow

### Input
- PR number + optional repo identifier
- User's project profile (feedbackStyle, AI config)
- Rules from `.lgtm/rules/*.md`
- Existing PR comments (for deduplication)

### Processing Pipeline

```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│  Step 1: Regex  │────▶│  Step 2: LLM    │────▶│  Step 3: LLM    │
│  Rule Matching  │     │  Rule Enforce   │     │  Holistic Review │
│  (0 tokens)     │     │  (scoped/rule)  │     │  (full diff)     │
└─────────────────┘     └─────────────────┘     └─────────────────┘
         │                       │                       │
         └───────────────────────┴───────────────────────┘
                                 │
                                 ▼
                    ┌─────────────────────────┐
                    │  Filter by severity     │
                    │  (threshold from config)│
                    └─────────────────────────┘
                                 │
                                 ▼
                    ┌─────────────────────────┐
                    │  Deduplicate against    │
                    │  existing PR comments   │
                    └─────────────────────────┘
                                 │
                                 ▼
                    ┌─────────────────────────┐
                    │  Apply tone formatting  │
                    │  (feedbackStyle)        │
                    └─────────────────────────┘
                                 │
                                 ▼
                         ReviewFinding[]
```

### Output
- `AutoReviewResult` containing:
  - `findings: ReviewFinding[]` — filtered, deduplicated, formatted comments
  - `summary: string` — human-readable review summary
  - `stats` — files reviewed, rules checked, tokens estimated, finding counts

## Key Types

### ReviewFinding

```typescript
interface ReviewFinding {
  file: string;           // relative path
  line: number;           // line in new version
  comment: string;        // formatted comment body
  severity: "low" | "medium" | "high" | "critical";
  source: "rule-regex" | "rule-llm" | "llm-review";
  ruleId?: string;        // if from a rule
  suggestion?: string;    // optional fix suggestion
}
```

### AutoReviewConfig

```typescript
interface AutoReviewConfig {
  severityThreshold: "low" | "medium" | "high" | "critical";
  formatting: {
    noEmDashes: boolean;
    noSemicolons: boolean;
    noSeverityLabels: boolean;
  };
}
```

### PostReviewConfig

```typescript
interface PostReviewConfig {
  commentDelay: [number, number];  // [min, max] seconds
  batchMode: boolean;              // single review vs individual
  dryRun: boolean;                 // print without posting
  rateLimitThreshold: number;      // pause below this limit
}
```

## Configuration

In `.lgtmrc.yaml` (repo root):

```yaml
review:
  ai_review:
    severity_threshold: high       # low | medium | high | critical
    comment_delay: [20, 90]        # seconds between individual posts
    rate_limit_threshold: 10       # pause when remaining < this
    formatting:
      no_em_dashes: true
      no_semicolons: true
      no_severity_labels: true
```

## CLI Usage

```bash
# Review a specific PR (posts findings to GitHub)
lgtm review auto --pr 42

# Dry run (show findings without posting)
lgtm review auto --pr 42 --dry-run

# Target a different repo
lgtm review auto --repo owner/repo --pr 42

# Only report critical issues
lgtm review auto --pr 42 --severity critical

# Post comments individually with delays (not batched)
lgtm review auto --pr 42 --no-batch
```

## Feedback Style

The `feedbackStyle` from the user's profile controls comment tone:

| Style | Behavior |
|-------|----------|
| `direct` | Concise, no sugar-coating. States issues plainly. |
| `gentle` | Polite suggestions. Uses "consider" and "might want to". |
| `socratic` | Guides via questions. "What happens if...?" |
| `minimal` | Extremely brief. One sentence max. Critical only. |

Set during `lgtm init` onboarding or in profile.

## LLM Task Routing

The auto-review uses the `review_delegation` task type, which can be routed to a specific model via config:

```yaml
ai:
  connections:
    - name: review-model
      provider: anthropic
      model: claude-sonnet-4-20250514
  routing:
    review_delegation: review-model
```

This allows using a higher-capability model for reviews while keeping cheaper models for other tasks.

## Token Budget

| Operation | Estimated Tokens | Frequency |
|-----------|-----------------|-----------|
| LLM rule enforcement (per rule) | ~500-1000 | Per rule per PR |
| Holistic review pass | ~2000-4000 | Per PR |
| Total per average PR | ~3000-6000 | Once |

The engine truncates diffs to stay within budget:
- LLM rules: max 4000 chars of added lines per rule
- Holistic review: max 6000 chars of added+removed lines

## Rate Limiting

When posting individually (not batched):
- Random delay between `comment_delay[0]` and `comment_delay[1]` seconds
- If GitHub returns 403 or mentions "rate limit", pauses remaining comments
- Configurable threshold (`rate_limit_threshold`) to proactively pause

## Integration Points

### Extending with new review sources

To add a new review source (e.g., security scanner):

1. Create findings in the `ReviewFinding` format
2. Add them to the pipeline in `auto-review.ts` between steps 3 and 4
3. Use a new `source` value for attribution

### Hooking into the watcher

The watcher (`src/commands/watch.ts`) knows which repos to check. A future integration could:

1. Load watched repos from `watch.md`
2. Check for new PRs since `lastChecked`
3. Auto-run `generateAutoReview()` on new PRs
4. Post findings automatically (with appropriate delays)

### Adding new feedback styles

1. Add the style name to `FEEDBACK_STYLES` in `packages/core/src/config/schema.ts`
2. Add tone instructions in `getToneInstructions()` in `auto-review.ts`
3. Update the `ProjectProfile.feedbackStyle` type in `plugin.ts`

## Error Handling

- **LLM unavailable:** Skips LLM steps, only runs regex rules
- **LLM response malformed:** Gracefully returns empty findings (no crash)
- **GitHub API errors:** Reports error, skips failed comments
- **Rate limit hit:** Pauses remaining posts, reports what was skipped
- **Invalid diff:** Returns early with informative message
- **No rules:** Still runs holistic LLM review (rules are optional)

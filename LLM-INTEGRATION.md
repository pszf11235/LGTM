# LLM Integration — How AI Reviews Are Triggered

> This document explains how LGTM's AI-powered review system works under the hood:
> how LLM calls are structured, when they fire, and how the pipeline connects
> GitHub events → diff analysis → LLM reasoning → posted comments.

---

## Table of Contents

1. [Overview](#overview)
2. [Trigger Paths](#trigger-paths)
3. [The Review Pipeline](#the-review-pipeline)
4. [LLM Call Architecture](#llm-call-architecture)
5. [Prompt Design](#prompt-design)
6. [Task Routing](#task-routing)
7. [Token Budget & Caching](#token-budget--caching)
8. [Configuration](#configuration)
9. [Extending the System](#extending-the-system)

---

## Overview

LGTM uses LLMs as **review tools**, not review replacements. The AI acts as a first-pass filter that catches high-severity issues (security, logic bugs, missing error handling) and surfaces them as inline PR comments — written in the user's configured tone.

```
┌─────────────┐     ┌──────────────┐     ┌─────────────┐     ┌──────────────┐
│   Trigger   │────▶│  Diff Fetch  │────▶│  LLM Review │────▶│  Post to GH  │
│             │     │  + Parse     │     │  Pipeline   │     │              │
└─────────────┘     └──────────────┘     └─────────────┘     └──────────────┘
  ↑ 3 paths:
  • Manual: `lgtm review auto --pr N`
  • Automated: `lgtm review watch auto`
  • Programmatic: `generateAutoReview()` API
```

---

## Trigger Paths

There are three ways AI reviews get triggered:

### 1. Manual — `lgtm review auto --pr <number>`

The user explicitly requests a review of a specific PR:

```bash
lgtm review auto --pr 42 --dry-run          # preview findings
lgtm review auto --pr 42                     # post to GitHub
lgtm review auto --pr 42 --severity critical # only critical issues
```

**Flow**: CLI command → fetch diff from GitHub API → run review pipeline → post findings.

### 2. Automated — `lgtm review watch auto`

The watcher polls watched repos and auto-reviews any new PRs:

```bash
# Single run: review all new PRs across watched repos
lgtm review watch auto --dry-run

# Polling mode: check every 15 minutes, post findings
lgtm review watch auto --interval 15

# Conservative: only critical, dry-run first
lgtm review watch auto --severity critical --dry-run
```

**Flow**: Poll GitHub for open PRs → filter to "not yet reviewed" → run review pipeline for each → mark as reviewed → repeat on interval.

**State tracking**: Reviewed PRs are tracked in `.lgtm/auto-reviewed.md` so the same PR isn't reviewed twice. The file stores `owner/repo#number` entries.

### 3. Programmatic — Direct API call

Other tools or scripts can call the review engine directly:

```typescript
import { generateAutoReview } from "@lgtm/plugin-review/domain/auto-review.js";
import { postReviewFindings } from "@lgtm/plugin-review/domain/post-review.js";
import { parseDiff } from "@lgtm/plugin-review/domain/diff-parser.js";

// 1. Parse a diff
const diff = parseDiff(rawDiffString);

// 2. Run the review engine
const result = await generateAutoReview(diff, rules, profile, llmProvider, existingComments, {
  severityThreshold: "high",
});

// 3. Post findings (or inspect them)
if (result.findings.length > 0) {
  await postReviewFindings(prNumber, result, githubAdapter, { dryRun: false, batchMode: true });
}
```

---

## The Review Pipeline

When a review is triggered (by any path), the pipeline runs these steps in order:

```
┌─────────────────────────────────────────────────────────────────────┐
│                     generateAutoReview()                             │
│                                                                     │
│  ┌─────────────────┐                                                │
│  │ Step 1: Regex   │  Run regex rules against added lines           │
│  │ Rules           │  Cost: 0 tokens (pure pattern matching)        │
│  │                 │  Maps rule severity: error→high, warn→medium   │
│  └────────┬────────┘                                                │
│           ▼                                                         │
│  ┌─────────────────┐                                                │
│  │ Step 2: LLM     │  For each rule with enforcement="llm":         │
│  │ Rule Enforce    │  Send rule description + examples + scoped diff│
│  │                 │  Cost: ~500 tokens per rule                    │
│  └────────┬────────┘                                                │
│           ▼                                                         │
│  ┌─────────────────┐                                                │
│  │ Step 3: LLM     │  Full diff review for high-impact issues       │
│  │ Holistic Review │  Security, logic bugs, performance, error      │
│  │                 │  handling. Cost: ~2000-4000 tokens              │
│  └────────┬────────┘                                                │
│           ▼                                                         │
│  ┌─────────────────┐                                                │
│  │ Step 4: Filter  │  Remove findings below severity threshold      │
│  │ by Severity     │  Default: only HIGH and CRITICAL pass through  │
│  └────────┬────────┘                                                │
│           ▼                                                         │
│  ┌─────────────────┐                                                │
│  │ Step 5: Dedup   │  Remove findings that match existing comments  │
│  │                 │  on the PR (same file+line or similar text)     │
│  └────────┬────────┘                                                │
│           ▼                                                         │
│  ┌─────────────────┐                                                │
│  │ Step 6: Format  │  Apply tone (feedbackStyle) and formatting     │
│  │ with Tone       │  rules (no em dashes, no severity labels)      │
│  └─────────────────┘                                                │
│                                                                     │
│  Output: ReviewFinding[] ready for posting                          │
└─────────────────────────────────────────────────────────────────────┘
```

---

## LLM Call Architecture

### Provider Interface

```typescript
interface LLMProvider {
  complete(prompt: string, options?: {
    maxTokens?: number;
    temperature?: number;
    systemPrompt?: string;
  }): Promise<string>;
  isAvailable(): Promise<boolean>;
}
```

### Supported Providers

| Provider | Model Default | Auth |
|----------|--------------|------|
| OpenAI | `gpt-4o-mini` | `OPENAI_API_KEY` env var |
| Anthropic | `claude-sonnet-4-20250514` | `ANTHROPIC_API_KEY` env var |
| Ollama | `llama3.2` | Local (no key needed) |

### How Calls Work

1. **No SDK dependencies** — all providers use raw `fetch()` calls
2. **Built-in retry** — 3 attempts with exponential backoff (retries on 429/500/502/503/timeout)
3. **Response caching** — identical prompts return cached results (1-hour TTL, content-hash keyed)
4. **Graceful degradation** — if LLM is unavailable, regex rules still run (zero-token enforcement)

### Call Flow

```
User's prompt
    │
    ▼
┌─────────────────┐     ┌───────────────┐
│  Check cache    │────▶│  Cache hit?   │──── Yes ──▶ Return cached
│  (content hash) │     │               │
└─────────────────┘     └───────┬───────┘
                                │ No
                                ▼
                        ┌───────────────┐
                        │  Route to     │
                        │  provider     │
                        │  (OpenAI/     │
                        │  Anthropic/   │
                        │  Ollama)      │
                        └───────┬───────┘
                                │
                                ▼
                        ┌───────────────┐
                        │  Call API     │
                        │  with retry   │
                        │  (3 attempts) │
                        └───────┬───────┘
                                │
                                ▼
                        ┌───────────────┐
                        │  Cache result │
                        │  Return       │
                        └───────────────┘
```

---

## Prompt Design

### Step 2: LLM Rule Enforcement

For each rule with `enforcement: "llm"`, a scoped prompt is sent:

```
System: "You are a code reviewer checking for rule violations. Respond ONLY with valid JSON."

User:
  Check this code for the following rule violation:

  Rule: {rule.description}
  Category: {rule.category}
  Bad example: {rule.examples.bad[0]}
  Good example: {rule.examples.good[0]}

  Code changes:
  {truncated added lines with file:line prefix, max 4000 chars}

  If there are violations, respond with a JSON array:
  [{"file": "path/to/file.ts", "line": 42, "comment": "explanation", "severity": "high"}]

  If no violations, respond with: []
```

**Parameters**: `maxTokens: 500, temperature: 0.1`

### Step 3: Holistic LLM Review

A broader review prompt is sent with the full diff context:

```
System: "You are a senior code reviewer. {toneInstructions}
         Focus only on high-impact issues. Respond ONLY with valid JSON.
         {formatting rules: no em dashes, no semicolons, no severity labels}"

User:
  Review this PR diff. Focus ONLY on high-impact issues:
  - Security vulnerabilities
  - Logic bugs that would cause incorrect behavior
  - Performance problems (O(n²) or worse, memory leaks)
  - Missing error handling for critical paths
  - Race conditions or concurrency issues

  DO NOT flag: style issues, naming preferences, missing comments, minor refactors.

  Stats: {filesChanged} files, +{additions} -{deletions}

  {compact diff with added+removed lines, max 6000 chars}

  Respond with a JSON array of findings. Each finding must have:
  - "file": relative file path
  - "line": line number in the new version
  - "comment": review comment ({toneInstructions})
  - "severity": "high" or "critical" only

  If no high-impact issues found, respond with: []
```

**Parameters**: `maxTokens: 1500, temperature: 0.2`

### Tone Instructions (from feedbackStyle)

| Style | System Prompt Addition |
|-------|----------------------|
| `direct` | "Be concise and direct. State the issue plainly. No sugar-coating." |
| `gentle` | "Be polite and constructive. Frame issues as suggestions. Use 'consider' and 'might want to'." |
| `socratic` | "Guide via questions. Ask 'What happens if...?' or 'Have you considered...?' to lead the developer to the issue." |
| `minimal` | "Be extremely brief. One sentence max per comment. Only critical issues." |

---

## Task Routing

LGTM supports routing different task types to different models/providers:

```yaml
# .lgtmrc.yaml
ai:
  provider: openai
  model: gpt-4o-mini
  connections:
    - name: review-model
      provider: anthropic
      model: claude-sonnet-4-20250514
    - name: fast-model
      provider: openai
      model: gpt-4o-mini
  routing:
    review_delegation: review-model    # AI reviews use Claude
    pr_summary: fast-model             # Summaries use cheap model
    rule_enforcement: fast-model       # Rule checks use cheap model
    pattern_analysis: review-model     # Pattern mining uses Claude
```

**Available task types**: `rule_enforcement`, `pr_summary`, `pattern_analysis`, `code_explanation`, `rule_import`, `review_delegation`

This lets you use an expensive model (Claude Sonnet) for the high-value holistic review while using a cheaper model (GPT-4o-mini) for simpler tasks like rule enforcement.

---

## Token Budget & Caching

### Estimated Token Usage Per PR

| Operation | Tokens | Notes |
|-----------|--------|-------|
| LLM rule enforcement (per rule) | ~500-1000 | Scoped to matching files |
| Holistic review pass | ~2000-4000 | Depends on diff size |
| **Total per average PR** | **~3000-6000** | One-time cost |

### Truncation Limits

- LLM rule enforcement: max **4000 chars** of added lines per rule
- Holistic review: max **6000 chars** of added+removed lines
- These limits prevent runaway token usage on large PRs

### Caching Behavior

- **Cache key**: `${provider}:${model}:${prompt}` (content-hashed)
- **TTL**: 1 hour
- **Effect**: Reviewing the same PR twice within an hour costs 0 additional tokens
- **Invalidation**: Cache clears on new commit push (diff changes → different prompt → cache miss)

### Cost Estimation

For a typical team reviewing ~10 PRs/day with GPT-4o-mini:
- ~50,000 tokens/day ≈ **$0.01-0.02/day** (at $0.15/1M input + $0.60/1M output)

With Claude Sonnet for holistic reviews:
- ~40,000 tokens/day ≈ **$0.15-0.30/day**

---

## Configuration

### Minimal setup (just works)

```bash
export OPENAI_API_KEY=sk-...
lgtm review auto --pr 42
```

### Full configuration (.lgtmrc.yaml)

```yaml
review:
  ai_review:
    # Minimum severity to report
    severity_threshold: high    # low | medium | high | critical

    # Delay between individual comment posts (anti-spam)
    comment_delay: [20, 90]     # [min, max] seconds

    # Pause when rate limit remaining drops below this
    rate_limit_threshold: 10

    # Formatting applied to all AI-generated comments
    formatting:
      no_em_dashes: true        # Replace — with hyphens
      no_semicolons: true       # Replace ; with periods
      no_severity_labels: true  # Strip [HIGH] prefix from comments
```

### Environment Variables

| Variable | Purpose |
|----------|---------|
| `OPENAI_API_KEY` | OpenAI API authentication |
| `ANTHROPIC_API_KEY` | Anthropic API authentication |
| `GITHUB_TOKEN` / `GH_TOKEN` | GitHub API access (fetch PRs, post reviews) |

---

## Extending the System

### Adding a New Review Source

To add a custom review source (e.g., security scanner, linter integration):

```typescript
import type { ReviewFinding } from "./domain/auto-review.js";

// Create findings in the standard format
const myFindings: ReviewFinding[] = [{
  file: "src/auth.ts",
  line: 42,
  comment: "SQL injection vulnerability detected",
  severity: "critical",
  source: "rule-regex",  // or "rule-llm" or "llm-review"
  suggestion: "Use parameterized queries instead",
}];
```

### Adding a New LLM Provider

Implement the `LLMProvider` interface:

```typescript
const myProvider: LLMProvider = {
  async complete(prompt, options) {
    // Call your API
    const response = await fetch("https://my-llm-api.com/v1/chat", {
      method: "POST",
      body: JSON.stringify({ prompt, ...options }),
    });
    return await response.text();
  },
  async isAvailable() {
    // Health check
    return true;
  },
};
```

### Hooking Into CI/CD

Run auto-review as a GitHub Action:

```yaml
# .github/workflows/lgtm-review.yml
name: LGTM Auto-Review
on:
  pull_request:
    types: [opened, synchronize]

jobs:
  review:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2
      - run: bun install
      - run: bun run lgtm review auto --pr ${{ github.event.pull_request.number }} --severity high
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}
```

This runs LGTM on every PR opened or updated — fully automated CI-based code review.

### MCP (Model Context Protocol) Integration

LGTM's review engine can be exposed as an MCP tool for AI agents:

```typescript
// Example MCP tool definition
{
  name: "lgtm_review_pr",
  description: "Run AI-powered code review on a GitHub PR",
  parameters: {
    repo: { type: "string", description: "owner/repo" },
    pr_number: { type: "number", description: "PR number" },
    severity: { type: "string", enum: ["low", "medium", "high", "critical"] },
    dry_run: { type: "boolean", description: "Preview without posting" },
  },
  handler: async ({ repo, pr_number, severity, dry_run }) => {
    // Fetch diff, run pipeline, optionally post
    const [owner, name] = repo.split("/");
    const github = createGitHubAdapter(owner, name);
    const rawDiff = await github.fetchDiff(pr_number);
    const diff = parseDiff(rawDiff);
    const result = await generateAutoReview(diff, rules, profile, llm, [], { severityThreshold: severity });

    if (!dry_run && result.findings.length > 0) {
      await postReviewFindings(pr_number, result, github, { batchMode: true });
    }

    return { findings: result.findings, summary: result.summary };
  },
}
```

This allows any MCP-compatible AI agent (Claude, GPT, etc.) to invoke LGTM reviews as a tool call.

---

## Security Considerations

1. **API keys** are never stored in OKF files or committed to git — only in env vars or `~/.lgtm-credentials`
2. **Rate limiting** prevents spam: configurable delays between posts, pause on GitHub 403
3. **Deduplication** prevents re-posting the same comment on subsequent runs
4. **Severity filtering** prevents noise: only high-impact issues are posted by default
5. **Dry-run mode** lets you preview before any GitHub writes happen
6. **Token budgets** prevent runaway costs: diffs are truncated to fixed character limits
7. **Reviewed-PR tracking** prevents the watcher from re-reviewing the same PR

---

*Last updated: August 2026*

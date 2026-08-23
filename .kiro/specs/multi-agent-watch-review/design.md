# Multi-Agent Watch Review — Design

## Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                     lgtm review watch auto                           │
│                     (Orchestrator Process)                            │
├─────────────────────────────────────────────────────────────────────┤
│                                                                      │
│  1. Poll watched repos → detect new PRs                              │
│  2. Fetch diff for each new PR                                       │
│  3. Load agent configs from .lgtm/agents/*.md                        │
│  4. For each agent: Bun.spawn(worker) with diff + config             │
│  5. Collect results, save to .lgtm/reviews/<pr>/agent-<name>.md      │
│                                                                      │
│  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐     │
│  │  Agent Worker 1  │  │  Agent Worker 2  │  │  Agent Worker N  │    │
│  │  (separate proc) │  │  (separate proc) │  │  (separate proc) │    │
│  │                  │  │                  │  │                  │     │
│  │  prompt: review  │  │  prompt: review  │  │  prompt: review  │    │
│  │  via: claude-cli │  │  via: codex-cli  │  │  via: openrouter │    │
│  │                  │  │                  │  │                  │     │
│  │  stdin ← diff    │  │  stdin ← diff    │  │  stdin ← diff    │    │
│  │  stdout → JSON   │  │  stdout → JSON   │  │  stdout → JSON   │    │
│  └────────┬─────────┘  └────────┬─────────┘  └────────┬─────────┘   │
│           │                      │                      │             │
│           ▼                      ▼                      ▼             │
│  ┌──────────────────────────────────────────────────────────────┐    │
│  │         .lgtm/reviews/42/                                    │    │
│  │           agent-reviewer.md     (OKF: findings)              │    │
│  │           agent-reviewer-2.md   (if multiple workers)        │    │
│  └──────────────────────────────────────────────────────────────┘    │
│                                                                      │
├─────────────────────────────────────────────────────────────────────┤
│                     Human Review (UI / CLI)                           │
│                                                                      │
│  Diff view with agent annotations:                                   │
│    Line 42: [reviewer] Hardcoded API key detected                    │
│    Line 67: [reviewer] Missing error handling                        │
│                                                                      │
│  Actions: p=post  x=discard  e=edit  P=post all  Shift+P=batch post │
│                                                                      │
│  → Approved findings posted as GitHub review (batched)               │
└─────────────────────────────────────────────────────────────────────┘
```

## Agent Worker Protocol

The orchestrator spawns each agent as a child process. The worker handles provider dispatch internally.

```ts
const worker = Bun.spawn(["bun", "run", "packages/plugins/review/src/workers/review-agent.ts"], {
  stdin: "pipe",
  stdout: "pipe",
  stderr: "pipe",
  env: { ...process.env, LGTM_AGENT_TIMEOUT: "120" },
});
```

### Input (via stdin — JSON)
```json
{
  "diff": "<raw unified diff>",
  "agent": {
    "name": "reviewer",
    "provider": "claude-cli",
    "prompt": "Review all open pull requests...",
    "severity": "high"
  },
  "rules": [
    { "id": "r1", "description": "...", "pattern": "...", "enforcement": "regex" }
  ],
  "pr": {
    "number": 42,
    "title": "Add user auth",
    "repo": "org/backend"
  },
  "profile": {
    "feedbackStyle": "direct",
    "goal": "production"
  }
}
```

### Worker Provider Dispatch

Inside the worker, based on `agent.provider`:

**claude-cli:**
```ts
const proc = Bun.spawn(["claude", "-p", combinedPrompt, "--output-format", "json"], {
  stdin: "pipe",  // pipe the diff content if too large for arg
});
// Parse JSON output from Claude
```

**codex-cli:**
```ts
const proc = Bun.spawn(["codex", "exec", combinedPrompt, "--json-output-schema", schema], {
  cwd: repoPath,
});
// Parse structured JSON output
```

**openrouter:**
```ts
const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
  headers: { "Authorization": `Bearer ${process.env.OPENROUTER_API_KEY}` },
  body: JSON.stringify({
    model: agent.model ?? "anthropic/claude-sonnet-4-20250514",
    messages: [{ role: "system", content: agent.prompt }, { role: "user", content: diff }],
    response_format: { type: "json_object" },
  }),
});
```

**ollama:**
```ts
const res = await fetch("http://localhost:11434/api/generate", {
  body: JSON.stringify({
    model: agent.model ?? "qwen2.5-coder:7b",
    prompt: combinedPrompt,
    format: "json",
    stream: false,
  }),
});
```

### Output (via stdout — JSON)
```json
{
  "agent": "reviewer",
  "findings": [
    {
      "file": "src/auth.ts",
      "line": 42,
      "comment": "Hardcoded API key. Use environment variable instead.",
      "severity": "critical",
      "source": "llm-review"
    }
  ],
  "stats": {
    "filesReviewed": 5,
    "tokensUsed": 2340,
    "durationMs": 8500
  },
  "error": null
}
```

### Error handling
- If process exits non-zero: orchestrator logs error, continues with other agents
- If timeout (120s default): orchestrator kills process, marks agent as "timed out"
- If stdout is not valid JSON: orchestrator logs raw output as error

## Storage (OKF Format)

### Review Prompt: `.lgtm/agents/reviewer.md`

The review prompt is an OKF file — not hardcoded in the service. Users edit this to customize their review style.

```markdown
---
name: reviewer
provider: claude-cli
prompt: |
  Review all open pull requests across the connected repositories. For each PR, report:
  1. Title and author
  2. How long it's been open
  3. Review status: approved, changes requested, or awaiting review
  4. CI status: passing, failing, or pending
  5. Merge conflicts: whether the branch is up to date

  For any PRs ready for review, focus on high and critical issues only.
  Provide feedback directly on the PR. Use my tone and voice: concise,
  actionable, no fluff, dev to dev. Never use em dashes or semicolons.
  When posting comments wait 20sec-1.5min between each post.
  Don't spell severity in the body.
  Instead of: "**High — these events won't make it to GA4.**"
  Use: "These events probably won't make it to GA4 (this is an important one)..."

  Highlight any PRs open for more than 3 days or with failing checks.
  Sort by oldest first. If there are no open PRs, confirm briefly.
  Provide a clear view on which ones I should approve (comments resolved,
  clean after review).

  Lastly, if there are PRs where I'm the author, provide a standup summary:
  "Yesterday I ..., today I will..."

  Output as JSON: {prs: [{number, title, author, url, age_days, review_status,
  ci_status, has_conflicts, recommendation, findings: [{file, line, comment, severity}]}],
  standup: string|null}
severity: high
commentDelay: [20, 90]
enabled: true
---

# LGTM Review Agent

Edit this file to change how the agent reviews PRs.
The prompt above is sent to the AI along with the PR diff.
```

### Agent Findings: `.lgtm/reviews/42/agent-reviewer.md`
```markdown
---
type: lgtm/agent-review
pr: 42
repo: org/backend
url: https://github.com/org/backend/pull/42
agent: reviewer
provider: claude-cli
reviewedAt: "2026-08-22T14:30:00Z"
durationMs: 8500
findings:
  - file: src/auth.ts
    line: 42
    comment: "Hardcoded API key. Use process.env.API_KEY instead."
    severity: critical
    posted: false
  - file: src/db.ts
    line: 18
    comment: "SQL query built with string concatenation. Use parameterized queries, this is exploitable."
    severity: high
    posted: false
---

# Review — PR #42

Reviewed 5 files, found 2 issues (1 critical, 1 high).
```

### Watcher Config: `watch.md`
```markdown
---
type: lgtm/watch
repos:
  - owner: org
    repo: backend
    filter: all
  - owner: org
    repo: frontend
    filter: review_requested
autoReview:
  enabled: true
  timeout: 120
lastUpdated: "2026-08-22T10:00:00Z"
---

# Watch Configuration

Monitoring 2 repos. Auto-review enabled.
```

## UI Integration

### Diff View — Agent Annotations

When viewing a PR diff that has agent findings:

```
  src/auth.ts
  ─────────────────────────────────────────────────────────────
  @@ -40,6 +40,8 @@
   import { hash } from './crypto';
  +
  +const API_KEY = "sk-live-12345678";       ← [reviewer] Hardcoded API key
  +
   export function login(user, pass) {
  +  if (!user) return null;                 ← [reviewer] Missing error type
     return db.auth(user, hash(pass));
   }

  ─────────────────────────────────────────────────────────────
  2 findings for this file (p=post  x=discard  e=edit)
```

### Status Indicators

```
  Review Queue:
    #42  Add user auth — review ready [2 findings]
    #43  Fix login — reviewing...
```

## Process Lifecycle

```
[Orchestrator]                [Worker: reviewer]
     │                              │
     ├── spawn ──────────────────── │
     │                              │
     ├── write stdin (JSON) ──────► │
     │                              │
     │                              ├── call claude -p / codex exec / openrouter
     │                              │
     │  ◄── stdout (findings) ───── │
     │                              │
     ├── save .lgtm/reviews/42/agent-reviewer.md
     │
     ├── [done — notify human]
```

When configured with multiple agents (user adds more .md files to .lgtm/agents/), multiple workers spawn in parallel.

## Dependencies

- `packages/plugins/review/src/commands/watch.ts` — existing watcher (poll + auto)
- `packages/plugins/review/src/domain/auto-review.ts` — existing review engine
- `packages/plugins/review/src/domain/post-review.ts` — existing GitHub posting
- `packages/plugins/review/src/domain/diff-parser.ts` — existing diff parser
- `packages/core/src/llm/provider.ts` — LLM provider creation
- `packages/core/src/store/okf.ts` — OKF read/write

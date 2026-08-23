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
│  │  prompt: secur.  │  │  prompt: arch.   │  │  prompt: custom  │    │
│  │  model: claude   │  │  model: gpt-4o   │  │  model: ollama   │    │
│  │                  │  │                  │  │                  │     │
│  │  stdin ← diff    │  │  stdin ← diff    │  │  stdin ← diff    │    │
│  │  stdout → JSON   │  │  stdout → JSON   │  │  stdout → JSON   │    │
│  └────────┬─────────┘  └────────┬─────────┘  └────────┬─────────┘   │
│           │                      │                      │             │
│           ▼                      ▼                      ▼             │
│  ┌──────────────────────────────────────────────────────────────┐    │
│  │         .lgtm/reviews/42/                                    │    │
│  │           agent-security.md    (OKF: findings)               │    │
│  │           agent-architecture.md (OKF: findings)              │    │
│  │           agent-custom.md       (OKF: findings)              │    │
│  └──────────────────────────────────────────────────────────────┘    │
│                                                                      │
├─────────────────────────────────────────────────────────────────────┤
│                     Human Review (TUI)                                │
│                                                                      │
│  Diff view with agent annotations:                                   │
│    Line 42: [🔒 security] Hardcoded API key detected                 │
│    Line 67: [🏗 architecture] Function too complex (cyclomatic: 12)  │
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
    "name": "security",
    "provider": "claude-cli",
    "prompt": "You are a security reviewer...",
    "severity": "high",
    "model": null
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
  "agent": "security",
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

### Agent Config: `.lgtm/agents/reviewer.md`

The primary code review agent — reviews individual PRs with your tone and style.

```markdown
---
name: reviewer
provider: claude-cli
prompt: |
  Review this pull request diff. Focus on HIGH and CRITICAL issues only.
  Provide feedback concisely, actionably, no fluff, dev to dev.
  Never use em dashes or semicolons.
  When flagging an issue, don't spell out "HIGH" or "Critical" in the body.
  Instead of: "**High / borderline critical — these events probably won't make it to GA4.**"
  Use: "These events probably won't make it to GA4 (this is an important one)..."
  Keep it direct: what's wrong, why it matters, what to do.
  Output findings as JSON array: [{file, line, comment, severity}]
severity: high
enabled: true
priority: 1
---

# Code Review Agent

Reviews each PR for high and critical issues.
Tone: concise, actionable, dev-to-dev. No fluff.
```

### Agent Config: `.lgtm/agents/ops.md`

The ops/overview agent — provides PR status dashboard and standup generation.

```markdown
---
name: ops
provider: codex-cli
prompt: |
  Review all open pull requests. For each PR, report:
  1. Title and author
  2. How long it's been open
  3. Review status: approved, changes requested, or awaiting review
  4. CI status: passing, failing, or pending
  5. Merge conflicts: whether the branch is up to date

  Highlight any PRs open for more than 3 days or with failing checks.
  Sort by oldest first.
  If there are no open PRs, confirm briefly.

  Provide a clear view on which ones should be approved (comments resolved,
  clean after review).

  Lastly, if there are any PRs where the user is the author, provide a
  standup summary: "Yesterday I ..., today I will..."

  Output as JSON: {prs: [{number, title, author, age_days, review_status,
  ci_status, has_conflicts, recommendation}], standup: string|null}
severity: medium
enabled: true
priority: 2
---

# Ops / Dashboard Agent

Provides PR health overview across repos: status, age, CI, conflicts.
Generates daily standup if user has authored PRs.
```

### Agent Findings: `.lgtm/reviews/42/agent-reviewer.md`
```markdown
---
type: lgtm/agent-review
pr: 42
repo: org/backend
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
    comment: "SQL query built with string concatenation. Use parameterized queries — this is exploitable."
    severity: high
    posted: false
---

# Reviewer Agent — PR #42

Reviewed 5 files, found 2 issues (1 critical, 1 high).
```

### Agent Findings: `.lgtm/reviews/42/agent-ops.md`
```markdown
---
type: lgtm/agent-review
pr: 42
repo: org/backend
agent: ops
provider: codex-cli
reviewedAt: "2026-08-22T14:30:05Z"
durationMs: 4200
overview:
  prs:
    - number: 42
      title: "Add user auth"
      author: "pascalhampel"
      age_days: 1
      review_status: "awaiting review"
      ci_status: "passing"
      has_conflicts: false
      recommendation: "review"
    - number: 38
      title: "Fix login redirect"
      author: "teammate"
      age_days: 5
      review_status: "changes requested"
      ci_status: "failing"
      has_conflicts: true
      recommendation: "needs attention"
  standup: "Yesterday I opened PR #42 (user auth). Today I will address review feedback and merge."
findings: []
---

# Ops Agent — PR Overview

2 open PRs. 1 needs attention (>3 days, failing CI).
```

### Watcher Config Extension: `watch.md`
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
  agentCount: 2
  timeout: 120
  agents:
    - security
    - architecture
lastUpdated: "2026-08-22T10:00:00Z"
---

# Watch Configuration

Monitoring 2 repos. Auto-review enabled with 2 agents.
```

## TUI Integration

### Review Tab — Agent Annotations

When viewing a PR diff that has agent reviews:

```
  src/auth.ts
  ─────────────────────────────────────────────────────────────
  @@ -40,6 +40,8 @@
   import { hash } from './crypto';
  +
  +const API_KEY = "sk-live-12345678";       ← [🔒 security] Hardcoded API key
  +
   export function login(user, pass) {
  +  if (!user) return null;                 ← [🏗 architecture] Missing error type
     return db.auth(user, hash(pass));
   }

  ─────────────────────────────────────────────────────────────
  2 agent findings for this file (p=post  x=discard  e=edit)
```

### Status Indicators

```
  Review Queue:
    #42  Add user auth — 2 agent reviews ready [🔒 2 findings, 🏗 1 finding]
    #43  Fix login — reviewing... (security: done, architecture: running)
```

## Process Lifecycle

```
[Orchestrator]                [Worker: security]        [Worker: architecture]
     │                              │                          │
     ├── spawn ──────────────────── │                          │
     ├── spawn ──────────────────── ├──────────────────────── │
     │                              │                          │
     ├── write stdin (JSON) ──────► │                          │
     ├── write stdin (JSON) ──────► ├─────────────────────── ►│
     │                              │                          │
     │                              ├── call LLM API           │
     │                              │   (security prompt)      ├── call LLM API
     │                              │                          │   (architecture prompt)
     │                              │                          │
     │  ◄── stdout (findings) ───── │                          │
     │                              │                          │
     │  ◄── stdout (findings) ───── ├──────────────────────── │
     │                              │                          │
     ├── save agent-security.md     │                          │
     ├── save agent-architecture.md │                          │
     │                              │                          │
     ├── [done — notify human]      │                          │
```

## Dependencies

- `packages/plugins/review/src/commands/watch.ts` — existing watcher (poll + auto)
- `packages/plugins/review/src/domain/auto-review.ts` — existing review engine
- `packages/plugins/review/src/domain/post-review.ts` — existing GitHub posting
- `packages/plugins/review/src/domain/diff-parser.ts` — existing diff parser
- `packages/core/src/llm/provider.ts` — LLM provider creation
- `packages/core/src/store/okf.ts` — OKF read/write

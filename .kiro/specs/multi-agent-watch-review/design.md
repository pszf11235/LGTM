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

### Agent Config: `.lgtm/agents/security.md`
```markdown
---
name: security
provider: claude-cli
prompt: |
  You are a security-focused code reviewer. Look for:
  - Hardcoded secrets, API keys, tokens
  - SQL injection, XSS, CSRF vulnerabilities
  - Auth/authz bypasses
  Only flag HIGH or CRITICAL issues.
  Output findings as JSON: [{file, line, comment, severity}]
severity: high
enabled: true
priority: 1
---

# Security Review Agent

Focuses on vulnerabilities, auth issues, and data exposure.
Uses Claude Code CLI (your Max/Pro subscription).
```

### Agent Config: `.lgtm/agents/architecture.md`
```markdown
---
name: architecture
provider: codex-cli
prompt: |
  You are an architecture reviewer. Look for:
  - Functions over 50 lines (suggest splitting)
  - Circular dependencies
  - Leaky abstractions
  - Missing error handling
  - God objects / God functions
  Focus on maintainability and separation of concerns.
  Output findings as JSON: [{file, line, comment, severity}]
severity: medium
enabled: true
priority: 2
---

# Architecture Review Agent

Focuses on code structure and long-term maintainability.
Uses Codex CLI (your ChatGPT subscription).
```

### Agent Findings: `.lgtm/reviews/42/agent-security.md`
```markdown
---
type: lgtm/agent-review
pr: 42
repo: org/backend
agent: security
model: claude-sonnet-4-20250514
reviewedAt: "2026-08-22T14:30:00Z"
durationMs: 8500
tokensUsed: 2340
findings:
  - file: src/auth.ts
    line: 42
    comment: "Hardcoded API key. Use process.env.API_KEY instead."
    severity: critical
    posted: false
  - file: src/db.ts
    line: 18
    comment: "SQL query built with string concatenation — use parameterized queries."
    severity: high
    posted: false
---

# Security Agent Review — PR #42

Reviewed 5 files, found 2 issues (1 critical, 1 high).
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

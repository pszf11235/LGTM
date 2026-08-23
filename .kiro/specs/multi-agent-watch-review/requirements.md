# Multi-Agent Watch Review — Requirements

## Overview

When the watcher detects a new PR/MR on any watched repo, it automatically dispatches 2+ AI review agents as **separate processes**. Each agent has its own system prompt (configurable via OKF file), reviews the diff independently, and produces local findings stored as comments in the diff. Reviews are **local-first** — findings stay on disk until the human reviews them in the TUI, then explicitly approves posting to GitHub/GitLab.

## Core Flow

```
Watcher detects new PR
  → Spawns N agent processes (configurable, default 2)
  → Each agent gets: diff + its own prompt + rules
  → Each agent produces findings (saved locally as OKF)
  → Human reviews in TUI (sees all agents' findings overlaid on diff)
  → Human approves/edits/discards findings
  → Approved findings posted to GitHub as review
```

## User Stories

### US-1: Auto-dispatch on new PR
**As a** developer watching multiple repos,
**I want** LGTM to automatically start reviewing when a new PR appears,
**So that** I have AI feedback ready by the time I sit down to review.

**Acceptance Criteria:**
- `lgtm review watch auto` polls watched repos and spawns agents on new PRs
- Each new PR triggers N separate agent processes (N = configured agent count)
- Agents run in parallel as separate OS processes (`Bun.spawn`)
- If watcher is not running, reviews can be triggered manually: `lgtm review auto --pr 42 --agents`
- Already-reviewed PRs are not re-reviewed (tracked in OKF)

### US-2: Configurable agent prompts in OKF
**As a** team lead tuning my review agents,
**I want** to configure each agent's focus/prompt in a readable file,
**So that** I can version-control my review strategy and share it with the team.

**Acceptance Criteria:**
- Agent configs stored at `.lgtm/agents/` (one file per agent, OKF format)
- Each agent file defines: name, prompt, severity threshold, model override
- Default ships with 2 agents: `security.md` + `architecture.md`
- Can add more agents by creating new `.md` files in the directory
- Per-repo agents override global agents (same as rules precedence)

Example `.lgtm/agents/security.md`:
```markdown
---
name: security
prompt: |
  You are a security-focused code reviewer. Look for:
  - Hardcoded secrets, API keys, tokens
  - SQL injection, XSS, CSRF vulnerabilities
  - Auth/authz bypasses
  - Insecure data handling
  - Dependency vulnerabilities
  Only flag HIGH or CRITICAL issues. Be concise.
severity: high
model: claude-sonnet-4-20250514
enabled: true
priority: 1
---

# Security Review Agent

Focuses on vulnerabilities, auth issues, and data exposure.
Reviews every PR from a security-first perspective.
```

### US-3: Separate processes per agent
**As a** user wanting isolation and parallelism,
**I want** each agent to run as a truly separate process,
**So that** they don't interfere with each other and can use different models.

**Acceptance Criteria:**
- Each agent is a separate `Bun.spawn` child process
- Parent process orchestrates: spawn, wait, collect results
- Agents can use different LLM models (one might use Claude, another GPT-4o)
- If one agent crashes, the other still completes
- Agent process receives: diff content, agent config, rules — via stdin or temp file
- Agent process outputs: structured findings JSON — via stdout or temp file
- Timeout per agent (configurable, default 120s)

### US-4: Local-first findings (not posted immediately)
**As a** reviewer who wants to curate AI feedback before it goes public,
**I want** findings to stay local until I explicitly approve them,
**So that** I control what gets posted and avoid noisy/wrong comments.

**Acceptance Criteria:**
- Agent findings saved to `.lgtm/reviews/<pr-number>/agent-<name>.md` (OKF format)
- Each finding stored with: file, line, comment, severity, agent name
- Findings are NOT posted to GitHub automatically
- `lgtm review status` shows "2 agent reviews ready for PR #42"
- In TUI Review tab: agent findings shown as inline annotations on the diff
- Human can: approve (→ post), edit (→ modify then post), discard (→ delete)
- Bulk approve: "Post all findings" / "Post findings from security agent only"
- After posting, findings are marked as `posted: true` in the OKF file

### US-5: Human review + selective posting
**As a** reviewer in the TUI diff view,
**I want** to see agent findings overlaid on the code with the agent name labeled,
**So that** I can evaluate each finding in context and decide what to post.

**Acceptance Criteria:**
- Diff view shows agent annotations: `[🔒 security] Hardcoded API key on line 42`
- Different agents use different colors/icons
- Keyboard: `p` post selected finding, `P` post all from cursor down, `x` discard
- `Shift+P` post all approved findings for this PR at once
- Posted findings become GitHub review comments (batched as one review)
- After posting, agent annotation changes to `✓ posted`

### US-6: Adjustable agent count per PR
**As a** user wanting deeper review on critical PRs,
**I want** to increase the agent count for specific PRs (e.g., 4 instead of 2),
**So that** I get more thorough review when it matters.

**Acceptance Criteria:**
- `lgtm review auto --pr 42 --agents 4` overrides the default count
- Extra agents use the same prompt pool but with different temperature/sampling
- Or: user can specify which agent configs to use: `--agents security,architecture,testing,performance`
- Configurable default in `.lgtmrc.yaml`: `watch.auto_review.agent_count: 2`

## Non-Functional Requirements

- **Storage**: All config (agents, findings, watcher state) in OKF format
- **Process isolation**: Each agent is a separate OS process (Bun.spawn)
- **Timeout**: Configurable per-agent timeout (default 120s, kills process if exceeded)
- **Fault tolerance**: One agent failing doesn't block others
- **Local-first**: No network posting without explicit human approval
- **Idempotent**: Re-running on the same PR doesn't duplicate findings (dedup by file+line+agent)
- **Performance**: Agents run in parallel, total wall time = slowest agent (not sum)

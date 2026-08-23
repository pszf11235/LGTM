# Multi-Agent Watch Review — Requirements

## Overview

When the watcher detects a new PR/MR on any watched repo, it automatically dispatches 2+ AI review agents as **separate processes**. Each agent has its own system prompt (configurable via OKF file), reviews the diff independently, and produces local findings stored as comments in the diff. Reviews are **local-first** — findings stay on disk until the human reviews them in the TUI, then explicitly approves posting to GitHub/GitLab.

## Provider Strategy

Agents use the user's existing AI tool subscriptions via CLI subprocess calls:

| Priority | Provider | Auth | Mechanism |
|----------|----------|------|-----------|
| 1 | **Claude Code CLI** | Max/Pro subscription (Keychain) | `claude -p --output-format json` |
| 2 | **Codex CLI** | ChatGPT subscription | `codex exec --json-output-schema` |
| 3 | **OpenRouter** | `OPENROUTER_API_KEY` | HTTP API (400+ models, free tier available) |
| 4 | **Ollama** (local) | None | HTTP to localhost:11434 (see #123 for auto-setup) |

**Key insight**: Claude CLI and Codex CLI use your existing subscriptions legally — we spawn their official CLIs as subprocesses, never touching OAuth tokens directly.

## Core Flow

```
Watcher detects new PR
  → Spawns N agent processes (configurable, default 2)
  → Each agent gets: diff + its own prompt + rules
  → Agent calls its provider (claude -p / codex exec / OpenRouter API / Ollama)
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
- Each agent file defines: name, prompt, provider, severity threshold, model override
- Default ships with 2 agents: `reviewer.md` (claude-cli, per-PR review) + `ops.md` (codex-cli, overview/standup)
- Can add more agents by creating new `.md` files in the directory
- Per-repo agents override global agents (same as rules precedence)
- `provider` field determines how the agent executes: `claude-cli`, `codex-cli`, `openrouter`, `ollama`

Example `.lgtm/agents/reviewer.md`:
```markdown
---
name: reviewer
provider: claude-cli
prompt: |
  Review this pull request diff. Focus on HIGH and CRITICAL issues only.
  Provide feedback concisely, actionably, no fluff, dev to dev.
  Never use em dashes or semicolons.
  Don't spell out severity labels in the body.
  Instead of: "**High — these events won't make it to GA4.**"
  Use: "These events probably won't make it to GA4 (this is an important one)..."
  Output findings as JSON array: [{file, line, comment, severity}]
severity: high
enabled: true
priority: 1
---

# Code Review Agent

Reviews each PR for high/critical issues. Tone: concise, dev-to-dev.
```

Example `.lgtm/agents/ops.md`:
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
  Highlight PRs open >3 days or with failing checks. Sort oldest first.
  Provide standup summary if user has authored PRs.
  Output as JSON: {prs: [...], standup: string|null}
severity: medium
enabled: true
priority: 2
---

# Ops Agent

PR health dashboard + standup generator.
```

### US-3: Separate processes per agent
**As a** user wanting isolation and parallelism,
**I want** each agent to run as a truly separate process,
**So that** they don't interfere with each other and can use different providers/models.

**Acceptance Criteria:**
- Each agent is a separate `Bun.spawn` child process
- Parent process orchestrates: spawn, wait, collect results
- Agents can use different providers (one uses Claude CLI, another uses Codex CLI)
- If one agent crashes/times out, the other still completes
- Agent worker process handles provider dispatch internally
- Timeout per agent (configurable, default 120s)

Provider dispatch in worker:
- `claude-cli`: spawns `claude -p "<prompt + diff>" --output-format json`
- `codex-cli`: spawns `codex exec "<prompt + diff>" --json-output-schema <schema>`
- `openrouter`: HTTP POST to `https://openrouter.ai/api/v1/chat/completions`
- `ollama`: HTTP POST to `http://localhost:11434/api/generate`

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
- Extra agents reuse the prompt pool with different temperature/sampling
- Or: user can specify which agent configs to use: `--agents security,architecture,testing`
- Configurable default in `.lgtmrc.yaml`: `watch.auto_review.agent_count: 2`

### US-7: Provider auto-detection and fallback
**As a** user who may have some providers but not others,
**I want** LGTM to automatically detect which providers are available,
**So that** agents fall back gracefully if their preferred provider isn't set up.

**Acceptance Criteria:**
- On agent start: check if configured provider is available
  - `claude-cli`: check `which claude` and auth status
  - `codex-cli`: check `which codex` and auth status
  - `openrouter`: check `OPENROUTER_API_KEY` env var
  - `ollama`: check `http://localhost:11434` reachable
- If configured provider unavailable: fall back to next available in priority order
- Show warning: "Agent 'security' configured for claude-cli but not available — falling back to openrouter"
- `lgtm ai discover` shows which providers are available for agent use

## Non-Functional Requirements

- **Storage**: All config (agents, findings, watcher state) in OKF format
- **Process isolation**: Each agent is a separate OS process (Bun.spawn)
- **Timeout**: Configurable per-agent timeout (default 120s, kills process if exceeded)
- **Fault tolerance**: One agent failing doesn't block others
- **Local-first**: No network posting without explicit human approval
- **Idempotent**: Re-running on the same PR doesn't duplicate findings (dedup by file+line+agent)
- **Performance**: Agents run in parallel, total wall time ≈ slowest agent (not sum)
- **Cross-platform**: CLI providers (claude, codex) must be on PATH; HTTP providers (openrouter, ollama) work anywhere

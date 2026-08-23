# MVP Review Pipeline — Requirements

## Goal

A focused tool that does exactly one thing well: **discover your repos, watch them for PRs, review those PRs with AI agents, store findings locally, let you approve them, then post to GitHub.**

Everything not serving that loop is removed and filed as an issue.

## The Loop

```
1. lgtm discover --ingest        → find local repos, accept into watcher
2. lgtm watch                    → poll every 15min (+ once on startup)
3. PR found                      → spawn review agent(s) via CLI
4. findings → .lgtm/reviews/     → local OKF, NOT posted
5. lgtm (TUI) or lgtm review show → inspect findings inline on diff
6. approve                       → agent posts to GitHub, marks posted: true
7. new commits detected          → verify old findings closed, run next round
```

## Requirements

### R1: Discover local repos and add to watcher

**As a** developer with many repos,
**I want** to scan my machine and pick which repos to watch,
**So that** I don't type `watch add owner/repo` for each one.

**Acceptance Criteria:**
- `lgtm discover --ingest [dir]` scans for git repos (already works)
- **NEW**: Accepting a repo writes it to `watch.md`, not just the ingest registry
  - Current bug: `acceptRepo()` in `reconcile.ts` only updates `~/.lgtm-ingest-registry.md`
  - The picker says "[a] accept (watch)" but the repo never reaches the watcher
- Requires `owner/repo` from the git remote — skip repos with no remote (log why)
- `lgtm watch list` shows repos accepted via ingest
- Re-running ingest shows already-watched repos with `👁`

### R2: Watcher polls on startup and on interval

**As a** developer,
**I want** the watcher to check for PRs when I start it and then keep checking,
**So that** I get reviews without manual triggers.

**Acceptance Criteria:**
- `lgtm watch` (new top-level alias for `lgtm review watch auto`) runs a check immediately
- Then polls every N minutes, **default 15**
  - Current bug: `--interval` defaults to `"0"` (single run) despite help text saying 15
- `--interval 0` = single run and exit (for cron)
- `--once` = same as `--interval 0`
- Ctrl+C exits cleanly
- Each cycle logs: repos checked, new PRs found, reviews triggered
- Reads watched repos fresh each cycle (picks up newly accepted repos)

### R3: Review via CLI agents with built-in review skills

**As a** developer with Claude/Codex/Kiro subscriptions,
**I want** reviews to run through those CLIs using their built-in review capabilities,
**So that** I use my existing subscription and get their best review quality.

**Acceptance Criteria:**
- Provider priority (first available wins unless configured):
  1. `kiro-cli` — `kiro-cli --no-interactive "<prompt>" --trust-all-tools` (needs `KIRO_API_KEY`)
  2. `claude-cli` — `claude -p "/review <pr-url>" --output-format json` (uses Max/Pro subscription)
  3. `codex-cli` — `codex exec "/review" --json-output-schema <schema>` (uses ChatGPT subscription)
  4. `openrouter` — HTTP API, needs `OPENROUTER_API_KEY`
  5. `ollama` — HTTP `localhost:11434`, no auth
- **Prefer built-in review commands** over raw prompting when the CLI has one:
  - Claude: `/review <url>` (multi-agent, fetches diff itself) or `/code-review` (local diff)
  - Codex: `/review` (GPT-5.x trained for review)
  - Kiro: custom agent from `.kiro/agents/` if present, else raw prompt
- The user's custom prompt from `.lgtm/agents/reviewer.md` is **appended as additional instructions**, not a replacement
- Each agent runs as a **separate child process** (`Bun.spawn`)
- Timeout per agent: 300s default (CLI reviews are slower than raw API calls)
- If a provider is unavailable, fall back to the next in priority order and log it
- `lgtm ai discover` reports which providers are available for review

### R4: Findings land in local OKF first

**As a** reviewer,
**I want** findings saved locally before anything is posted,
**So that** nothing goes public without my approval.

**Acceptance Criteria:**
- Findings written to `<lgtmDir>/reviews/<owner>-<repo>-<pr>/` where `lgtmDir` respects storage mode (`.lgtm/` or `~/.lgtm-farm/<repo>/`)
- Per-PR directory contains:
  - `meta.md` — PR metadata, round tracking, last reviewed SHA
  - `r<N>-<agent>.md` — findings from round N by that agent
- **Nothing is posted to GitHub during the review step**
  - Current behavior: `watch auto` and `review auto` post immediately — this must change
- `lgtm review status` shows PRs with pending findings: `#42 — 3 findings (round 1, unposted)`
- Findings include: file, line, comment, severity, `posted: false`, `discarded: false`

### R5: Human review inline on diff, then approve and post

**As a** reviewer,
**I want** to see findings on the actual diff lines and approve them selectively,
**So that** I have code context and control what gets posted.

**Acceptance Criteria:**
- **CLI path** (P0): `lgtm review show <pr>` prints the diff with findings annotated inline
- **TUI path** (P1): Review tab diff view shows findings as inline annotations with agent label
- Approve actions:
  - `lgtm review post <pr>` — post all unposted, non-discarded findings
  - `lgtm review post <pr> --dry-run` — show what would post
  - `lgtm review discard <pr> --finding <n>` — mark a finding discarded
  - TUI: `p` post finding under cursor, `x` discard, `P` post all
- Posting behavior:
  - Batched as one GitHub review by default
  - `--no-batch` posts individually with 20s–90s random delay between comments
- **After posting, the OKF file is updated**: `posted: true`, `postedAt: <iso>`, `commentId: <github-id>`
- Re-running `post` skips already-posted findings (idempotent)

### R6: Onboarding asks one question

**As a** new user,
**I want** setup to take 5 seconds,
**So that** I can start using the tool immediately.

**Acceptance Criteria:**
- Only question: **storage mode** (per-repo `.lgtm/` vs central `~/.lgtm-farm/`)
- Everything else is defaulted or auto-detected:
  - `goal`, `feedbackStyle`, `teamSize`, `qualityReferences` → removed from profile entirely (or defaulted silently)
  - AI provider → detected at review time, not during onboarding
- `lgtm init` completes in one keypress
- Removed from onboarding: AI provider question, model question, API key question, provider priority picker, tech stack detection prompt, "press q to skip" affordance
- The removed questions are filed as an issue for a future `lgtm config --advanced`

### R7: Multiple review rounds with commit detection

**As a** reviewer following up on a PR,
**I want** the watcher to notice new commits, check whether my previous findings were addressed, and review the new changes,
**So that** I don't re-flag fixed issues or miss new ones.

**Acceptance Criteria:**
- `meta.md` tracks `lastReviewedSha` and `currentRound`
- On each watcher cycle, for each watched PR already reviewed:
  - Fetch current head SHA
  - If SHA differs from `lastReviewedSha` → new commits exist
- When new commits are detected:
  1. **Verification pass**: load previously *posted* findings, ask the agent whether each is now addressed in the new diff
  2. Mark each previous finding `resolved: true|false` with a short reason
  3. **New review round**: run the review on the new diff, passing unresolved findings as context so the agent doesn't duplicate them
  4. Save as `r<N+1>-<agent>.md`, bump `currentRound`, update `lastReviewedSha`
- Rounds are identifiable: `lgtm review status` shows `#42 — round 2, 1 unresolved from round 1, 2 new findings`
- `lgtm review show <pr>` shows all rounds, marking which findings are resolved/unresolved/new

## Non-Functional Requirements

- **Storage**: everything in OKF (YAML frontmatter + markdown), respecting central/decentral mode
- **No auto-posting**: network writes only on explicit user approval
- **Process isolation**: each review agent is a separate OS process
- **Idempotent**: re-running watch/review/post never duplicates work
- **Graceful degradation**: no AI provider → clear message, tool still usable for queue/rules
- **Demo-able without secrets**: `--demo` flag and `lgtm smoke` must work with zero credentials

## Out of Scope (removed, filed as issues)

See `removals.md` in this spec directory for the full list with issue numbers.

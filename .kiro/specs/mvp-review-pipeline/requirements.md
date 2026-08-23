# MVP Review Pipeline — Requirements

## Goal

A focused tool that does exactly one thing well: **discover your repos, watch them for PRs, review those PRs with AI agents, store findings locally, let you approve them, then post to GitHub.**

Everything not serving that loop is removed and filed as an issue.

## The Loop

```
1. lgtm discover --ingest        → find local repos, accept into watcher
2. lgtm watch                    → poll every 15min (+ once on startup)
3. PR found                      → spawn review agent(s) via CLI
4. findings → ~/.lgtm-farm/      → central OKF store, nothing posted
5. lgtm review post <pr>         → creates a PENDING review on GitHub
6. you open the PR on GitHub     → edit/delete comments in the native diff UI
7. you click "Submit review"     → review goes live
8. new commits detected          → verify prior findings closed, run next round
```

**Why pending reviews:** GitHub's own diff UI is the review surface. A PENDING review
is a draft visible only to its author, with every comment anchored to the correct
line, fully editable before submission. That is strictly better than rendering a
diff in a terminal, so the tool posts a draft and gets out of the way.

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
- The user's custom prompt from `~/.lgtm-farm/agents/reviewer.md` is **appended as additional instructions**, not a replacement
- Each agent runs as a **separate child process** (`Bun.spawn`)
- Timeout per agent: 300s default (CLI reviews are slower than raw API calls)
- If a provider is unavailable, fall back to the next in priority order and log it
- `lgtm ai discover` reports which providers are available for review

### R4: Findings land in a central OKF store first

**As a** reviewer watching several repos,
**I want** one central store for all findings, with the repo always identified,
**So that** nothing goes public without my approval and I can always tell which repo a finding belongs to.

**Acceptance Criteria:**
- **Storage is always central** — `~/.lgtm-farm/`. The per-repo `.lgtm/` mode is dropped
  - Removes the `storageMode` question from onboarding entirely
  - `resolveLgtmDir()` always returns the central root, flat (no per-repo subdirectory)
- Findings written to `~/.lgtm-farm/reviews/<owner>-<repo>-<pr>/`
- Per-PR directory contains:
  - `meta.md` — PR metadata, round tracking, last reviewed SHA, pending review id
  - `r<N>-<agent>.md` — findings from round N by that agent
- **Every review artefact carries `owner`, `repo`, and `url` in its frontmatter**
- **Every command that displays findings shows the repo name**, never a bare PR number:
  - `lgtm review status` → `pszf11235/LGTM#42  round 1  3 unposted`
  - `lgtm review post pszf11235/LGTM#42` accepted, plus bare `42` when unambiguous
  - Ambiguous bare numbers (same PR number in two watched repos) → error listing the candidates
- **Nothing is posted to GitHub during the review step**
  - Current behaviour: `watch auto` and `review auto` post immediately — this must change
- Findings include: file, line, comment, severity, `posted: false`, `discarded: false`

### R5: Post as a PENDING GitHub review, edit and submit on GitHub

**As a** reviewer,
**I want** findings pushed to GitHub as a draft review I can edit before submitting,
**So that** I get GitHub's diff context for free and stay in control of what goes live.

**Acceptance Criteria:**
- `lgtm review post <repo>#<pr>` creates a **PENDING** review via
  `POST /repos/{owner}/{repo}/pulls/{n}/reviews` **with the `event` field omitted**
  - Omitting `event` is what makes it a draft. `event: "COMMENT"` submits immediately and must never be sent by the post command
  - There is no `draft: true` parameter — omission is the only mechanism
  - All comments go in the single create call; the API cannot append to an existing pending review
- The response `id` is stored as `pendingReviewId` in `meta.md`
- Output tells the user exactly where to go:
  ```
  Created pending review on pszf11235/LGTM#42 with 3 comments.
  Edit and submit: https://github.com/pszf11235/LGTM/pull/42
  ```
- `--dry-run` prints the comment payload without calling the API
- `lgtm review discard <repo>#<pr> -f <id>` marks a finding discarded so `post` skips it
- **After posting, each finding is updated**: `posted: true`, `postedAt`, `pendingReviewId`
- Re-running `post` refuses when a pending review already exists, pointing at the PR URL
  - `--recreate` deletes the existing pending review and posts a fresh one
- Findings whose `line` is not present in the PR diff are skipped with a warning rather than failing the whole call
- **Optional convenience**: `lgtm review submit <repo>#<pr>` submits the pending review via
  `POST /pulls/{n}/reviews/{review_id}/events` for users who prefer not to open the browser

**Not building:** a terminal diff renderer or TUI inline annotations. GitHub's diff view
is the review surface. Filed as issues for later if a terminal-only workflow is wanted.

### R6: Onboarding asks nothing

**As a** new user,
**I want** zero setup,
**So that** the first command I run just works.

**Acceptance Criteria:**
- **No questions at all.** Storage is always central (`~/.lgtm-farm/`), so the last remaining question is gone
- `lgtm init` creates the store, writes a default `agents/reviewer.md`, prints what it did, exits
- Everything else is defaulted or detected at the point of use:
  - AI provider → detected when a review runs, not during setup
  - GitHub token → resolved from `gh auth token`, then env vars, then `~/.lgtm-credentials`
  - `goal`, `feedbackStyle`, `teamSize`, `qualityReferences` → dropped from the profile entirely
- Removed: the storage-mode question, AI provider question, model question, API key question, provider priority picker, tech-stack detection prompt, "press q to skip" affordance
- `init` is idempotent — running it again reports the existing store and changes nothing
- The removed questions are filed for a future `lgtm config --advanced` (#140)

### R6b: GitHub token needs no registration

**As a** user,
**I want** GitHub access to work without registering an OAuth app,
**So that** I can use the tool immediately.

**Acceptance Criteria:**
- Token resolution order:
  1. `gh auth token` — shell out to the `gh` CLI (zero setup for anyone who has it)
  2. `GITHUB_TOKEN` / `GH_TOKEN` env var
  3. `~/.lgtm-credentials`
- If none resolve, print all three options with copy-pasteable commands
- `gh` invocation suppresses stderr so a missing `gh` binary produces no noise
- OAuth device flow stays out of the MVP (#84, #139). When added, one registered app's
  public client ID ships in the binary and serves every user — no per-user registration

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
- Rounds are identifiable and always repo-qualified:
  `pszf11235/LGTM#42  round 2  1 unresolved from round 1  2 new findings`
- Each round posts its own pending review, so round 2's draft contains only round 2's
  findings plus anything still unresolved from round 1
- `lgtm review list <repo>#<pr>` prints a plain text listing of all rounds and findings
  with their state — no diff rendering, just the facts

## Non-Functional Requirements

- **Storage**: everything in OKF (YAML frontmatter + markdown) in one central store at `~/.lgtm-farm/`
- **Repo attribution**: every stored artefact and every line of user-facing output that
  references a PR includes the `owner/repo`
- **No auto-posting**: the only network write is `review post`, and it creates a draft, not a live review
- **Process isolation**: each review agent is a separate OS process
- **Idempotent**: re-running watch/review/post never duplicates work
- **Graceful degradation**: no AI provider → clear message, tool still usable for queue/rules
- **Demo-able without secrets**: `--demo` flag and `lgtm smoke` must work with zero credentials
- **No shell noise**: `which` and `gh` probes suppress stderr

## Out of Scope (removed, filed as issues)

See `removals.md` in this spec directory for the full list with issue numbers.

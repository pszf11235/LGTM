# LGTM v1 requirements

Status: draft for sign-off
Date: 2026-08-29
Scope: the ground-up rebuild on the `v2` branch. This document supersedes every spec under the old `.kiro/` tree.

## Premise

AI coding agents let one developer open five PRs in an hour. A human still has to review them. LGTM watches your repositories, reviews new PRs by spawning the Claude CLI you already pay for, and writes the findings to disk. Nothing reaches GitHub until you post, and what posts is a PENDING draft review that only you can see, editable comment by comment in GitHub's own UI before you submit it there.

v1 replaces the TUI with a local web UI served by a background daemon. A native menu bar shell follows in v1.1 and is out of scope here except for the API contract it will consume.

v1 is built for one user on macOS. The repo stays public and the README stays honest, but there is no cross-platform work and no packaging polish until the tool has survived two weeks of daily use.

## Definitions

- **Forge**: a code host. v1 implements GitHub only, behind an adapter interface so GitLab and others can follow.
- **Auto-class PR**: an open PR that qualifies for review without being asked: you authored it, or you are a requested reviewer, an assignee, or @-mentioned in its title or description.
- **Triage PR**: any other open PR in a watched repo. It waits in the inbox for a manual decision: review or skip.
- **Round**: one review pass over one PR at one head SHA, by one agent.
- **Finding**: one reviewer observation with file, line, severity, comment, and optional suggestion. Findings carry their own state on disk: `open`, `discarded`, `posted`, or `held`.
- **Gate**: the human step between findings on disk and a draft review on GitHub.
- **Window**: a Claude subscription usage window (the 5-hour session window or a weekly window), reported by the CLI as a percentage used.

## R1: Watching

1. The daemon polls each watched repo for open PRs every 15 minutes by default. The interval is configurable in the store's config file, not by flags.
2. A poll cycle runs immediately at daemon start and immediately after the machine wakes from sleep.
3. The watch list is a single file, `watch.md`, keyed by `owner/repo`. There is no other repo registry.
4. You add repos manually, by typing `owner/repo` in the web UI or running `lgtm watch add owner/repo`. Disk discovery does not exist in v1.
5. Polling uses conditional requests (ETag) so unchanged repos cost no rate limit. GitHub offers no push channel a local daemon can receive without public infrastructure, so polling is the mechanism, not a placeholder for one.

## R2: PR classification and triage

1. On every cycle, each open PR is classified. Auto-class PRs are queued for review. All other PRs enter the triage inbox and wait.
2. Mention detection covers requested reviewers, assignees, and `@login` in the PR title or description. Comment scanning and the notifications API are explicit non-goals for v1.
3. A draft PR is never auto-reviewed. It is visible with a "reviews when ready" marker, and the review fires when it leaves draft state. A manual "review anyway" action overrides the hold.
4. A triage decision is `review` or `skip`. Skip is sticky. New commits do not resurrect a skipped PR, and skipped PRs stay listed under a filter with an unskip action.
5. The triage inbox shows, per PR: author, additions and deletions, files changed, age, mergeable state, and CI status for the head SHA.
6. Adding a repo backfills its open PRs into the triage inbox with the same metadata. Auto-class PRs arrive pre-selected for review, and nothing runs until the selection is confirmed. Auto-classification of new activity begins only after the repo is watched.
7. A closed or merged PR leaves the active views. Its on-disk review data is kept.

## R3: Review execution

1. v1 has one agent, the Claude CLI, spawned in print mode with its bundled review command and the user's prompt appended as additional instructions. The CLI version is pinned to 2.1.233 or later (earlier versions break bundled slash commands in print mode), and an M0 spike verifies the invocation from a directory outside any checkout before anything builds on it. The provider layer is an interface so codex and others can be added by configuration later, but no second provider ships in v1.
2. The agent prompt lives in `agents/reviewer.md` in the store, an editable markdown file with frontmatter for provider, timeout, and severity floor. Editing it changes review behavior without a restart.
3. At most 2 provider processes run at once, globally. Further work queues. Each run has a 10-minute timeout; on timeout the process is killed and partial output is salvaged.
4. The tolerant multi-strategy parser ported from the old codebase normalizes agent output. Unparseable output is preserved next to the round file as `.raw.txt` and surfaces as a failed round, never as silently missing findings.
5. A PR is not marked reviewed when its round failed. The next cycle retries it, up to 3 attempts per head SHA.
6. When a reviewed PR gets new commits, the daemon runs a fresh round and injects the prior rounds' findings as "already raised, do not repeat" context. There is no verification pass over posted findings in v1.
7. The review step and the watch step never write to GitHub.

## R4: Quota gating

1. Before dispatching a review, and on a background timer, the daemon reads real subscription usage via `claude -p "/usage"`, which is non-interactive and consumes no tokens or turns.
2. The gate pauses new dispatches when the highest reported window percentage exceeds `pause_above_pct` (default 70) and resumes below `resume_below_pct` (default 60), or when a parsed window reset time passes. Queued work is kept, not dropped.
3. When the usage output cannot be parsed (for example after a CLI update), the gate degrades to a hard daily run cap (default 20), and every gating decision logs which mode produced it. Richer local estimation is deferred.
4. Quota state, mode, and any pause are always visible in the UI status area, and the first pause of a window fires a notification.

## R5: Findings and the gate

1. The findings view lists PRs with ungated findings, and per PR shows each finding as a card: severity, file and line, agent, comment, suggestion, and the surrounding diff hunk sliced server-side from the PR diff. Each card links to the file and line on GitHub.
2. Discarding a finding flips its state in the round file's frontmatter. It is reversible and the finding remains on disk.
3. There is no full diff viewer in v1. The hunk on the card plus the GitHub link is the reading surface before posting; GitHub's own UI is the surface after.

## R6: Posting

1. Posting collects the PR's open findings and creates one PENDING draft review on GitHub: `POST /repos/{owner}/{repo}/pulls/{n}/reviews` with a body and line comments and no `event` key. The response must come back in `PENDING` state or the operation fails loudly.
2. The new codebase contains zero code paths that can publish a review. There is no submit command and no function that sends an `event` field. Submission happens in GitHub's UI. Tests assert this, as in the old codebase, and the absence of any event-sending function to guard strengthens it.
3. Before posting, every finding's line is validated against the current diff, re-fetched at post time. Findings whose line no longer exists are marked `held` with a reason, disclosed in the review body, and retried automatically at the next post. GitHub rejects the whole request if one comment misses, so validation is a precondition, not politeness. When zero findings validate, the post aborts before any GitHub call.
4. The post flow shows a confirm pane first: the auto-generated review body (finding counts by severity, agent attribution, held-back disclosure) rendered from an editable template at `templates/review-body.md`, editable inline before sending.
5. One pending review per PR at a time. Posting over an existing draft is refused; a recreate action deletes the old draft and posts fresh, because the REST API cannot append to a pending review. When the recorded draft was already submitted or deleted on GitHub, LGTM detects that and clears its record instead of refusing forever.
6. After posting, the UI shows per-finding results (posted, held with reason) and a link that opens the pending review on GitHub.
7. A dry-run mode prints the exact request without writing to GitHub or to the store.

## R7: Daemon and lifecycle

1. Everything ships as one Bun-compiled binary, `lgtm`. `lgtm up` runs the daemon in the foreground; `lgtm install` writes and bootstraps a launchd LaunchAgent so the daemon survives reboots and crashes; `lgtm uninstall` removes it.
2. The HTTP server binds 127.0.0.1 only. All `/api/*` routes require a bearer token generated at first run and stored with mode 0600. `lgtm open` launches the browser with the token in the URL fragment; the SPA stores it locally and strips it from the URL. Host and Origin checks reject DNS-rebinding and cross-site requests.
3. The daemon resolves absolute paths to `claude` and `gh` at startup via a login-shell probe, caches them, re-probes when a spawn fails, and exposes the results in the status API. launchd gives daemons a bare PATH; this is a correctness requirement, not polish. A manual path override exists in settings for installs the probe cannot see.
4. `lgtm status` reports daemon liveness, last cycle, queue, and quota from the API, and exits non-zero when the daemon is down.
5. On a port conflict the daemon probes the occupant's health endpoint to distinguish a stale LGTM instance from a foreign process, then scans a small port range.
6. GitHub auth resolves in order: `GITHUB_TOKEN` or `GH_TOKEN`, then `gh auth token` with stderr discarded, then a saved credential file. Missing auth produces guidance, not a stack trace.

## R8: Notifications

1. The daemon fires native macOS notifications for exactly four events: findings ready for gating, a new PR in triage, a watcher error that needs the user (dead token, missing or failing CLI), and a quota pause.
2. Errors notify once per distinct cause, not once per cycle.
3. If findings sit ungated for 4 hours, one reminder fires. No other repeats.
4. Notifications are best-effort: terminal-notifier with a deep link into the web UI when available, osascript otherwise, silence when neither works. An open browser tab additionally receives live updates over SSE.

## R9: Store

1. The store lives at `~/.lgtm-farm/` as markdown files with YAML frontmatter, human-readable and greppable. Review data is under `reviews/<owner>/<repo>/pr-<n>/` with a `meta.md` and per-round `r<N>-<agent>.md` files.
2. The old flat store layout is ignored. There is no migration; old review dirs simply stop being read.
3. Finding identity is scoped `r<N>:<agent>:<id>`, for example `r2:reviewer:f1`, because ids restart per round file. Any state change addresses a finding by its full key.
4. Only the daemon writes the store. UI and CLI mutate through the API. The daemon watches the store directory so hand-edits made in an editor are picked up and broadcast to the UI.
5. Removing a repo from the watch list keeps its on-disk reviews; its PRs leave the active views. Re-adding reconciles against the existing files, so known PRs keep their state and backfill lists only unknown ones.

## R10: Web UI

1. The SPA is embedded in the binary and served by the daemon. It is built with React and shadcn/ui components so nearly all UI is assembled from stock parts.
2. Views: an inbox (triage PRs and PRs with ungated findings), a PR detail view (findings cards, gate actions, post flow), a repos view (watch list, add and remove, backfill confirm), and a settings and status view (provider and auth detection, quota, paths, daemon health).
3. The UI is a stateless view over the API, refreshed by SSE events. Closing the tab affects nothing.

## Non-goals for v1

Cut deliberately, most of them for the second time. Do not re-add without a spec:

- The TUI, and any terminal diff rendering
- Verification passes over posted findings (verdicts)
- A second review agent, multi-agent orchestration, cross-agent dedup
- Disk discovery of repos, ingest registries
- The rules engine, rule import and export, repo-wide scan
- Submitting reviews from LGTM
- Plugin architecture, queue and approve workflow, dashboards, attention system
- OAuth flows and multi-service auth
- Cross-repo review, GitLab and other forges (the adapter boundary exists; implementations do not)
- Webhook or relay based event delivery

## v1.1 preview (contract only)

A signed Swift MenuBarExtra shell, roughly 300 lines, polls `GET /api/status` and renders watcher health (greyed icon within 30 seconds of daemon death), the count of PRs awaiting gate or triage, the last cycle time, and menu actions to open the UI and stop the daemon through launchctl. v1 designs the read contract from day one; mutating tray actions such as pause ship with v1.1 endpoints of their own.

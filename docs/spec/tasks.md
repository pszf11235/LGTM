# LGTM v1 tasks

Status: draft for sign-off
Date: 2026-08-29
Order matters. Each milestone leaves the branch green (typecheck + tests) and ends with something runnable. Dogfooding starts at M4, not at the end.

## M0: Clean slate

- [ ] Upgrade Bun to current stable (>= 1.3.13 required; machine has 1.2.18)
- [ ] Spike: run the Claude CLI's bundled review command in print mode against a full PR URL from a directory outside any checkout, on the pinned CLI version (>= 2.1.233), and confirm the findings survive the parser. The provider design depends on this result
- [ ] Branch `v2` from `main`
- [ ] First commit: remove everything except `LICENSE` and `.gitignore`. This includes all of `.kiro/`, the old packages, webapp, and Taskfile; new `.gitignore` entries keep the untracked clutter (built binaries, demo videos, `.bun-build` artifacts) out from then on
- [ ] Second commit: `docs/spec/` (these three files), a stub `README.md` stating what is being built and pointing at the spec
- [ ] Scaffold: `bun init --react=shadcn`, restructure into `src/` (core, forge, provider, store, daemon, api, ui), wire `build.ts` with `Bun.build()` + Tailwind plugin + compile, CI workflow: typecheck, test, build binary, `--version` smoke run

Exit: `bun run build.ts` produces a styled hello-world binary serving the SPA shell on 127.0.0.1.

## M1: Domain port

- [ ] Port `okf.ts` (frontmatter + clone guard) and its 8 tests
- [ ] Port `pr-ref.ts` and its 19 tests
- [ ] Port `diff-parser.ts` with its 28 tests; add hunk slicing (given a file and line, return the surrounding hunk lines) with tests
- [ ] Implement the new store layout (`src/store/reviews.ts`): meta.md and round files per design; adapt the 44 review-store tests; keep the `round:agent:id` finding-key rules and their regression tests
- [ ] Implement `watch.md` and `config.md` read/write with defaults

Exit: store round-trips reviews, findings, and config on disk; all ported tests green.

## M2: Forge and provider

- [ ] `ForgeAdapter` interface; GitHub implementation ported from `infra/github.ts` (13 tests) plus ETag support on `listOpenPRs` and `getReview` for pending-draft reconciliation
- [ ] Draft-review module ported from `pending-review.ts` with submit removed; tests assert no `event` key, PENDING-or-throw, refuse-empty-comments, and that no exported function can publish
- [ ] Token resolution chain (env, `gh auth token`, credentials file) with the silent-stderr test
- [ ] Provider interface; claude implementation with the spawn/timeout/salvage `run()` pattern, prompt assembly (including do-not-repeat context), `extractFindings` + `validateFindings` ported with their tests
- [ ] Login-shell PATH probe with cache, ENOENT re-probe, and manual override; unit tests with a fake shell
- [ ] Fake `claude` shim for the offline harness (fixture findings, configurable failure modes)

Exit: with the shim on PATH, a script can review a fixture PR end to end into the store, offline.

## M3: Daemon

- [ ] Scheduler: boot cycle, 15-minute jittered timer, in-flight overlap guard, wake catch-up
- [ ] Poll cycle + classifier per design (auto-class, triage, draft hold and draft-to-ready transition, sticky skip, closed and reopen handling, failed-round retry with the 3-attempt cap, pending-review reconciliation via `getReview`); adapt the 18 `decidePR` tests to the triage model
- [ ] Review queue with global concurrency 2, one entry per PR with latest-SHA-wins; failed rounds leave the PR retryable
- [ ] Diff snapshot per reviewed SHA written into the PR dir at round completion (the hunk-slicing source)
- [ ] Quota gate: `/usage` probe, parser, ok/throttled/fallback state machine, daily-cap counter, mode logging; tests with canned CLI outputs including unparseable ones
- [ ] Backfill: on watch add, fetch open PRs with triage metadata, compute pre-selection
- [ ] Event bus + notifier (terminal-notifier, osascript fallback, dedup rules, 4-hour reminder)
- [ ] `daemon.json` rendezvous, pid lock with stale-pid recovery (rewrite the file and reset `queued`/`reviewing` metas at boot), port scan with health-probe handshake

Exit: `lgtm up` against a real repo (or the shim) watches, classifies, reviews, and notifies; nothing touches GitHub write APIs.

## M4: API and UI read path

- [ ] HTTP API: health, status (the tray contract), events (SSE), prs, decision (review, skip, unskip, review-anyway), findings with sliced hunks; bearer auth, Host and Origin checks
- [ ] CLI clients: `lgtm status` (non-zero when down), `lgtm open` (token fragment handoff), `lgtm watch add|rm|ls`
- [ ] SPA: inbox and PR detail views read-only, SSE-driven refresh, empty states with watcher health
- [ ] Repos view with add flow and backfill confirm pane (one decision call per selected PR)

Exit: dogfooding begins. Watch this repo and one work repo; read real findings in the browser.

## M5: The gate

- [ ] Inbox decision buttons (skip, review, unskip, review-anyway) and the skipped section
- [ ] Discard and restore on finding cards (PATCH by full finding key)
- [ ] Validate endpoint and post flow: confirm pane with editable rendered body, held-back list, per-finding results, recreate path (flips posted findings back to open), dry run, zero-valid abort
- [ ] `templates/review-body.md` shipped default
- [ ] Settings view: detection results, path pins, quota thresholds, interval, daemon info

Exit: full loop live: notification, gate in browser, PENDING draft on GitHub, submit in GitHub's UI.

## M6: Lifecycle and release

- [ ] `lgtm install` / `uninstall` (launchd plist, bootstrap, kickstart, bootout)
- [ ] `fs.watch` on the store with SSE invalidation
- [ ] Regression checklist from the old audit encoded as tests (see design, Testing)
- [ ] README rewritten for what v1 actually is; TESTING.md for the offline harness
- [ ] Release workflow: darwin-arm64 binary + checksum on GitHub Releases

Exit: daemon survives reboot; a fresh machine could install from the release page.

## Dogfood gate (before any v1.1 work)

Two weeks of daily use, then review:

- [ ] Did the quota gate ever block your interactive work, or fail to?
- [ ] Were mentions missed (tier-b detection needed)?
- [ ] Did skipped PRs need resurrection on new commits?
- [ ] Is the pinned-tab notification gap painful enough to justify the tray now?
- [ ] What died silently, and would the tray have caught it?

## v1.1 (after the gate)

- [ ] Swift MenuBarExtra shell against `/api/status` (design's tray contract)
- [ ] codex CLI as a second provider entry
- [ ] Whatever the dogfood review promoted

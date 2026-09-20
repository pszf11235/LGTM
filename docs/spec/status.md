# LGTM v1 build status

Companion to [design.md](design.md) and [requirements.md](requirements.md).
[tasks.md](tasks.md) is the milestone plan the build followed; it's marked
complete now, and this document is the one to read for what the result
actually does.

This branch has more than one agent working on it at once. The specifics
below are a snapshot, not a promise about tomorrow's commit.

## Where things stand

As of this writing, `bun test` reports 1126 passing tests across 40 files,
3129 assertions, in under 10 seconds. `bunx tsc --noEmit` is clean under
`strict` plus `noUncheckedIndexedAccess`. `bun run build.ts` produces a
`dist/lgtm` binary that runs and answers `--version`. Run the suite yourself
for the current numbers; they move every time a task lands.

The daemon has run against real GitHub: it authenticated, listed real open
pull requests, and reviewed real PRs end to end, writing real findings to the
store. It is one person's tool, run so far by nobody but its author.

## Done

- **M0, clean slate.** The Bun scaffold, `build.ts`'s `Bun.build()` compile step with the Tailwind plugin, and CI (`.github/workflows/ci.yml`: typecheck, test, build, then a `--version` smoke run of the compiled binary).
- **M1, domain port.** `okf.ts`'s frontmatter round trip and its `structuredClone` guard, `pr-ref.ts`, the diff parser plus hunk slicing for finding cards, the new store layout (`meta.md`, per-round files, the `r<N>:<agent>:<id>` finding key), and `watch.md` / `config.md` read and write with their documented defaults.
- **M2, forge and provider.** The GitHub `ForgeAdapter` with ETag support on the list and review-reconciliation calls, the draft-review module (no `event` key, throws unless the response is `PENDING`, refuses an empty comment list, and exposes no function that could publish), the GitHub token resolution chain, the Claude provider's spawn/timeout/salvage loop and prompt assembly, the login-shell PATH probe with its manual-pin override, and the fake `claude` shim at `test/fixtures/fake-claude.ts` (see [TESTING.md](../../TESTING.md)).
- **M3, daemon, as modules.** The scheduler, poll cycle and classifier, review queue, quota gate, backfill, diff snapshotting, and notifier are each built and tested standalone. `createDaemon` (`src/daemon/boot.ts`) assembles all of them into one running daemon and has its own boot-sequence tests covering the lock, the binary probe order, and the rendezvous file. `lgtm up` runs it, and a booted daemon creates its store, binds loopback, serves the UI and the API, polls on its schedule, and shuts down cleanly on a signal.
- **M4, API read path.** Every read route in design.md's HTTP API table (`health`, `status`, `events`, `prs`, `prs/.../findings`, `watchlist`, `config`) is defined and mounted in the live route table (`src/api/routes.ts`), with a test matrix that walks the table and asserts bearer, Host, and Origin checks on every entry. `lgtm status`, `lgtm open`, and `lgtm watch add|rm|ls` are real implementations against that API, not stubs.
- **M5, the gate.** `src/api/post.ts` and `src/ui/views/PostPane.tsx` carry the full post flow: the validate endpoint, discard and restore by full finding key (`r2:reviewer:f1`, never a bare id), the confirm pane with an editable body rendered from `templates/review-body.md` (`src/store/templates.ts`), the recreate path, the zero-valid abort, and dry run. The Settings view is real and reads the same detection results the daemon logs. The loop this milestone promised, notification through a `PENDING` draft on GitHub, is wired end to end; see [What remains unproven](#what-remains-unproven) for what wiring alone can't settle.
- **M6, lifecycle and release.** `lgtm install` and `lgtm uninstall` write and bootstrap a real launchd plist and have their own tests (`src/cli/install.ts`, `src/cli/install.test.ts`). The store watcher (`src/daemon/store-watch.ts`) runs `fs.watch` on `~/.lgtm-farm` and pushes SSE invalidation, so a hand-edited file shows up in the UI without a restart. The release workflow (`.github/workflows/release.yml`) builds the darwin-arm64 binary and a checksum on a version tag. The seven-item regression checklist from design.md's testing section is encoded as tests, one `describe` block per item, in `src/regression.test.ts` (see [TESTING.md](../../TESTING.md)).
- **End-to-end journeys**, beyond any single milestone. `test/e2e/` boots a real daemon (`createDaemon`, the same assembly `lgtm up` runs) against a fake GitHub on a real loopback socket and the fake Claude shim, and drives nine journeys, seventeen tests, through watching, classifying, reviewing, gating, and posting. It's mutation-checked: six of the seventeen mutations first run against these tests survived, because the journey they broke only walked the cooperating path. See [test/e2e/README.md](../../test/e2e/README.md).

## What's wired

The seams that parallel work leaves behind are closed. `lgtm up` starts the
daemon, the real API router and the SPA are mounted on the port it binds,
`App.tsx` renders the Reviews, PR detail, Repos, and Settings views,
`postRoutes()` is spliced into the route table, the post pane is mounted in
the PR detail view, and the store watcher runs with the daemon.

## What remains unproven

Wiring settles whether the pieces are connected. It doesn't settle these.

- **Whether a draft review has landed on a real GitHub pull request, and been submitted there by a human, is unconfirmed.** The daemon has reviewed real PRs end to end and written real findings to the store. The post flow itself is built and is exercised end to end against a fake GitHub in `test/e2e/`. Nobody has yet watched a `PENDING` review appear on a real PR and submitted it in GitHub's own UI. That's still ahead.
- **The keyboard shortcuts in design.md's Web UI section are not bound.** `j`/`k` between cards, `d` to discard, `enter` to confirm. They need a document-level listener that no view owns, and the render harness has no DOM to exercise it with.
- **`src/ui/api.ts` still carries its own `validate` and `post` methods** (`src/ui/api.ts:582-583`), written before `src/api/post.ts` existed and parsing shapes it does not send. `src/ui/actions.ts` is the client the gate actually uses. The stale pair should go, so the gate has one client rather than two.

## Known gaps, by design or by an open seam

These are not bugs waiting for a fix. Each is a deliberate trade-off or a limit the code already works around; they're recorded here so nobody re-discovers them the hard way.

- **No verification pass over posted findings.** Ruled out for v1 by requirements.md R3.6 and the non-goals list, not an oversight. A fresh round on new commits gets prior findings as "already raised, do not repeat" context, but nothing re-checks whether an old finding still holds once it's been posted.
- **A mid-review head move loses that round's diff snapshot.** `ForgeAdapter.getDiff` only returns a PR's *current* head diff; there's no way to ask GitHub for the diff at an arbitrary earlier SHA. A review takes minutes (the M0 spike measured 5m44s for a two-file PR), so `src/daemon/snapshot.ts` checks the live head immediately before and immediately after fetching, and writes nothing if it moved either time. The finding card falls back to a GitHub link when that happens; it's a known, handled state, not a crash, but an active PR can lose its inline diff hunks on the card mid-review.
- **`watch.md` takes two read-modify-write passes per repo per cycle.** `recordPoll` in `src/daemon/cycle.ts` calls `updateLastPolledAt`, then, only if the ETag changed, `updateETag`; each is its own full load and save of the file (`src/store/watch-list.ts`). Harmless at the size of a personal watch list, but it's two write windows instead of one, and a crash between them would leave a stale ETag next to a fresh poll timestamp.
- **The close pass reads one file per known-closed PR, every cycle, forever.** `closeMissingPR` in `src/daemon/cycle.ts` calls `loadMeta` for every locally-known PR no longer in the repo's open list, checks `closedAt`, and returns once it finds the PR already marked closed. There's no memory of "already handled this one", so a repo's entire history of merged PRs gets re-read on every poll indefinitely. Fine at personal scale; a real cost if the store ever holds thousands of closed PRs for one repo.

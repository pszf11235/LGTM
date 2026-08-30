# LGTM v1 build status

Companion to [design.md](design.md), [requirements.md](requirements.md), and [tasks.md](tasks.md). Written from what the code and its tests actually do, not from tasks.md's checkboxes, which are still all unchecked even though most of the milestones below have landed. Treat this document, not that one, as the record of what's actually built.

This branch has more than one agent working on it at once. The specifics below are a snapshot, not a promise about tomorrow's commit.

## Where things stand

As of this writing, `bun test` reports 991 passing tests across 36 files, 2459 assertions, in under 10 seconds. `bunx tsc --noEmit` is clean under `strict` plus `noUncheckedIndexedAccess`. `bun run build.ts` produces a `dist/lgtm` binary that runs and answers `--version`. Run the suite yourself for the current numbers; they move every time a task lands.

## Done

- **M0, clean slate.** The Bun scaffold, `build.ts`'s `Bun.build()` compile step with the Tailwind plugin, and CI (`.github/workflows/ci.yml`: typecheck, test, build, then a `--version` smoke run of the compiled binary).
- **M1, domain port.** `okf.ts`'s frontmatter round trip and its `structuredClone` guard, `pr-ref.ts`, the diff parser plus hunk slicing for finding cards, the new store layout (`meta.md`, per-round files, the `r<N>:<agent>:<id>` finding key), and `watch.md` / `config.md` read and write with their documented defaults.
- **M2, forge and provider.** The GitHub `ForgeAdapter` with ETag support on the list and review-reconciliation calls, the draft-review module (no `event` key, throws unless the response is `PENDING`, refuses an empty comment list, and exposes no function that could publish), the GitHub token resolution chain, the Claude provider's spawn/timeout/salvage loop and prompt assembly, the login-shell PATH probe with its manual-pin override, and the fake `claude` shim at `test/fixtures/fake-claude.ts` (see [TESTING.md](../../TESTING.md)).
- **M3, daemon, as modules.** The scheduler, poll cycle and classifier, review queue, quota gate, backfill, diff snapshotting, and notifier are each built and tested standalone. `createDaemon` (`src/daemon/boot.ts`) assembles all of them into one running daemon and has its own boot-sequence tests covering the lock, the binary probe order, and the rendezvous file. `lgtm up` runs it, and a booted daemon creates its store, binds loopback, serves the UI and the API, polls on its schedule, and shuts down cleanly on a signal.
- **M4, API read path.** Every read route in design.md's HTTP API table (`health`, `status`, `events`, `prs`, `prs/.../findings`, `watchlist`, `config`) is defined and mounted in the live route table (`src/api/routes.ts`), with a test matrix that walks the table and asserts bearer, Host, and Origin checks on every entry. The two mutating routes this milestone also needs, `decision` and the findings `PATCH`, are mounted and tested too. `lgtm status`, `lgtm open`, and `lgtm watch add|rm|ls` are real implementations against that API, not stubs.
- **M6, partially.** `lgtm install` and `lgtm uninstall` write and bootstrap a real launchd plist and have their own tests (`src/cli/install.ts`, `src/cli/install.test.ts`). The release workflow (`.github/workflows/release.yml`) builds the darwin-arm64 binary and a checksum on a version tag. The seven-item regression checklist from design.md's testing section is encoded as tests, one `describe` block per item, in `src/regression.test.ts` (see [TESTING.md](../../TESTING.md)).

## Not wired yet

The seams that parallel work leaves behind are closed. `lgtm up` starts the
daemon, the real API router and the SPA are mounted on the port it binds,
`App.tsx` renders the four views, `postRoutes()` is spliced into the route
table, the post pane is mounted in the PR detail view, and the store watcher
runs with the daemon.

What remains unproven is the part no amount of wiring settles.

- **No review has ever run against a real pull request.** The daemon has been
  booted against a live GitHub token and a real repository: it authenticated,
  listed open pull requests, and wrote the watch list. That repository had no
  open PRs, so nothing has yet been classified, queued, reviewed, or posted.
  The first real round, and the first draft review, are still ahead.
- **The keyboard shortcuts in design.md's Web UI section are not bound.**
  `j`/`k` between cards, `d` to discard, `enter` to confirm. They need a
  document-level listener that no view owns, and the render harness has no DOM
  to exercise it with.
- **`src/ui/api.ts` still carries its own `validate` and `post` methods**,
  written before `src/api/post.ts` existed and parsing shapes it does not
  send. `src/ui/actions.ts` is the client the gate actually uses. The stale
  pair should go, so the gate has one client rather than two.

## Known gaps, by design or by an open seam

These are not bugs waiting for a fix. Each is a deliberate trade-off or a limit the code already works around; they're recorded here so nobody re-discovers them the hard way.

- **No verification pass over posted findings.** Ruled out for v1 by requirements.md R3.6 and the non-goals list, not an oversight. A fresh round on new commits gets prior findings as "already raised, do not repeat" context, but nothing re-checks whether an old finding still holds once it's been posted.
- **A mid-review head move loses that round's diff snapshot.** `ForgeAdapter.getDiff` only returns a PR's *current* head diff; there's no way to ask GitHub for the diff at an arbitrary earlier SHA. A review takes minutes (the M0 spike measured 5m44s for a two-file PR), so `src/daemon/snapshot.ts` checks the live head immediately before and immediately after fetching, and writes nothing if it moved either time. The finding card falls back to a GitHub link when that happens; it's a known, handled state, not a crash, but an active PR can lose its inline diff hunks on the card mid-review.
- **`watch.md` takes two read-modify-write passes per repo per cycle.** `recordPoll` in `src/daemon/cycle.ts` calls `updateLastPolledAt`, then, only if the ETag changed, `updateETag`; each is its own full load and save of the file (`src/store/watch-list.ts`). Harmless at the size of a personal watch list, but it's two write windows instead of one, and a crash between them would leave a stale ETag next to a fresh poll timestamp.
- **The close pass reads one file per known-closed PR, every cycle, forever.** `closeMissingPR` in `src/daemon/cycle.ts` calls `loadMeta` for every locally-known PR no longer in the repo's open list, checks `closedAt`, and returns once it finds the PR already marked closed. There's no memory of "already handled this one", so a repo's entire history of merged PRs gets re-read on every poll indefinitely. Fine at personal scale; a real cost if the store ever holds thousands of closed PRs for one repo.

## Reading this alongside tasks.md

tasks.md's checkboxes are all unchecked. That's the file falling behind the work, not a sign the work didn't happen; this document is the one to trust.

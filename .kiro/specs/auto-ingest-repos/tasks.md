# Auto-Ingest Repos — Implementation Tasks

> **Status: shipped** in [#116](https://github.com/pszf11235/LGTM/pull/116).
> 
> `lgtm discover --ingest` and the Repos page.

## Task 1: Build the repo scanner
- [ ] Create `packages/core/src/registry/scanner.ts`
- [ ] Implement `scanForRepos(opts)` as async generator
- [ ] Walk filesystem finding `.git/` directories (respect maxDepth, excludes)
- [ ] Default scan roots: `~/projects`, `~/dev`, `~/code`, `~/repos`, `~/src`, `~/work`, cwd
- [ ] Progress callback: `onProgress(found: number, scanning: string)`
- [ ] Tests: finds repos in temp directory structure, respects depth/excludes

## Task 2: Enrich scanned repos with metadata
- [ ] Read `.git/config` to extract remote origin URL
- [ ] Parse remote URL via `parseGitUrl()` → owner, repo, platform
- [ ] Get last commit date: `git log -1 --format=%aI` (spawn per repo)
- [ ] Detect primary language (count file extensions in top-level)
- [ ] Detect monorepo (package.json workspaces, go.work, Cargo workspace)
- [ ] Return `ScannedRepo` objects with all metadata populated
- [ ] Tests: enrichment of real git repos, handles repos with no remote

## Task 3: Reconcile against registry (prune + status)
- [ ] Extend `RegistryEntry` interface with `status: "active" | "denied" | "removed"`
- [ ] On ingest: load registry, compare against scan results
- [ ] Identify new repos (on disk but not in registry)
- [ ] Identify removed repos (in registry but path no longer exists)
- [ ] Auto-prune: remove deleted repos from watch list and registry
- [ ] Show warning for removed repos: "⚠ N repos no longer found on disk"
- [ ] Mark watched repos: cross-reference with `watch.md` to show 👁 indicator
- [ ] `--prune` flag to only clean up without full interactive picker
- [ ] Tests: reconciliation logic, prune removes from watch, idempotent

## Task 4: Interactive CLI picker with watched status
- [ ] Add `--ingest` flag to `lgtm discover` command (triggerable any time)
- [ ] Display repos grouped by parent directory with status indicators:
  - `👁` = currently watching
  - `✦` = new (needs decision)
  - `○` = previously skipped/denied
  - `⚠` = removed from disk
- [ ] Keyboard input: `[a]` accept, `[s]` skip, `[w]` unwatch, `[A]` accept all new, `[q]` done
- [ ] On accept: register with `status: active` + add to watch
- [ ] On deny: register with `status: denied`
- [ ] On unwatch: remove from watch list, keep in registry as `denied`
- [ ] Re-accept previously denied repos (status flips to active)
- [ ] Final summary: "Watching N repos. Added M new. Removed K stale."
- [ ] Tests: picker state transitions, accept/deny/unwatch

## Task 5: Smart recommendations and filtering
- [ ] Sort repos: recent activity first, GitHub/GitLab over local-only
- [ ] Add `--recommended` flag: auto-accept all repos with activity < 7 days
- [ ] Add `--new-only` flag: only show repos needing a decision (hide watched/denied)
- [ ] Add `--all` flag: show everything including denied (for re-review)
- [ ] Badge display: ✦ (recommended), stale label (>90 days)
- [ ] Tests: sorting logic, recommendation threshold, flag filtering

## Task 6: TUI Dashboard integration
- [ ] Add "New repos found" indicator to Dashboard page header
- [ ] On click/Enter: show inline picker (same accept/deny UX)
- [ ] Show watched repos with 👁 in the list
- [ ] Accepted repos immediately appear in watch list
- [ ] Removed repos show a warning notification
- [ ] Background scan on TUI launch (non-blocking)

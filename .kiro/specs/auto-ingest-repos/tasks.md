# Auto-Ingest Repos — Implementation Tasks

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

## Task 3: Interactive CLI picker
- [ ] Add `--ingest` flag to `lgtm discover` command
- [ ] After scan, filter out already-registered repos (check registry)
- [ ] Display repos grouped by parent directory
- [ ] Mark "recommended" (activity < 7 days) and "stale" (> 90 days)
- [ ] Keyboard input: `[a]` accept, `[s]` skip, `[A]` accept all recommended, `[q]` done
- [ ] On accept: register in `~/.lgtm-registry.md` + add to watch
- [ ] On deny: register with `status: denied`
- [ ] Final summary: "Added N repos. Skipping M."

## Task 4: Registry status tracking
- [ ] Extend `RegistryEntry` interface with `status: "active" | "denied" | "stale"`
- [ ] Update `registerRepo()` to set status
- [ ] Add `denyRepo(path)` function
- [ ] On re-run: filter out repos already in registry (unless `--all` flag)
- [ ] Tests: idempotent registration, denied repos hidden on re-run

## Task 5: Smart recommendations
- [ ] Sort repos: recent activity first, GitHub/GitLab over local-only
- [ ] Add `--recommended` flag: auto-accept all repos with activity < 7 days
- [ ] Badge display in picker: ✦ (recommended), ⚠ (stale), ✓ (already tracked)
- [ ] Tests: sorting logic, recommendation threshold

## Task 6: TUI Dashboard integration
- [ ] Add "New repos found" indicator to Dashboard page header
- [ ] On click/Enter: show inline picker (same accept/deny UX)
- [ ] Accepted repos immediately appear in watch list
- [ ] Scan runs in background on TUI launch (non-blocking)

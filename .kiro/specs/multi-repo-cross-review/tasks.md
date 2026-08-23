# Multi-Repo Cross-Review — Implementation Tasks

> **Status: not implemented.**
> 
> Specified alongside `auto-ingest-repos` in [#115](https://github.com/pszf11235/LGTM/pull/115), but only the auto-ingest half was built. Nothing in
> `packages/` implements cross-repo review. Kept as a design record for what the
> multi-repo story would look like, not as work in progress.

## Task 1: Extend queue to store repo context
- [ ] Add `repo?: string` and `repoShort?: string` to `QueuedPR` interface in `domain/types.ts`
- [ ] Update `queue.ts` → `addToQueue()` to accept repo info from PR ref
- [ ] Update queue serialization (OKF write/read) to persist repo field
- [ ] Update `review add` command to resolve PRs via `parsePRRef()` + registry lookup
- [ ] Tests: queue with mixed-repo PRs serializes and loads correctly

## Task 2: Multi-repo PR resolution in `review add`
- [ ] Update `commands/add.ts` to parse each arg through `parsePRRef()`
- [ ] Resolve short refs (`repo#42`) via registry → find owner from git remote
- [ ] Resolve full refs (`owner/repo#42`) directly
- [ ] Fetch PR metadata from correct repo (pass owner/repo to GitHub adapter)
- [ ] Error handling: "repo not found in registry — use full format: owner/repo#42"
- [ ] Tests: resolution chain (plain number → short → full format)

## Task 3: Cross-repo overlap detection
- [ ] Add `crossRepoPatterns` config option to `.lgtmrc.yaml` schema
- [ ] Default patterns: `types/`, `proto/`, `*.graphql`, `openapi.*`, `shared/`
- [ ] Extend `overlap.ts` → `detectOverlaps()` to compare cross-repo file paths against patterns
- [ ] New function: `detectCrossRepoContracts(prs)` → returns contract-level overlaps
- [ ] Suggest review order based on dependency direction (contract definer first)
- [ ] Tests: cross-repo overlap with shared type files

## Task 4: Global rules support
- [ ] Add `globalRulesDir` to config resolution (defaults to `~/.lgtm-farm/rules/`)
- [ ] Update `rules.ts` → `loadRules()` to accept multiple directories
- [ ] Implement `mergeRules(local, global)` — local wins on same ID
- [ ] Add `--global` flag to `lgtm review rule add`
- [ ] Update `lgtm review rule list` to show source column (local/global)
- [ ] Tests: rule merge priority, global rule creation

## Task 5: Multi-repo status display
- [ ] Update `review status` CLI output to show `Repo` column when multi-repo
- [ ] Update `QueuePage.tsx` TUI to show repo labels
- [ ] Group by repo in display (with cross-repo groups spanning repos)
- [ ] Color-code repos for visual distinction

## Task 6: Cross-repo report aggregation
- [ ] Update `review report` to aggregate watched repos
- [ ] Add `--repo <filter>` flag to narrow results
- [ ] Show per-repo summary + overall totals
- [ ] Tests: report with multiple repos

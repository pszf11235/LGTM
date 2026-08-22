# Multi-Repo Cross-Review — Design

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                    Review Queue                          │
│  ┌─────────────────┐  ┌─────────────────────────────┐  │
│  │ PR #42 (current)│  │ PR #108 (org/backend)       │  │
│  │ PR #10 (current)│  │ PR #5  (org/shared-types)   │  │
│  └─────────────────┘  └─────────────────────────────┘  │
├─────────────────────────────────────────────────────────┤
│              Cross-Repo Overlap Engine                   │
│  - Shared file pattern matching (types/, proto/, api)   │
│  - Contract dependency detection                        │
│  - Review order suggestion                              │
├─────────────────────────────────────────────────────────┤
│                  Rules Resolution                        │
│  ~/.lgtm-farm/rules/ (global) + .lgtm/rules/ (local)   │
│  Priority: local > global (same ID = override)          │
├─────────────────────────────────────────────────────────┤
│               GitHub Multi-Repo Adapter                  │
│  - Resolves owner/repo from registry or input           │
│  - Fetches diffs per-repo (parallelized)                │
│  - Posts reviews back to correct repo                   │
└─────────────────────────────────────────────────────────┘
```

## Key Design Decisions

### 1. PR Resolution Chain

When user types `lgtm review add repo-name#42`:
1. Check registry (`~/.lgtm-registry.md`) for a repo named `repo-name` → extract owner from git remote
2. If not in registry, try `{current-owner}/repo-name` (same org assumption)
3. If full format `owner/repo#42`, use directly
4. Plain number `42` → current repo (existing behavior)

Uses existing `parsePRRef()` and `resolvePRRef()` from `domain/multi-repo.ts`.

### 2. Cross-Repo Overlap Detection

Extend the existing `overlap.ts` engine:
- Current: compares `filesChanged` paths within one repo
- New: also compare across repos using **contract file patterns**:
  - `**/types/**`, `**/proto/**`, `**/*.graphql`, `**/openapi.*`
  - Configurable via `.lgtmrc.yaml` → `review.crossRepoPatterns`
- When file `shared-types/user.ts` changes in repo A, and repo B imports from `@shared/types`, flag it

### 3. Global Rules Storage

```
~/.lgtm-farm/
  rules/
    global-rule-1.md    ← applies to all repos
    global-rule-2.md
```

Rules engine loads both:
```ts
const localRules = await engine.loadRules(lgtmDir);
const globalRules = await engine.loadRules(globalRulesDir);
const merged = mergeRules(localRules, globalRules); // local wins on ID conflict
```

### 4. Queue Schema Extension

Current `QueuedPR`:
```ts
interface QueuedPR {
  number: number;
  title: string;
  filesChanged: string[];
  source: "github" | "local";
  // ... existing fields
}
```

Extended:
```ts
interface QueuedPR {
  // ... existing fields
  repo?: string;       // "owner/repo" — undefined = current repo
  repoShort?: string;  // "repo" — for display
}
```

### 5. Status Display

When queue has mixed repos, show the `Repo` column:
```
#     Repo          State    Title                Files  Group
───────────────────────────────────────────────────────────────
○ 42   frontend      queued   Add user avatar      3     auth-feature
○ 108  backend       queued   User API endpoint    5     auth-feature
○ 5    shared-types  queued   User type update     1     auth-feature
```

Cross-repo group detected: "auth-feature" spans 3 repos.

## Dependencies

- `packages/plugins/review/src/domain/multi-repo.ts` — existing PR ref parser
- `packages/core/src/registry/index.ts` — existing repo registry
- `packages/plugins/review/src/domain/overlap.ts` — existing overlap detection
- `packages/plugins/review/src/domain/rules.ts` — existing rules engine
- `packages/plugins/review/src/infra/github.ts` — existing GitHub adapter

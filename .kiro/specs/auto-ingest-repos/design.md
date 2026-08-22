# Auto-Ingest Repos — Design

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│             lgtm discover --ingest                       │
├─────────────────────────────────────────────────────────┤
│                                                          │
│  ┌──────────────┐    ┌───────────────┐    ┌──────────┐ │
│  │  Scanner     │───▶│  Enricher     │───▶│  Picker  │ │
│  │  (find .git) │    │  (remote,date)│    │  (TUI)   │ │
│  └──────────────┘    └───────────────┘    └──────────┘ │
│         │                                       │       │
│         ▼                                       ▼       │
│  ~/.lgtm-registry.md                    watch.md        │
│  (all known repos)                (watched repos)       │
│                                                          │
└─────────────────────────────────────────────────────────┘
```

## Component Design

### 1. Scanner (`packages/core/src/registry/scanner.ts`)

Walks the filesystem looking for `.git/` directories.

```ts
interface ScannedRepo {
  path: string;           // absolute path to repo root
  name: string;           // directory name
  remote?: string;        // origin URL (GitHub, GitLab, etc.)
  owner?: string;         // extracted from remote
  repoName?: string;      // extracted from remote
  platform?: "github" | "gitlab" | "bitbucket" | "other";
  lastCommitDate?: string; // ISO date of most recent commit
  defaultBranch?: string;  // main, master, etc.
  language?: string;       // primary language (from file extensions)
  isMonorepo?: boolean;    // has workspaces/packages/
}

interface ScanOptions {
  roots?: string[];       // directories to scan (defaults to common locations)
  maxDepth?: number;      // how deep to recurse (default: 4)
  excludePatterns?: string[]; // dirs to skip
}

function scanForRepos(opts: ScanOptions): AsyncGenerator<ScannedRepo>;
```

**Default scan roots** (in order):
1. `~/projects`, `~/dev`, `~/code`, `~/repos`, `~/src`, `~/work`
2. `~/Desktop`, `~/Documents` (lower priority)
3. Current working directory (always)

**Exclude**: `node_modules`, `.cache`, `vendor`, `dist`, `build`, `Library`, `.Trash`

### 2. Enricher

For each found `.git/` directory:
1. Read `.git/config` → extract `[remote "origin"]` URL
2. Parse remote URL → owner, repo, platform (reuse `utils/git.ts` → `parseGitUrl()`)
3. Run `git log -1 --format=%aI` → last commit date
4. Check for monorepo indicators: `package.json#workspaces`, `Cargo.toml#[workspace]`, `go.work`
5. Detect primary language from file extension frequency (quick heuristic)

### 3. Picker (Interactive UI)

Two modes:
- **CLI mode** (`lgtm discover --ingest`): readline-based accept/deny
- **TUI mode** (Dashboard tab): Ink-based list with keyboard navigation

Display format:
```
  Discovered 23 repos (3 new, 12 watching, 6 skipped, 2 removed)

  ~/projects/
    👁 frontend-app      github.com/org/frontend   2 days ago    TypeScript
    👁 backend-api       github.com/org/backend    5 hours ago   Go
    ✦ new-service        github.com/org/new-svc    1 day ago     Rust        [NEW]
      mobile-app         github.com/org/mobile     3 months ago  Swift       (stale)

  ~/work/
    ✦ internal-tool      gitlab.com/team/tool      1 day ago     Python      [NEW]
    👁 data-pipeline     github.com/org/pipeline   12 hours ago  Python
      archived-thing     (no remote)               1 year ago    —           (stale)

  ⚠ Removed (no longer on disk):
    ✗ old-project        was at ~/projects/old-project
    ✗ deleted-repo       was at ~/work/deleted-repo

  👁 = watching  ✦ = new (needs decision)  ○ = skipped  ⚠ = removed

  Showing 2 new repos for review:
  [a] accept  [s] skip  [A] accept all new  [q] done
```

### 4. Registry Integration

**Every ingest run performs a full reconciliation:**

1. **Scan** filesystem → get current repos on disk
2. **Compare** against registry → identify new, existing, and removed
3. **Prune** removed repos (path no longer exists) → remove from watch + registry
4. **Present** full state to user with clear status indicators

Repo states in `~/.lgtm-registry.md`:
- `status: active` — accepted and being watched
- `status: denied` — user explicitly skipped (hidden on re-run unless `--all`)
- `status: removed` — path no longer exists (auto-cleaned)

Accepted repos:
- Added to `~/.lgtm-registry.md` with `status: active`
- Added to `watch.md` in the current LGTM storage dir
- Auto-registered so `lgtm review add repo-name#42` works (short form)

Denied repos:
- Added to `~/.lgtm-registry.md` with `status: denied`
- Not shown for decision on subsequent runs (unless `--all`)
- Can be re-accepted at any time (status flips back to active)

Removed repos:
- Detected when registered path no longer has a `.git/` directory
- Automatically removed from watch list
- Shown as warning: "⚠ 2 repos no longer found on disk"
- Removed from registry (or marked `status: removed` for audit trail)

### 5. Watch Integration

After accepting, repos are added to the watcher the same way `lgtm review watch add` works:
```ts
// Reuse existing watch infrastructure
await addToWatch(owner, repo);
```

This means `lgtm review watch status` and `lgtm review report` immediately include them.

## Storage Format (OKF)

All data is stored in OKF format (YAML frontmatter + markdown body) — human-readable and git-friendly.

### Registry (`~/.lgtm-registry.md`)

```markdown
---
type: lgtm/registry
lastUpdated: "2026-08-22T10:30:00Z"
lastScan: "2026-08-22T10:30:00Z"
repos:
  - path: /Users/pascal/projects/frontend-app
    name: frontend-app
    remote: https://github.com/org/frontend-app.git
    owner: org
    platform: github
    status: active
    lastCommitDate: "2026-08-20T14:22:00Z"
    language: typescript
    addedAt: "2026-08-15T09:00:00Z"
  - path: /Users/pascal/projects/old-thing
    name: old-thing
    status: denied
    addedAt: "2026-08-15T09:00:00Z"
  - path: /Users/pascal/work/deleted-repo
    name: deleted-repo
    status: removed
    removedAt: "2026-08-22T10:30:00Z"
---

# LGTM Registry

Tracks 15 repos on this machine. Last scan: 2026-08-22.

- **frontend-app** — `~/projects/frontend-app` (👁 watching)
- **backend-api** — `~/projects/backend-api` (👁 watching)
- **old-thing** — `~/projects/old-thing` (skipped)
```

### Watch list (`.lgtm/watch.md` or `~/.lgtm-farm/watch.md`)

Already uses OKF format (existing):
```markdown
---
type: lgtm/watch
repos:
  - owner: org
    repo: frontend-app
    addedAt: "2026-08-15T09:00:00Z"
  - owner: org
    repo: backend-api
    addedAt: "2026-08-16T11:00:00Z"
---

# Watched Repos

2 repos being monitored for new PRs.
```

## Configuration

```yaml
# .lgtmrc.yaml
discover:
  scanRoots:
    - ~/projects
    - ~/work
  maxDepth: 4
  excludePatterns:
    - "**/archive/**"
    - "**/old/**"
  recommendedThresholdDays: 7
  staleThresholdDays: 90
```

## Dependencies

- `packages/core/src/registry/index.ts` — existing registry (load, save, register)
- `packages/core/src/utils/git.ts` — existing `parseGitUrl()`
- `packages/plugins/review/src/commands/watch.ts` — existing watch add logic
- `packages/core/src/cli/commands/discover.ts` — existing discover command (will be extended)

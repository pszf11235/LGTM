# MVP Review Pipeline — Design

## System Flow

```
┌──────────────────────────────────────────────────────────────────────────┐
│  lgtm discover --ingest                                                   │
│    scanner.ts → reconcile.ts → ingest.ts (picker)                        │
│    accept → ~/.lgtm-ingest-registry.md  AND  <lgtmDir>/watch.md  ← NEW   │
└──────────────────────────────────────────────────────────────────────────┘
                                    ↓
┌──────────────────────────────────────────────────────────────────────────┐
│  lgtm watch  (runs immediately, then every 15min)                         │
│                                                                           │
│  for each repo in watch.md:                                              │
│    fetchOpenPRs()                                                        │
│    for each PR:                                                          │
│      meta = loadReviewMeta(pr)                                           │
│      if !meta                      → NEW PR      → review(round 1)       │
│      elif meta.lastReviewedSha != pr.head.sha                            │
│                                    → NEW COMMITS → verify() + review(N+1)│
│      else                          → skip                                │
└──────────────────────────────────────────────────────────────────────────┘
                                    ↓
┌──────────────────────────────────────────────────────────────────────────┐
│  orchestrator.ts                                                          │
│    load .lgtm/agents/*.md  →  for each enabled agent:                    │
│      Bun.spawn(workers/review-agent.ts)  ← separate process              │
│         stdin  ← {diff, prUrl, agent, priorFindings}                     │
│         stdout → {findings[], stats, error}                              │
│    collect all, write to <lgtmDir>/reviews/<owner>-<repo>-<pr>/          │
└──────────────────────────────────────────────────────────────────────────┘
                                    ↓
┌──────────────────────────────────────────────────────────────────────────┐
│  HUMAN GATE — nothing on GitHub yet                                       │
│    lgtm review status                → repos + PRs with unposted findings │
│    lgtm review list <repo>#<pr>      → plain listing of rounds/findings   │
│    lgtm review discard <repo>#<pr> -f f3   → drop one before posting      │
└──────────────────────────────────────────────────────────────────────────┘
                                    ↓
┌──────────────────────────────────────────────────────────────────────────┐
│  lgtm review post <repo>#<pr>                                             │
│    findings where posted:false && discarded:false                        │
│    POST /pulls/{n}/reviews  with NO event field  → PENDING review        │
│    store response.id as meta.pendingReviewId                             │
│    mark findings posted:true                                             │
└──────────────────────────────────────────────────────────────────────────┘
                                    ↓
┌──────────────────────────────────────────────────────────────────────────┐
│  YOU, on github.com                                                       │
│    open the PR → draft review with every comment on its diff line        │
│    edit / delete comments in GitHub's native UI                          │
│    click "Submit review"                                                 │
│    (or: lgtm review submit <repo>#<pr>)                                   │
└──────────────────────────────────────────────────────────────────────────┘
```

## Why pending reviews instead of a terminal diff renderer

`POST /repos/{owner}/{repo}/pulls/{n}/reviews` creates a review in **PENDING** state
when the `event` field is omitted. A pending review:

- is visible only to its author until submitted
- shows every comment anchored to the correct diff line in GitHub's UI
- is fully editable — change wording, delete comments, add your own
- becomes live only when the author clicks "Submit review"

That is a better review surface than anything renderable in a terminal, and it is free.
So the tool's job ends at creating a good draft.

**Two API constraints that shape the implementation:**

1. **`event` must be omitted, not set to a falsy value.** Sending `event: "COMMENT"`
   submits the review immediately. There is no `draft: true` parameter. This has bitten
   other tools — see anthropics/claude-code#82964 where a live review was published by
   accident because `draft: true` was assumed to work.
2. **All comments must be in the create call.** The API cannot append comments to an
   existing pending review (community discussion #168380). So one round → one create
   call → one pending review. If the user wants to add to it, they do so in the UI.

### Posting implementation

```ts
async function postPendingReview(owner, repo, pr, findings, summary, token) {
  const comments = findings
    .filter((f) => !f.posted && !f.discarded)
    .map((f) => ({ path: f.file, line: f.line, body: formatBody(f) }));

  const res = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/pulls/${pr}/reviews`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" },
      // NOTE: no `event` key. Its absence is what creates a PENDING review.
      body: JSON.stringify({ body: summary, comments }),
    }
  );

  if (!res.ok) throw new Error(`GitHub ${res.status}: ${await res.text()}`);
  const review = await res.json();
  return { reviewId: review.id, commentCount: comments.length };
}
```

**Line validation.** GitHub rejects the whole call if any comment targets a line outside
the diff. Before posting, every finding's `file` + `line` is checked against the parsed
diff; misses are dropped with a warning and left `posted: false` so nothing is silently lost.

**Optional submit.** `lgtm review submit <repo>#<pr>` calls
`POST /pulls/{n}/reviews/{reviewId}/events` with `{"event": "COMMENT"}` for users who
would rather not open a browser.

## Provider Dispatch

The worker process resolves and calls exactly one provider. Detection runs before the call.

### Detection

```ts
interface ProviderStatus {
  id: "kiro-cli" | "claude-cli" | "codex-cli" | "openrouter" | "ollama";
  available: boolean;
  detail: string;
  hasBuiltInReview: boolean;
}

async function detectProviders(): Promise<ProviderStatus[]> {
  return [
    // kiro-cli: binary on PATH + KIRO_API_KEY
    { id: "kiro-cli", available: which("kiro-cli") && !!process.env.KIRO_API_KEY, hasBuiltInReview: false },
    // claude: binary on PATH (auth via Keychain/OAuth, can't check directly)
    { id: "claude-cli", available: which("claude"), hasBuiltInReview: true },
    // codex: binary on PATH
    { id: "codex-cli", available: which("codex"), hasBuiltInReview: true },
    // openrouter: env var
    { id: "openrouter", available: !!process.env.OPENROUTER_API_KEY, hasBuiltInReview: false },
    // ollama: ping localhost
    { id: "ollama", available: await ping("http://localhost:11434/api/tags"), hasBuiltInReview: false },
  ];
}
```

`which()` uses `Bun.spawnSync(["which", cmd])` with stderr suppressed (fixes the current `which: no claude` noise leaking into onboarding output).

### Invocation per provider

**kiro-cli** (headless mode, `KIRO_API_KEY` required):
```ts
Bun.spawn([
  "kiro-cli", "--no-interactive",
  buildPrompt(agent, diff, priorFindings),
  "--trust-all-tools",
], { env: { ...process.env, KIRO_API_KEY: key } })
```
Output is prose, not JSON — parse with `extractFindings()` (see below).
If `.kiro/agents/code-reviewer.json` exists in the target repo, pass `--agent code-reviewer`.

**claude-cli** (prefer built-in `/review`):
```ts
// Preferred: Claude fetches the PR itself, runs its own multi-agent review
Bun.spawn([
  "claude", "-p",
  `/review ${prUrl}\n\nAdditional instructions:\n${agent.prompt}`,
  "--output-format", "json",
], { cwd: repoPath })

// Fallback when no PR URL (local diff only):
Bun.spawn(["claude", "-p", `/code-review\n\n${agent.prompt}`, "--output-format", "json"], { cwd: repoPath })
```

**codex-cli** (prefer built-in `/review`):
```ts
Bun.spawn([
  "codex", "exec",
  `/review\n\nAdditional instructions:\n${agent.prompt}`,
  "--json-output-schema", JSON.stringify(FINDINGS_SCHEMA),
  "--skip-git-repo-check",
], { cwd: repoPath })
```

**openrouter** (raw HTTP, no built-in review):
```ts
fetch("https://openrouter.ai/api/v1/chat/completions", {
  method: "POST",
  headers: { Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}` },
  body: JSON.stringify({
    model: agent.model ?? "anthropic/claude-sonnet-4-20250514",
    messages: [
      { role: "system", content: agent.prompt + "\n\n" + JSON_OUTPUT_INSTRUCTION },
      { role: "user", content: truncateDiff(diff, 60000) },
    ],
    response_format: { type: "json_object" },
  }),
})
```

**ollama** (raw HTTP, local):
```ts
fetch("http://localhost:11434/api/generate", {
  method: "POST",
  body: JSON.stringify({
    model: agent.model ?? "qwen2.5-coder:7b",
    prompt: agent.prompt + "\n\n" + JSON_OUTPUT_INSTRUCTION + "\n\n" + truncateDiff(diff, 30000),
    format: "json",
    stream: false,
  }),
})
```

### Output normalisation

CLI providers return varying shapes. `extractFindings(raw: string)` handles all of:
1. Pure JSON array — parse directly
2. JSON object with `findings` key — unwrap
3. JSON inside a ```json fence — extract fence, parse
4. Claude's `--output-format json` envelope — read `.result` then recurse
5. Prose with `file:line — comment` lines — regex fallback
6. Nothing parseable — return `[]` and set `error` on the result

Every finding is validated: `file` non-empty, `line` a positive int, `severity` in the allowed set (default `medium` if missing), `comment` non-empty. Invalid entries are dropped with a count in `stats.dropped`.

## OKF Storage Layout

**One central store, always.** `resolveLgtmDir()` returns `~/.lgtm-farm/` flat — no
per-repo subdirectory, no `storageMode` branch. Repo identity lives in the review
directory name and in every file's frontmatter.

```
~/.lgtm-farm/
  agents/
    reviewer.md                       ← the review prompt (user-editable)
  reviews/
    pszf11235-LGTM-42/                ← <owner>-<repo>-<pr>
      meta.md                         ← rounds, lastReviewedSha, pendingReviewId
      r1-reviewer.md                  ← round 1 findings
      r2-reviewer.md                  ← round 2 findings (after new commits)
    someorg-backend-108/              ← a different repo, same store
      meta.md
      r1-reviewer.md
  watch.md                            ← all watched repos, one file
  rules/                              ← rules apply across all repos
  cache/
    pszf11235-LGTM-42.md              ← cached diff, repo-qualified
```

Because the store is shared across repos, **cache keys and review dirs are repo-qualified**.
The existing `cache/pr-42.md` naming would collide between repos, so it becomes
`cache/<owner>-<repo>-<pr>.md`.

### PR reference parsing

Commands accept both forms:

```
lgtm review post pszf11235/LGTM#42     ← explicit, always works
lgtm review post 42                    ← resolved against watched repos
```

`resolvePrRef(input)`:
1. Matches `owner/repo#N` → use directly
2. Matches bare `N` → scan `reviews/` for directories ending `-N`
   - exactly one match → use it
   - several matches → error listing each candidate as `owner/repo#N`
   - none → error suggesting the explicit form

### `agents/reviewer.md`

```markdown
---
name: reviewer
provider: auto          # auto | kiro-cli | claude-cli | codex-cli | openrouter | ollama
model: null             # only used by openrouter/ollama
severity: high          # minimum severity to record
timeout: 300            # seconds
commentDelay: [20, 90]  # seconds between individual posts
enabled: true
prompt: |
  Focus on high and critical issues only.
  Use my tone and voice: concise, actionable, no fluff, dev to dev.
  Never use em dashes or semicolons.
  Do not spell out the severity in the comment body.
  Instead of "High / borderline critical - these events won't make it to GA4."
  write "These events probably won't make it to GA4 (this is an important one)..."
  Cite the exact file and line for every finding.
---

# Review Agent

Edit the `prompt` field above to change how reviews are written.
`provider: auto` picks the first available CLI in priority order.
```

### `reviews/<owner>-<repo>-<pr>/meta.md`

```markdown
---
type: lgtm/review-meta
owner: pszf11235
repo: LGTM
pr: 42
url: https://github.com/pszf11235/LGTM/pull/42
title: Add user auth
author: someone
currentRound: 2
lastReviewedSha: a1b2c3d4e5f6
pendingReviewId: 2847362        # set by `review post`, cleared after submit
rounds:
  - round: 1
    sha: 9f8e7d6c5b4a
    reviewedAt: "2026-08-23T09:00:00Z"
    agents: [reviewer]
    findingCount: 3
    postedCount: 2
    pendingReviewId: 2847362
    submittedAt: "2026-08-23T09:20:00Z"
  - round: 2
    sha: a1b2c3d4e5f6
    reviewedAt: "2026-08-23T14:30:00Z"
    agents: [reviewer]
    findingCount: 2
    postedCount: 0
    pendingReviewId: null
    verifiedPriorRound: 1
    resolvedFromPrior: 1
    unresolvedFromPrior: 1
---

# Review Meta — pszf11235/LGTM#42

[Add user auth](https://github.com/pszf11235/LGTM/pull/42) by @someone

Round 2 of review. 1 finding from round 1 still unresolved.
```

### `reviews/<owner>-<repo>-<pr>/r1-reviewer.md`

```markdown
---
type: lgtm/review-findings
pr: 42
url: https://github.com/pszf11235/LGTM/pull/42
round: 1
agent: reviewer
provider: claude-cli
sha: 9f8e7d6c5b4a
reviewedAt: "2026-08-23T09:00:00Z"
durationMs: 42000
findings:
  - id: f1
    file: src/auth.ts
    line: 42
    severity: critical
    comment: "Hardcoded API key. Move it to an env var before this ships."
    posted: true
    postedAt: "2026-08-23T09:15:00Z"
    pendingReviewId: 2847362
    discarded: false
    resolved: true
    resolvedNote: "Replaced with process.env.API_KEY in a1b2c3d"
  - id: f2
    file: src/db.ts
    line: 18
    severity: high
    comment: "Query built by string concat. Use parameterised queries, this is exploitable."
    posted: true
    postedAt: "2026-08-23T09:15:00Z"
    pendingReviewId: 2847362
    discarded: false
    resolved: false
    resolvedNote: "Still concatenating on line 18"
  - id: f3
    file: src/util.ts
    line: 7
    severity: medium
    comment: "Unused import."
    posted: false
    discarded: true
  - id: f4
    file: src/gone.ts
    line: 900
    severity: low
    comment: "Line no longer in the diff."
    posted: false
    skipped: true
    skipReason: "line 900 not present in PR diff"
---

# Round 1 — reviewer (claude-cli)

3 findings. 2 posted, 1 discarded.
1 resolved in a later commit, 1 still open.
```

**Finding IDs** are stable within a file (`f1`, `f2`, ...) so `lgtm review discard 42 --finding f3` is unambiguous.

## Commit Detection and Re-Review

```ts
async function checkPR(pr, watched, agents) {
  const meta = await loadReviewMeta(store, watched.owner, watched.repo, pr.number);

  // Case 1: never reviewed
  if (!meta) {
    const diff = await github.fetchDiff(pr.number);
    const findings = await orchestrate(agents, { diff, prUrl: pr.html_url, priorFindings: [] });
    await saveRound(store, pr, 1, findings, pr.head.sha);
    return { action: "reviewed", round: 1 };
  }

  // Case 2: no new commits
  if (meta.lastReviewedSha === pr.head.sha) {
    return { action: "skipped", reason: "no new commits" };
  }

  // Case 3: new commits → verify then re-review
  const priorPosted = await loadPostedFindings(store, meta);   // only posted ones matter
  const newDiff = await github.fetchDiff(pr.number);

  // 3a. verification pass
  if (priorPosted.length > 0) {
    const verdicts = await verifyFindings(agents[0], priorPosted, newDiff);
    await applyVerdicts(store, meta, verdicts);   // writes resolved / resolvedNote
  }

  // 3b. new round, passing unresolved as context
  const unresolved = priorPosted.filter((f) => !f.resolved);
  const findings = await orchestrate(agents, {
    diff: newDiff,
    prUrl: pr.html_url,
    priorFindings: unresolved,   // "these are already flagged, do not repeat them"
  });

  const nextRound = meta.currentRound + 1;
  await saveRound(store, pr, nextRound, findings, pr.head.sha, {
    verifiedPriorRound: meta.currentRound,
    resolvedFromPrior: priorPosted.length - unresolved.length,
    unresolvedFromPrior: unresolved.length,
  });
  return { action: "re-reviewed", round: nextRound };
}
```

### Verification prompt

```
These issues were raised on an earlier version of this PR:

1. src/auth.ts:42 (critical) — Hardcoded API key. Move it to an env var before this ships.
2. src/db.ts:18 (high) — Query built by string concat. Use parameterised queries.

Here is the current diff:
<diff>

For each numbered issue, answer whether it is now addressed.
Output JSON: {"verdicts": [{"index": 1, "resolved": true, "note": "short reason"}]}
```

Verification uses the same provider dispatch as review, so it costs one extra agent call per PR that has new commits.

## Worker Protocol

Orchestrator → worker over stdin/stdout, one JSON object each way.

**stdin:**
```json
{
  "mode": "review",
  "diff": "<unified diff>",
  "prUrl": "https://github.com/org/repo/pull/42",
  "repoPath": "/Users/me/projects/repo",
  "agent": {
    "name": "reviewer",
    "provider": "auto",
    "model": null,
    "severity": "high",
    "prompt": "Focus on high and critical issues only..."
  },
  "priorFindings": [
    { "file": "src/db.ts", "line": 18, "comment": "Query built by string concat..." }
  ]
}
```

`mode` is `"review"` or `"verify"`. In verify mode, `priorFindings` is the list to check and the worker returns `verdicts` instead of `findings`.

**stdout:**
```json
{
  "agent": "reviewer",
  "provider": "claude-cli",
  "findings": [
    { "file": "src/auth.ts", "line": 42, "severity": "critical", "comment": "..." }
  ],
  "stats": { "durationMs": 42000, "dropped": 0, "rawLength": 1840 },
  "error": null
}
```

Failure modes:
- Provider unavailable → worker tries the next in priority order, notes it in `stats.fallbackFrom`
- All providers unavailable → `{ findings: [], error: "no provider available" }`, exit 1
- Timeout → orchestrator sends SIGTERM, records `{ error: "timeout after 300s" }`
- Unparseable output → `{ findings: [], error: "could not parse output", stats.rawLength }` and the raw output is written to `<lgtmDir>/reviews/<pr>/r<N>-<agent>.raw.txt` for debugging

## Command Surface (after trim)

```
lgtm                          → TUI
lgtm init                     → onboarding (1 question)
lgtm config                   → show config
lgtm smoke [--demo]           → self-test
lgtm ai discover              → provider availability report

lgtm discover --ingest [dir]  → scan + pick repos → watch.md
lgtm discover                 → list registered repos
lgtm discover --prune         → drop repos that no longer exist

lgtm watch [--interval 15]    → poll + review (alias of `review watch auto`)
lgtm watch --once             → single cycle

lgtm review add <prs...>           → manual review of an unwatched repo's PR
lgtm review status                 → all repos + PRs with unposted findings
lgtm review list <repo>#<pr>       → plain listing of rounds and findings
lgtm review post <repo>#<pr>       → create a PENDING review on GitHub
lgtm review post <repo>#<pr> --recreate  → replace an existing pending review
lgtm review submit <repo>#<pr>     → submit the pending review (optional)
lgtm review discard <repo>#<pr> -f <id>  → mark a finding discarded
lgtm review rule add|list|enable|disable → rules (regex local, llm as prompt context)
```

All PR arguments accept `owner/repo#N` or bare `N` when unambiguous.

## Rules feed the agent, they do not call the LLM themselves

`matchLLM()` in `domain/rules.ts` is deleted. Once review is delegated to
`claude -p /review` there is no raw `llm.complete()` provider to hand it, so LLM-enforced
rules become prompt context instead:

| Enforcement | Behaviour |
|---|---|
| `regex` | Runs locally against added lines, zero cost. Violations become findings directly, tagged `source: "rule-regex"` |
| `llm` | The rule description and examples are appended to the agent prompt: *"Also enforce these project rules: …"*. The agent already has the diff, so this costs nothing extra |

This removes ~60 lines and the last dependency on the raw LLM provider inside the rules engine.

## GitHub token resolution

No OAuth app, no registration. In order:

```ts
async function resolveGitHubToken(): Promise<string | null> {
  // 1. gh CLI — zero setup for anyone who has it
  const gh = Bun.spawnSync(["gh", "auth", "token"], { stdio: ["ignore", "pipe", "ignore"] });
  if (gh.exitCode === 0) {
    const token = gh.stdout.toString().trim();
    if (token) return token;
  }
  // 2. environment
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN;
  if (process.env.GH_TOKEN) return process.env.GH_TOKEN;
  // 3. saved credentials
  return loadSavedToken("github");
}
```

`stdio: ["ignore","pipe","ignore"]` matters — without it a missing `gh` binary prints to
the terminal mid-command.

## Files: New, Modified, Deleted

### New
| File | Purpose | Est. lines |
|---|---|---|
| `plugins/review/src/domain/agent-config.ts` | Load `agents/*.md`, defaults, provider resolution | 150 |
| `plugins/review/src/domain/providers.ts` | Detect + invoke the 5 providers, normalise output | 320 |
| `plugins/review/src/workers/review-agent.ts` | Worker entry point (stdin→stdout) | 130 |
| `plugins/review/src/domain/orchestrator.ts` | Spawn workers, timeout, collect | 180 |
| `plugins/review/src/domain/review-store.ts` | meta.md + r<N>-<agent>.md read/write, rounds, mark posted | 300 |
| `plugins/review/src/domain/verify.ts` | Verification pass for prior findings | 120 |
| `plugins/review/src/domain/pr-ref.ts` | Parse/resolve `owner/repo#N` and bare `N` | 90 |
| `plugins/review/src/commands/list.ts` | `review list` — plain text rounds/findings | 110 |
| `plugins/review/src/commands/post.ts` | `review post` — create PENDING review, mark posted | 200 |
| `plugins/review/src/commands/submit.ts` | `review submit` — submit the pending review | 60 |

### Modified
| File | Change |
|---|---|
| `core/src/config/loader.ts` | `resolveLgtmDir()` always returns `~/.lgtm-farm/` flat; drop `storageMode` |
| `core/src/registry/reconcile.ts` | `acceptRepo()` also writes `watch.md` |
| `core/src/onboarding/questions.ts` | Delete — no questions remain |
| `core/src/onboarding/flow.ts` | Becomes `initStore()`: create dirs, write default agent, print summary. ~751 → ~80 lines |
| `core/src/onboarding/detect-ai.ts` | 615 → ~80 lines, only the 5-provider availability check |
| `core/src/auth/github-oauth.ts` | Add `resolveGitHubToken()` with the `gh auth token` path |
| `plugins/review/src/domain/rules.ts` | Delete `matchLLM()`; add `rulesAsPromptContext(rules)` |
| `plugins/review/src/commands/watch.ts` | Interval default 15, run on startup, orchestrator instead of `generateAutoReview`, **no posting** |
| `plugins/review/src/commands/status.ts` | Repo-qualified output, rounds, unposted counts |
| `plugins/review/src/commands/add.ts` | Repo-qualified cache keys |
| `plugins/review/src/domain/post-review.ts` | Add `postPendingReview()`; keep `formatCommentBody` |
| `plugins/review/src/index.ts` | Register `list`, `post`, `submit`, `discard`; drop removed commands |
| `core/src/index.ts` | Top-level `lgtm watch` alias; `init` becomes non-interactive |
| `core/src/cli/commands/ai.ts` | `ai discover` reports the 5 review providers |

### Deleted (filed as issues — see `removals.md`)
| Path | Lines | Issue |
|---|---|---|
| `plugins/learn/` | 30 | #130 |
| `plugins/specify/` | 36 | #130 |
| `plugins/review/src/pages/ModelPicker.tsx` | 66 | dead code, no issue |
| `plugins/review/src/commands/scan.ts` | 245 | #131 |
| `plugins/review/src/pages/ScanResultsPage.tsx` | 130 | #131 |
| `plugins/review/src/commands/dashboard.ts` | 120 | #132 |
| `plugins/review/src/domain/attention.ts` | 195 | #132 |
| `plugins/review/src/pages/DashboardPage.tsx` | 170 | #132 |
| `plugins/review/src/domain/patterns.ts` | ~200 | #133 |
| `plugins/review/src/domain/summarize.ts` | ~150 | #133 |
| `plugins/review/src/domain/grouping.ts` | ~180 | #134 |
| `plugins/review/src/domain/overlap.ts` | ~170 | #134 |
| `plugins/review/src/domain/multi-repo.ts` | ~120 | #135 |
| `plugins/review/src/domain/rules-import.ts` | 206 | #136 |
| `plugins/review/src/domain/rules-export.ts` | 175 | #136 |
| `plugins/review/src/pages/HistoryPage.tsx` | 252 | #137 |
| `plugins/review/src/components/SideBySideView.tsx` | 154 | #138 |
| `core/src/auth/pkce-flow.ts` | 198 | #139 |
| `core/src/auth/providers.ts` | 210 | #139 |
| `plugins/review/src/domain/auto-review.ts` | 654 | replaced by CLI delegation |

Net: roughly **3,600 lines deleted**, **1,540 added**.

## Dependencies to keep

- `domain/diff-parser.ts` (311) — needed for `review show` inline rendering
- `domain/post-review.ts` (466) — reused for posting, modified to read from OKF
- `infra/github.ts` (206) — fetch PR, fetch diff, post review
- `domain/queue.ts` — review queue for manual adds
- `domain/rules.ts` (380) — regex rules feed extra context into the agent prompt
- `store/okf.ts`, `config/loader.ts`, `store/paths.ts` — storage layer
- `registry/*` — repo discovery
- `llm/provider.ts` — trimmed to power `openrouter`/`ollama` paths only; drop `getProviderForTask`
- TUI: `Shell.tsx`, `ReviewTab.tsx`, `QueuePage.tsx`, `ReviewPage.tsx`, `RulesPage.tsx`, `DiscoverPage.tsx`, `ConfigPage.tsx`, `AITab.tsx`

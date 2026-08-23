# MVP Review Pipeline — Implementation Tasks

Priorities: **P0** = required for the demo to work, **P1** = strongly wanted, **P2** = only if time remains.

Ordered so that each task leaves the tool in a working state.

---

## Task 1 — Central store, zero-question init  `P0`  ~45min

- [ ] `core/src/config/loader.ts`:
  - [ ] `resolveLgtmDir()` always returns `~/.lgtm-farm/` — flat, no per-repo subdir, no `storageMode` branch
  - [ ] Drop `storageMode` from `BootstrapConfig` and `LGTMConfig`
  - [ ] Keep `loadBootstrap`/`saveBootstrap` for future settings
- [ ] Delete `core/src/onboarding/questions.ts`
- [ ] `core/src/onboarding/flow.ts` → collapse to `initStore()`:
  - [ ] Create `~/.lgtm-farm/{agents,reviews,rules,cache}`
  - [ ] Write `agents/reviewer.md` if absent (Task 3 supplies the content)
  - [ ] Write a minimal `profile.md`: `createdAt` only
  - [ ] Print what was created; idempotent on re-run
  - [ ] Delete `selectWithArrows`, `pickProviderPriority`, `waitForSkipOrContinue`, `getModelSuggestions`, the question loop, the background `discoverAIProviders()` call
  - [ ] Target: 751 → ~80 lines
- [ ] `isOnboardingComplete()` → `storeExists()`: true when `~/.lgtm-farm/` exists
- [ ] `core/src/index.ts`: `lgtm init` is non-interactive; bare `lgtm` calls `initStore()` silently if needed then opens the TUI
- [ ] Silence shell noise: every `which`/`gh` probe uses `stdio: ["ignore","pipe","ignore"]`
- [ ] Repo-qualify cache keys: `cache/<owner>-<repo>-<pr>.md` in `commands/add.ts`
- [ ] Rewrite `onboarding/flow.test.ts` against `initStore()`
- [ ] Verify: `lgtm init` prints a summary and exits with no prompts; running it twice changes nothing

## Task 1b — GitHub token via `gh`  `P0`  ~20min

- [ ] `core/src/auth/github-oauth.ts`: add `resolveGitHubToken()`
  - [ ] `gh auth token` first, stderr suppressed
  - [ ] then `GITHUB_TOKEN`, then `GH_TOKEN`, then `~/.lgtm-credentials`
- [ ] Replace every direct `process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN` read with it
      (`watch.ts`, `auto.ts`, `post-review.ts`, `infra/github.ts`, `DashboardPage.tsx`)
- [ ] Missing token → print all three options with copy-pasteable commands
- [ ] Verify: works with only `gh` authenticated and no env vars set

## Task 2 — Wire ingest acceptance into the watcher  `P0`  ~30min

- [ ] `core/src/registry/reconcile.ts`: extend `acceptRepo()` to also append to `watch.md`
  - [ ] Requires `owner` + `repoName` from the scan (already collected by `scanner.ts`)
  - [ ] Skip repos with no remote, return a reason so the picker can display it
  - [ ] Read-modify-write `watch.md` through the OKF store, dedup on `owner/repo`
- [ ] `unwatchRepo()` removes the entry from `watch.md`
- [ ] `registry/ingest.ts`: print `→ added to watcher` on accept, `→ no remote, cannot watch` on skip
- [ ] Verify: `lgtm discover --ingest . --recommended` then `lgtm review watch list` shows the repo

## Task 3 — Agent config loader  `P0`  ~30min

- [ ] Create `plugins/review/src/domain/agent-config.ts`
  - [ ] `AgentConfig` = `{ name, provider, model, severity, timeout, commentDelay, enabled, prompt }`
  - [ ] `loadAgentConfigs(store)` — read every `.md` under `~/.lgtm-farm/agents/`
  - [ ] `ensureDefaultAgent(store)` — write `agents/reviewer.md` with the default prompt on first use
  - [ ] Agents are global now that the store is central — no per-repo override
- [ ] Default `reviewer.md` content exactly as in `design.md`
- [ ] `rulesAsPromptContext(rules)` in `domain/rules.ts`: format `enforcement: "llm"` rules
      as prompt text, delete `matchLLM()` (~60 lines)
- [ ] Tests: load, default creation, missing dir, rule context formatting

## Task 4 — Provider detection and invocation  `P0`  ~2h

- [ ] Create `plugins/review/src/domain/providers.ts`
- [ ] `detectProviders()` → status for `kiro-cli`, `claude-cli`, `codex-cli`, `openrouter`, `ollama`
  - [ ] `which()` helper with suppressed stderr
  - [ ] `ollama` ping with a 2s timeout
- [ ] `resolveProvider(agent, statuses)` — honour `agent.provider`, else first available by priority
- [ ] `invokeProvider(provider, input)` for each of the five, per `design.md`
  - [ ] `kiro-cli`: `--no-interactive`, `--trust-all-tools`, `--agent` when `.kiro/agents/` exists
  - [ ] `claude-cli`: `/review <url>` when a PR URL is present, else `/code-review`
  - [ ] `codex-cli`: `/review` + `--json-output-schema` + `--skip-git-repo-check`
  - [ ] `openrouter`: chat completions with `response_format: json_object`
  - [ ] `ollama`: `/api/generate` with `format: "json"`
- [ ] `extractFindings(raw)` — the six-strategy parser from `design.md`
- [ ] `validateFindings(list)` — drop invalid, count drops
- [ ] Tests: each parse strategy, validation, provider resolution order

## Task 5 — Worker process  `P0`  ~1h

- [ ] Create `plugins/review/src/workers/review-agent.ts`
- [ ] Read one JSON object from stdin, support `mode: "review" | "verify"`
- [ ] Build the prompt: agent prompt + prior-findings context + JSON output instruction
- [ ] Call `invokeProvider`, fall back through the priority list on failure
- [ ] Write one JSON object to stdout; exit 0 on success, 1 on hard failure
- [ ] Handle SIGTERM: flush a partial result and exit
- [ ] Verify: `echo '<json>' | bun run .../review-agent.ts` returns valid JSON

## Task 6 — Orchestrator  `P0`  ~1h

- [ ] Create `plugins/review/src/domain/orchestrator.ts`
- [ ] `orchestrate(agents, input)`:
  - [ ] `Bun.spawn` one worker per enabled agent
  - [ ] Write input to each stdin, close it
  - [ ] Read stdout with a per-agent timeout (`agent.timeout`, default 300s)
  - [ ] SIGTERM on timeout, record the error, keep other agents running
  - [ ] Return `Array<{ agent, provider, findings, stats, error }>`
- [ ] Progress callback so the watcher can log `reviewer: running…` / `reviewer: 3 findings`
- [ ] Tests: two agents in parallel, one timing out, one crashing

## Task 7 — Review store (OKF, rounds)  `P0`  ~1.5h

- [ ] Create `plugins/review/src/domain/review-store.ts`
- [ ] Path helper: `reviewDir(owner, repo, pr)` → `reviews/<owner>-<repo>-<pr>`
- [ ] `loadReviewMeta` / `saveReviewMeta` for `meta.md`
- [ ] `saveRound(pr, round, results, sha, extra?)` → writes `r<N>-<agent>.md` per agent, updates `meta.md`
- [ ] `loadRoundFindings(owner, repo, pr, round?)` — all rounds when round is omitted
- [ ] `loadPostedFindings` — flat list of `posted: true` across rounds
- [ ] `markFindingPosted(…, findingId, commentId)` and `markFindingDiscarded(…, findingId)`
- [ ] `applyVerdicts(…, verdicts)` — set `resolved` + `resolvedNote` on prior findings
- [ ] Stable finding ids (`f1`, `f2`, …) assigned on write
- [ ] Dedup on write: same `file` + `line` + `comment` inside one round is collapsed
- [ ] Tests: round-trip, multi-round, mark posted, mark discarded, verdicts, dedup

## Task 8 — Rewire the watcher  `P0`  ~1.5h

- [ ] `plugins/review/src/commands/watch.ts`:
  - [ ] `--interval` default `"15"`, `--once` sets it to 0
  - [ ] Always run one cycle immediately before starting the timer
  - [ ] Replace `generateAutoReview` + `postReviewFindings` with `orchestrate` + `saveRound`
  - [ ] **Remove all posting from the watch path**
  - [ ] Per-PR decision logic from `design.md` (`checkPR`): new PR / new commits / skip
  - [ ] Drop `auto-reviewed.md` in favour of `meta.lastReviewedSha`
  - [ ] Use `resolveGitHubToken()` from Task 1b
  - [ ] Every log line is repo-qualified: `pszf11235/LGTM#42  reviewing (round 1)…`
  - [ ] Cycle summary lists per repo: PRs checked, reviewed, rounds created, findings pending
  - [ ] Closing line points at the next action: `3 PRs have findings → lgtm review status`
- [ ] `core/src/index.ts`: register top-level `lgtm watch` that delegates to `review watch auto`
- [ ] Verify: `lgtm watch --once` reviews an open PR and writes
      `~/.lgtm-farm/reviews/<owner>-<repo>-42/r1-reviewer.md` and posts nothing

## Task 9 — PR reference parsing + `review list`  `P0`  ~1h

- [ ] Create `plugins/review/src/domain/pr-ref.ts`
  - [ ] `parsePrRef(input)` handles `owner/repo#N` and bare `N`
  - [ ] `resolvePrRef(input, store)` — bare numbers resolved by scanning `reviews/` for `*-N`
  - [ ] Several matches → error listing every candidate as `owner/repo#N`
  - [ ] No match → error suggesting the explicit form
- [ ] Create `plugins/review/src/commands/list.ts` — plain text, no diff rendering:
  ```
  pszf11235/LGTM#42 — Add user auth
  https://github.com/pszf11235/LGTM/pull/42

  Round 1  (claude-cli, 9f8e7d6)  3 findings
    f1  critical  src/auth.ts:42   posted    Hardcoded API key. Move it to an env var.
    f2  high      src/db.ts:18     posted    Query built by string concat...
    f3  medium    src/util.ts:7    discarded Unused import.

  Round 2  (claude-cli, a1b2c3d)  2 findings  1 unresolved from round 1
    f1  high      src/db.ts:18     unposted  Still concatenating, see round 1
    f2  medium    src/api.ts:55    unposted  Missing error handling on the fetch
  ```
- [ ] `--round <n>` filter, `--unposted` filter
- [ ] Verify: output is repo-qualified and states are correct

## Task 10 — `review post` creates a PENDING review  `P0`  ~1.5h

- [ ] `plugins/review/src/domain/post-review.ts`: add `postPendingReview(owner, repo, pr, findings, summary, token)`
  - [ ] `POST /repos/{owner}/{repo}/pulls/{n}/reviews` with **no `event` key** — its absence is what creates the draft
  - [ ] Never send `event` from this path; add a code comment explaining why (claude-code#82964)
  - [ ] Return `{ reviewId, commentCount, skipped }`
- [ ] Line validation before posting: check each finding's `file` + `line` against the parsed diff
  - [ ] Misses are dropped, marked `skipped: true` + `skipReason`, left `posted: false`
  - [ ] Prevents GitHub rejecting the entire call for one bad line
- [ ] Create `plugins/review/src/commands/post.ts`
  - [ ] Collect findings where `posted: false && discarded: false && !skipped`
  - [ ] `--dry-run` prints the payload without calling the API
  - [ ] `--round <n>` to post one round only
  - [ ] Refuse when `meta.pendingReviewId` is already set; point at the PR URL
  - [ ] `--recreate` deletes the existing pending review then posts fresh
  - [ ] On success store `pendingReviewId` in `meta.md` and on each finding, set `posted: true`
  - [ ] Output the PR URL as the next step
- [ ] Add `review discard <repo>#<pr> -f <id>`
- [ ] Verify: draft appears on GitHub, is editable, is not live until submitted; re-running refuses

## Task 10b — `review submit`  `P1`  ~30min

- [ ] Create `plugins/review/src/commands/submit.ts`
- [ ] `POST /pulls/{n}/reviews/{reviewId}/events` with `{"event": "COMMENT"}`
- [ ] `--approve` / `--request-changes` map to the other event values
- [ ] Clear `meta.pendingReviewId`, record `submittedAt` on the round
- [ ] Error clearly when there is no pending review
- [ ] Verify: review goes live, meta is updated

## Task 11 — Verification pass and round 2  `P1`  ~1.5h

- [ ] Create `plugins/review/src/domain/verify.ts`
- [ ] `verifyFindings(agent, priorPosted, newDiff)` → `verdicts[]` using worker `mode: "verify"`
- [ ] Verification prompt exactly as in `design.md`
- [ ] Wire into the watcher's new-commits branch: verify, then review with `priorFindings = unresolved`
- [ ] `meta.md` records `verifiedPriorRound`, `resolvedFromPrior`, `unresolvedFromPrior`
- [ ] Tests: verdict parsing, resolved/unresolved split

## Task 12 — Status output with rounds  `P1`  ~45min

- [ ] `plugins/review/src/commands/status.ts`: scan `reviews/` and show, grouped by repo:
  ```
  pszf11235/LGTM
    #42  round 2  2 unposted  1 unresolved from round 1   → lgtm review post pszf11235/LGTM#42
    #38  round 1  0 unposted  pending review created      → https://github.com/pszf11235/LGTM/pull/38

  someorg/backend
    #108 round 1  3 unposted                              → lgtm review post someorg/backend#108
  ```
- [ ] Always repo-qualified — never a bare `#42`
- [ ] Show `pending review created` with the PR URL when `meta.pendingReviewId` is set
- [ ] Verify against two repos, one with two rounds

## Task 13 — Delete removed code  `P1`  ~1h

- [ ] Delete every path listed in `design.md` → *Deleted*
- [ ] Remove their command registrations from `plugins/review/src/index.ts`
- [ ] Remove the deleted tabs from `plugin.pages`
- [ ] Delete the matching test files
- [ ] Drop `getProviderForTask` from `llm/provider.ts` and its two call sites
- [ ] `bun run lint` and `bun test` clean
- [ ] `bun run build:binary` and `./dist/lgtm smoke` pass

## Task 14 — TUI queue shows finding counts  `P2`  ~30min

- [ ] `QueuePage.tsx`: show `[3 findings]` next to PRs that have unposted findings
- [ ] Repo name in the queue row now that the store is shared
- [ ] `p` on a selected PR runs `review post` for it, flash the result

Inline diff annotations are **not** built — GitHub's pending review UI is the review
surface. Filed as an issue if a terminal-only workflow is ever wanted.

## Task 15 — Docs and release  `P1`  ~45min

- [ ] README: replace the feature list with the eight-step loop
- [ ] README: add a **Built with Kiro** section (specs, steering, spec-driven workflow)
- [ ] README: add **Quick Verify** with the exact commands a judge should run
- [ ] README: document that reviews are posted as editable drafts, never live
- [ ] `docs/TESTING.md`: rewrite around the new loop, delete sections for removed features
- [ ] Re-tag `v0.1.0` on the final main

---

## Cut line

Ship after **Task 10**. That is the complete loop:

```
discover → watch → review via CLI → central OKF → post as pending review
  → edit on GitHub → submit
```

Task 10b (`review submit`) is a convenience — the user can click Submit in the UI.
Tasks 11–12 add multi-round verification. Task 14 is polish.
**Task 13 (deleting 3,660 lines) is a separate PR** and must not block the loop.

## Revised estimate

| Tasks | Hours | Delivers |
|---|--:|---|
| 1, 1b, 2, 3, 4, 5, 6, 7, 8, 9, 10 | ~10.5 | The full loop |
| 10b, 11, 12 | ~2.75 | Submit command + multi-round review |
| 14, 15 | ~1.25 | Polish + docs |
| 13 (separate PR) | ~1 | Deletions |

Dropping the terminal diff renderer and TUI annotations saved ~2.5 hours versus the
original plan.

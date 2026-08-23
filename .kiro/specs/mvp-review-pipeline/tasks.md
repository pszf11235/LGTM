# MVP Review Pipeline — Implementation Tasks

Priorities: **P0** = required for the demo to work, **P1** = strongly wanted, **P2** = only if time remains.

Ordered so that each task leaves the tool in a working state.

---

## Task 1 — Trim onboarding to one question  `P0`  ~30min

- [ ] `core/src/onboarding/questions.ts`: reduce `ONBOARDING_QUESTIONS` to only `storageMode`
- [ ] `core/src/onboarding/flow.ts`:
  - [ ] Remove the background `discoverAIProviders()` call and all AI question special-casing
  - [ ] Remove `pickProviderPriority()` (~60 lines)
  - [ ] Remove `waitForSkipOrContinue()` "press q to skip" affordance
  - [ ] Remove `getModelSuggestions()`
  - [ ] Keep `selectWithArrows()` (still needed for the one question)
  - [ ] `saveProgress()`: write a minimal profile — `project`, `storageMode`, `createdAt`, `ai: { enabled: false }`
  - [ ] Target: 751 → ~250 lines
- [ ] `isOnboardingComplete()`: return true when the bootstrap file has a `storageMode` (no longer depends on goal/feedbackStyle/teamSize)
- [ ] Silence provider-detection shell noise: `which` calls must use `stdio: ["ignore","pipe","ignore"]`
- [ ] Update `onboarding/flow.test.ts` for the new completion rule
- [ ] Verify: `lgtm init` finishes after one selection, `.lgtm/profile.md` is written

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
  - [ ] `loadAgentConfigs(store)` — read every `.md` under `agents/`
  - [ ] `ensureDefaultAgent(store)` — write `agents/reviewer.md` with the default prompt on first use
  - [ ] Fall back to `~/.lgtm-farm/agents/` when the local dir is empty
- [ ] Default `reviewer.md` content exactly as in `design.md`
- [ ] Tests: load, default creation, missing dir

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
  - [ ] Cycle summary: repos checked, PRs reviewed, rounds created, findings pending
- [ ] `core/src/index.ts`: register top-level `lgtm watch` that delegates to `review watch auto`
- [ ] Verify: `lgtm watch --once` reviews an open PR and writes `reviews/<…>/r1-reviewer.md` without posting

## Task 9 — `review show` with inline findings  `P0`  ~1.5h

- [ ] Create `plugins/review/src/commands/show.ts`
- [ ] Load the cached or freshly fetched diff, parse with `diff-parser.ts`
- [ ] Load all rounds for the PR
- [ ] Render the diff with findings anchored to their line:
  ```
  src/auth.ts
   41   import { hash } from './crypto';
   42 + const API_KEY = "sk-live-1234";
        ⚠ [r1 reviewer/critical] f1  Hardcoded API key. Move it to an env var.
        state: unposted
  ```
- [ ] Legend for state: `unposted`, `posted`, `discarded`, `resolved`
- [ ] `--round <n>` to filter, `--unposted` to show only actionable findings
- [ ] Verify: findings appear against the correct lines

## Task 10 — `review post` from local OKF  `P0`  ~1h

- [ ] Create `plugins/review/src/commands/post.ts`
- [ ] Collect findings where `posted: false && discarded: false` (optionally `--round`)
- [ ] `--dry-run` prints without posting
- [ ] Batched by default via existing `post-review.ts`; `--no-batch` uses the delayed individual path
- [ ] Capture the returned GitHub comment id and call `markFindingPosted`
- [ ] Refuse to run when there is nothing to post, with a clear message
- [ ] Add `review discard <pr> -f <id>`
- [ ] Verify: post → `posted: true` + `commentId` in the OKF; re-running posts nothing

## Task 11 — Verification pass and round 2  `P1`  ~1.5h

- [ ] Create `plugins/review/src/domain/verify.ts`
- [ ] `verifyFindings(agent, priorPosted, newDiff)` → `verdicts[]` using worker `mode: "verify"`
- [ ] Verification prompt exactly as in `design.md`
- [ ] Wire into the watcher's new-commits branch: verify, then review with `priorFindings = unresolved`
- [ ] `meta.md` records `verifiedPriorRound`, `resolvedFromPrior`, `unresolvedFromPrior`
- [ ] Tests: verdict parsing, resolved/unresolved split

## Task 12 — Status output with rounds  `P1`  ~45min

- [ ] `plugins/review/src/commands/status.ts`: for every PR with a review dir show
  `#42  round 2  2 unposted  1 unresolved from round 1  → lgtm review show 42`
- [ ] Group by repo when more than one repo has findings
- [ ] Verify against a PR carrying two rounds

## Task 13 — Delete removed code  `P1`  ~1h

- [ ] Delete every path listed in `design.md` → *Deleted*
- [ ] Remove their command registrations from `plugins/review/src/index.ts`
- [ ] Remove the deleted tabs from `plugin.pages`
- [ ] Delete the matching test files
- [ ] Drop `getProviderForTask` from `llm/provider.ts` and its two call sites
- [ ] `bun run lint` and `bun test` clean
- [ ] `bun run build:binary` and `./dist/lgtm smoke` pass

## Task 14 — TUI inline findings  `P2`  ~1.5h

- [ ] `ReviewPage.tsx`: load findings for the open PR, render as annotations after their diff line
- [ ] Colour by severity, prefix with `[r<N> <agent>]`
- [ ] `p` post the finding under the cursor, `x` discard, `P` post all unposted
- [ ] Flash confirmation via the existing `useFlash` hook
- [ ] `QueuePage.tsx`: show `[2 findings]` next to PRs that have pending findings

## Task 15 — Docs and release  `P1`  ~45min

- [ ] README: replace the feature list with the seven-step loop
- [ ] README: add a **Built with Kiro** section (specs, steering, spec-driven workflow)
- [ ] README: add **Quick Verify** with the exact commands a judge should run
- [ ] `docs/TESTING.md`: rewrite around the new loop, delete sections for removed features
- [ ] Re-tag `v0.1.0` on the final main

---

## Cut line

If time runs out, ship after **Task 10**. That gives the complete loop:
discover → watch → review via CLI → local OKF → show → approve → post.

Tasks 11–12 add multi-round review. Task 14 is polish. Task 13 can slip to a
follow-up PR as long as the dead code does not break the build.

# MVP Review Pipeline — Removals

Everything cut from the codebase to reach the focused MVP, with the issue that tracks bringing it back.

## Deleted code

| Path | Lines | What it did | Issue |
|---|---:|---|---|
| `packages/plugins/learn/` | 30 | `lgtm learn start` stub — AI curricula | [#130](https://github.com/pszf11235/LGTM/issues/130) |
| `packages/plugins/specify/` | 36 | `lgtm specify analyze` stub — codebase diagrams | [#130](https://github.com/pszf11235/LGTM/issues/130) |
| `plugins/review/src/commands/scan.ts` | 245 | `lgtm review scan` — repo-wide rule scan | [#131](https://github.com/pszf11235/LGTM/issues/131) |
| `plugins/review/src/pages/ScanResultsPage.tsx` | 130 | Scan TUI tab | [#131](https://github.com/pszf11235/LGTM/issues/131) |
| `plugins/review/src/commands/dashboard.ts` | 120 | `lgtm review dashboard` | [#132](https://github.com/pszf11235/LGTM/issues/132) |
| `plugins/review/src/domain/attention.ts` | 195 | Attention item collection + urgency | [#132](https://github.com/pszf11235/LGTM/issues/132) |
| `plugins/review/src/pages/DashboardPage.tsx` | 170 | Dashboard TUI tab | [#132](https://github.com/pszf11235/LGTM/issues/132) |
| `plugins/review/src/domain/patterns.ts` | ~200 | Rule suggestions from review history | [#133](https://github.com/pszf11235/LGTM/issues/133) |
| `plugins/review/src/domain/summarize.ts` | ~150 | AI PR summaries on queue add | [#133](https://github.com/pszf11235/LGTM/issues/133) |
| `plugins/review/src/domain/grouping.ts` | ~180 | Feature grouping by shared files | [#134](https://github.com/pszf11235/LGTM/issues/134) |
| `plugins/review/src/domain/overlap.ts` | ~170 | Overlap detection + review order | [#134](https://github.com/pszf11235/LGTM/issues/134) |
| `plugins/review/src/domain/multi-repo.ts` | ~120 | `owner/repo#42` ref parsing | [#135](https://github.com/pszf11235/LGTM/issues/135) |
| `plugins/review/src/domain/rules-import.ts` | 206 | Import rules from CLAUDE.md etc. | [#136](https://github.com/pszf11235/LGTM/issues/136) |
| `plugins/review/src/domain/rules-export.ts` | 175 | Export rules as git hook / JSON | [#136](https://github.com/pszf11235/LGTM/issues/136) |
| `plugins/review/src/pages/HistoryPage.tsx` | 252 | History TUI tab | [#137](https://github.com/pszf11235/LGTM/issues/137) |
| `plugins/review/src/components/SideBySideView.tsx` | 154 | Side-by-side diff pane | [#138](https://github.com/pszf11235/LGTM/issues/138) |
| `core/src/auth/pkce-flow.ts` | 198 | PKCE browser login | [#139](https://github.com/pszf11235/LGTM/issues/139) |
| `core/src/auth/providers.ts` | 210 | 9-service provider registry | [#139](https://github.com/pszf11235/LGTM/issues/139) |
| `plugins/review/src/pages/ModelPicker.tsx` | 66 | Dead code — no importers | none needed |
| `plugins/review/src/domain/auto-review.ts` | 654 | Raw-LLM review engine | replaced by CLI delegation |

**Total deleted: ~3,660 lines**

## Trimmed, not deleted

| Path | Change | Issue |
|---|---|---|
| `core/src/onboarding/questions.ts` | **Deleted** — zero questions remain | [#140](https://github.com/pszf11235/LGTM/issues/140) |
| `core/src/onboarding/flow.ts` | 751 → ~80 lines: becomes `initStore()`, no questions, no AI discovery, no priority picker, no skip affordance | [#140](https://github.com/pszf11235/LGTM/issues/140) |
| `core/src/onboarding/detect-ai.ts` | 615 → ~80 lines: only the 5-provider availability check. All credential extraction (Keychain, Continue.dev, Aider, Cursor, config files) removed — the CLIs handle their own auth | none — the extraction existed only to feed a raw LLM provider |
| `core/src/config/loader.ts` | `resolveLgtmDir()` always returns `~/.lgtm-farm/` flat. `storageMode` dropped from bootstrap and config | none — central-only was a deliberate simplification |
| `core/src/llm/provider.ts` | Drop `getProviderForTask` and `LLMTaskType` routing; keep the OpenRouter/Ollama HTTP paths | none — routing had 2 call sites, both replaced |
| `plugins/review/src/domain/rules.ts` | Delete `matchLLM()` (~60 lines). LLM-enforced rules become agent prompt context via `rulesAsPromptContext()` | none — behaviour preserved, mechanism changed |
| `plugins/review/src/commands/watch.ts` | No longer posts to GitHub; calls the orchestrator | n/a |
| `plugins/review/src/commands/rule.ts` | Drop `import`, `export`, `suggest` subcommands | [#136](https://github.com/pszf11235/LGTM/issues/136), [#133](https://github.com/pszf11235/LGTM/issues/133) |

## Not built (design decision, not a removal)

| Feature | Why | Issue |
|---|---|---|
| Terminal diff renderer (`review show`) | GitHub's pending review UI anchors comments to diff lines natively and allows editing before submission | [#142](https://github.com/pszf11235/LGTM/issues/142) |
| TUI inline finding annotations | Same reason. `ReviewPage.tsx` is 441 lines of scroll/cursor logic and threading findings through it is high risk for a worse result | [#143](https://github.com/pszf11235/LGTM/issues/143) |

Together these saved ~2.5 hours and removed the need to keep a diff renderer in sync
with GitHub's line numbering.

## Deleted tests

Removed alongside their subjects:

- `plugins/review/src/domain/auto-review.test.ts` (379)
- `plugins/review/src/e2e/auto-review-pipeline.test.ts` (458)
- `plugins/review/src/domain/grouping.test.ts`
- `plugins/review/src/domain/overlap.test.ts`
- `plugins/review/src/domain/patterns.test.ts`
- `plugins/review/src/domain/summarize.test.ts`
- `plugins/review/src/domain/multi-repo.test.ts`
- `core/src/__tests__/preservation.test.ts` (455) — asserted behaviour of removed features
- `core/src/__tests__/bug-conditions.test.ts` (333) — same

New tests land with tasks 3–11 to cover the replacement code.

## Kept — required by the loop

`diff-parser.ts`, `post-review.ts`, `infra/github.ts`, `domain/queue.ts`, `domain/rules.ts`,
`store/okf.ts`, `config/loader.ts`, `store/paths.ts`, `registry/*`,
`commands/smoke.ts`, `commands/ai.ts`, `commands/discover.ts`,
TUI: `Shell.tsx`, `ReviewTab.tsx`, `QueuePage.tsx`, `ReviewPage.tsx`, `RulesPage.tsx`, `DiscoverPage.tsx`, `ConfigPage.tsx`, `AITab.tsx`

## Bugs found during the audit

Fixed as part of this spec rather than filed separately:

1. **Ingest accept never reaches the watcher** — `acceptRepo()` in `registry/reconcile.ts` writes only to `~/.lgtm-ingest-registry.md`. The picker advertises `[a] accept (watch)` but `watch.md` is untouched, so accepted repos are never polled. → Task 2
2. **`watch auto --interval` defaults to 0** — help text says 15, code says `"0"`, so the documented polling never happens unless the flag is passed explicitly. → Task 8
3. **`which` leaks stderr into onboarding output** — provider detection prints `which: no claude in /usr/...` mid-wizard. → Task 1
4. **`lgtm plugins enable <name>` does not exist** — registered as `plugins:enable` with a colon while the help text advertises the space form. → fix in Task 13
5. **`fetchOpenPRs` ignores the stored `filter`** — `watch.md` records `all|assigned|review_requested` but the query is always `state=open`, hardcoded to 10 results with no pagination. → Task 8
6. **`rateLimitThreshold` is never used** — `post-review.ts` accepts it but never reads `X-RateLimit-Remaining`; rate limiting is reactive error-string sniffing only. → moot once posting is a single pending-review call
7. **Cache keys collide across repos** — `cache/pr-42.md` is not repo-qualified. Harmless while storage was per-repo, but a real collision once the store is central. → Task 1

## Posting: the `event` field trap

Worth recording because it has burned other tools. `POST /repos/{owner}/{repo}/pulls/{n}/reviews`
creates a **PENDING** draft only when the `event` field is **absent**. Sending
`event: "COMMENT"` submits the review immediately and irreversibly. There is no
`draft: true` parameter — [anthropics/claude-code#82964](https://github.com/anthropics/claude-code/issues/82964)
documents a live review being published because that parameter was assumed to exist.

The post path must never construct an `event` key. Task 10 requires a code comment
at the call site stating this.

A second constraint: [the API cannot append comments to an existing pending review](https://github.com/orgs/community/discussions/168380).
One round produces one create call produces one draft. Further edits happen in GitHub's UI.

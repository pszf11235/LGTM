# Multi-Agent Watch Review — Implementation Tasks

## Task 1: Agent config loader (OKF)
- [ ] Create `.lgtm/agents/` directory convention
- [ ] Create `packages/plugins/review/src/domain/agent-config.ts`
- [ ] Define `AgentConfig` interface: name, prompt, severity, model, enabled, priority
- [ ] Implement `loadAgentConfigs(lgtmDir)` — reads all `.md` files from `agents/` dir
- [ ] Ship 2 default agent configs: `security.md` + `architecture.md`
- [ ] Support global agents at `~/.lgtm-farm/agents/` (fallback if no local)
- [ ] Tests: load configs, parse OKF, handle missing dir gracefully

## Task 2: Agent worker process
- [ ] Create `packages/plugins/review/src/workers/review-agent.ts` (standalone entry point)
- [ ] Worker reads JSON from stdin: { diff, agent, rules, pr, profile }
- [ ] Worker creates LLM provider from agent config (model, key resolution)
- [ ] Worker calls `generateAutoReview()` with the agent's prompt injected
- [ ] Worker outputs JSON to stdout: { agent, findings, stats, error }
- [ ] Handle timeout: exit gracefully on SIGTERM
- [ ] Handle errors: output `{ error: "message" }` and exit 1
- [ ] Tests: worker produces valid JSON for sample input

## Task 3: Orchestrator — spawn and collect
- [ ] Create `packages/plugins/review/src/domain/orchestrator.ts`
- [ ] Implement `runAgentReview(pr, diff, agents, rules, profile)`:
  - Spawn N child processes (one per agent config)
  - Write input JSON to each worker's stdin
  - Collect stdout JSON from each (with timeout)
  - Handle failures: log error, continue with others
  - Return: all findings grouped by agent
- [ ] Configurable timeout per agent (default 120s)
- [ ] Configurable max parallel agents
- [ ] Tests: orchestrator handles N agents, timeout, crash

## Task 4: Save findings locally (OKF)
- [ ] Create `packages/plugins/review/src/domain/review-store.ts`
- [ ] Save findings to `.lgtm/reviews/<pr-number>/agent-<name>.md` (OKF)
- [ ] Load findings for a PR: `loadAgentFindings(store, prNumber)`
- [ ] Mark finding as posted: `markFindingPosted(store, prNumber, agent, findingIdx)`
- [ ] Mark finding as discarded: `markFindingDiscarded(store, prNumber, agent, findingIdx)`
- [ ] Dedup: don't save duplicate findings (same file+line+agent)
- [ ] Tests: save/load round-trip, dedup, mark posted

## Task 5: Wire into watcher
- [ ] Update `watch auto` command to use orchestrator instead of direct `generateAutoReview()`
- [ ] Load agent configs at start of cycle
- [ ] For each new PR: spawn agents via orchestrator, save findings locally
- [ ] Do NOT post to GitHub automatically (local-first)
- [ ] Show summary: "PR #42: 2 agent reviews complete (3 findings)"
- [ ] Respect `autoReview` config in `watch.md` (enabled, agentCount, agents list)
- [ ] `lgtm review auto --pr 42 --agents` triggers agent review for a specific PR

## Task 6: TUI — show agent findings on diff
- [ ] Update ReviewPage to load agent findings for the current PR
- [ ] Display findings as inline annotations on diff lines
- [ ] Color/icon per agent: 🔒 security (red), 🏗 architecture (yellow), etc.
- [ ] Show finding count in queue page: "[🔒 2, 🏗 1]"
- [ ] Keyboard: `p` post finding, `x` discard, `e` edit, `P` post all
- [ ] After posting: mark in OKF, change annotation to "✓ posted"
- [ ] After discarding: remove annotation

## Task 7: Selective posting
- [ ] Implement `postApprovedFindings(store, prNumber, github)`:
  - Collect all findings where `posted: false` and not discarded
  - Batch into one GitHub review (COMMENT event)
  - Mark all as `posted: true` in OKF
- [ ] Wire `p`/`P` keys in TUI to call this
- [ ] Support CLI posting: `lgtm review post 42` posts all unposted findings
- [ ] Support agent filter: `lgtm review post 42 --agent security`
- [ ] Support dry-run: `lgtm review post 42 --dry-run`
- [ ] Tests: selective posting, batch creation, marking

## Task 8: Per-PR agent count override
- [ ] Add `--agents <count>` or `--agents <names...>` flag to `lgtm review auto`
- [ ] If count > configured agents: reuse agents with different temperature
- [ ] If names specified: only run those agents
- [ ] Default from `.lgtmrc.yaml`: `watch.auto_review.agent_count`
- [ ] Tests: override works, count clamping

# LGTM v1 decision log

Date: 2026-08-29
The record of the requirements session behind [requirements.md](requirements.md). The spec states outcomes; this file keeps the reasoning, so none of it gets re-litigated from scratch. Format per entry: what was decided, then why. The five decisions that are hard to reverse and the result of real trade-offs also have formal records in [docs/adr/](../adr/); the project glossary lives in [CONTEXT.md](../../CONTEXT.md).

## Delivery mechanism

**Decided: hybrid, staged.** A Bun daemon with a localhost web UI ships in v1; a thin signed Swift menu-bar shell follows in v1.1 against the same status API.

Three designs were developed independently (local web app, native menu-bar app in Tauri, hybrid) and scored by two judges with different mandates. Both picked the hybrid. The native app lost because macOS notarization, sidecar signing, and a Rust shell land in the v1 critical path for a solo TypeScript developer, and because a tray-owned watcher dies when the tray quits. The pure web app lost the tiebreak because a dead daemon is silent in that shape, and its own contingency plan was to grow a tray, which is the hybrid. Prior art (Ollama, Syncthing, Docker Desktop) converges on the same split: daemon binds 127.0.0.1, UI is disposable, tray is thin status.

Consequences kept in the spec: plain compiled binaries skip Gatekeeper, so Apple signing only ever touches the small v1.1 shell; launchd owns the daemon so every UI is optional; the status API is shaped as the tray's contract from day one.

## Scope

**Watch + review + post.** No verification passes over posted findings in v1. Re-review on new commits injects prior findings as do-not-repeat context, which is a prompt block, not the verify machinery.

**One agent, the Claude CLI.** codex is a v1.x configuration addition behind the same provider interface. Multi-agent orchestration and cross-agent dedup wait until a second agent exists.

**No submit path at all.** The old `review submit` command is not ported. GitHub's UI does submission better, and a codebase with zero publish-capable code paths is a stronger claim than one guarded publish path.

**Forge-agnostic later, GitHub-only now.** A `ForgeAdapter` interface is the seam; GitLab's draft-note model differs enough that the adapter boundary is where that difference will live.

**Manual watch list.** Disk discovery dies; it was the buggiest old subsystem and answered the wrong question (what is on disk versus what is on GitHub). A GitHub-API repo picker is deferred.

## Triage model

**Auto-review classes: own PRs, requested reviewer, assignee, @mention in title or description.** Everything else in a watched repo waits in a triage inbox for a manual skip-or-review call. Comment-mention scanning and the notifications API are deferred until real mentions get missed.

**Drafts hold until ready**, with a manual override. Reviewing WIP burns quota on code the author knows is unfinished.

**Skip is sticky.** New commits do not resurrect a skipped PR; a skipped filter with unskip keeps it one click away. Resurrection would turn skip into snooze.

**Backfill asks.** Adding a repo lists its open PRs with author, size, age, conflict and CI state; auto-class rows arrive pre-selected but nothing runs until confirmed. Auto rules apply only to activity after watching begins.

## Quota

**Gate on real usage, not estimates.** `claude -p "/usage"` was verified live: non-interactive, zero tokens and turns consumed, roughly four seconds, and it returns the same window percentages as the /usage screen. Defaults: pause new dispatches above 70% of the highest window, resume below 60% or on a parsed reset. The output format is undocumented, so the parser fails closed into a daily-cap fallback (20 runs) with the active mode logged. Richer local estimation (ccusage-style) was considered and deferred; the cap is the actual safety mechanism.

**Pacing: 15-minute poll, two concurrent provider runs, 10-minute per-run timeout.** Configured in one file, no flag zoo.

## Store and stack

**Markdown plus frontmatter stays.** Human-readable, greppable, portable was a stated requirement. Same `~/.lgtm-farm/` root, new nested layout, no migration; old review dirs are transient artifacts, not data.

**Bun >= 1.3.13, React 19, shadcn/ui, Tailwind v4.** shadcn was requested so the UI is mostly stock components. Verified constraints: production builds must use the `Bun.build()` JS API because the CLI ignores bundler plugins and emits an unstyled binary, and the 1.3.13 floor exists because the Tailwind-mangling `@layer` bug was a 1.3.0 regression fixed there.

**Polling, not webhooks.** GitHub webhooks require a public HTTPS endpoint a home daemon does not have, and no public streaming API exists. Conditional requests make polling nearly free (a 304 costs no rate limit). A webhook relay is deferred to a hypothetical team setup.

## Process

**Clean-slate `v2` branch.** First commit removes everything except LICENSE and .gitignore, including all of `.kiro/`. Old code stays reachable on `main` as the porting reference; dead code living alongside new code is how the last codebase grew three repo registries.

**Battle-tested modules port with their tests.** Diff parser, tolerant output parser, draft-review poster, finding-key rules, frontmatter layer. The spec's ported-modules table carries exact old paths and test counts.

**Spec-first, in `docs/spec/`.** The old repo's own history showed specced features holding up best; only the Kiro branding goes.

## Verification carried into the spec

An adversarial review pass (four critics: decision fidelity, technical claims, consistency, style) ran before sign-off and fixed 48 findings, including five design blockers: held findings that could never be posted again, a pending-review id that was never cleared after submission, an unreachable draft-to-ready transition, unretryable failed rounds with no crash recovery, and closed/reopened PRs having no representation. The remaining known unknown is deliberate: whether `claude -p` with the bundled review command works from a directory outside any checkout is the first M0 task, because the old code always ran inside a local clone and v1 has no clones.

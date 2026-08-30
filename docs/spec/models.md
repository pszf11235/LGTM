# Which model to run a task on

Date: 2026-08-30
Written before the build as a prediction, then corrected against what the
build actually did. The second half is the part worth reading.

## The rule

Tier follows the blast radius of a *subtle* mistake, not the size of the task.
A one-line pid check and a whole SPA belong on the same tier if their worst
quiet failure costs the same.

A cheap model is safe exactly where verification catches its mistakes. That
makes ported code with its ported tests the cheapest work in the project,
because the tests carry the original author's insight and the porting model
does not need to understand the trap being guarded.

The corollary is what people get wrong. Tests written in the same pass as the
code inherit that model's blind spots, so "it has tests" only buys a cheaper
tier when someone else wrote them.

## Assignments

**Haiku.** Verbatim ports whose old suites come with them (frontmatter layer,
PR reference parsing), git mechanics, config round trips, the fake CLI shim,
the notifier, and button-to-endpoint wiring where a mistake is obvious on the
first click.

**Sonnet.** The scaffold and toolchain, the store layout, path probing,
backfill, diff snapshots, the rendezvous file, CLI clients, the SPA views,
launchd, and any public prose.

**Opus.** Eight places where a mistake is quiet and expensive:

| Task | Why |
|---|---|
| The provider spike | Cheap to run, expensive to misread, and everything downstream is built on the conclusion |
| GitHub adapter | The only module that speaks to the forge, and a 304 misread as an empty list marks every PR closed |
| Draft review | The product's one promise, and the meta-test guarding it can be written hollow |
| Scheduler | A stuck guard stops all polling silently |
| Review queue | Latest-SHA-wins races; a lost entry means a PR is never reviewed |
| Quota gate | Failing open spends the user's own subscription |
| Poll cycle | The largest state machine, and the spec's own bullets contradict the requirements |
| Post flow | The only path that writes to GitHub |

**Fable.** Nothing. Two assessors argued for it on the posting tasks, on the
grounds that a mistake there lands publicly. That premise is wrong by
construction: no code path can publish, a pending draft is visible only to its
author, and the invariant is pinned by verbatim-ported tests. Opus plus five
minutes of human attention on the safety tests is the better spend. Fable
earns its cost reviewing finished work, not writing it.

## What the build actually showed

Roughly forty agent-tasks ran across six waves. The tier map held up, with one
large exception.

**Opus earned it on the tasks it was given.** The scheduler agent hit the
silent-stop bug in its own first draft: a cycle that throws synchronously never
reaches an await, so its `finally` clears the in-flight slot before the promise
is published, wedging shutdown forever. Its own tests hung rather than failed,
which is how it found it. The cycle agent refused an instruction of mine that
would have broken backfill, and refined it correctly. The draft-review agent
read a freshly ported diff parser it did not own and found a phantom trailing
line that would have made GitHub reject entire reviews.

**Cheap tiers were fine, and one of them shipped the worst bug.** The phantom
line came out of a Haiku port. Its 28 ported tests all passed, because the bug
lived in behaviour the old suite never asserted. That is the honest limit of
"ported tests make it safe": they protect what someone once thought to check.

**Opus still ships bugs.** The post-flow agent marked findings posted before
the create call rather than after, so a failed post would leave LGTM believing
it had posted a review GitHub never saw. Its own tests caught it. Tier buys a
better error rate, never immunity, which is the argument for tests over trust
at every tier.

**The real failures were at the seams, and no tier addresses them.** Every
agent owned files; nobody owned the joins between them. Running the binary
found what 1050 passing tests could not:

- `lgtm up` was still a stub, so no entry point ever called the daemon
- the API router was never mounted on the server the daemon binds
- `App.tsx` imported none of the four views it was supposed to render
- the post routes were never spliced into the route table
- the CLI could not perform a single write, because it sent no Origin header

None of that is a model-quality problem, and buying a dearer tier would not
have prevented any of it. The lesson is about orchestration. Give someone the
seams, hold the commits centrally, and run the thing before believing it.

## Practical mechanics

Verified against Claude Code 2.1.250.

- `/model <alias>` switches mid-session and saves the choice; pressing `s` in
  the picker switches for the session only.
- `opusplan` plans on Opus and executes on Sonnet, which suits milestones where
  the design is hard and the code is small.
- Subagents take a per-call model override, so a Sonnet session can farm ports
  out to Haiku without touching the session model.
- `--effort low|medium|high|xhigh` is a second cost lever, independent of tier.
- Anthropic publishes no per-model burn multipliers for subscription plans. API
  prices give the ratios: Fable is twice Opus, Opus about 1.7 times Sonnet,
  Sonnet two to three times Haiku. Historical subscription burn ran steeper
  than list price suggests.

## How to spend it

Run Sonnet by default. Switch to Opus for the eight tasks above. Farm verbatim
ports to Haiku. Save Fable for reviewing a finished milestone, where its
self-verification pays, rather than for writing one.

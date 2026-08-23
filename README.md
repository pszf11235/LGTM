# 👍 LGTM — Looks Good To Me

[![CI](https://github.com/pszf11235/LGTM/actions/workflows/ci.yml/badge.svg)](https://github.com/pszf11235/LGTM/actions/workflows/ci.yml)

> AI agents let you open five PRs in an hour. Now **you** have to review them.

LGTM watches your repositories, reviews new pull requests with the AI CLI you already have installed, and leaves the findings on your disk. Nothing reaches GitHub until you say so, and when it does it arrives as a **draft review** you can edit comment by comment before submitting.

Built with [Kiro](https://kiro.dev). [How that actually went](#built-with-kiro),
drift included.

## The loop

```
lgtm discover --ingest        find local repos, pick which to watch
        ↓
lgtm watch                    every 15 min: new PR? new commits?
        ↓                     review via claude / codex / kiro / openrouter / ollama
   ~/.lgtm-farm/reviews/       findings land here as markdown. nothing posted.
        ↓
lgtm review list              read them, drop the ones you disagree with
        ↓
lgtm review post <pr>         creates a PENDING review on GitHub
        ↓
   github.com                 a draft only you can see, each comment on its line
        ↓                     edit the wording, delete what you like, hit Submit
lgtm watch                    new commits? verify what you raised, then review again
```

The second `lgtm watch` is the part that makes this a loop rather than a one-shot: when a PR gets new commits, LGTM first asks whether the findings you already posted were addressed, records the verdicts, and then reviews again while telling the agent what it already said.

## Why a draft review

Findings are worthless if you can't edit them before your teammates see them, and a terminal is a bad place to read a diff.

`POST /pulls/{n}/reviews` **without** an `event` field creates a review in `PENDING` state. That review is visible only to you, anchors every comment to the right line of the diff, and stays fully editable in GitHub's own UI until you click Submit. So LGTM's job ends at producing a good draft in the best review surface that already exists.

This is also the single most dangerous line in the codebase, because sending `event: "COMMENT"` publishes immediately and there is no `draft: true` parameter to fall back on. It is asserted in tests rather than trusted:

```ts
expect("event" in request.body).toBe(false);
```

The GitHub adapter has no function that can publish a review at all. The one
place an `event` is ever sent is `submitPendingReview()`, which runs only when
you type `lgtm review submit`.

## Built with Kiro

Specs are in [`.kiro/specs/`](.kiro/specs/), one directory per feature, each with
`requirements.md`, `design.md` and `tasks.md`.
[`.kiro/steering/workflow.md`](.kiro/steering/workflow.md) holds the standing
rules: atomic commits, conventional messages, one task per branch, and a PR is
not done until CI is green.

The honest version of how that went, because the git history shows it either way.

**It started spec first.** The second commit in the repo, before any real code,
was a full spec: `requirements.md`, `design.md` and `tasks.md`, 1453 lines, for
what was then called `pr-review-harness` and is now
[`.kiro/specs/lgtm/`](.kiro/specs/lgtm/).

**Then it drifted.** Between 17 and 21 August there are 81 commits and not one
`spec:` commit among them. I kept building and leaned on Kiro, half expecting it
to hold the spec-driven line for me. It did not, and it was never going to. It
followed where I pointed it, and I was pointing it at code. That is the part I
would do differently: the discipline has to come from the person, and the steering
file is where you put it.

**Then a real bug pulled it back.** `lgtm init` had five separate defects tangled
together, and poking at them individually was not working. Kiro's bugfix workflow
was the right tool:
[`init-onboarding-improvements`](.kiro/specs/init-onboarding-improvements/) is
`workflowType: requirements-first`, `specType: bugfix`, with each defect written
down as current behaviour versus expected before anything was touched, and
`tasks.meta.json` carrying 27 execution records. Naming five bugs properly turned
out to be most of fixing them.

**Then the bigger features went back through specs**, and that is where the
cadence actually holds. Every `spec:` commit in this repo is from 22 or 23 August:

| Spec | Spec commit | What it produced |
|---|---|---|
| [`tui-ux-redesign`](.kiro/specs/tui-ux-redesign/) | `7170f70` | keyboard model, scrolling, the Repos page |
| [`multi-agent-watch-review`](.kiro/specs/multi-agent-watch-review/) | `4730eb8` | one OS process per agent, so a hung provider cannot take the watcher down |
| [`codebase-quality-improvements`](.kiro/specs/codebase-quality-improvements/) | `f6aeb28` | the removals pass, deleting the code that posted straight to a PR |
| [`mvp-review-pipeline`](.kiro/specs/mvp-review-pipeline/) | `5e57278` | provider dispatch, the on-disk review store, `lgtm review pr` |
| [`mvp-review-pipeline`](.kiro/specs/mvp-review-pipeline/) | `4050c28` | PENDING-only posting, the central store, zero-question `init` |

The last row is the clearest one. `4050c28` wrote down the decision to post a
draft and nothing else at 13:42 UTC. `cc1c051` implemented it at 14:19 and
collapsed onboarding from 751 lines to about 80, because the spec had already
decided `init` would ask nothing.

The decision this whole tool is built around, that LGTM produces a draft review
and never a published one, was argued out in
[`mvp-review-pipeline/design.md`](.kiro/specs/mvp-review-pipeline/design.md)
before any of the posting code existed.
[`removals.md`](.kiro/specs/mvp-review-pipeline/removals.md) in the same spec is
the list of things Kiro was told to delete rather than build, and it is most of
why this is a small tool instead of a large one.

So: spec, drift, debug, realign. The specs that were written before the code are
the features that came out clean, and the stretch with no specs is where the
review later found the most bugs. That is not a coincidence and it is the useful
thing I learned.

## Install

### Binary, no runtime needed

`curl -f` so a missing asset fails loudly instead of writing the 404 body to disk.

```bash
# macOS (Apple Silicon)
curl -fL https://github.com/pszf11235/LGTM/releases/latest/download/lgtm-darwin-arm64 -o lgtm

# macOS (Intel)
curl -fL https://github.com/pszf11235/LGTM/releases/latest/download/lgtm-darwin-x64 -o lgtm

# Linux (x64 / arm64)
curl -fL https://github.com/pszf11235/LGTM/releases/latest/download/lgtm-linux-x64 -o lgtm
curl -fL https://github.com/pszf11235/LGTM/releases/latest/download/lgtm-linux-arm64 -o lgtm

chmod +x lgtm && sudo mv lgtm /usr/local/bin/
```

Checksums are published with each release as `checksums-sha256.txt`.

### From source

Needs [Bun](https://bun.sh). Takes about a minute.

```bash
git clone https://github.com/pszf11235/LGTM.git && cd LGTM
bun install
bun run build:binary   # → dist/lgtm
```

## Quick start

```bash
lgtm init                 # creates ~/.lgtm-farm. asks nothing.
lgtm ai discover          # which review provider will be used?
lgtm discover --ingest    # find local repos, pick which to watch
lgtm watch --once         # one pass now, instead of waiting 15 minutes
lgtm review list          # what was found
lgtm review post owner/repo#42 --dry-run   # exactly what would be sent
lgtm review post owner/repo#42             # create the draft
```

Then open the PR on GitHub, edit the draft, and submit it. Or `lgtm review submit owner/repo#42` if you would rather not leave the terminal.

You need a GitHub token. `GITHUB_TOKEN` is used if set, otherwise `gh auth token`, so if you already use the GitHub CLI there is nothing to configure and no OAuth app to register.

## Review providers

LGTM does not implement code review. Claude's `/review` already runs a multi-agent pass with false-positive filtering, and Codex ships a model trained for it, so LGTM shells out to whichever CLI you already have authenticated and layers your prompt on top of its built-in review skill.

| Provider | How it's detected | Notes |
|---|---|---|
| `kiro-cli` | binary + `KIRO_API_KEY` | headless mode needs the key |
| `claude-cli` | `claude` on PATH | uses its own `/review`, best results |
| `codex-cli` | `codex` on PATH | uses its own `/review` |
| `openrouter` | `OPENROUTER_API_KEY` | raw API, any model |
| `ollama` | `localhost:11434` answers | local and private |

`provider: auto` picks the first available in that order. Run `lgtm ai discover` to see what it resolves to and what to fix.

Your subscription stays yours: LGTM spawns the official CLI, which authenticates itself. It never reads the OAuth tokens those tools store, which for Anthropic would also breach their terms.

## The review prompt is a file, not code

Reviews are written by whatever is in `~/.lgtm-farm/agents/reviewer.md`. Edit the `prompt` field and the next review reads differently. No rebuild, no flag.

```markdown
---
name: reviewer
provider: auto          # auto | kiro-cli | claude-cli | codex-cli | openrouter | ollama
model: null             # only used by openrouter and ollama
severity: high          # minimum severity to record
timeout: 300
enabled: true
prompt: |
  Focus on high and critical issues only.
  Use my tone and voice: concise, actionable, no fluff, dev to dev.
  Never use em dashes or semicolons.
  Do not spell out the severity in the comment body.
  Cite the exact file and line for every finding.
---
```

**Two reviewers on one PR:** copy the file to `agents/second.md` and give it a different `provider`. Each enabled agent runs in its own process, so they run in parallel, and if two agents are both on `auto` they are assigned different providers, because two identical reviews read as corroboration and aren't.

## What's on disk

Everything is markdown with YAML frontmatter. One store serves every repository, so review directories and frontmatter both carry the repo.

```
~/.lgtm-farm/
  agents/reviewer.md                  the review prompt
  watch.md                            repos being polled
  rules/                              regex rules and prompt-context rules
  reviews/
    pszf11235-LGTM-42/
      meta.md                         rounds, last reviewed SHA, draft review id
      r1-reviewer.md                  round 1 findings
      r2-reviewer.md                  round 2, after new commits
    someorg-backend-108/              a different repo, same store
```

A finding carries its own state, which is what makes the human gate work:

```yaml
findings:
  - id: f1
    file: src/auth.ts
    line: 42
    severity: critical
    comment: Hardcoded API key. Move it to an env var before this ships.
    posted: true
    pendingReviewId: 2847362
    discarded: false
    resolved: true
    resolvedNote: Replaced with process.env.API_KEY in a1b2c3d
```

Finding ids are stable, so `lgtm review discard 42 -f f3` means the same finding tomorrow. A discarded finding stays on disk marked discarded rather than disappearing, and a finding whose line is no longer in the diff is held back rather than dropped, because GitHub rejects an entire review if one comment targets a line it cannot find.

## Rules

Rules live in `~/.lgtm-farm/rules/` and come in two kinds.

- **regex** runs locally against added lines. Free, instant, and produces findings directly.
- **llm** is appended to the review agent's prompt. The agent already has the diff in front of it, so this costs nothing extra.

```bash
lgtm review rule add "No hardcoded secrets" \
  --pattern '(api_key|secret)\s*=\s*"[^"]{8,}"' --category security --severity error
lgtm review rule import CLAUDE.md          # reuse rules you already wrote
lgtm review rule export --format hook -o .git/hooks/pre-commit
lgtm review scan                           # regex rules against the whole repo
```

## Commands

| Command | Description |
|---|---|
| `lgtm` | Open the TUI |
| `lgtm init` | Create the store. No questions. |
| `lgtm config` | Store location, agents, resolved settings |
| `lgtm smoke` | Self-test, 12 checks |
| `lgtm ai discover` | Which review providers are available |
| `lgtm discover --ingest [dir]` | Find local repos and pick which to watch |
| `lgtm discover --prune` | Forget repos no longer on disk |
| `lgtm watch [--interval 15]` | Poll and review. Posts nothing. |
| `lgtm watch --once` | A single pass, good for cron |
| `lgtm review watch add owner/repo` | Watch a repo directly |
| `lgtm review pr <ref> [--force]` | Review one PR now, including unwatched repos |
| `lgtm review list [<ref>]` | Findings for a PR, or every PR with findings |
| `lgtm review post <ref>` | Create the draft review on GitHub |
| `lgtm review post <ref> --dry-run` | Print the exact request, send nothing |
| `lgtm review submit <ref>` | Submit the draft |
| `lgtm review discard <ref> -f f2 f3` | Drop findings so they are never posted |
| `lgtm review rule ...` | add / list / enable / disable / import / export / suggest |

Every `<ref>` accepts `owner/repo#42`, a pasted GitHub URL, or a bare `42` when it is unambiguous. When it isn't, LGTM prints the exact commands that would be.

Finding ids restart at `f1` in every round, so once a PR has been reviewed twice
a bare `f1` names two different findings. `discard` refuses an ambiguous id and
prints the qualified `round:agent:id` forms to use instead.

## The TUI

`lgtm` with no arguments opens a terminal UI over the same store the CLI uses.
Tab or the arrow keys move between pages.

| Page | Shows |
|---|---|
| Dashboard | open PRs in watched repos that need attention |
| Review | PRs with findings on disk, and the findings themselves |
| Rules | the regex and prompt rules in `~/.lgtm-farm/rules/` |
| Repos | git repos found on disk, and which are watched |
| Config | store location, agents, resolved settings |
| Scan | results of the last `lgtm review scan` |
| AI | which review providers are available, and what `auto` resolves to |

It is a reader. Reviewing, posting and submitting are deliberate acts, so they
stay in the CLI where they are explicit and scriptable.

## Verify it works

```bash
bun install
bun run lint            # tsc --noEmit
bun test                # 420 tests
bun run build:binary
./dist/lgtm smoke       # 12 checks, exits non-zero on failure
```

`lgtm smoke` spawns a real review worker subprocess, because the way a worker is reached differs between running from source and running the compiled binary, and getting that wrong would break reviews only in the artefact users actually download.

See [TESTING.md](TESTING.md) to exercise the loop without a GitHub token or a paid provider.

## Architecture

```
packages/core/                 CLI, TUI, store, provider detection
  src/ai/providers.ts          which review CLI is available
  src/store/agents.ts          the agent config format
  src/store/paths.ts           repo-qualified review paths
  src/registry/                local repo discovery, watch list
packages/plugins/review/
  src/domain/orchestrator.ts   one process per agent
  src/domain/providers.ts      invoke a CLI, normalise whatever it prints
  src/domain/watch-cycle.ts    decide: review, re-review, or skip
  src/domain/review-store.ts   findings, rounds, posted state
  src/domain/pending-review.ts the draft review contract
  src/workers/review-agent.ts  worker: JSON in, JSON out
```

Thin core, domain logic in plugins. A plugin can claim a top-level command name, which is why the main loop is `lgtm watch` and not `lgtm review watch auto`.

Five CLIs have five output conventions and none promise stability across versions, so provider output is parsed by trying six shapes in order: a bare JSON array, a `{findings}` object, a fenced block, Claude's `--output-format json` envelope, prose shaped like `file:line severity comment`, then giving up and recording the raw output for debugging. Embedded JSON is found by counting brackets outside string literals, because a brace inside a comment breaks a regex.

## Development

```bash
bun run lgtm            # run from source
bun test                # tests
task check              # lint + test + build
task reset              # wipe the store and start fresh
```

## Tech stack

Bun, TypeScript (strict), Ink for the TUI, markdown + YAML frontmatter for storage, raw `fetch` for GitHub and the HTTP providers, `simple-git` for git.

## Roadmap

Filed as issues rather than promised here: a web UI to replace the TUI ([#126](https://github.com/pszf11235/LGTM/issues/126)), a work tracker over the stored findings ([#127](https://github.com/pszf11235/LGTM/issues/127)), ClickUp ticket context ([#128](https://github.com/pszf11235/LGTM/issues/128)), a terminal diff renderer ([#142](https://github.com/pszf11235/LGTM/issues/142)), inline TUI annotations ([#143](https://github.com/pszf11235/LGTM/issues/143)), Ollama auto-setup ([#123](https://github.com/pszf11235/LGTM/issues/123)), and specialised agent prompts ([#124](https://github.com/pszf11235/LGTM/issues/124)).

## License

MIT

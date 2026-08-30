# LGTM

AI coding agents make it easy to open five pull requests in an hour. Reviewing them is still your job. LGTM watches your repositories, sends each new PR through the AI CLI you already pay for, and writes what it finds to disk. Nothing reaches GitHub until you look at the findings yourself and decide, PR by PR, what's worth posting.

## The loop

A background daemon polls your watched repositories on a timer, 15 minutes by default. For each open pull request:

1. **Classify.** A PR you authored, were requested to review, were assigned, or are @-mentioned in gets queued automatically. Everything else waits in a triage inbox until you tell it to review or skip.
2. **Review.** Queued PRs go to the Claude CLI in print mode, one round per head commit. Findings, one per file and line, each with a severity, a comment, and an optional suggestion, land in a markdown file in the store.
3. **Gate.** You open the local web UI, read each finding next to the diff hunk it's about, and discard whatever isn't worth raising.
4. **Post.** What's left goes up as one pending draft review on GitHub. You open that draft in GitHub's own editor and submit it yourself, or don't.

New commits on a PR LGTM already reviewed start a fresh round. The prompt tells the CLI what it already raised so it doesn't repeat itself, but there's no separate pass that re-checks old findings once they're posted (see [Status](#status)).

## Why a draft review is the whole point

A review LGTM creates on GitHub is visible only to you, editable comment by comment, and does nothing until you submit it yourself in GitHub's UI. There's no submit command in this codebase and no function anywhere that sends the `event` field GitHub needs to publish a review. There's no flag and no override for it either: LGTM can create a pending review and delete one, and that's the entire GitHub write surface it has. The reasoning is in [ADR 0001](docs/adr/0001-draft-only-posting.md); the tests that hold the line are the "no publish path" assertions on the forge adapter.

## Install and first run

LGTM ships as one Bun-compiled binary. Build it:

```bash
bun run build.ts
```

That writes `dist/lgtm`. The commands you'd run day to day:

```bash
lgtm up                     # run the daemon in the foreground
lgtm install                # register it with launchd so it survives reboots
lgtm open                   # open the web UI, already authenticated
lgtm watch add owner/repo   # start watching a repository
```

`lgtm open` finds the running daemon and launches your browser with a bearer token in the URL fragment; the page moves it to local storage and strips it from the address bar on load. Adding a repository, from the Repos view or with `watch add`, triggers a backfill: you see its currently open PRs with the auto-class ones pre-selected, and nothing auto-queues until you confirm the list. `lgtm status` reports daemon liveness, the last cycle, queue depth, and quota state, and exits non-zero when nothing is running.

Read [Status](#status) before you try this. The daemon runs, but it has not yet been pointed at a real repository.

## The store

Everything LGTM knows lives at `~/.lgtm-farm/` as markdown files with YAML frontmatter, plain text you can grep, open in an editor, and hand-edit. The daemon is the only writer, but it's built to watch the directory too, so an edit you make by hand shows up in the UI without a restart.

```
~/.lgtm-farm/
  token                        bearer token for the API, mode 0600
  daemon.json                  port, pid, start time
  config.md                    interval, quota thresholds, concurrency, binary path pins
  watch.md                     the repositories being polled
  agents/reviewer.md           the review prompt, yours to edit
  templates/review-body.md     the posted review's body template
  reviews/<owner>/<repo>/pr-<n>/
    meta.md                    state, classification, head SHA, round count
    r<N>-<agent>.md            one file per review round, findings in frontmatter
    diff-<sha>.patch           a snapshot of the diff at each reviewed head
  logs/daemon.log
```

`agents/reviewer.md` is the file worth opening first. It's the block of instructions the daemon appends to the CLI's built-in review command, written in your own words, not shipped as a fixed prompt.

## What it needs

One AI CLI, already installed and signed in. v1 supports the Claude CLI only, pinned to 2.1.233 or later, since earlier versions break the bundled review command in print mode. LGTM runs it against your existing subscription. It never reads your credentials and never calls a raw completions API directly; it spawns the CLI you already use for your own coding and reads back whatever it prints. GitHub auth resolves from `GITHUB_TOKEN` or `GH_TOKEN`, then `gh auth token`, then a saved credential file.

v1 targets macOS only (`lgtm install` writes a launchd LaunchAgent). [ADR 0002](docs/adr/0002-delegate-reviews-to-installed-clis.md) covers why review is delegated to an installed CLI instead of calling an API directly, and [ADR 0003](docs/adr/0003-daemon-plus-local-web-ui.md) covers why this is a background daemon with a web UI instead of a native app.

## Status

This is a ground-up rebuild on the `v2` branch. The typecheck is clean, the test suite passes, the binary builds, and the daemon runs: it creates its store, binds loopback, serves the UI and the API, polls on a schedule, and shuts down cleanly. What it has never done is watch a real repository or post a real draft review. Every run so far has been against an empty store with no GitHub token, so the first review round and the first post are still ahead. Read [docs/spec/status.md](docs/spec/status.md) for the specifics, milestone by milestone.

## Learn more

- [docs/spec/requirements.md](docs/spec/requirements.md), what v1 does and what it deliberately doesn't
- [docs/spec/design.md](docs/spec/design.md), how it's built
- [docs/architecture.md](docs/architecture.md), where data lives and the lines it cannot cross
- [docs/spec/tasks.md](docs/spec/tasks.md), the milestone plan (its checkboxes lag reality; [status.md](docs/spec/status.md) is the current record)
- [docs/spec/decisions.md](docs/spec/decisions.md), why, in the words of the session that decided it
- [docs/spec/models.md](docs/spec/models.md), which model tier each kind of task needs, and what the build showed about that
- [docs/adr/](docs/adr/), the five decisions that were hard to reverse
- [CONTEXT.md](CONTEXT.md), the project glossary
- [TESTING.md](TESTING.md), running the suite and driving the review loop offline

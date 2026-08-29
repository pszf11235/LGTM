# Spike: does the Claude CLI review a PR from outside a checkout?

Date: 2026-08-29
Task: M0, first item. The provider design in [design.md](design.md) rests on this, because
the old codebase always spawned the CLI inside a local clone and v1 has no clones.

## Question

Can `claude -p` review a pull request given only its URL, from a working directory that is
not a git repository, and does its output survive the tolerant parser?

## Method

Two real runs against a real PR (`pszf11235/LGTM#147`, two files changed) from a scratch
directory with no `.git` anywhere above it. CLI version 2.1.250.

1. Bare invocation: `claude -p "/review <url>" --output-format json`
2. Production-shaped prompt: the same, plus appended instructions and the JSON contract from
   design.md's prompt assembly, with `--model sonnet` pinned.

## Results

Both runs exited 0 and returned real findings that cited `file:line` and were checked against
the repository's own history. The premise holds: **the CLI fetches the PR itself and needs no
local checkout.**

| | Run 1 (bare) | Run 2 (contract + pinned model) |
|---|---|---|
| Model | session default, `claude-opus-5[1m]` | `claude-sonnet-5` |
| Wall clock | 5m44s | 5m40s |
| Cost | $1.55 | $0.77 |
| Output shape | prose, markdown list items | fenced ```json block, exactly the requested schema |

## What this changes

**Pin the model explicitly.** Run 1 inherited the session default and cost twice as much for
the same work. A daemon reviewing every PR on an inherited default would burn the user's
subscription on a choice nobody made. The model becomes an agent-config field.

**The JSON contract works, and the prose fallback still earns its place.** With the contract
appended the CLI emitted the exact schema inside a fenced block, so the fenced-JSON strategy is
the primary path. Without it, findings arrived as prose list items shaped
`` - `README.md:75` — comment ``. Since a future CLI release can drift back toward prose, the
fallback chain is not decoration.

**Six minutes is the real duration for a small PR.** The 10-minute timeout stands, but it is
not generous, and it means a review is minutes of wall clock rather than seconds. Concurrency
of 2 with a 15-minute poll is the right shape.

**Close stdin when spawning.** Both runs warned `no stdin data received in 3s` until stdin was
redirected from /dev/null.

## Consequence for the parser

Strategy order confirmed by evidence: unwrap the CLI's JSON envelope (the review text lives in
its `result` field), then look for a fenced JSON block, then bare JSON, then the prose form.
Anything unparseable becomes a failed round with a `.raw.txt` dump, never a silent zero.

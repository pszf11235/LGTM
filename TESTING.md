# Testing LGTM

## Running the suite

```bash
bun test              # the whole suite, offline, no network and no AI CLI needed
bunx tsc --noEmit      # typecheck: strict, plus noUncheckedIndexedAccess
bun run build.ts       # production binary
```

Build with `bun run build.ts`, never the `bun build --compile` CLI directly. That path ignores bundler plugins, including the Tailwind one, and ships a binary whose UI is unstyled.

Every test in the suite runs offline. No real network call, no real `claude` or `gh` process, no real launchd. Clocks, timers, `fetch`, and `spawn` are all injected, so a test file's fakes live next to the test, not behind a shared mock you have to go find.

Run one file while you work on it:

```bash
bun test src/daemon/cycle.test.ts
```

## Driving the review loop offline

`test/fixtures/fake-claude.ts` stands in for the real Claude CLI. It's a Bun script with a shebang, already executable, and it reads the same `-p`, `--output-format`, and `--model` flags the real CLI takes. What it replies with is controlled by `FAKE_CLAUDE_MODE`:

| Mode | What it emits |
|---|---|
| `json` (default) | A valid envelope with two findings; the main parsing path |
| `prose` | Markdown-formatted findings inside the envelope; exercises the prose fallback |
| `garbage` | Unparseable text; exercises the failed-round and `.raw.txt` path |
| `empty` | A valid envelope with zero findings |
| `timeout` | Sleeps 30 seconds, past any real timeout; exercises the kill-and-salvage path |
| `crash` | Exits 1 with nothing on stdout |
| `usage` | The quota gate's `/usage` output, regardless of the prompt |

The provider and quota tests spawn this script directly by absolute path, the way the real daemon spawns a resolved binary:

```ts
const SHIM = join(import.meta.dir, "../../test/fixtures/fake-claude.ts");
process.env.FAKE_CLAUDE_MODE = "prose";
const outcome = await run({ ...input, binPath: SHIM });
```

`src/provider/claude.test.ts` and `src/provider/index.test.ts` run the real subprocess round trip against every mode. `src/daemon/quota.test.ts` spawns the shim in `usage` mode for the quota parser. `src/daemon/cycle.test.ts` and the boot tests inject a fake `review` function instead of spawning a process, so they exercise the rest of the loop, classify, queue, gate, dry-run post, against fixture data with no I/O at all. `test/e2e/` is the one place that spawns the shim through a whole booted daemon rather than injecting a fake anywhere in the chain; see [Driving the review loop through a real daemon](#driving-the-review-loop-through-a-real-daemon) below.

To point a script or a manual run at the shim instead of the real CLI, set `claude_path` in `config.md` to the shim's absolute path (a manual pin skips the binary resolver's own PATH probe) and set `FAKE_CLAUDE_MODE` before starting whatever you're running. `test/fixtures/README.md` has the full flag and mode reference.

## Driving the review loop through a real daemon

Everything above tests one module, or the loop with a fake standing in
somewhere in the chain. `test/e2e/` is different: it boots a real daemon,
`createDaemon` assembling the same modules `lgtm up` does, in the same order,
against a fake GitHub on a real loopback socket and the fake `claude` shim on
PATH. No real network, no real GitHub, no real `claude`; `globalThis.fetch` is
replaced with one that rewrites `https://api.github.com` onto the fake's port
and throws on any other host, so a new code path that reaches for the real
internet fails the suite instead of passing quietly.

```bash
bun test test/e2e/loop.test.ts     # the journeys alone, about a second
```

Nine journeys, seventeen tests: watching a repo backfills triage without
reviewing anything, an auto-class PR gets reviewed and its findings land in
the API, a triage PR waits and a Skip survives a new commit, the gate posts
one finding and holds two whose lines left the diff, posting twice is
refused and recreate replaces the old draft, a draft submitted in GitHub's UI
stops blocking the next post, a garbage round fails without marking the PR
reviewed, the auth choke point refuses a missing or wrong bearer and a
foreign Origin, and the quota gate parks a PR above the pause threshold with
no round run. `test/e2e/README.md` has the full account, including which
mutations these tests catch that the module tests don't.

## Things worth breaking

design.md's testing section names seven regressions from the old codebase that already bit once. They're gathered in `src/regression.test.ts`, one `describe` block per item, deliberately away from the module tests, because each one crosses a seam a module test in isolation can't see:

```bash
bun test src/regression.test.ts
```

1. A repo added through the API lands in `watch.md` and gets polled on the very next cycle, not the one after.
2. The documented default poll interval, 15 minutes, is the actual default, not just what the docs claim.
3. A missing `claude` or `gh` binary, and rc-file chatter from the login-shell probe (motd, nvm, direnv), never leak onto the daemon's own stderr during detection.
4. PR listing respects GitHub's pagination. A repo with more open PRs than fit on one page doesn't silently lose the rest.
5. Dry-run posting writes nothing, not to GitHub, not to the store.
6. Cache and store keys are qualified by repo, so two watched repos never share one, whether that's an ETag or a review directory for the same PR number.
7. A round where every finding fails validation, or where the CLI's output didn't parse at all, does not mark the PR reviewed. The next cycle has to retry it.

If a change touches the poll cycle, the parser, or posting, check whether it can regress one of these before calling it done.

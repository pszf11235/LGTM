# Testing LGTM

Two ways to exercise this: the automated suite, and driving the real loop by hand with a fake provider so it costs nothing.

## Automated

```bash
bun install
bun run lint            # tsc --noEmit
bun test                # 426 tests
bun run build:binary
./dist/lgtm smoke       # 12 checks against the compiled binary
```

`bun test` includes the loop end to end. `watch-cycle.test.ts` spawns real worker subprocesses against a fake CLI placed on `PATH`, so the process boundary and the output parsing are exercised rather than mocked. That is where the bugs have been.

`lgtm smoke` deliberately spawns a worker too. A worker is reached by re-invoking the program itself, and that resolves differently from source than from a compiled binary, so a mistake there would break reviews only in the artefact people download.

## Driving the loop by hand, with no provider and no token

You do not need a paid CLI or a GitHub token to see the pipeline work. Put a fake provider on `PATH` and point the store somewhere disposable.

```bash
export HOME=$(mktemp -d)          # disposable store, keeps your real one intact
mkdir -p "$HOME/bin" && export PATH="$HOME/bin:$PATH"

cat > "$HOME/bin/claude" <<'SH'
#!/bin/sh
cat <<'JSON'
{"type":"result","result":"```json\n{\"findings\":[{\"file\":\"src/auth.ts\",\"line\":2,\"severity\":\"critical\",\"comment\":\"Hardcoded API key. Move it to an env var before this ships.\"}]}\n```"}
JSON
SH
chmod +x "$HOME/bin/claude"

./dist/lgtm init
./dist/lgtm ai discover           # claude-cli should now show as available
```

`ai discover` proving the fake is detected is the point: detection walks `PATH` in JS rather than shelling out to `which`, so it sees exactly the `PATH` this process has.

### One review, one process per agent

```bash
./dist/lgtm review watch add acme/app     # any name, nothing is fetched yet
./dist/lgtm config                        # shows the reviewer agent and its provider
```

To run a review you need a diff, which means a real repo and PR. Without a token, verify the parts that do not need the network:

```bash
# the exact request that would create the draft review, with nothing sent
./dist/lgtm review post owner/repo#1 --dry-run
```

`--dry-run` works without a token or a reachable API on purpose. It is most useful precisely when the API is not reachable. Check the printed body has `body` and `comments` and **no** `event` key: that absence is what makes the review a draft instead of a published one.

### Two reviewers in parallel

```bash
cd "$HOME/.lgtm-farm/agents"
cp reviewer.md second.md
# `sed -i` differs between GNU and BSD, so rewrite the line portably
perl -pi -e 's/^provider: auto/provider: codex-cli/' second.md
cp "$HOME/bin/claude" "$HOME/bin/codex"
cd -

./dist/lgtm config    # both agents listed, on different providers
```

With both enabled, a review spawns two worker processes. They report their own durations, and the wall clock is close to the slower one rather than the sum.

### Timeouts

```bash
printf '#!/bin/sh\nsleep 300\n' > "$HOME/bin/claude" && chmod +x "$HOME/bin/claude"

time (echo '{"mode":"review","provider":"claude-cli","agent":{"name":"r","provider":"claude-cli","model":null,"severity":"high","timeout":2,"commentDelay":[0,0],"enabled":true,"prompt":"p","sourcePath":"x"},"diff":"d"}' \
  | ./dist/lgtm review internal-worker)
```

Should return in about two seconds with `"error":"claude timed out after 2s"`. This is worth checking because it used to hang forever: every one of these CLIs spawns subprocesses, those inherit the stdout pipe, and the pipe stays open while any of them lives, so killing the CLI and then reading its output to completion never finished.

## With a real repo

```bash
unset GITHUB_TOKEN        # so gh auth token is used
gh auth login             # if you have not already

lgtm discover --ingest ~/projects   # pick repos with `a`, or `A` for all
lgtm review watch list              # confirm they arrived in the watcher
lgtm watch --once                   # one pass
lgtm review list                    # findings, per round, per agent
lgtm review discard owner/repo#42 -f f3
lgtm review post owner/repo#42 --dry-run
lgtm review post owner/repo#42
```

Then open the PR. The draft is visible only to you, with each comment on its diff line. Edit the wording, delete any you disagree with, and submit from GitHub, or run `lgtm review submit owner/repo#42`.

Push a commit to that PR and run `lgtm watch --once` again. It should verify the findings you posted, report how many look resolved, and then review the new state without repeating what is still open.

## Things worth breaking on purpose

| Try | Expected |
|---|---|
| Run `lgtm watch` with nothing watched | Points at `discover --ingest`, does not error |
| Remove every provider from `PATH` | One clear report before polling, not one error per PR |
| Accept a repo with no git remote during ingest | "not watched (no git remote)", counted separately |
| `provider: nonsense` in an agent file | Falls back to `auto` rather than failing the review |
| `severity: catastrophic` in an agent file | Falls back to `high` |
| A finding on a line outside the diff | Held back with a reason, and declared in the review summary |
| `lgtm review post` twice | Refuses the second, points at `--recreate` |
| `lgtm review discard` on a posted finding | Refuses. It is already on GitHub. |
| Hand-edit a round file and delete a `posted:` flag | Reads as unposted, never as posted |
| Corrupt one round file's YAML | That file is skipped, the PR still loads |

## Cleaning up

```bash
rm -rf "$HOME"        # only the temp dir from above
task reset            # or wipe the real store
```

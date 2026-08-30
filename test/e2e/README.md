# End-to-end journeys

Everything else in LGTM is tested a module at a time. This directory tests the
joins: an entry point that calls nothing, a route table missing a row, a client
reading a bare array where the daemon sends an envelope. Those defects pass
every unit test in the repo, because each module is correct on its own.

Three files:

| File | What it is |
|---|---|
| `fake-github.ts` | A GitHub REST impersonator on a real loopback socket, with a drivable repository fixture and a log of every request it received |
| `harness.ts` | One whole daemon, wired to that fake and to the fake Claude shim, with handles a journey drives it by |
| `loop.test.ts` | The journeys |

## Running

```bash
bun test test/e2e/loop.test.ts     # the journeys alone, about a second
bun test                           # everything, journeys included
```

No network, no GitHub, no Anthropic, no real `claude`. The harness replaces
`globalThis.fetch` with one that rewrites `https://api.github.com` onto the
fake's port and throws on any other host, so a new code path that reaches
for the internet fails the suite rather than passing quietly on a machine with
a token in its environment.

Nothing sleeps on a real interval either. The scheduler gets a ticker that
never ticks, so a poll cycle happens when, and only when, a test calls
`poll()`; `settle()` then waits on the review queue's own bookkeeping.

## What runs for real

Everything under `src/`. `createDaemon` builds the same modules `lgtm up`
does, in the same order. `apiBind()` mounts the same route table behind the
same auth choke point. The GitHub adapter does its own ETag handling,
pagination, media types and 401 retry. The poll cycle, the classifier, the
queue, the quota gate, the store writer, the diff parser, the tolerant output
parser and the post flow are all the production code. The Provider layer
really spawns a subprocess.

That is deliberate down to the seam choice. The harness does not inject
`DaemonOptions.forge`, even though boot offers it, for two reasons:

- Injecting a Forge would skip `createGitHubAdapter` entirely, which is a
  third of what these journeys exercise.
- `postPendingReview` in `src/forge/github/draft-review.ts` builds its own
  absolute `https://api.github.com/...` URL and never consults the adapter's
  `baseUrl`. A harness that injected a Forge would pass while the real post
  flow talked to the internet.

## The journeys

1. Watching a repo backfills every open PR into triage, and reviews nothing
   until a human decides. Plus the multi-page listing, which drops its ETag.
2. A PR you authored is auto-classified, reviewed, and its findings reach
   `GET /api/prs` with the severity counts the inbox badge reads.
3. A PR you did not author waits in triage, and a Skip survives a new commit.
4. The Gate: one finding discarded, one posted, two held because their line
   left the diff, and a create request with no `event` key. Plus the dry run,
   and a check that the fake really would publish an `event` if it got one.
5. Posting twice is refused, and recreate deletes the old draft before it
   creates the new one.
6. A draft submitted in GitHub's UI stops blocking the next post, cleared
   both by the poll cycle and by the post flow itself.
7. A provider that returns garbage produces a failed Round and a `.raw.txt`,
   does not mark the PR reviewed, and is retried on the next cycle.
8. The auth choke point: no bearer, a wrong bearer and a foreign Origin are all
   refused, nothing reaches GitHub through any of them, and the same call with
   the token succeeds, so the refusals are the check answering rather than a
   missing route.
9. The quota gate: above the pause threshold a PR is classified and enqueued
   and then sits there, `pausedByGate`, with no Round, no snapshot and no
   findings. A second cycle does not sneak it past.

Four of these exist because the network refused rather than cooperated, and
they are the ones that earn the directory. A create GitHub rejects must leave
every finding `open`, which is the only way to tell marking-after-the-create
from marking-before-it. A `DELETE` it rejects must leave exactly one draft. A
finding held because its line left the diff must post once the line returns,
which is what makes `held` mean "not yet" rather than "never". And a Skip must
survive a draft going ready, the one event that queues an auto-class draft.

If you add a journey, make something fail in it. A journey that only walks the
cooperating path is the failure mode this directory exists to prevent: six of
the seventeen mutations first run against these tests survived precisely
because every path through them was a happy one.

## What is faked, and why

| Fake | Why |
|---|---|
| GitHub, over HTTP | The adapter's own code is under test, so the substitution has to happen at the socket, not at the interface above it |
| The `claude` binary (`test/fixtures/fake-claude.ts`) | Reviews cost money, take minutes, and are not deterministic. `FAKE_CLAUDE_MODE` picks the response shape; `harness.setClaudeMode()` changes it between rounds |
| The `BinaryResolver` | The real one probes with `$SHELL -l -c 'command -v ...'` for anything unpinned, which spawns the developer's own login shell and rc files inside a test. It has its own unit tests in `src/daemon/binaries.test.ts` |
| The notifier's spawn | So a test run does not fire real macOS notifications. Calls are recorded on `harness.notifications` |

## What the fake GitHub covers

- `GET /user`
- `GET /repos/{o}/{r}/pulls?state=open` with `ETag`, `If-None-Match` and a
  real `304`, plus `Link: rel="next"` pagination when `repo.pageSize` is set
  below the open count
- `GET /repos/{o}/{r}/pulls/{n}`, answering JSON or the raw unified diff
  depending on the `Accept` media type
- `GET /repos/{o}/{r}/commits/{sha}/check-runs`
- `POST /repos/{o}/{r}/pulls/{n}/reviews`
- `GET` and `DELETE` on `.../reviews/{id}`
- A `401` for a request with no bearer, and a `404` for any path it does not
  know. A daemon calling an endpoint the fake has never heard of shows up as a
  failing journey rather than as silence

Two behaviours matter more than the list:

**It represents the dangerous request.** A create body carrying an `event` key
is recorded as sent, and publishes the review, exactly as GitHub does
(ADR 0001). A fake that stripped or rejected `event` would make
`expect("event" in body).toBe(false)` pass no matter what the daemon sent.
`loop.test.ts` proves the fake actually does this, by sending a published
review at it by hand, so the absence asserted in journey 4 is an observation
rather than an arrangement.

**It rejects a comment on a line outside the diff.** GitHub answers 422 to the
whole create call rather than dropping the one comment, and so does the fake.
The post flow validates before it sends, so a 422 here means that validation
was wrong. Turn the check off per repo with `repo.strictCommentLines = false`.

## What the fake GitHub deliberately does not cover

- **Rate limiting and its headers.** No `X-RateLimit-*`, no secondary limit,
  no `Retry-After`. Nothing in v1 reads them.
- **Token validity.** Any non-empty `Bearer` is accepted. The value is
  recorded, so a test can assert on it, but the fake never issues a 401 for a
  wrong token and so never exercises the adapter's re-resolve-and-retry path.
  That path has unit coverage in `src/forge/github/adapter.test.ts`.
- **Review comments as first-class objects.** Comments live on the review; the
  `.../comments` endpoints do not exist, because LGTM never reads them.
- **Anything the ForgeAdapter does not call.** No issues, no commits, no
  merges, no branches, no webhooks, no GraphQL.
- **Timing.** Responses are immediate. Slow requests, timeouts and partial
  responses are not modelled; the adapter's 30-second `AbortSignal.timeout` is
  never reached.
- **Multiple viewers.** One authenticated login at a time
  (`github.viewer = "..."`).

And two things the *harness* does not cover, listed here because their absence
is easy to mistake for coverage:

- **Binary resolution** (`$SHELL -l` probing, pins, ENOENT re-probe). Stubbed;
  see the table above.
- **The port scan and the daemon lock.** The harness borrows a free ephemeral
  port and starts a lone daemon, so the 4747-to-4757 scan, the `/api/health`
  handshake and the "another daemon holds this store" refusal are not
  exercised here. They are covered in `src/daemon/rendezvous.test.ts` and
  `src/daemon/boot.test.ts`.

## Adding a journey

A journey is a story a person could tell about using LGTM, asserted in three
places: the store, the API, and the request log. If a test only reads one of
the three, it is probably a unit test wearing a costume.

```ts
test("a closed PR leaves the inbox and keeps its findings", async () => {
  const h = await start();

  await h.api.post("/api/watchlist", { repo: `${OWNER}/${REPO}` });
  h.repo.openPR({ number: 40, author: VIEWER, diff: DIFF_BOTH });
  await h.poll();

  h.repo.closePR(40);
  await h.poll();

  // The store
  expect((await loadMeta(h.lgtmDir, ref(40)))?.closedAt).not.toBeNull();
  // The API
  expect((await listPRs(h)).prs.map((row) => row.key)).not.toContain(`${OWNER}/${REPO}#40`);
  // The request log
  expect(createCalls(h)).toHaveLength(0);
});
```

Four rules that keep a journey honest:

1. **Start and stop the harness.** `start()` in `loop.test.ts` registers the
   harness with the shared `afterEach`, which stops the daemon, stops the
   fake, restores `globalThis.fetch` and puts `HOME`, `GITHUB_TOKEN` and
   `FAKE_CLAUDE_MODE` back. The harness mutates process-wide state; leaking it
   breaks whatever runs next.

2. **Drive the fixture, not the store.** Write `h.repo.pushCommit(40)`, never
   `saveMeta(..., { headSha })`. The point is to make the daemon notice
   something, and hand-writing the store skips the code that was supposed to.

3. **Remember the ETag.** A cycle over a repo nothing has touched gets a 304
   and does no work. If a journey needs a full listing, change something in
   the fixture first. Any mutator bumps the validator.

4. **Read the envelope the browser reads.** `GET /api/prs` answers
   `{ prs, total }`. The helpers in `loop.test.ts` type it that way on
   purpose; a helper that unwrapped it would hide exactly the defect class
   this directory exists to catch.

## A known gap this harness found

Journey 4 pins one assertion that looks wrong on purpose:

```ts
expect(request.headers.authorization).toBe("Bearer present");
```

`boot.ts` hands the API `githubToken: () => "present"`, a presence flag for
`/api/status`, and `runPost` uses that same value as the bearer credential on
the create call. The read path sends the resolved token; the post path sends
the string `present`. Against real GitHub that is a 401 on the one request
that matters. `src/api/post.test.ts` cannot see it, because it injects
`githubToken: () => "ghp_secret"` and never runs the production wiring.

The fake accepts any bearer, so the rest of the journey stays testable. When
the wiring is fixed, that line fails and should be deleted.

## Fixture facts worth knowing

- The fake CLI's `json` mode always reports two findings:
  `src/index.ts:42` (high) and `src/utils.ts:18` (medium). `DIFF_BOTH` makes
  both lines commentable; `DIFF_INDEX_ONLY` makes only the first, which is how
  the held-back path in journey 4 is produced without staging it.
- The harness writes `agents/reviewer.md` with `severity_floor: low`, because
  the shipped default of `high` would drop the medium finding before it ever
  reached the store. Pass `severityFloor` to `startHarness` to change it.
- SHAs are deterministic, derived from the repo key and the PR's history, so a
  failing assertion prints a stable value and `diff-<sha>.patch` filenames are
  predictable.
- The default quota probe really spawns the fake CLI with `-p /usage`, which
  reports 61% and leaves the gate open. Pass `usageProbe` to `startHarness` to
  drive the throttled and fallback paths.

/**
 * End-to-end journeys through a whole running LGTM.
 *
 * Every test here starts a real daemon against a real HTTP server pretending
 * to be GitHub, and drives it the way a person would: add a repo, decide on a
 * PR, discard a finding, post the rest. Assertions land in three places, and
 * the third is the one unit tests cannot reach.
 *
 *   THE STORE. What ended up on disk, read back through @/store.
 *   THE API. What the browser would receive, over the wire, with the envelopes
 *     and field names the SPA actually parses.
 *   THE REQUEST LOG. What the daemon actually did, which endpoints it called,
 *     in what order, with what bodies and headers.
 *
 * That last one is why the fake is an HTTP server rather than a stub object.
 * "Nothing was posted" and "the recreate deleted before it created" and "the
 * create body had no `event` key" are claims about traffic, and traffic is
 * the only place they can be checked.
 *
 * Run with: bun test test/e2e/loop.test.ts
 */

import { afterEach, describe, expect, test } from "bun:test";
import fs from "fs/promises";
import path from "path";

import type { Finding, PRRef, Severity } from "@/core";
import { loadAllRounds, loadMeta, reviewDir } from "@/store/reviews";
import { loadWatchList } from "@/store/watch-list";

import { addedLines, buildDiff } from "./fake-github";
import { E2E_GITHUB_TOKEN, startHarness, type Harness } from "./harness";

// ─── Fixtures ───────────────────────────────────────────────────────────────

const VIEWER = "octocat";
const OWNER = "acme";
const REPO = "api";

/**
 * The fake CLI's `json` mode always reports `src/index.ts:42` (high) and
 * `src/utils.ts:18` (medium). These two diffs decide which of those two a
 * finding can actually be attached to, which is what makes the held-back
 * path in journey 4 real rather than staged.
 */
const DIFF_BOTH = buildDiff([addedLines("src/index.ts", 40, 6), addedLines("src/utils.ts", 15, 8)]);
const DIFF_INDEX_ONLY = buildDiff([addedLines("src/index.ts", 40, 6)]);

function ref(number: number): PRRef {
  return { owner: OWNER, repo: REPO, number };
}

let harness: Harness | null = null;

async function start(options: Parameters<typeof startHarness>[0] = {}): Promise<Harness> {
  harness = await startHarness({ viewer: VIEWER, owner: OWNER, repo: REPO, ...options });
  return harness;
}

afterEach(async () => {
  await harness?.stop();
  harness = null;
});

// ─── Small readers ──────────────────────────────────────────────────────────

interface PRListRow {
  key: string;
  state: string;
  classification: string;
  author: string;
  headSha: string;
  rounds: number;
  pendingReviewId: number | null;
  additions: number | null;
  deletions: number | null;
  mergeable: boolean | null;
  checkStatus: string | null;
  findings: {
    total: number;
    open: number;
    held: number;
    posted: number;
    discarded: number;
    pending: number;
    pendingBySeverity: Record<Severity, number>;
  };
}

/** The exact envelope `/api/prs` returns. Journeys read it, never a bare array. */
interface PRListEnvelope {
  prs: PRListRow[];
  total: number;
}

async function listPRs(h: Harness, query = ""): Promise<PRListEnvelope> {
  const response = await h.api.get<PRListEnvelope>(`/api/prs${query}`);
  expect(response.status).toBe(200);
  return response.body;
}

function rowFor(list: PRListEnvelope, number: number): PRListRow {
  const key = `${OWNER}/${REPO}#${number}`;
  const row = list.prs.find((entry) => entry.key === key);
  if (!row) throw new Error(`no ${key} in ${list.prs.map((entry) => entry.key).join(", ")}`);
  return row;
}

/** Every finding of every round for one PR, with its canonical key. */
async function allFindings(
  h: Harness,
  number: number
): Promise<Array<Finding & { key: string; round: number }>> {
  const rounds = await loadAllRounds(h.lgtmDir, ref(number));
  return rounds.flatMap((round) =>
    round.findings.map((finding) => ({
      ...finding,
      round: round.round,
      key: `r${round.round}:${round.agent}:${finding.id}`,
    }))
  );
}

/** One finding's state on disk, by full key, or "missing". */
async function findingState(h: Harness, number: number, key: string): Promise<string> {
  const findings = await allFindings(h, number);
  return findings.find((finding) => finding.key === key)?.state ?? "missing";
}

async function dirEntries(h: Harness, number: number): Promise<string[]> {
  return (await fs.readdir(reviewDir(h.lgtmDir, ref(number))).catch(() => [] as string[])).sort();
}

/** Every review-creation request the fake received, in arrival order. */
function createCalls(h: Harness) {
  return h.github.log.matching("POST", /\/reviews$/);
}

// ═══════════════════════════════════════════════════════════════════════════
// 1. Watching a repo backfills it, and reviews nothing
// ═══════════════════════════════════════════════════════════════════════════

describe("journey 1: adding a repo backfills without reviewing", () => {
  test("every open PR lands in triage and no Round runs until a human decides", async () => {
    const h = await start();

    h.repo.openPR({ number: 1, author: VIEWER, title: "Add rate limiter", diff: DIFF_BOTH });
    h.repo.openPR({ number: 2, author: "someone-else", title: "Bump deps", diff: DIFF_BOTH });
    h.repo.openPR({ number: 3, author: "someone-else", title: "Draft work", draft: true });

    const added = await h.api.post<{
      added: boolean;
      key: string;
      entries: Array<{ key: string; classification: string; autoClass: boolean; preSelected: boolean }>;
    }>("/api/watchlist", { repo: `${OWNER}/${REPO}` });

    expect(added.status).toBe(201);
    expect(added.body.added).toBe(true);
    expect(added.body.key).toBe(`${OWNER}/${REPO}`);

    // The backfill list is the confirm pane's data: every open PR, with the
    // one the viewer authored pre-selected and nothing else.
    expect(added.body.entries.map((entry) => entry.key).sort()).toEqual([
      `${OWNER}/${REPO}#1`,
      `${OWNER}/${REPO}#2`,
      `${OWNER}/${REPO}#3`,
    ]);
    const own = added.body.entries.find((entry) => entry.key === `${OWNER}/${REPO}#1`);
    expect(own?.classification).toBe("own");
    expect(own?.autoClass).toBe(true);
    expect(own?.preSelected).toBe(true);
    expect(added.body.entries.filter((entry) => entry.preSelected)).toHaveLength(1);

    // R9.1/R2.6: the repo is on the watch list and every PR is on disk in
    // triage, including the one the viewer wrote.
    expect((await loadWatchList(h.lgtmDir)).map((entry) => `${entry.owner}/${entry.repo}`)).toEqual([
      `${OWNER}/${REPO}`,
    ]);
    for (const number of [1, 2, 3]) {
      const meta = await loadMeta(h.lgtmDir, ref(number));
      expect(meta?.state).toBe("triage");
      expect(meta?.rounds).toBe(0);
    }
    expect((await loadMeta(h.lgtmDir, ref(1)))?.classification).toBe("own");

    // The backfill's own listing left a validator behind, so the very next
    // cycle is conditional and costs nothing (R1.5).
    const first = await h.poll();
    expect(first.cycle?.repos[0]?.status).toBe("not-modified");
    expect(first.cycle?.repos[0]?.queued).toBe(0);

    // Now make the listing genuinely change, so the cycle does the full pass
    // and still queues nothing. R2.6: auto-classification begins only for
    // activity after watching starts, and #1 is the viewer's own PR.
    h.repo.setMergeable(2, null);
    h.github.log.clear();

    const second = await h.poll();
    expect(second.cycle?.repos[0]?.status).toBe("ok");
    expect(second.cycle?.repos[0]?.seen).toBe(3);
    expect(second.cycle?.repos[0]?.queued).toBe(0);

    for (const number of [1, 2, 3]) {
      expect(await allFindings(h, number)).toEqual([]);
      expect((await loadMeta(h.lgtmDir, ref(number)))?.state).toBe("triage");
    }

    // The claim that matters, and the one only the request log can make: no
    // Round ran and nothing was written to the code host.
    expect(createCalls(h)).toHaveLength(0);
    expect(h.github.reviews.all()).toHaveLength(0);
    expect(h.github.log.filter((request) => request.method !== "GET")).toEqual([]);

    // And a cycle over an unchanged repo is conditional again, with the
    // validator the previous listing returned.
    h.github.log.clear();
    const third = await h.poll();
    expect(third.cycle?.repos[0]?.status).toBe("not-modified");

    const conditional = h.github.log.matching("GET", `/repos/${OWNER}/${REPO}/pulls`);
    expect(conditional).toHaveLength(1);
    expect(conditional[0]?.headers["if-none-match"]).toBe(h.repo.etag);
    expect(conditional[0]?.status).toBe(304);
    // A 304 ends the repo's cycle. No per-PR detail, no check runs, nothing.
    expect(h.github.log.matching("GET", /\/pulls\/\d+$/)).toHaveLength(0);

    // And the consequence, which the status word on its own does not prove.
    // "Nothing changed" and "no open PRs" are different answers to different
    // questions, and an adapter that collapsed the 304 into an empty list
    // would have just closed all three of these.
    for (const number of [1, 2, 3]) {
      const meta = await loadMeta(h.lgtmDir, ref(number));
      expect(meta?.state).toBe("triage");
      expect(meta?.closedAt).toBeNull();
    }
    expect((await listPRs(h)).prs.map((row) => row.key).sort()).toEqual([
      `${OWNER}/${REPO}#1`,
      `${OWNER}/${REPO}#2`,
      `${OWNER}/${REPO}#3`,
    ]);
  }, 60_000);

  test("a repo whose open PRs spill past one page is listed whole, and stops being conditional", async () => {
    const h = await start();

    // One PR per page, so the listing takes three round trips and a Link
    // header to walk.
    h.repo.pageSize = 1;
    h.repo.openPR({ number: 1, author: VIEWER });
    h.repo.openPR({ number: 2, author: "someone-else" });
    h.repo.openPR({ number: 3, author: "someone-else" });

    const added = await h.api.post<{ entries: Array<{ key: string }> }>("/api/watchlist", {
      repo: `${OWNER}/${REPO}`,
    });
    expect(added.status).toBe(201);
    // Every open PR, not just page one. The regression this guards against
    // shipped once already.
    expect(added.body.entries).toHaveLength(3);

    const pages = h.github.log.matching("GET", `/repos/${OWNER}/${REPO}/pulls`);
    expect(pages).toHaveLength(3);
    expect(pages.map((request) => request.query.page ?? "1")).toEqual(["1", "2", "3"]);

    // An If-None-Match covers the page it was issued for and nothing else, so
    // a multi-page repo drops out of conditional polling rather than risk a
    // 304 that hides changes on page two.
    h.github.log.clear();
    const cycle = await h.poll();
    expect(cycle.cycle?.repos[0]?.status).toBe("ok");

    const listed = h.github.log.matching("GET", `/repos/${OWNER}/${REPO}/pulls`);
    expect(listed).toHaveLength(3);
    expect(listed[0]?.headers["if-none-match"]).toBeUndefined();
  }, 60_000);
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. A PR you authored is reviewed by itself
// ═══════════════════════════════════════════════════════════════════════════

describe("journey 2: an auto-classified PR reviews itself", () => {
  test("findings land on disk and reach GET /api/prs with the browser's severity counts", async () => {
    const h = await start();

    await h.api.post("/api/watchlist", { repo: `${OWNER}/${REPO}` });

    // Opened *after* the repo joined the watch list, which is the only way a
    // PR is auto-classified rather than backfilled into triage (R2.6).
    h.repo.openPR({ number: 7, author: VIEWER, title: "Add rate limiter", diff: DIFF_BOTH });

    const cycle = await h.poll();
    expect(cycle.cycle?.repos[0]?.queued).toBe(1);

    const meta = await loadMeta(h.lgtmDir, ref(7));
    expect(meta?.classification).toBe("own");
    expect(meta?.state).toBe("reviewed");
    expect(meta?.rounds).toBe(1);
    expect(meta?.lastReviewedSha).toBe(h.repo.pr(7)?.headSha);
    expect(meta?.failedAttempts).toBe(0);

    // The round file, its findings, and the diff snapshot the finding cards
    // slice their hunks from, all under the PR's own directory.
    const entries = await dirEntries(h, 7);
    expect(entries).toContain("meta.md");
    expect(entries).toContain("r1-reviewer.md");
    expect(entries).toContain(`diff-${h.repo.pr(7)?.headSha}.patch`);
    expect(entries.some((name) => name.endsWith(".raw.txt"))).toBe(false);

    const findings = await allFindings(h, 7);
    expect(findings.map((finding) => finding.key)).toEqual(["r1:reviewer:f1", "r1:reviewer:f2"]);
    expect(findings.map((finding) => `${finding.file}:${finding.line}`)).toEqual([
      "src/index.ts:42",
      "src/utils.ts:18",
    ]);
    expect(findings.every((finding) => finding.state === "open")).toBe(true);

    // The wire shape the SPA reads. `/api/prs` answers an envelope, not a
    // bare array, and the inbox badge counts `pendingBySeverity`.
    const list = await listPRs(h);
    expect(Array.isArray(list.prs)).toBe(true);
    expect(list.total).toBe(list.prs.length);

    const row = rowFor(list, 7);
    expect(row.state).toBe("reviewed");
    expect(row.classification).toBe("own");
    expect(row.author).toBe(VIEWER);
    expect(row.rounds).toBe(1);
    expect(row.findings.total).toBe(2);
    expect(row.findings.open).toBe(2);
    expect(row.findings.pending).toBe(2);
    expect(row.findings.pendingBySeverity).toEqual({ critical: 0, high: 1, medium: 1, low: 0 });

    // And the finding cards, with hunks sliced from the stored snapshot.
    const cards = await h.api.get<{
      rounds: Array<{ round: number; findings: Array<{ key: string; hunk: unknown; githubUrl: string }> }>;
    }>(`/api/prs/${OWNER}/${REPO}/7/findings`);
    expect(cards.status).toBe(200);
    const carded = cards.body.rounds.flatMap((round) => round.findings);
    expect(carded.map((finding) => finding.key)).toEqual(["r1:reviewer:f1", "r1:reviewer:f2"]);
    expect(carded[0]?.hunk).not.toBeNull();
    // The card's fallback link points at the file and line in the SHA this
    // round reviewed, which is what R5.1 asks for.
    expect(carded[0]?.githubUrl).toContain(`src/index.ts#L42`);

    // Reviewing writes to the store and reads from the Forge, never the
    // other way round (R3.7).
    expect(h.github.log.filter((request) => request.method !== "GET")).toEqual([]);

    // The SPA's invalidation hints fired for this PR.
    expect(h.events).toContainEqual({ type: "findings-ready", ref: ref(7) });
  }, 60_000);
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. Triage, and a Skip that sticks
// ═══════════════════════════════════════════════════════════════════════════

describe("journey 3: a PR you did not author waits, and a Skip is sticky", () => {
  test("skipping survives a new commit", async () => {
    const h = await start();

    await h.api.post("/api/watchlist", { repo: `${OWNER}/${REPO}` });

    // Not authored by the viewer, not requested, not assigned, not mentioned.
    h.repo.openPR({ number: 4, author: "someone-else", title: "Bump deps", diff: DIFF_BOTH });

    const first = await h.poll();
    expect(first.cycle?.repos[0]?.triaged).toBe(1);
    expect(first.cycle?.repos[0]?.queued).toBe(0);

    const triaged = await loadMeta(h.lgtmDir, ref(4));
    expect(triaged?.state).toBe("triage");
    expect(triaged?.classification).toBe("none");
    // R2.5's inbox line, fetched once on the way into triage.
    expect(triaged?.additions).toBe(12);
    expect(triaged?.deletions).toBe(3);
    expect(triaged?.mergeable).toBe(true);
    expect(triaged?.checkStatus).toBe("success");
    expect(await allFindings(h, 4)).toEqual([]);

    // The human decides.
    const skip = await h.api.post<{ state: string; queued: boolean }>(
      `/api/prs/${OWNER}/${REPO}/4/decision`,
      { action: "skip" }
    );
    expect(skip.status).toBe(200);
    expect(skip.body.state).toBe("skipped");
    expect(skip.body.queued).toBe(false);
    expect(h.daemon.queue.status().queued).toBe(0);

    const atSkip = await loadMeta(h.lgtmDir, ref(4));
    expect(atSkip?.state).toBe("skipped");

    // R2.4: new commits do not resurrect a skipped PR. Only an unskip does.
    h.repo.pushCommit(4);
    const second = await h.poll();
    expect(second.cycle?.repos[0]?.queued).toBe(0);

    const afterPush = await loadMeta(h.lgtmDir, ref(4));
    expect(afterPush?.state).toBe("skipped");
    // The sticky skip short-circuits `decide` before anything can react to the
    // new commit, and a `none` decision writes nothing at all, so the recorded
    // head SHA deliberately stays where it was when the Skip landed.
    // The unskip below shows it catching up once the PR is live again.
    expect(afterPush?.headSha).toBe(atSkip?.headSha ?? "");
    expect(afterPush?.rounds).toBe(0);
    expect(await allFindings(h, 4)).toEqual([]);
    expect(await dirEntries(h, 4)).toEqual(["meta.md"]);

    // Nothing was reviewed and nothing was written to the code host.
    expect(createCalls(h)).toHaveLength(0);
    expect(h.github.log.filter((request) => request.method !== "GET")).toEqual([]);

    // Skipped PRs stay listed under their own filter, with an unskip action.
    const active = await listPRs(h);
    expect(rowFor(active, 4).state).toBe("skipped");
    const skipped = await listPRs(h, "?state=skipped");
    expect(skipped.prs.map((row) => row.key)).toEqual([`${OWNER}/${REPO}#4`]);

    const unskip = await h.api.post<{ state: string }>(`/api/prs/${OWNER}/${REPO}/4/decision`, {
      action: "unskip",
    });
    expect(unskip.status).toBe(200);
    // Back to triage, not to the queue: the next decision is its own act.
    expect(unskip.body.state).toBe("triage");
    expect(h.daemon.queue.status().queued).toBe(0);

    // And once it is live again, the next commit refreshes it like any other
    // triage PR. Still nothing is reviewed: it is not auto-class, and nobody
    // has said "review" yet.
    const latest = h.repo.pushCommit(4);
    const third = await h.poll();
    expect(third.cycle?.repos[0]?.queued).toBe(0);

    const resumed = await loadMeta(h.lgtmDir, ref(4));
    expect(resumed?.state).toBe("triage");
    expect(resumed?.headSha).toBe(latest.headSha);
    expect(resumed?.rounds).toBe(0);
    expect(createCalls(h)).toHaveLength(0);
  }, 60_000);

  test("a Skip on a PR the user authored survives the one event that queues drafts", async () => {
    const h = await start();

    await h.api.post("/api/watchlist", { repo: `${OWNER}/${REPO}` });

    // Auto-class, because the viewer wrote it, but a draft. R2.3 holds it in
    // triage carrying the "reviews when ready" marker instead of reviewing it
    // now, which is what gives this journey something to skip.
    h.repo.openPR({ number: 5, author: VIEWER, title: "Spike", draft: true, diff: DIFF_BOTH });

    const first = await h.poll();
    expect(first.cycle?.repos[0]?.queued).toBe(0);

    const waiting = await loadMeta(h.lgtmDir, ref(5));
    expect(waiting?.state).toBe("triage");
    expect(waiting?.classification).toBe("own");
    expect(waiting?.draft).toBe(true);

    // The human says no. Skip is offered on every PR, not only on the ones
    // that were waiting on a decision because nothing else would have
    // happened to them anyway.
    const skip = await h.api.post<{ state: string }>(`/api/prs/${OWNER}/${REPO}/5/decision`, {
      action: "skip",
    });
    expect(skip.status).toBe(200);
    expect(skip.body.state).toBe("skipped");

    // Ready for review is the one transition that queues an auto-class draft.
    // Journey 3 skips a PR that never qualified for review in the first
    // place, so it cannot tell a sticky rule from a classifier that was never
    // going to queue that PR anyway. This one can: a skip that stopped short
    // of auto-class PRs would review this at the worst possible moment,
    // spending the user's quota on the PR they just said no to.
    h.repo.markReadyForReview(5);

    const second = await h.poll();
    expect(second.cycle?.repos[0]?.queued).toBe(0);
    expect(h.daemon.queue.status().queued).toBe(0);

    const after = await loadMeta(h.lgtmDir, ref(5));
    expect(after?.state).toBe("skipped");
    expect(after?.rounds).toBe(0);
    expect(await allFindings(h, 5)).toEqual([]);
    expect(await dirEntries(h, 5)).toEqual(["meta.md"]);
    expect(createCalls(h)).toHaveLength(0);
  }, 60_000);
});

// ═══════════════════════════════════════════════════════════════════════════
// 4. The Gate
// ═══════════════════════════════════════════════════════════════════════════

describe("journey 4: the Gate decides what reaches GitHub", () => {
  test("a discarded finding is not sent, a stale line is held, and the create carries no event key", async () => {
    const h = await start();

    await h.api.post("/api/watchlist", { repo: `${OWNER}/${REPO}` });
    h.repo.openPR({ number: 10, author: VIEWER, title: "Add rate limiter", diff: DIFF_BOTH });
    await h.poll();

    // A second commit whose diff no longer touches src/utils.ts. Round 2
    // raises the same two findings, but only one of them still has a line.
    h.repo.pushCommit(10, { diff: DIFF_INDEX_ONLY });
    await h.poll();

    const before = await allFindings(h, 10);
    expect(before.map((finding) => finding.key)).toEqual([
      "r1:reviewer:f1",
      "r1:reviewer:f2",
      "r2:reviewer:f1",
      "r2:reviewer:f2",
    ]);

    // The human discards round 1's copy of the index.ts finding. Addressed by
    // the full key: ids restart at f1 per round, so a bare `f1` would have hit
    // round 2's as well (R9.3).
    const discard = await h.api.patch<{ state: string; changed: boolean }>(
      `/api/prs/${OWNER}/${REPO}/10/findings/r1:reviewer:f1`,
      { state: "discarded" }
    );
    expect(discard.status).toBe(200);
    expect(discard.body).toMatchObject({ state: "discarded", changed: true });

    const posted = await h.api.post<{
      dryRun: boolean;
      reviewId: number;
      body: string;
      commentCount: number;
      posted: Array<{ key: string; file: string; line: number }>;
      held: Array<{ key: string; reason: string }>;
    }>(`/api/prs/${OWNER}/${REPO}/10/post`);

    expect(posted.status).toBe(200);
    expect(posted.body.dryRun).toBe(false);
    expect(posted.body.commentCount).toBe(1);
    expect(posted.body.posted.map((entry) => entry.key)).toEqual(["r2:reviewer:f1"]);
    expect(posted.body.held.map((entry) => entry.key).sort()).toEqual([
      "r1:reviewer:f2",
      "r2:reviewer:f2",
    ]);
    for (const entry of posted.body.held) expect(entry.reason).toContain("src/utils.ts");

    // ── What actually went over the wire ──────────────────────────────────
    const calls = createCalls(h);
    expect(calls).toHaveLength(1);

    const request = calls[0];
    if (!request) throw new Error("no create request recorded");
    expect(request.path).toBe(`/repos/${OWNER}/${REPO}/pulls/10/reviews`);

    // Both paths must present the same resolved credential. They did not:
    // boot.ts handed the API a presence flag for /api/status, and the post
    // flow used that same function as its bearer, so the create call went out
    // as `Bearer present` and would have been a 401 against real GitHub. The
    // fake accepts any bearer, so only an assertion on what was actually sent
    // could see it.
    expect(h.github.log.matching("GET", `/repos/${OWNER}/${REPO}/pulls`)[0]?.headers.authorization).toBe(
      `Bearer ${E2E_GITHUB_TOKEN}`
    );
    expect(request.headers.authorization).toBe(`Bearer ${E2E_GITHUB_TOKEN}`);

    const sent = request.body as Record<string, unknown>;
    // ADR 0001, asserted against a fake that would happily have published the
    // review if an `event` key had arrived. The absence is observed, not
    // arranged.
    expect("event" in sent).toBe(false);
    expect(Object.keys(sent).sort()).toEqual(["body", "comments"]);

    expect(sent.comments).toEqual([
      {
        path: "src/index.ts",
        line: 42,
        body: "Potential null reference",
      },
    ]);
    // The discarded finding is on the same file and line as the one that
    // posted, so "one comment" is the only assertion that proves it was left
    // out rather than merged in.
    expect((sent.comments as unknown[]).length).toBe(1);
    expect(String(sent.body)).toContain("AI-assisted code review by reviewer");
    // R6.3: the held findings are disclosed in the review body, not dropped
    // silently.
    expect(String(sent.body)).toContain("r1:reviewer:f2");
    expect(String(sent.body)).toContain("r2:reviewer:f2");

    // The review GitHub now holds is a draft only its author can see.
    const review = h.github.reviews.get(posted.body.reviewId);
    expect(review?.state).toBe("PENDING");
    expect(review?.comments).toHaveLength(1);

    // ── And what the store says afterwards ────────────────────────────────
    const after = await allFindings(h, 10);
    const stateOf = (key: string): string =>
      after.find((finding) => finding.key === key)?.state ?? "missing";

    expect(stateOf("r1:reviewer:f1")).toBe("discarded");
    expect(stateOf("r2:reviewer:f1")).toBe("posted");
    expect(stateOf("r1:reviewer:f2")).toBe("held");
    expect(stateOf("r2:reviewer:f2")).toBe("held");
    for (const finding of after.filter((entry) => entry.state === "held")) {
      expect(finding.heldReason).toContain("src/utils.ts");
    }

    const meta = await loadMeta(h.lgtmDir, ref(10));
    expect(meta?.pendingReviewId).toBe(posted.body.reviewId);

    const row = rowFor(await listPRs(h), 10);
    expect(row.pendingReviewId).toBe(posted.body.reviewId);
    expect(row.findings).toMatchObject({ total: 4, posted: 1, discarded: 1, held: 2, pending: 2 });
  }, 60_000);

  test("a finding held because its line left the diff posts once the line comes back", async () => {
    const h = await start();

    await h.api.post("/api/watchlist", { repo: `${OWNER}/${REPO}` });
    // Only src/index.ts is in this diff, so the fake CLI's second finding has
    // nowhere to attach from the moment it is written.
    h.repo.openPR({ number: 15, author: VIEWER, diff: DIFF_INDEX_ONLY });
    await h.poll();

    const first = await h.api.post<{
      reviewId: number;
      commentCount: number;
      held: Array<{ key: string }>;
    }>(`/api/prs/${OWNER}/${REPO}/15/post`);

    expect(first.status).toBe(200);
    expect(first.body.commentCount).toBe(1);
    expect(first.body.held.map((entry) => entry.key)).toEqual(["r1:reviewer:f2"]);
    expect(await findingState(h, 15, "r1:reviewer:f2")).toBe("held");

    // The human reads the draft and submits it in GitHub's editor.
    h.github.reviews.submit(first.body.reviewId);

    // Then the file comes back into the diff. The head SHA does not move, so
    // no new Round runs and no new finding is written: the only way f2 ever
    // reaches GitHub is the post flow re-checking a finding it held (R6.3).
    // "Held" has to mean "not yet", not "never".
    h.repo.setDiff(15, DIFF_BOTH);
    await h.poll();

    const between = await loadMeta(h.lgtmDir, ref(15));
    expect(between?.rounds).toBe(1);
    expect(between?.pendingReviewId).toBeNull();
    expect(await findingState(h, 15, "r1:reviewer:f1")).toBe("posted");
    expect(await findingState(h, 15, "r1:reviewer:f2")).toBe("held");

    const second = await h.api.post<{
      reviewId: number;
      commentCount: number;
      posted: Array<{ key: string; file: string; line: number }>;
    }>(`/api/prs/${OWNER}/${REPO}/15/post`);

    expect(second.status).toBe(200);
    expect(second.body.commentCount).toBe(1);
    expect(second.body.posted.map((entry) => entry.key)).toEqual(["r1:reviewer:f2"]);

    // On the wire, and only the finding that was held. The one already on the
    // submitted review is not sent a second time.
    const sent = createCalls(h).at(-1)?.body as Record<string, unknown>;
    expect(sent.comments).toEqual([
      { path: "src/utils.ts", line: 18, body: "Missing error handling" },
    ]);

    expect(await findingState(h, 15, "r1:reviewer:f2")).toBe("posted");
    expect(rowFor(await listPRs(h), 15).findings).toMatchObject({ posted: 2, held: 0, pending: 0 });
  }, 60_000);

  test("a dry run shows the exact request and writes nothing", async () => {
    const h = await start();

    await h.api.post("/api/watchlist", { repo: `${OWNER}/${REPO}` });
    h.repo.openPR({ number: 11, author: VIEWER, diff: DIFF_BOTH });
    await h.poll();

    h.github.log.clear();

    const dry = await h.api.post<{
      dryRun: boolean;
      request: { url: string; method: string; headers: Record<string, string>; body: unknown };
    }>(`/api/prs/${OWNER}/${REPO}/11/post`, { dryRun: true });

    expect(dry.status).toBe(200);
    expect(dry.body.dryRun).toBe(true);
    expect(dry.body.request.method).toBe("POST");
    expect(dry.body.request.url).toContain(`/repos/${OWNER}/${REPO}/pulls/11/reviews`);
    expect("event" in (dry.body.request.body as Record<string, unknown>)).toBe(false);
    // The GitHub token never leaves the daemon, not even in a preview (R7.2).
    expect(dry.body.request.headers.Authorization).toBe("Bearer <redacted>");

    // Nothing was sent, and nothing on disk moved.
    expect(createCalls(h)).toHaveLength(0);
    expect(h.github.log.filter((entry) => entry.method !== "GET")).toEqual([]);
    expect((await allFindings(h, 11)).every((finding) => finding.state === "open")).toBe(true);
    expect((await loadMeta(h.lgtmDir, ref(11)))?.pendingReviewId).toBeNull();
  }, 60_000);

  test("a create GitHub refuses leaves every finding open, and the retry posts them", async () => {
    const h = await start();

    await h.api.post("/api/watchlist", { repo: `${OWNER}/${REPO}` });
    h.repo.openPR({ number: 14, author: VIEWER, diff: DIFF_BOTH });
    await h.poll();

    // A secondary rate limit, a 500, a token that lost its scope: refusals
    // LGTM cannot predict and cannot prevent. The only question is what the
    // store looks like afterwards.
    h.repo.failNextCreate(500, "Server Error");

    const refused = await h.api.post<{ error: string; message: string }>(
      `/api/prs/${OWNER}/${REPO}/14/post`
    );
    expect(refused.status).toBe(502);
    expect(refused.body.error).toBe("forge-error");
    expect(refused.body.message).toContain("500");

    // The call was made and it failed. Nothing is on the host.
    expect(createCalls(h)).toHaveLength(1);
    expect(createCalls(h)[0]?.status).toBe(500);
    expect(h.github.reviews.all()).toHaveLength(0);

    // The claim, and the one a happy path cannot make. A finding marked
    // `posted` for a comment that never left the machine is gone: it is not
    // in any review, and `pendingFindings` will never offer it again. Moving
    // the marking to before the create call is all it takes, and every
    // assertion in journey 4 still passes when you do.
    const after = await allFindings(h, 14);
    expect(after.map((finding) => finding.state)).toEqual(["open", "open"]);
    expect((await loadMeta(h.lgtmDir, ref(14)))?.pendingReviewId).toBeNull();
    expect(rowFor(await listPRs(h), 14).findings).toMatchObject({
      posted: 0,
      open: 2,
      pending: 2,
    });

    // Which is the point of leaving them open: the next attempt posts them.
    const retried = await h.api.post<{ reviewId: number; commentCount: number }>(
      `/api/prs/${OWNER}/${REPO}/14/post`
    );
    expect(retried.status).toBe(200);
    expect(retried.body.commentCount).toBe(2);
    expect(h.github.reviews.get(retried.body.reviewId)?.state).toBe("PENDING");
    expect((await allFindings(h, 14)).every((finding) => finding.state === "posted")).toBe(true);
  }, 60_000);

  test("a recreate whose delete GitHub refuses does not leave two drafts on the PR", async () => {
    const h = await start();

    await h.api.post("/api/watchlist", { repo: `${OWNER}/${REPO}` });
    h.repo.openPR({ number: 18, author: VIEWER, diff: DIFF_BOTH });
    await h.poll();

    const first = await h.api.post<{ reviewId: number }>(`/api/prs/${OWNER}/${REPO}/18/post`);
    expect(first.status).toBe(200);
    const firstId = first.body.reviewId;

    h.repo.failNextDelete(500, "Server Error");

    const recreate = await h.api.post<{ error: string }>(`/api/prs/${OWNER}/${REPO}/18/post`, {
      recreate: true,
    });

    // Deleting first is not only about ordering. A recreate that treats the
    // delete as fire-and-forget reads the same in the request log and leaves
    // the PR carrying two pending drafts the moment GitHub says no.
    expect(recreate.status).toBe(502);
    expect(createCalls(h)).toHaveLength(1);
    expect(h.github.reviews.all().map((review) => review.id)).toEqual([firstId]);
    expect(h.github.reviews.get(firstId)?.state).toBe("PENDING");

    // The store still describes GitHub accurately, so the user can try again.
    expect((await loadMeta(h.lgtmDir, ref(18)))?.pendingReviewId).toBe(firstId);

    const again = await h.api.post<{ reviewId: number; recreated: { deletedReviewId: number } | null }>(
      `/api/prs/${OWNER}/${REPO}/18/post`,
      { recreate: true }
    );
    expect(again.status).toBe(200);
    expect(again.body.recreated?.deletedReviewId).toBe(firstId);
    expect(h.github.reviews.all()).toHaveLength(1);
  }, 60_000);

  test("the fake publishes when it is sent an event key, which is what makes its absence mean something", async () => {
    const h = await start();
    h.repo.openPR({ number: 13, author: VIEWER, diff: DIFF_BOTH });

    // Not the daemon. A hand-built request straight at the fake, carrying the
    // one key LGTM must never send. If the fake quietly dropped or rejected
    // `event`, the assertion in the journey above would pass no matter what
    // the daemon sent, and the whole ADR 0001 claim would rest on nothing.
    const response = await fetch(`${h.github.url}/repos/${OWNER}/${REPO}/pulls/13/reviews`, {
      method: "POST",
      headers: { authorization: "Bearer probe", "content-type": "application/json" },
      body: JSON.stringify({
        body: "published by hand",
        event: "COMMENT",
        comments: [{ path: "src/index.ts", line: 42, body: "visible to everyone" }],
      }),
    });

    expect(response.status).toBe(200);
    const created = (await response.json()) as { id: number; state: string };
    // Published, exactly as GitHub would. `postPendingReview` throws on any
    // state but PENDING, so a regression that reintroduced `event` would fail
    // loudly here rather than silently going public.
    expect(created.state).toBe("COMMENTED");
    expect(h.github.reviews.get(created.id)?.state).toBe("COMMENTED");

    const recorded = createCalls(h).at(-1);
    expect(recorded && "event" in (recorded.body as Record<string, unknown>)).toBe(true);
  }, 60_000);

  test("the fake would record a second draft and a comment on a line that is not in the diff", async () => {
    const h = await start();
    // Only src/index.ts:40-45 can carry a comment on this PR.
    h.repo.openPR({ number: 19, author: VIEWER, diff: DIFF_INDEX_ONLY });

    const create = async (body: unknown): Promise<Response> =>
      fetch(`${h.github.url}/repos/${OWNER}/${REPO}/pulls/19/reviews`, {
        method: "POST",
        headers: { authorization: "Bearer probe", "content-type": "application/json" },
        body: JSON.stringify(body),
      });

    // ── A second draft ────────────────────────────────────────────────────
    // Journey 5 asserts that a refused post left exactly one review on the
    // host, and the recreate journey asserts that a failed delete left
    // exactly one. Neither claim means anything unless the fake would happily
    // hold two, the way GitHub does. It has no uniqueness rule of its own.
    const one = (await (await create({
      body: "first",
      comments: [{ path: "src/index.ts", line: 42, body: "a" }],
    })).json()) as { id: number };
    const two = (await (await create({
      body: "second",
      comments: [{ path: "src/index.ts", line: 43, body: "b" }],
    })).json()) as { id: number };

    expect(two.id).not.toBe(one.id);
    const both = h.github.reviews.forPR(OWNER, REPO, 19);
    expect(both.map((review) => review.state)).toEqual(["PENDING", "PENDING"]);

    // ── A comment on a line that left the diff ────────────────────────────
    // src/utils.ts is not in this PR's diff at all. GitHub answers 422 for
    // the whole create rather than dropping the one comment, which is why the
    // post flow validates before it sends and why journey 4's held findings
    // are held rather than attempted.
    const rejected = await create({
      body: "out of range",
      comments: [{ path: "src/utils.ts", line: 18, body: "nowhere to attach" }],
    });
    expect(rejected.status).toBe(422);
    expect(h.github.reviews.forPR(OWNER, REPO, 19)).toHaveLength(2);

    // And with the rule off, the wrong line is recorded rather than silently
    // dropped. That is what makes journey 4's "exactly one comment, on
    // src/index.ts:42" an observation: a comment on the stale line would have
    // shown up here, not vanished.
    h.repo.strictCommentLines = false;
    const accepted = (await (await create({
      body: "recorded anyway",
      comments: [{ path: "src/utils.ts", line: 18, body: "nowhere to attach" }],
    })).json()) as { id: number };
    expect(h.github.reviews.get(accepted.id)?.comments).toEqual([
      { path: "src/utils.ts", line: 18, body: "nowhere to attach" },
    ]);
  }, 60_000);
});

// ═══════════════════════════════════════════════════════════════════════════
// 5. One draft at a time
// ═══════════════════════════════════════════════════════════════════════════

describe("journey 5: posting twice is refused, recreate replaces", () => {
  test("the second post is a 409 and recreate deletes before it creates", async () => {
    const h = await start();

    await h.api.post("/api/watchlist", { repo: `${OWNER}/${REPO}` });
    h.repo.openPR({ number: 12, author: VIEWER, diff: DIFF_BOTH });
    await h.poll();

    const first = await h.api.post<{ reviewId: number; commentCount: number }>(
      `/api/prs/${OWNER}/${REPO}/12/post`
    );
    expect(first.status).toBe(200);
    expect(first.body.commentCount).toBe(2);
    const firstId = first.body.reviewId;

    // R6.5: one pending review per PR. The REST API cannot append to a
    // pending review, so a second post is refused rather than creating a
    // second draft beside the first.
    const refused = await h.api.post<{ error: string; pendingReviewId: number; reviewUrl: string }>(
      `/api/prs/${OWNER}/${REPO}/12/post`
    );
    expect(refused.status).toBe(409);
    expect(refused.body.error).toBe("pending-review-exists");
    expect(refused.body.pendingReviewId).toBe(firstId);
    expect(createCalls(h)).toHaveLength(1);
    expect(h.github.reviews.all()).toHaveLength(1);

    h.github.log.clear();

    const recreated = await h.api.post<{
      reviewId: number;
      commentCount: number;
      recreated: { deletedReviewId: number; reopened: string[] } | null;
    }>(`/api/prs/${OWNER}/${REPO}/12/post`, { recreate: true });

    expect(recreated.status).toBe(200);
    expect(recreated.body.recreated?.deletedReviewId).toBe(firstId);
    expect(recreated.body.recreated?.reopened.sort()).toEqual(["r1:reviewer:f1", "r1:reviewer:f2"]);
    expect(recreated.body.commentCount).toBe(2);

    const deletes = h.github.log.matching("DELETE", `/repos/${OWNER}/${REPO}/pulls/12/reviews/${firstId}`);
    const creates = createCalls(h);
    expect(deletes).toHaveLength(1);
    expect(creates).toHaveLength(1);
    // The order is the whole point. Deleting after creating would leave two
    // drafts on the PR for as long as the second call took.
    const deleteSeq = deletes[0]?.seq ?? Number.POSITIVE_INFINITY;
    const createSeq = creates[0]?.seq ?? 0;
    expect(deleteSeq).toBeLessThan(createSeq);

    // The old draft is gone from the host and the new one is pending.
    expect(h.github.reviews.get(firstId)).toBeNull();
    expect(h.github.reviews.get(recreated.body.reviewId)?.state).toBe("PENDING");
    expect(recreated.body.reviewId).not.toBe(firstId);

    const meta = await loadMeta(h.lgtmDir, ref(12));
    expect(meta?.pendingReviewId).toBe(recreated.body.reviewId);
    // The findings went open and then posted again, so they are on the new
    // draft rather than silently missing from it.
    expect((await allFindings(h, 12)).every((finding) => finding.state === "posted")).toBe(true);
  }, 60_000);
});

// ═══════════════════════════════════════════════════════════════════════════
// 6. A draft submitted in GitHub's UI
// ═══════════════════════════════════════════════════════════════════════════

describe("journey 6: a submitted draft stops blocking the next post", () => {
  test("both the poll cycle and the post flow clear a record GitHub no longer holds pending", async () => {
    const h = await start();

    await h.api.post("/api/watchlist", { repo: `${OWNER}/${REPO}` });
    h.repo.openPR({ number: 20, author: VIEWER, diff: DIFF_BOTH });
    await h.poll();

    const first = await h.api.post<{ reviewId: number }>(`/api/prs/${OWNER}/${REPO}/20/post`);
    expect(first.status).toBe(200);
    const firstId = first.body.reviewId;
    expect((await loadMeta(h.lgtmDir, ref(20)))?.pendingReviewId).toBe(firstId);

    // The human opens GitHub and submits the draft. It is no longer pending.
    h.github.reviews.submit(firstId);

    // ── The poll cycle notices ────────────────────────────────────────────
    h.repo.pushCommit(20);
    h.github.log.clear();
    const cycle = await h.poll();

    expect(cycle.cycle?.repos[0]?.reconciled).toBe(1);
    expect(
      h.github.log.matching("GET", `/repos/${OWNER}/${REPO}/pulls/20/reviews/${firstId}`)
    ).toHaveLength(1);

    const reconciled = await loadMeta(h.lgtmDir, ref(20));
    expect(reconciled?.pendingReviewId).toBeNull();
    expect(reconciled?.rounds).toBe(2);

    // The new round's findings are open; the ones already on the submitted
    // review stay posted and are not sent again.
    const secondRound = (await allFindings(h, 20)).filter((finding) => finding.round === 2);
    expect(secondRound.map((finding) => finding.state)).toEqual(["open", "open"]);

    const second = await h.api.post<{ reviewId: number; commentCount: number; clearedReviewId: number | null }>(
      `/api/prs/${OWNER}/${REPO}/20/post`
    );
    expect(second.status).toBe(200);
    expect(second.body.commentCount).toBe(2);
    const secondId = second.body.reviewId;

    // ── And the post flow notices on its own ──────────────────────────────
    // Submitted again, and this time nothing polls in between, so the only
    // thing standing between the user and a permanent refusal is step 1 of
    // the posting flow.
    h.github.reviews.submit(secondId);

    const reopen = await h.api.patch<{ changed: boolean }>(
      `/api/prs/${OWNER}/${REPO}/20/findings/r1:reviewer:f1`,
      { state: "open" }
    );
    expect(reopen.status).toBe(200);
    expect(reopen.body.changed).toBe(true);

    const third = await h.api.post<{ reviewId: number; clearedReviewId: number | null }>(
      `/api/prs/${OWNER}/${REPO}/20/post`
    );
    expect(third.status).toBe(200);
    expect(third.body.clearedReviewId).toBe(secondId);
    expect(third.body.reviewId).not.toBe(secondId);
    expect(h.github.reviews.get(third.body.reviewId)?.state).toBe("PENDING");

    // A stale record is cleared, never deleted from the host: the submitted
    // reviews are still there, and no DELETE was ever sent.
    expect(h.github.reviews.get(firstId)?.state).toBe("COMMENTED");
    expect(h.github.reviews.get(secondId)?.state).toBe("COMMENTED");
    expect(h.github.log.matching("DELETE", /\/reviews\/\d+$/)).toHaveLength(0);
  }, 60_000);
});

// ═══════════════════════════════════════════════════════════════════════════
// 7. A provider that returns garbage
// ═══════════════════════════════════════════════════════════════════════════

describe("journey 7: unparseable provider output is a failed Round", () => {
  test("the raw output is kept, the PR is not marked reviewed, and the next cycle retries", async () => {
    const h = await start({ claudeMode: "garbage" });

    await h.api.post("/api/watchlist", { repo: `${OWNER}/${REPO}` });
    h.repo.openPR({ number: 30, author: VIEWER, diff: DIFF_BOTH });
    await h.poll();

    // R3.5: a failed Round never marks the PR reviewed, and lastReviewedSha
    // stays put so the next cycle sees this SHA as still un-reviewed.
    const meta = await loadMeta(h.lgtmDir, ref(30));
    expect(meta?.state).toBe("failed");
    expect(meta?.lastReviewedSha).toBeNull();
    expect(meta?.failedAttempts).toBe(1);
    expect(meta?.rounds).toBe(1);

    const rounds = await loadAllRounds(h.lgtmDir, ref(30));
    expect(rounds).toHaveLength(1);
    expect(rounds[0]?.status).toBe("failed");
    // R3.4: never a silent zero findings.
    expect(rounds[0]?.findings).toEqual([]);

    // The unparseable output is preserved next to the round file.
    const entries = await dirEntries(h, 30);
    expect(entries).toContain("r1-reviewer.raw.txt");
    // A failed Round gets no snapshot; nothing will ever slice a hunk from one.
    expect(entries.some((name) => name.startsWith("diff-"))).toBe(false);

    const raw = await fs.readFile(path.join(reviewDir(h.lgtmDir, ref(30)), "r1-reviewer.raw.txt"), "utf-8");
    expect(raw).toContain("could not parse provider output");
    expect(raw).toContain("This is not valid JSON");

    // The failure is one cause on the bus, so one broken CLI notifies once
    // however many PRs hit it (R8.2).
    expect(
      h.events.filter((event) => event.type === "error" && event.cause.startsWith("review:"))
    ).not.toHaveLength(0);

    const row = rowFor(await listPRs(h), 30);
    expect(row.state).toBe("failed");
    expect(row.findings.total).toBe(0);
    expect(row.findings.pending).toBe(0);

    // Nothing reached GitHub.
    expect(createCalls(h)).toHaveLength(0);

    // The next cycle retries the same SHA, up to the cap of 3.
    h.repo.setMergeable(30, null);
    await h.poll();
    const retried = await loadMeta(h.lgtmDir, ref(30));
    expect(retried?.failedAttempts).toBe(2);
    expect(retried?.rounds).toBe(2);
    expect(retried?.state).toBe("failed");

    // And once the provider recovers, the same PR reviews cleanly.
    h.setClaudeMode("json");
    h.repo.setMergeable(30, true);
    await h.poll();

    const recovered = await loadMeta(h.lgtmDir, ref(30));
    expect(recovered?.state).toBe("reviewed");
    expect(recovered?.failedAttempts).toBe(0);
    expect(recovered?.lastReviewedSha).toBe(h.repo.pr(30)?.headSha);
    expect((await allFindings(h, 30)).filter((finding) => finding.round === 3)).toHaveLength(2);
  }, 60_000);
});

// ═══════════════════════════════════════════════════════════════════════════
// 8. The API is closed to anything without the daemon's token
// ═══════════════════════════════════════════════════════════════════════════

describe("journey 8: the token is what stands between a local process and the Gate", () => {
  test("an unauthenticated caller can neither read the inbox nor post a review", async () => {
    const h = await start();

    await h.api.post("/api/watchlist", { repo: `${OWNER}/${REPO}` });
    h.repo.openPR({ number: 16, author: VIEWER, diff: DIFF_BOTH });
    await h.poll();
    expect(await allFindings(h, 16)).toHaveLength(2);

    // Not through the harness's client, which always carries the token, and
    // which is exactly why every other journey here is blind to this. The
    // daemon listens on loopback and every process on the machine can reach
    // it; `apiBind()` mounting the auth choke point is the whole of what
    // stops one of them posting a review under the user's name. A unit test
    // of the auth function cannot see a bind that forgot to call it.
    const origin = h.api.origin;

    const bare = await fetch(`${origin}/api/prs`);
    expect(bare.status).toBe(401);

    const wrongToken = await fetch(`${origin}/api/prs`, {
      headers: { authorization: "Bearer not-this-daemons-token" },
    });
    expect(wrongToken.status).toBe(401);

    const post = await fetch(`${origin}/api/prs/${OWNER}/${REPO}/16/post`, {
      method: "POST",
      headers: { "content-type": "application/json", origin },
      body: "{}",
    });
    expect(post.status).toBe(401);

    // With the token but a browser's Origin, the write is refused as well,
    // which is what keeps a page the user happens to be visiting from driving
    // the Gate through their own daemon.
    const crossOrigin = await fetch(`${origin}/api/prs/${OWNER}/${REPO}/16/post`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${h.daemon.token}`,
        "content-type": "application/json",
        origin: "https://not-the-daemon.example",
      },
      body: "{}",
    });
    expect(crossOrigin.status).toBe(403);

    // None of them reached GitHub, and none of them moved a finding.
    expect(createCalls(h)).toHaveLength(0);
    expect(h.github.reviews.all()).toHaveLength(0);
    expect((await allFindings(h, 16)).every((finding) => finding.state === "open")).toBe(true);
    expect((await loadMeta(h.lgtmDir, ref(16)))?.pendingReviewId).toBeNull();

    // And the same request with the token works. Without this line the four
    // refusals above would also pass against a daemon with no such route.
    const allowed = await h.api.post<{ reviewId: number }>(`/api/prs/${OWNER}/${REPO}/16/post`);
    expect(allowed.status).toBe(200);
    expect(createCalls(h)).toHaveLength(1);
    expect(h.github.reviews.get(allowed.body.reviewId)?.state).toBe("PENDING");
  }, 60_000);
});

// ═══════════════════════════════════════════════════════════════════════════
// 9. The QuotaGate
// ═══════════════════════════════════════════════════════════════════════════

describe("journey 9: high usage holds new review work", () => {
  test("a PR that would auto-review waits instead of spending the user's quota", async () => {
    const h = await start({
      // Above config.md's pause_above_pct of 70. No reset is printed, so the
      // throttle cannot expire underneath the journey. The gate runs on the
      // maximum across windows because either one exhausting blocks the user
      // as completely as it blocks LGTM.
      usageProbe: async () => ({ output: "Current session: 92% used", error: null }),
      // The queue re-drains itself on a real timer, which is right in
      // production and a race here. This journey wants the queue held until
      // it says otherwise.
      setTimer: () => () => {},
    });

    await h.api.post("/api/watchlist", { repo: `${OWNER}/${REPO}` });
    h.repo.openPR({ number: 17, author: VIEWER, title: "Add rate limiter", diff: DIFF_BOTH });

    const cycle = await h.poll();
    // The cycle still classifies and enqueues. The gate governs dispatch, not
    // decisions: queued work is kept, never dropped (R4.2).
    expect(cycle.cycle?.repos[0]?.queued).toBe(1);

    const queue = h.daemon.queue.status();
    expect(queue.queued).toBe(1);
    expect(queue.inFlight).toBe(0);
    expect(queue.pausedByGate).toBe(true);
    expect(h.daemon.quota.state().mode).toBe("throttled");
    expect(h.daemon.quota.state().maxPercent).toBe(92);

    // Nothing ran. No Round file, no findings, no diff snapshot, and the PR
    // says `queued` rather than claiming to have been reviewed. The QuotaGate
    // exists so LGTM never competes with the human for the subscription they
    // are both spending; a gate wired but not consulted looks identical to a
    // working one on every other journey in this file.
    const meta = await loadMeta(h.lgtmDir, ref(17));
    expect(meta?.state).toBe("queued");
    expect(meta?.rounds).toBe(0);
    expect(meta?.lastReviewedSha).toBeNull();
    expect(await allFindings(h, 17)).toEqual([]);
    expect(await dirEntries(h, 17)).toEqual(["meta.md"]);
    expect(createCalls(h)).toHaveLength(0);

    const row = rowFor(await listPRs(h), 17);
    expect(row.state).toBe("queued");
    expect(row.findings.total).toBe(0);

    // A second cycle does not sneak it past either.
    h.repo.setMergeable(17, null);
    await h.poll();
    expect(h.daemon.queue.status().queued).toBe(1);
    expect((await loadMeta(h.lgtmDir, ref(17)))?.rounds).toBe(0);
  }, 60_000);
});

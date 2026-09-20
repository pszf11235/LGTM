/**
 * The review store is the state machine the whole loop turns on: what has
 * been found, what has been posted, what a later round already covered.
 * Getting "posted" wrong either double-posts to a real PR or silently drops
 * findings — so the finding-identity tests below come first and are ported
 * verbatim in spirit from the old codebase's regression fix (main: 6c0f08c,
 * "scope posted, skipped and discarded to one round").
 *
 * Adapted from packages/plugins/review/src/domain/review-store.test.ts on
 * the old `main` branch (44 tests) to the new nested reviews/<owner>/<repo>/
 * pr-<n>/ layout and the new state/heldReason finding model. Three groups of
 * old tests do not carry over, and each is called out where it would have
 * been:
 *  - round-file "frontmatter repeats owner/repo/url" and "body links the
 *    PR": design.md's round-file schema does not repeat PR identity (the
 *    nested path already provides it); that behavior now lives on meta.md
 *    instead, so the equivalent tests moved to the "meta" describe block.
 *  - the old meta's round-table (RoundRecord[], postedCount/findingCount
 *    recompute, verifiedPriorRound carryover, submittedAt): design.md's
 *    meta.md frontmatter tracks `rounds` as a plain count, not a per-round
 *    history, so there is nothing left to recompute. Replaced with tests of
 *    the new upsert/patch behavior around the fields design.md does define
 *    (failedAttempts, pendingReviewId, closedAt).
 *  - applyVerdicts and everything under "resolved": verification passes
 *    over posted findings are an explicit v1 non-goal (requirements.md,
 *    "Non-goals for v1"), and core/types.ts's Finding has no resolved
 *    field. Not ported.
 *
 * One behavior is new, not ported from anywhere: markFindingsOpen's
 * posted -> open transition, for R6.1's "recreate" flow, which the old flat
 * per-finding-pendingReviewId model didn't need in this shape.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { parseOKF, stringifyOKF } from "./okf.js";
import {
  diffSnapshotPath,
  ensureSessionsDir,
  listReviewedPRs,
  loadAllRounds,
  loadMeta,
  loadRound,
  markFindingsDiscarded,
  markFindingsHeld,
  markFindingsOpen,
  markFindingsPosted,
  pendingFindings,
  postedFindings,
  prUrl,
  rawOutputPath,
  reviewDir,
  saveMeta,
  saveRound,
  sessionsDir,
  type SaveRoundInput,
} from "./reviews.js";
import type { Finding, PRRef } from "@/core";

let store: string;

const ref: PRRef = { owner: "pszf11235", repo: "LGTM", number: 42 };
const other: PRRef = { owner: "someorg", repo: "backend", number: 108 };

type RawFinding = Omit<Finding, "id" | "state" | "heldReason">;

function finding(over: Partial<RawFinding> = {}): RawFinding {
  return { file: "src/a.ts", line: 10, severity: "high", comment: "boom", ...over };
}

function writeRound(
  target: PRRef,
  round: number,
  agent: string,
  findings: RawFinding[],
  extra: Partial<SaveRoundInput> = {}
) {
  return saveRound(store, {
    ref: target,
    round,
    agent,
    provider: "claude-cli",
    headSha: "a".repeat(40),
    status: "ok",
    startedAt: new Date().toISOString(),
    durationMs: 1000,
    findings,
    ...extra,
  });
}

beforeEach(async () => {
  store = await fs.mkdtemp(path.join(os.tmpdir(), "lgtm-review-store-"));
});

afterEach(async () => {
  await fs.rm(store, { recursive: true, force: true }).catch(() => {});
});

// ─── Layout ─────────────────────────────────────────────────────────────────

describe("layout", () => {
  test("a PR's reviews live in a nested, repo-qualified directory", () => {
    // Nesting by owner then repo then pr-<n> means no directory name ever
    // has to be split back apart, unlike the old flat <owner>-<repo>-<pr>.
    expect(reviewDir(store, ref)).toBe(path.join(store, "reviews", "pszf11235", "LGTM", "pr-42"));
  });

  test("two repos with the same PR number do not collide", async () => {
    await writeRound(ref, 1, "reviewer", [finding()]);
    await writeRound({ owner: "other", repo: "repo", number: 42 }, 1, "reviewer", [
      finding({ comment: "different" }),
    ]);

    expect((await loadRound(store, ref, 1, "reviewer"))!.findings[0]!.comment).toBe("boom");
    expect((await loadRound(store, { owner: "other", repo: "repo", number: 42 }, 1, "reviewer"))!.findings[0]!.comment).toBe(
      "different"
    );
  });

  test("round files are named r<N>-<agent>.md", async () => {
    await writeRound(ref, 2, "reviewer", [finding()]);

    expect(await fs.exists(path.join(reviewDir(store, ref), "r2-reviewer.md"))).toBe(true);
  });

  test("meta.md frontmatter repeats owner, repo, number and url so it reads standalone", async () => {
    // Round files don't need to (the path already identifies them), but
    // meta.md is the file design.md gives PR identity to.
    await saveMeta(store, ref, { title: "Add auth", author: "someone" });

    const raw = await fs.readFile(path.join(reviewDir(store, ref), "meta.md"), "utf-8");
    const { data } = parseOKF(raw);

    expect(data.owner).toBe("pszf11235");
    expect(data.repo).toBe("LGTM");
    expect(data.number).toBe(42);
    expect(data.url).toBe("https://github.com/pszf11235/LGTM/pull/42");
  });

  test("the meta body links the PR so it is clickable wherever it is rendered", async () => {
    await saveMeta(store, ref, { title: "Add auth", author: "someone" });

    const body = await fs.readFile(path.join(reviewDir(store, ref), "meta.md"), "utf-8");

    expect(body).toContain(`[Add auth](${prUrl(ref)})`);
    expect(body).toContain("pszf11235/LGTM#42");
  });
});

// ─── Finding ids ────────────────────────────────────────────────────────────

describe("finding ids", () => {
  test("are f1..fn in file order", async () => {
    const round = await writeRound(ref, 1, "reviewer", [
      finding({ comment: "one" }),
      finding({ comment: "two" }),
      finding({ comment: "three" }),
    ]);

    expect(round.findings.map((f) => f.id)).toEqual(["f1", "f2", "f3"]);
  });

  test("survive a reload, so a discard by f3 means the same finding later", async () => {
    await writeRound(ref, 1, "reviewer", [finding({ comment: "one" }), finding({ comment: "two" })]);

    const reloaded = (await loadRound(store, ref, 1, "reviewer"))!;

    expect(reloaded.findings.map((f) => f.id)).toEqual(["f1", "f2"]);
    expect(reloaded.findings[1]!.comment).toBe("two");
  });

  test("restart per round file, which is why round and agent are part of the key", async () => {
    await writeRound(ref, 1, "reviewer", [finding({ comment: "round one" })]);
    await writeRound(ref, 2, "reviewer", [finding({ comment: "round two" })]);

    expect((await loadRound(store, ref, 1, "reviewer"))!.findings[0]!.id).toBe("f1");
    expect((await loadRound(store, ref, 2, "reviewer"))!.findings[0]!.id).toBe("f1");
  });
});

// ─── Posting state ──────────────────────────────────────────────────────────

describe("posting state", () => {
  test("new findings start open, which is what makes local-first work", async () => {
    const round = await writeRound(ref, 1, "reviewer", [finding()]);

    expect(round.findings[0]!.state).toBe("open");
    expect(round.findings[0]!.heldReason).toBeNull();
  });

  test("pendingFindings returns what has not been posted or discarded", async () => {
    await writeRound(ref, 1, "reviewer", [
      finding({ comment: "one" }),
      finding({ comment: "two" }),
      finding({ comment: "three" }),
    ]);

    await markFindingsPosted(store, ref, ["r1:reviewer:f1"]);
    await markFindingsDiscarded(store, ref, ["r1:reviewer:f2"]);

    expect((await pendingFindings(store, ref)).map((f) => f.comment)).toEqual(["three"]);
  });

  test("posting r2's f1 leaves r1's f1 alone, because ids restart every round", async () => {
    // Ids are only unique within a round file. Keying on the bare id meant
    // posting one round stamped every other round's f1 as posted too: those
    // findings were never sent, dropped out of pendingFindings forever, and
    // showed as posted in the UI. The full r<N>:<agent>:<id> key is the fix.
    await writeRound(ref, 1, "reviewer", [finding({ comment: "round one" })]);
    await writeRound(ref, 2, "reviewer", [finding({ comment: "round two" })]);

    await markFindingsPosted(store, ref, ["r2:reviewer:f1"]);

    expect((await loadRound(store, ref, 1, "reviewer"))!.findings[0]!.state).toBe("open");
    expect((await loadRound(store, ref, 2, "reviewer"))!.findings[0]!.state).toBe("posted");
    expect((await pendingFindings(store, ref)).map((f) => f.comment)).toEqual(["round one"]);
  });

  test("a key without the round's r prefix does not match — the canonical form is required", async () => {
    // r2:reviewer:f1 and r1:reviewer:f1 must never be treated as the same
    // finding, and neither may collapse to a bare "1:reviewer:f1"-style key.
    await writeRound(ref, 1, "reviewer", [finding()]);

    const changed = await markFindingsPosted(store, ref, ["1:reviewer:f1"]);

    expect(changed).toEqual([]);
    expect((await loadRound(store, ref, 1, "reviewer"))!.findings[0]!.state).toBe("open");
  });

  test("discarding is scoped to one round too", async () => {
    await writeRound(ref, 1, "reviewer", [finding({ comment: "round one" })]);
    await writeRound(ref, 2, "reviewer", [finding({ comment: "round two" })]);

    await markFindingsDiscarded(store, ref, ["r1:reviewer:f1"]);

    expect((await loadRound(store, ref, 1, "reviewer"))!.findings[0]!.state).toBe("discarded");
    expect((await loadRound(store, ref, 2, "reviewer"))!.findings[0]!.state).toBe("open");
  });

  test("marking posted returns the canonical key that changed", async () => {
    await writeRound(ref, 1, "reviewer", [finding()]);

    const changed = await markFindingsPosted(store, ref, ["r1:reviewer:f1"]);

    expect(changed).toEqual(["r1:reviewer:f1"]);
    expect((await loadRound(store, ref, 1, "reviewer"))!.findings[0]!.state).toBe("posted");
  });

  test("marking posted twice does not report a second change", async () => {
    // Re-running a post must not double-count or re-post.
    await writeRound(ref, 1, "reviewer", [finding()]);

    await markFindingsPosted(store, ref, ["r1:reviewer:f1"]);
    expect(await markFindingsPosted(store, ref, ["r1:reviewer:f1"])).toEqual([]);

    expect((await loadRound(store, ref, 1, "reviewer"))!.findings[0]!.state).toBe("posted");
  });

  test("a key that does not exist is reported as unchanged, not silently ignored", async () => {
    await writeRound(ref, 1, "reviewer", [finding()]);

    expect(await markFindingsDiscarded(store, ref, ["r1:reviewer:f9"])).toEqual([]);
  });

  test("a posted finding cannot be discarded, because it is already on GitHub", async () => {
    await writeRound(ref, 1, "reviewer", [finding()]);
    await markFindingsPosted(store, ref, ["r1:reviewer:f1"]);

    expect(await markFindingsDiscarded(store, ref, ["r1:reviewer:f1"])).toEqual([]);
    expect((await loadRound(store, ref, 1, "reviewer"))!.findings[0]!.state).toBe("posted");
  });

  test("a discarded finding stays on disk, so the decision is auditable", async () => {
    await writeRound(ref, 1, "reviewer", [finding()]);
    await markFindingsDiscarded(store, ref, ["r1:reviewer:f1"]);

    const stored = (await loadRound(store, ref, 1, "reviewer"))!.findings[0]!;
    expect(stored.state).toBe("discarded");
    expect(stored.comment).toBe("boom");
  });

  test("discarding is reversible (R5.2): markFindingsOpen undoes it", async () => {
    await writeRound(ref, 1, "reviewer", [finding()]);
    await markFindingsDiscarded(store, ref, ["r1:reviewer:f1"]);

    const changed = await markFindingsOpen(store, ref, ["r1:reviewer:f1"]);

    expect(changed).toEqual(["r1:reviewer:f1"]);
    expect((await loadRound(store, ref, 1, "reviewer"))!.findings[0]!.state).toBe("open");
  });

  test("recreating a draft flips that draft's posted findings back to open (R6.1)", async () => {
    // The REST API cannot append to a pending review, so recreating one
    // deletes the old draft — and its comments left GitHub with it.
    await writeRound(ref, 1, "reviewer", [finding()]);
    await markFindingsPosted(store, ref, ["r1:reviewer:f1"]);

    const changed = await markFindingsOpen(store, ref, ["r1:reviewer:f1"]);

    expect(changed).toEqual(["r1:reviewer:f1"]);
    expect((await loadRound(store, ref, 1, "reviewer"))!.findings[0]!.state).toBe("open");
  });
});

// ─── Held findings ──────────────────────────────────────────────────────────

describe("held findings", () => {
  test("a held finding stays eligible, since a fresh diff may restore the line", async () => {
    // GitHub rejects a comment on a line outside the diff. Holding it back
    // is not the same as dropping it (R6.3).
    await writeRound(ref, 1, "reviewer", [finding({ line: 900 })]);

    await markFindingsHeld(store, ref, [{ key: "r1:reviewer:f1", reason: "line 900 not present in PR diff" }]);

    const stored = (await loadRound(store, ref, 1, "reviewer"))!.findings[0]!;
    expect(stored.state).toBe("held");
    expect(stored.heldReason).toContain("not present");

    expect((await pendingFindings(store, ref)).map((f) => f.id)).toEqual(["f1"]);
  });

  test("posting a previously held finding clears the hold", async () => {
    await writeRound(ref, 1, "reviewer", [finding()]);
    await markFindingsHeld(store, ref, [{ key: "r1:reviewer:f1", reason: "not in diff" }]);

    await markFindingsPosted(store, ref, ["r1:reviewer:f1"]);

    const stored = (await loadRound(store, ref, 1, "reviewer"))!.findings[0]!;
    expect(stored.state).toBe("posted");
    expect(stored.heldReason).toBeNull();
  });
});

// ─── Meta ───────────────────────────────────────────────────────────────────

describe("meta", () => {
  test("is null before the first save, which is how a new PR is detected", async () => {
    expect(await loadMeta(store, ref)).toBeNull();
  });

  test("creating fresh meta fills tolerant defaults for everything not given", async () => {
    const meta = await saveMeta(store, ref, { title: "Add auth" });

    expect(meta.state).toBe("triage");
    expect(meta.classification).toBe("none");
    expect(meta.draft).toBe(false);
    expect(meta.failedAttempts).toBe(0);
    expect(meta.rounds).toBe(0);
    expect(meta.lastReviewedSha).toBeNull();
    expect(meta.pendingReviewId).toBeNull();
    expect(meta.closedAt).toBeNull();
    expect(meta.url).toBe(prUrl(ref));
  });

  test("a second save merges onto the existing record rather than replacing it", async () => {
    await saveMeta(store, ref, { title: "Add auth", author: "someone" });
    await saveMeta(store, ref, { state: "queued" });

    const meta = (await loadMeta(store, ref))!;
    expect(meta.title).toBe("Add auth");
    expect(meta.author).toBe("someone");
    expect(meta.state).toBe("queued");
  });

  test("records the head SHA, which is how new commits are detected", async () => {
    await saveMeta(store, ref, { headSha: "a".repeat(40) });
    await saveMeta(store, ref, { headSha: "b".repeat(40), lastReviewedSha: "b".repeat(40), rounds: 1 });

    const meta = (await loadMeta(store, ref))!;
    expect(meta.headSha).toBe("b".repeat(40));
    expect(meta.lastReviewedSha).toBe("b".repeat(40));
    expect(meta.rounds).toBe(1);
  });

  test("failedAttempts is set and reset to 0 explicitly, not just left alone by omission", async () => {
    await saveMeta(store, ref, { failedAttempts: 2 });
    expect((await loadMeta(store, ref))!.failedAttempts).toBe(2);

    // A fresh head SHA resets the retry counter (design.md, "Poll cycle").
    // 0 is a legitimate explicit value, not "omitted" — `??` must not treat
    // it as such.
    await saveMeta(store, ref, { failedAttempts: 0 });
    expect((await loadMeta(store, ref))!.failedAttempts).toBe(0);
  });

  test("pendingReviewId is recorded and cleared back to null explicitly", async () => {
    await saveMeta(store, ref, { pendingReviewId: 987654 });
    expect((await loadMeta(store, ref))!.pendingReviewId).toBe(987654);

    await saveMeta(store, ref, { pendingReviewId: null });
    expect((await loadMeta(store, ref))!.pendingReviewId).toBeNull();
  });

  test("closedAt is stamped on close and stays null otherwise", async () => {
    await saveMeta(store, ref, { state: "reviewed" });
    expect((await loadMeta(store, ref))!.closedAt).toBeNull();

    const closedAt = new Date().toISOString();
    await saveMeta(store, ref, { state: "closed", closedAt });
    expect((await loadMeta(store, ref))!.closedAt).toBe(closedAt);
  });

  test("updatedAt bumps on every save", async () => {
    const first = await saveMeta(store, ref, { title: "Add auth" });
    await new Promise((r) => setTimeout(r, 2));
    const second = await saveMeta(store, ref, { state: "queued" });

    expect(second.updatedAt).not.toBe(first.updatedAt);
  });

  test("triage metadata round-trips through the frontmatter", async () => {
    await saveMeta(store, ref, {
      createdAt: "2026-08-01T00:00:00.000Z",
      additions: 120,
      deletions: 34,
      changedFiles: 7,
      mergeable: true,
      checkStatus: "failure",
    });

    const meta = (await loadMeta(store, ref))!;
    expect(meta.createdAt).toBe("2026-08-01T00:00:00.000Z");
    expect(meta.additions).toBe(120);
    expect(meta.deletions).toBe(34);
    expect(meta.changedFiles).toBe(7);
    expect(meta.mergeable).toBe(true);
    expect(meta.checkStatus).toBe("failure");
  });

  test("triage metadata is null before anything fetched it, never zero", async () => {
    // Null is the honest answer for a PR known only from a list row, where
    // nobody has called the detail endpoint yet. A 0 would render as a
    // measured "+0 -0" in the inbox.
    const meta = await saveMeta(store, ref, { state: "triage" });

    expect(meta.createdAt).toBeNull();
    expect(meta.additions).toBeNull();
    expect(meta.deletions).toBeNull();
    expect(meta.changedFiles).toBeNull();
    expect(meta.mergeable).toBeNull();
    expect(meta.checkStatus).toBeNull();
  });

  test("a mergeable GitHub is still computing stays null all the way to disk", async () => {
    // The one field where a wrong default does damage. Null means
    // "computing", and false claims a conflict the user would go looking for.
    await saveMeta(store, ref, { mergeable: null });

    expect((await loadMeta(store, ref))!.mergeable).toBeNull();
  });

  test("a rebase clears a stored conflict back to computing", async () => {
    // false -> null is a real transition, so the patch has to be able to
    // write null over a value rather than read it as "field omitted".
    await saveMeta(store, ref, { mergeable: false });
    expect((await loadMeta(store, ref))!.mergeable).toBe(false);

    await saveMeta(store, ref, { mergeable: null });
    expect((await loadMeta(store, ref))!.mergeable).toBeNull();
  });

  test("a save that omits triage metadata keeps what was fetched before", async () => {
    await saveMeta(store, ref, { additions: 9, deletions: 2, changedFiles: 1, checkStatus: "success" });
    await saveMeta(store, ref, { state: "queued" });

    const meta = (await loadMeta(store, ref))!;
    expect(meta.state).toBe("queued");
    expect(meta.additions).toBe(9);
    expect(meta.checkStatus).toBe("success");
  });

  test("no checks and never fetched are different answers", async () => {
    // "none" is measured. The Checks API was read and this SHA has no runs,
    // where null is that it was never read at all. The inbox renders one as
    // "No checks" and the other as a dash.
    await saveMeta(store, ref, { checkStatus: "none" });
    expect((await loadMeta(store, ref))!.checkStatus).toBe("none");
  });

  test("the body carries the triage line once there is something to say", async () => {
    await saveMeta(store, ref, {
      title: "Add auth",
      additions: 12,
      deletions: 3,
      changedFiles: 2,
      mergeable: true,
      checkStatus: "success",
    });

    const body = await fs.readFile(path.join(reviewDir(store, ref), "meta.md"), "utf-8");
    expect(body).toContain("+12 -3 across 2 file(s)");
    expect(body).toContain("checks: success");
  });

  test("mentions the open draft when one exists, with a link to edit it", async () => {
    await saveMeta(store, ref, { title: "Add auth", pendingReviewId: 4242 });

    const body = await fs.readFile(path.join(reviewDir(store, ref), "meta.md"), "utf-8");
    expect(body).toContain("draft review is open");
    expect(body).toContain(`${prUrl(ref)}/files`);
  });
});

// ─── Rounds across agents ───────────────────────────────────────────────────

describe("multiple agents and rounds", () => {
  test("loadAllRounds returns every file, ordered by round then agent", async () => {
    await writeRound(ref, 2, "reviewer", [finding()]);
    await writeRound(ref, 1, "second", [finding()]);
    await writeRound(ref, 1, "reviewer", [finding()]);

    expect((await loadAllRounds(store, ref)).map((r) => `r${r.round}-${r.agent}`)).toEqual([
      "r1-reviewer",
      "r1-second",
      "r2-reviewer",
    ]);
  });

  test("pendingFindings spans agents and rounds, tagged with where each came from", async () => {
    await writeRound(ref, 1, "reviewer", [finding({ comment: "from reviewer" })]);
    await writeRound(ref, 1, "second", [finding({ comment: "from second" })]);

    const pending = await pendingFindings(store, ref);

    expect(pending.length).toBe(2);
    expect(pending.map((f) => f.agent).sort()).toEqual(["reviewer", "second"]);
  });

  test("postedFindings returns only what has actually gone to GitHub", async () => {
    await writeRound(ref, 1, "reviewer", [finding({ comment: "shown" }), finding({ comment: "held back" })]);
    await markFindingsPosted(store, ref, ["r1:reviewer:f1"]);

    expect((await postedFindings(store, ref)).map((f) => f.comment)).toEqual(["shown"]);
  });
});

// ─── Failed rounds ──────────────────────────────────────────────────────────

describe("failed rounds", () => {
  test("a failed round writes status: failed with an empty findings array", async () => {
    await writeRound(ref, 1, "reviewer", [], { status: "failed" });

    const round = (await loadRound(store, ref, 1, "reviewer"))!;
    expect(round.status).toBe("failed");
    expect(round.findings).toEqual([]);

    const body = await fs.readFile(path.join(reviewDir(store, ref), "r1-reviewer.md"), "utf-8");
    expect(body).toContain("Review failed");
  });

  test("keeps raw output only when the round actually failed", async () => {
    // Otherwise every review would leave a copy of the whole provider
    // transcript on disk.
    await writeRound(ref, 1, "reviewer", [], { status: "failed", raw: "I am not JSON" });
    await writeRound(ref, 1, "second", [finding()], { raw: "some output" });

    expect(await fs.exists(rawOutputPath(store, ref, 1, "reviewer"))).toBe(true);
    expect(await fs.readFile(rawOutputPath(store, ref, 1, "reviewer"), "utf-8")).toBe("I am not JSON");
    expect(await fs.exists(rawOutputPath(store, ref, 1, "second"))).toBe(false);
  });
});

// ─── The session behind a round ─────────────────────────────────────────────

describe("session", () => {
  const SESSION = {
    sessionId: "f47ac10b-58cc-4372-a567-0e02b2c3d479",
    sessionCwd: "/Users/someone/.lgtm-farm/sessions",
    costUsd: 0.77,
    turns: 14,
  };

  test("every round is spawned from one directory the store owns", async () => {
    // The Claude CLI files sessions under a slug of the working directory it
    // ran in, so this fixed name is what makes a session findable later.
    expect(sessionsDir(store)).toBe(path.join(store, "sessions"));

    expect(await ensureSessionsDir(store)).toBe(sessionsDir(store));
    expect(await fs.exists(sessionsDir(store))).toBe(true);
  });

  test("creating the sessions directory twice is not an error", async () => {
    // Every round calls it, so it has to be safe to call on an existing store.
    await ensureSessionsDir(store);
    await ensureSessionsDir(store);

    expect(await fs.exists(sessionsDir(store))).toBe(true);
  });

  test("a round records the session, the directory, the cost and the turns", async () => {
    await writeRound(ref, 1, "reviewer", [finding()], SESSION);

    expect(await loadRound(store, ref, 1, "reviewer")).toMatchObject(SESSION);
  });

  test("the session lands in the frontmatter, where a human can read it", async () => {
    await writeRound(ref, 1, "reviewer", [finding()], SESSION);

    const { data } = parseOKF(
      await fs.readFile(path.join(reviewDir(store, ref), "r1-reviewer.md"), "utf-8")
    );

    expect(data.sessionId).toBe(SESSION.sessionId);
    expect(data.sessionCwd).toBe(SESSION.sessionCwd);
    expect(data.costUsd).toBe(0.77);
    expect(data.turns).toBe(14);
  });

  test("the body spells out the command that resumes the review", async () => {
    // Both halves or nothing: run the resume from any other directory and the
    // CLI reports no such session, so the cd is part of the instruction.
    await writeRound(ref, 1, "reviewer", [finding()], SESSION);

    const body = await fs.readFile(path.join(reviewDir(store, ref), "r1-reviewer.md"), "utf-8");

    expect(body).toContain(
      `cd ${SESSION.sessionCwd} && claude --resume ${SESSION.sessionId}`
    );
    expect(body).toContain("Cost: $0.77, 14 turn(s)");
  });

  test("a failed round says how to resume it too", async () => {
    // The round most worth reopening by hand: the review ran, and only the
    // reading of it failed.
    await writeRound(ref, 1, "reviewer", [], { ...SESSION, status: "failed", raw: "not JSON" });

    const body = await fs.readFile(path.join(reviewDir(store, ref), "r1-reviewer.md"), "utf-8");

    expect(body).toContain("Review failed");
    expect(body).toContain(`claude --resume ${SESSION.sessionId}`);
  });

  test("a round with no session says nothing about resuming", async () => {
    await writeRound(ref, 1, "reviewer", [finding()]);

    const round = (await loadRound(store, ref, 1, "reviewer"))!;
    expect(round).toMatchObject({ sessionId: null, sessionCwd: null, costUsd: null, turns: null });

    const body = await fs.readFile(path.join(reviewDir(store, ref), "r1-reviewer.md"), "utf-8");
    expect(body).not.toContain("--resume");
    expect(body).not.toContain("Cost:");
  });

  test("a round that cost nearly nothing still reports a number", async () => {
    // Two decimals would round $0.0031 to $0.00 and read as free.
    await writeRound(ref, 1, "reviewer", [finding()], { costUsd: 0.0031 });

    const body = await fs.readFile(path.join(reviewDir(store, ref), "r1-reviewer.md"), "utf-8");
    expect(body).toContain("Cost: $0.0031");
  });
});

// ─── Hand-edited files ──────────────────────────────────────────────────────

describe("hand-edited files", () => {
  test("a finding with no state field reads as open", async () => {
    // These are markdown files a user may edit. Treating a missing state as
    // undefined would make "is this postable" ambiguous.
    const dir = reviewDir(store, ref);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      path.join(dir, "r1-reviewer.md"),
      stringifyOKF(
        { round: 1, agent: "reviewer", findings: [{ file: "a.ts", line: 1, comment: "hand written" }] },
        "body"
      ),
      "utf-8"
    );

    const findings = (await loadRound(store, ref, 1, "reviewer"))!.findings;

    expect(findings[0]!.state).toBe("open");
    expect(findings[0]!.heldReason).toBeNull();
    expect(findings[0]!.id).toBe("f1");
  });

  test("a finding missing a file or comment is dropped as unusable", async () => {
    const dir = reviewDir(store, ref);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      path.join(dir, "r1-reviewer.md"),
      stringifyOKF(
        {
          round: 1,
          agent: "reviewer",
          findings: [
            { line: 1, comment: "no file" },
            { file: "a.ts", line: 2 },
          ],
        },
        "body"
      ),
      "utf-8"
    );

    expect((await loadRound(store, ref, 1, "reviewer"))!.findings).toEqual([]);
  });

  test("editing the body does not get overwritten when findings change", async () => {
    await writeRound(ref, 1, "reviewer", [finding()]);
    const filePath = path.join(reviewDir(store, ref), "r1-reviewer.md");

    const { data } = parseOKF(await fs.readFile(filePath, "utf-8"));
    await fs.writeFile(filePath, stringifyOKF(data, "my own notes here"), "utf-8");

    await markFindingsDiscarded(store, ref, ["r1:reviewer:f1"]);

    expect(await fs.readFile(filePath, "utf-8")).toContain("my own notes here");
    expect((await loadRound(store, ref, 1, "reviewer"))!.findings[0]!.state).toBe("discarded");
  });

  test("a meta.md with no triage fields reads as null rather than throwing", async () => {
    // Every meta.md written before this data existed looks like this, and so
    // does one a user trimmed by hand.
    const dir = reviewDir(store, ref);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      path.join(dir, "meta.md"),
      stringifyOKF({ owner: ref.owner, repo: ref.repo, number: ref.number, state: "triage" }, "body"),
      "utf-8"
    );

    const meta = (await loadMeta(store, ref))!;
    expect(meta.state).toBe("triage");
    expect(meta.additions).toBeNull();
    expect(meta.changedFiles).toBeNull();
    expect(meta.mergeable).toBeNull();
    expect(meta.checkStatus).toBeNull();
  });

  test("garbage in a triage field reads as null, and never as false or zero", async () => {
    const dir = reviewDir(store, ref);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      path.join(dir, "meta.md"),
      stringifyOKF(
        {
          owner: ref.owner,
          repo: ref.repo,
          number: ref.number,
          additions: "lots",
          mergeable: "maybe",
          checkStatus: "greenish",
        },
        "body"
      ),
      "utf-8"
    );

    const meta = (await loadMeta(store, ref))!;
    expect(meta.additions).toBeNull();
    // Not false. A hand-edit typo must not tell the user their PR conflicts.
    expect(meta.mergeable).toBeNull();
    expect(meta.checkStatus).toBeNull();
  });

  test("a round file written before sessions existed loads with them null", async () => {
    // Exactly the shape every round file on disk already has. It must keep
    // loading unchanged, with four honest nulls rather than a parse failure.
    const dir = reviewDir(store, ref);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      path.join(dir, "r1-reviewer.md"),
      stringifyOKF(
        {
          round: 1,
          agent: "reviewer",
          provider: "claude-cli",
          status: "ok",
          headSha: "abc123",
          startedAt: "2026-08-29T10:00:00Z",
          durationMs: 84210,
          findings: [{ id: "f1", file: "src/limiter.ts", line: 118, severity: "high", comment: "boom", state: "open" }],
        },
        "# Round 1"
      ),
      "utf-8"
    );

    const round = (await loadRound(store, ref, 1, "reviewer"))!;

    expect(round).toMatchObject({
      round: 1,
      agent: "reviewer",
      status: "ok",
      headSha: "abc123",
      durationMs: 84210,
      sessionId: null,
      sessionCwd: null,
      costUsd: null,
      turns: null,
    });
    expect(round.findings[0]).toMatchObject({ id: "f1", file: "src/limiter.ts", state: "open" });
  });

  test("garbage in a session field reads as null, never as a resumable id", async () => {
    // A round file claiming a session that does not exist would print a
    // resume command that fails, which is worse than printing none.
    const dir = reviewDir(store, ref);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      path.join(dir, "r1-reviewer.md"),
      stringifyOKF(
        {
          round: 1,
          agent: "reviewer",
          sessionId: "   ",
          sessionCwd: 42,
          costUsd: "free",
          turns: 2.5,
          findings: [],
        },
        "body"
      ),
      "utf-8"
    );

    expect(await loadRound(store, ref, 1, "reviewer")).toMatchObject({
      sessionId: null,
      sessionCwd: null,
      costUsd: null,
      turns: null,
    });
  });

  test("a corrupt round file is skipped rather than taking the PR down", async () => {
    await writeRound(ref, 1, "reviewer", [finding()]);
    await fs.writeFile(path.join(reviewDir(store, ref), "r1-second.md"), "---\n: not yaml :\n---\n", "utf-8");

    // The good file still loads.
    expect((await loadAllRounds(store, ref)).some((r) => r.agent === "reviewer")).toBe(true);
  });
});

// ─── Discovery ──────────────────────────────────────────────────────────────

describe("listReviewedPRs", () => {
  test("is empty on a fresh store", async () => {
    expect(await listReviewedPRs(store)).toEqual([]);
  });

  test("finds every PR with a meta file, across repos", async () => {
    await saveMeta(store, ref, { title: "Add auth" });
    await saveMeta(store, other, { title: "Add auth" });

    expect(await listReviewedPRs(store)).toEqual([
      { owner: "pszf11235", repo: "LGTM", number: 42 },
      { owner: "someorg", repo: "backend", number: 108 },
    ]);
  });

  test("a hyphenated repo name works, since the path never needs splitting", async () => {
    // The old flat <owner>-<repo>-<pr> layout made this ambiguous and had to
    // trust frontmatter over the directory name. The nested layout gives
    // owner, repo and number their own path segments, so there is nothing
    // left to disambiguate.
    const hyphenated: PRRef = { owner: "acme", repo: "my-cool-repo", number: 7 };
    await saveMeta(store, hyphenated, { title: "Add auth" });

    expect(await listReviewedPRs(store)).toEqual([hyphenated]);
  });

  test("ignores a directory with no meta file", async () => {
    await fs.mkdir(path.join(store, "reviews", "pszf11235", "LGTM", "junk-dir"), { recursive: true });
    await saveMeta(store, ref, { title: "Add auth" });

    expect(await listReviewedPRs(store)).toEqual([{ owner: "pszf11235", repo: "LGTM", number: 42 }]);
  });
});

// ─── Diff snapshot path ─────────────────────────────────────────────────────

describe("diffSnapshotPath", () => {
  test("sits next to the round and meta files, named by head SHA", () => {
    expect(diffSnapshotPath(store, ref, "abc123")).toBe(path.join(reviewDir(store, ref), "diff-abc123.patch"));
  });
});

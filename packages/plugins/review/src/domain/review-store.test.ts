/**
 * The review store is the state machine the whole loop turns on: what has been
 * found, what has been posted, what a later round already covered. Getting
 * "posted" wrong either double-posts to a real PR or silently drops findings.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import fs from "fs";
import os from "os";
import path from "path";
import matter from "gray-matter";
import {
  saveRound,
  saveMeta,
  loadMeta,
  loadRound,
  loadAllRounds,
  pendingFindings,
  postedFindings,
  markFindingsPosted,
  markFindingsSkipped,
  markFindingsDiscarded,
  applyVerdicts,
  setPendingReviewId,
  markSubmitted,
  listReviewedPRs,
  reviewDir,
  rawOutputPath,
  prUrl,
  type PRRef,
} from "./review-store.js";
import type { RawFinding } from "./providers.js";

let store: string;

const ref: PRRef = { owner: "pszf11235", repo: "LGTM", pr: 42 };
const other: PRRef = { owner: "someorg", repo: "backend", pr: 108 };

function finding(over: Partial<RawFinding> = {}): RawFinding {
  return { file: "src/a.ts", line: 10, severity: "high", comment: "boom", ...over };
}

function writeRound(
  target: PRRef,
  round: number,
  agent: string,
  findings: RawFinding[],
  extra: Partial<Parameters<typeof saveRound>[1]> = {}
) {
  return saveRound(store, {
    ref: target,
    title: "Add auth",
    author: "someone",
    sha: "a".repeat(40),
    round,
    agent,
    provider: "claude-cli",
    findings,
    durationMs: 1000,
    ...extra,
  });
}

beforeEach(() => {
  store = fs.mkdtempSync(path.join(os.tmpdir(), "lgtm-review-store-"));
});

afterEach(() => {
  try { fs.rmSync(store, { recursive: true, force: true }); } catch { /* ignore */ }
});

// ─── Layout ─────────────────────────────────────────────────────────────────

describe("layout", () => {
  test("a PR's reviews live in a repo-qualified directory", () => {
    // One store serves every repo, so the directory has to carry repo identity
    // or two repos' PR 42 collide.
    expect(reviewDir(store, ref)).toBe(path.join(store, "reviews", "pszf11235-LGTM-42"));
  });

  test("two repos with the same PR number do not collide", () => {
    writeRound(ref, 1, "reviewer", [finding()]);
    writeRound({ owner: "other", repo: "repo", pr: 42 }, 1, "reviewer", [finding({ comment: "different" })]);

    expect(loadRound(store, ref, 1, "reviewer")!.findings[0].comment).toBe("boom");
    expect(loadRound(store, { owner: "other", repo: "repo", pr: 42 }, 1, "reviewer")!.findings[0].comment)
      .toBe("different");
  });

  test("round files are named r<N>-<agent>.md", () => {
    writeRound(ref, 2, "reviewer", [finding()]);

    expect(fs.existsSync(path.join(reviewDir(store, ref), "r2-reviewer.md"))).toBe(true);
  });

  test("frontmatter repeats owner, repo and url so a file reads standalone", () => {
    // An agent handed one of these files has no directory context.
    writeRound(ref, 1, "reviewer", [finding()]);

    const { data } = matter(fs.readFileSync(path.join(reviewDir(store, ref), "r1-reviewer.md"), "utf-8"));

    expect(data.owner).toBe("pszf11235");
    expect(data.repo).toBe("LGTM");
    expect(data.pr).toBe(42);
    expect(data.url).toBe("https://github.com/pszf11235/LGTM/pull/42");
  });

  test("the body links the PR so it is clickable wherever it is rendered", () => {
    writeRound(ref, 1, "reviewer", [finding()]);

    const body = fs.readFileSync(path.join(reviewDir(store, ref), "r1-reviewer.md"), "utf-8");

    expect(body).toContain(`[Add auth](${prUrl(ref)})`);
    expect(body).toContain("pszf11235/LGTM#42");
  });
});

// ─── Finding ids ────────────────────────────────────────────────────────────

describe("finding ids", () => {
  test("are f1..fn in file order", () => {
    const round = writeRound(ref, 1, "reviewer", [
      finding({ comment: "one" }),
      finding({ comment: "two" }),
      finding({ comment: "three" }),
    ]);

    expect(round.findings.map((f) => f.id)).toEqual(["f1", "f2", "f3"]);
  });

  test("survive a reload, so `discard -f f3` means the same finding later", () => {
    writeRound(ref, 1, "reviewer", [finding({ comment: "one" }), finding({ comment: "two" })]);

    const reloaded = loadRound(store, ref, 1, "reviewer")!;

    expect(reloaded.findings.map((f) => f.id)).toEqual(["f1", "f2"]);
    expect(reloaded.findings[1].comment).toBe("two");
  });

  test("restart per round file, which is why round and agent are part of the key", () => {
    writeRound(ref, 1, "reviewer", [finding({ comment: "round one" })]);
    writeRound(ref, 2, "reviewer", [finding({ comment: "round two" })]);

    expect(loadRound(store, ref, 1, "reviewer")!.findings[0].id).toBe("f1");
    expect(loadRound(store, ref, 2, "reviewer")!.findings[0].id).toBe("f1");
  });
});

// ─── Posting state ──────────────────────────────────────────────────────────

describe("posting state", () => {
  test("new findings start unposted, which is what makes local-first work", () => {
    const round = writeRound(ref, 1, "reviewer", [finding()]);

    expect(round.findings[0].posted).toBe(false);
    expect(round.findings[0].discarded).toBe(false);
  });

  test("pendingFindings returns what has not been posted or discarded", () => {
    writeRound(ref, 1, "reviewer", [
      finding({ comment: "one" }),
      finding({ comment: "two" }),
      finding({ comment: "three" }),
    ]);
    saveMeta(store, metaInput(1, ["reviewer"], 3));

    markFindingsPosted(store, ref, ["f1"], 999);
    markFindingsDiscarded(store, ref, ["f2"]);

    expect(pendingFindings(store, ref).map((f) => f.comment)).toEqual(["three"]);
  });

  test("marking posted records the pending review it went out in", () => {
    writeRound(ref, 1, "reviewer", [finding()]);
    saveMeta(store, metaInput(1, ["reviewer"], 1));

    const changed = markFindingsPosted(store, ref, ["f1"], 2847362);

    expect(changed).toEqual(["f1"]);

    const stored = loadRound(store, ref, 1, "reviewer")!.findings[0];
    expect(stored.posted).toBe(true);
    expect(stored.pendingReviewId).toBe(2847362);
    expect(stored.postedAt).toBeTruthy();
  });

  test("marking posted twice does not report a second change", () => {
    // Re-running `review post` must not double-count or re-post.
    writeRound(ref, 1, "reviewer", [finding()]);
    saveMeta(store, metaInput(1, ["reviewer"], 1));

    markFindingsPosted(store, ref, ["f1"], 1);
    expect(markFindingsPosted(store, ref, ["f1"], 2)).toEqual([]);

    // The original review id stands, since that is where the comment actually is.
    expect(loadRound(store, ref, 1, "reviewer")!.findings[0].pendingReviewId).toBe(1);
  });

  test("an id that does not exist is reported as unchanged, not silently ignored", () => {
    writeRound(ref, 1, "reviewer", [finding()]);

    expect(markFindingsDiscarded(store, ref, ["f9"])).toEqual([]);
  });

  test("a posted finding cannot be discarded, because it is already on GitHub", () => {
    writeRound(ref, 1, "reviewer", [finding()]);
    saveMeta(store, metaInput(1, ["reviewer"], 1));
    markFindingsPosted(store, ref, ["f1"], 1);

    expect(markFindingsDiscarded(store, ref, ["f1"])).toEqual([]);
    expect(loadRound(store, ref, 1, "reviewer")!.findings[0].discarded).toBe(false);
  });

  test("a discarded finding stays on disk, so the decision is auditable", () => {
    writeRound(ref, 1, "reviewer", [finding()]);
    markFindingsDiscarded(store, ref, ["f1"]);

    const stored = loadRound(store, ref, 1, "reviewer")!.findings[0];
    expect(stored.discarded).toBe(true);
    expect(stored.comment).toBe("boom");
  });
});

// ─── Skipped findings ───────────────────────────────────────────────────────

describe("skipped findings", () => {
  test("a skipped finding stays eligible, since a later round may restore the line", () => {
    // GitHub rejects a comment on a line outside the diff. Holding it back is
    // not the same as dropping it.
    writeRound(ref, 1, "reviewer", [finding({ line: 900 })]);

    markFindingsSkipped(store, ref, [{ id: "f1", reason: "line 900 not present in PR diff" }]);

    const stored = loadRound(store, ref, 1, "reviewer")!.findings[0];
    expect(stored.skipped).toBe(true);
    expect(stored.skipReason).toContain("not present");

    expect(pendingFindings(store, ref).map((f) => f.id)).toEqual(["f1"]);
  });

  test("posting a previously skipped finding clears the skip", () => {
    writeRound(ref, 1, "reviewer", [finding()]);
    saveMeta(store, metaInput(1, ["reviewer"], 1));
    markFindingsSkipped(store, ref, [{ id: "f1", reason: "not in diff" }]);

    markFindingsPosted(store, ref, ["f1"], 5);

    const stored = loadRound(store, ref, 1, "reviewer")!.findings[0];
    expect(stored.posted).toBe(true);
    expect(stored.skipped).toBeUndefined();
    expect(stored.skipReason).toBeUndefined();
  });
});

// ─── Meta and rounds ────────────────────────────────────────────────────────

function metaInput(round: number, agents: string[], findingCount: number, extra = {}) {
  return {
    ref,
    title: "Add auth",
    author: "someone",
    sha: round === 1 ? "a".repeat(40) : "b".repeat(40),
    round,
    agents,
    findingCount,
    ...extra,
  };
}

describe("meta", () => {
  test("is null before the first review, which is how a new PR is detected", () => {
    expect(loadMeta(store, ref)).toBeNull();
  });

  test("records the head SHA, which is how new commits are detected", () => {
    saveMeta(store, metaInput(1, ["reviewer"], 2));

    const meta = loadMeta(store, ref)!;
    expect(meta.lastReviewedSha).toBe("a".repeat(40));
    expect(meta.currentRound).toBe(1);
  });

  test("appends a round rather than replacing the history", () => {
    saveMeta(store, metaInput(1, ["reviewer"], 2));
    saveMeta(store, metaInput(2, ["reviewer"], 1));

    const meta = loadMeta(store, ref)!;
    expect(meta.rounds.map((r) => r.round)).toEqual([1, 2]);
    expect(meta.currentRound).toBe(2);
    expect(meta.lastReviewedSha).toBe("b".repeat(40));
  });

  test("re-running a round replaces its record, leaving no phantom round", () => {
    saveMeta(store, metaInput(1, ["reviewer"], 2));
    saveMeta(store, metaInput(1, ["reviewer", "second"], 5));

    const meta = loadMeta(store, ref)!;
    expect(meta.rounds.length).toBe(1);
    expect(meta.rounds[0].findingCount).toBe(5);
    expect(meta.rounds[0].agents).toEqual(["reviewer", "second"]);
  });

  test("carries verification results onto the round that triggered them", () => {
    saveMeta(store, metaInput(1, ["reviewer"], 2));
    saveMeta(
      store,
      metaInput(2, ["reviewer"], 1, {
        verifiedPriorRound: 1,
        resolvedFromPrior: 1,
        unresolvedFromPrior: 1,
      })
    );

    const round2 = loadMeta(store, ref)!.rounds[1];
    expect(round2.verifiedPriorRound).toBe(1);
    expect(round2.resolvedFromPrior).toBe(1);
    expect(round2.unresolvedFromPrior).toBe(1);
  });

  test("posted counts are recomputed from the round files, not tracked separately", () => {
    // Two sources of truth for "how many are posted" would drift.
    writeRound(ref, 1, "reviewer", [finding({ comment: "one" }), finding({ comment: "two" })]);
    saveMeta(store, metaInput(1, ["reviewer"], 2));

    markFindingsPosted(store, ref, ["f1"], 77);

    const meta = loadMeta(store, ref)!;
    expect(meta.rounds[0].postedCount).toBe(1);
    expect(meta.rounds[0].findingCount).toBe(2);
    expect(meta.pendingReviewId).toBe(77);
  });

  test("the body renders a round table and a clickable PR link", () => {
    saveMeta(store, metaInput(1, ["reviewer"], 2));

    const body = fs.readFileSync(path.join(reviewDir(store, ref), "meta.md"), "utf-8");

    expect(body).toContain(`[Add auth](${prUrl(ref)})`);
    expect(body).toContain("| Round | SHA | Findings | Posted | Notes |");
  });

  test("mentions the open draft when one exists, with a link to edit it", () => {
    saveMeta(store, metaInput(1, ["reviewer"], 1));
    setPendingReviewId(store, ref, 4242);

    const body = fs.readFileSync(path.join(reviewDir(store, ref), "meta.md"), "utf-8");
    expect(body).toContain("draft review is open");
    expect(body).toContain(`${prUrl(ref)}/files`);
  });

  test("submitting clears the pending id and stamps the round", () => {
    saveMeta(store, metaInput(1, ["reviewer"], 1));
    setPendingReviewId(store, ref, 4242);

    markSubmitted(store, ref);

    const meta = loadMeta(store, ref)!;
    expect(meta.pendingReviewId).toBeNull();
    expect(meta.rounds[0].submittedAt).toBeTruthy();
  });
});

// ─── Rounds across agents ───────────────────────────────────────────────────

describe("multiple agents and rounds", () => {
  test("loadAllRounds returns every file, ordered by round then agent", () => {
    writeRound(ref, 2, "reviewer", [finding()]);
    writeRound(ref, 1, "second", [finding()]);
    writeRound(ref, 1, "reviewer", [finding()]);

    expect(loadAllRounds(store, ref).map((r) => `r${r.round}-${r.agent}`)).toEqual([
      "r1-reviewer",
      "r1-second",
      "r2-reviewer",
    ]);
  });

  test("pendingFindings spans agents and rounds, tagged with where each came from", () => {
    writeRound(ref, 1, "reviewer", [finding({ comment: "from reviewer" })]);
    writeRound(ref, 1, "second", [finding({ comment: "from second" })]);

    const pending = pendingFindings(store, ref);

    expect(pending.length).toBe(2);
    expect(pending.map((f) => f.agent).sort()).toEqual(["reviewer", "second"]);
  });

  test("postedFindings returns only what the author has actually seen", () => {
    // Verification asks "was this addressed", which is meaningless for a
    // finding nobody was ever shown.
    writeRound(ref, 1, "reviewer", [finding({ comment: "shown" }), finding({ comment: "held back" })]);
    saveMeta(store, metaInput(1, ["reviewer"], 2));
    markFindingsPosted(store, ref, ["f1"], 1);

    expect(postedFindings(store, ref).map((f) => f.comment)).toEqual(["shown"]);
  });
});

// ─── Verdicts ───────────────────────────────────────────────────────────────

describe("applyVerdicts", () => {
  test("maps 1-based verdict indices back onto the findings that were checked", () => {
    writeRound(ref, 1, "reviewer", [finding({ comment: "one" }), finding({ comment: "two" })]);
    saveMeta(store, metaInput(1, ["reviewer"], 2));
    markFindingsPosted(store, ref, ["f1", "f2"], 1);

    const checked = postedFindings(store, ref).map((f) => ({ id: f.id, round: f.round, agent: f.agent }));

    const counts = applyVerdicts(store, ref, checked, [
      { index: 1, resolved: true, note: "fixed in a1b2c3d" },
      { index: 2, resolved: false, note: "still concatenating" },
    ]);

    expect(counts).toEqual({ resolved: 1, unresolved: 1 });

    const findings = loadRound(store, ref, 1, "reviewer")!.findings;
    expect(findings[0].resolved).toBe(true);
    expect(findings[0].resolvedNote).toBe("fixed in a1b2c3d");
    expect(findings[1].resolved).toBe(false);
  });

  test("does not confuse the same id in different rounds", () => {
    // Both round files have an f1.
    writeRound(ref, 1, "reviewer", [finding({ comment: "round one issue" })]);
    writeRound(ref, 2, "reviewer", [finding({ comment: "round two issue" })]);
    saveMeta(store, metaInput(1, ["reviewer"], 1));
    markFindingsPosted(store, ref, ["f1"], 1);

    applyVerdicts(store, ref, [{ id: "f1", round: 1, agent: "reviewer" }], [
      { index: 1, resolved: true, note: "done" },
    ]);

    expect(loadRound(store, ref, 1, "reviewer")!.findings[0].resolved).toBe(true);
    expect(loadRound(store, ref, 2, "reviewer")!.findings[0].resolved).toBeUndefined();
  });

  test("an out-of-range index changes nothing", () => {
    writeRound(ref, 1, "reviewer", [finding()]);

    const counts = applyVerdicts(store, ref, [{ id: "f1", round: 1, agent: "reviewer" }], [
      { index: 99, resolved: true, note: "?" },
    ]);

    expect(counts).toEqual({ resolved: 0, unresolved: 0 });
  });
});

// ─── Failed rounds ──────────────────────────────────────────────────────────

describe("failed rounds", () => {
  test("records the error and says so in the body", () => {
    writeRound(ref, 1, "reviewer", [], { error: "claude timed out after 300s" });

    const round = loadRound(store, ref, 1, "reviewer")!;
    expect(round.error).toBe("claude timed out after 300s");
    expect(round.findings).toEqual([]);

    const body = fs.readFileSync(path.join(reviewDir(store, ref), "r1-reviewer.md"), "utf-8");
    expect(body).toContain("Review failed: claude timed out after 300s");
  });

  test("keeps raw output only when it could not be parsed", () => {
    // Otherwise every review leaves a copy of the whole provider transcript.
    writeRound(ref, 1, "reviewer", [], { error: "could not parse", raw: "I am not JSON" });
    writeRound(ref, 1, "second", [finding()], { raw: "some output" });

    expect(fs.existsSync(rawOutputPath(store, ref, 1, "reviewer"))).toBe(true);
    expect(fs.readFileSync(rawOutputPath(store, ref, 1, "reviewer"), "utf-8")).toBe("I am not JSON");
    expect(fs.existsSync(rawOutputPath(store, ref, 1, "second"))).toBe(false);
  });
});

// ─── Hand-edited files ──────────────────────────────────────────────────────

describe("hand-edited files", () => {
  test("a finding with no posted field reads as unposted", () => {
    // These are markdown files a user may edit. Treating a missing flag as
    // undefined would make "should this go to GitHub" ambiguous.
    const dir = reviewDir(store, ref);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "r1-reviewer.md"),
      ["---", "round: 1", "agent: reviewer", "findings:", "  - file: a.ts", "    line: 1", "    comment: hand written", "---", "", "body"].join("\n"),
      "utf-8"
    );

    const findings = loadRound(store, ref, 1, "reviewer")!.findings;

    expect(findings[0].posted).toBe(false);
    expect(findings[0].discarded).toBe(false);
    expect(findings[0].id).toBe("f1");
  });

  test("a finding missing a file or comment is dropped as unusable", () => {
    const dir = reviewDir(store, ref);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "r1-reviewer.md"),
      ["---", "round: 1", "agent: reviewer", "findings:", "  - line: 1", "    comment: no file", "  - file: a.ts", "    line: 2", "---", "", "body"].join("\n"),
      "utf-8"
    );

    expect(loadRound(store, ref, 1, "reviewer")!.findings).toEqual([]);
  });

  test("editing the body does not get overwritten when findings change", () => {
    writeRound(ref, 1, "reviewer", [finding()]);
    const filePath = path.join(reviewDir(store, ref), "r1-reviewer.md");

    const { data } = matter(fs.readFileSync(filePath, "utf-8"));
    fs.writeFileSync(filePath, matter.stringify("my own notes here", data), "utf-8");

    markFindingsDiscarded(store, ref, ["f1"]);

    expect(fs.readFileSync(filePath, "utf-8")).toContain("my own notes here");
    expect(loadRound(store, ref, 1, "reviewer")!.findings[0].discarded).toBe(true);
  });

  test("a corrupt round file is skipped rather than taking the PR down", () => {
    writeRound(ref, 1, "reviewer", [finding()]);
    fs.writeFileSync(path.join(reviewDir(store, ref), "r1-second.md"), "---\n: not yaml :\n---\n", "utf-8");

    // The good file still loads.
    expect(loadAllRounds(store, ref).some((r) => r.agent === "reviewer")).toBe(true);
  });
});

// ─── Discovery ──────────────────────────────────────────────────────────────

describe("listReviewedPRs", () => {
  test("is empty on a fresh store", () => {
    expect(listReviewedPRs(store)).toEqual([]);
  });

  test("finds every PR with a meta file, across repos", () => {
    saveMeta(store, metaInput(1, ["reviewer"], 1));
    saveMeta(store, { ...metaInput(1, ["reviewer"], 1), ref: other });

    expect(listReviewedPRs(store)).toEqual([
      { owner: "pszf11235", repo: "LGTM", pr: 42 },
      { owner: "someorg", repo: "backend", pr: 108 },
    ]);
  });

  test("reads identity from frontmatter, so a hyphenated repo name still works", () => {
    // The directory is <owner>-<repo>-<pr>, which cannot be split reliably when
    // the repo name itself contains a hyphen.
    const hyphenated: PRRef = { owner: "acme", repo: "my-cool-repo", pr: 7 };
    saveMeta(store, { ...metaInput(1, ["reviewer"], 1), ref: hyphenated });

    expect(listReviewedPRs(store)).toEqual([hyphenated]);
  });

  test("ignores a directory with no meta file", () => {
    fs.mkdirSync(path.join(store, "reviews", "junk-dir"), { recursive: true });
    saveMeta(store, metaInput(1, ["reviewer"], 1));

    expect(listReviewedPRs(store)).toEqual([{ owner: "pszf11235", repo: "LGTM", pr: 42 }]);
  });
});

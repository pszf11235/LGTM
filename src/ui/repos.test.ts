/**
 * The selection-to-request mapping in BackfillPane.tsx.
 *
 * These functions are exported specifically so they can be tested without
 * rendering a component or faking a DOM: `buildConfirmRequests` turns a
 * checkbox selection into the exact decision calls Confirm makes, and
 * `runConfirm` runs them through an injected `postDecision` and settles
 * each independently.
 *
 * R2.6 says auto-class rows arrive pre-checked but nothing runs until a
 * human confirms; a bug that sent a decision for a row the user never
 * checked would review a PR nobody asked for and spend quota before anyone
 * noticed. The tests below assert the exact set of calls a mixed selection
 * produces, in both directions: every checked row gets exactly one call,
 * and every unchecked row gets none, checked-then-unchecked included.
 */
import { describe, expect, test } from "bun:test";
import type { Classification, PRRef } from "@/core";
import {
  buildConfirmRequests,
  computeInitialSelection,
  prKey,
  runConfirm,
  type BackfillRow,
  type ConfirmAction,
  type PostDecision,
} from "./views/BackfillPane";

// ─── Fixtures ───────────────────────────────────────────────────────────────

function ref(number: number): PRRef {
  return { owner: "acme", repo: "api", number };
}

interface RowOverrides {
  draft?: boolean;
  classification?: Classification;
  autoClass?: boolean;
  preSelected?: boolean;
}

function row(number: number, over: RowOverrides = {}): BackfillRow {
  return {
    ref: ref(number),
    key: prKey(ref(number)),
    url: `https://github.com/acme/api/pull/${number}`,
    title: `PR ${number}`,
    author: "grace",
    draft: over.draft ?? false,
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-02T00:00:00.000Z",
    headSha: `sha-${number}`,
    additions: 10,
    deletions: 2,
    changedFiles: 3,
    mergeable: "mergeable",
    checks: { state: "success", runs: 1 },
    classification: over.classification ?? "own",
    autoClass: over.autoClass ?? true,
    preSelected: over.preSelected ?? true,
  };
}

// ─── prKey ──────────────────────────────────────────────────────────────────

describe("prKey", () => {
  test("formats owner/repo#number", () => {
    expect(prKey({ owner: "acme", repo: "api", number: 7 })).toBe("acme/api#7");
  });
});

// ─── computeInitialSelection ────────────────────────────────────────────────

describe("computeInitialSelection", () => {
  test("selects only rows marked preSelected", () => {
    const e1 = row(1, { preSelected: true });
    const e2 = row(2, { preSelected: false });
    const e3 = row(3, { preSelected: true });

    const selected = computeInitialSelection([e1, e2, e3]);

    expect(selected).toEqual(new Set([prKey(e1.ref), prKey(e3.ref)]));
  });

  test("a draft auto-class row starts unchecked, per the draft hold", () => {
    // R2.3: a draft is never auto-reviewed, so the backfill list must not
    // pre-check it even though it is auto-class.
    const draftRow = row(1, { draft: true, autoClass: true, preSelected: false });

    expect(computeInitialSelection([draftRow]).size).toBe(0);
  });
});

// ─── buildConfirmRequests ───────────────────────────────────────────────────

describe("buildConfirmRequests", () => {
  test("maps a mixed selection to the exact requests it should produce", () => {
    const e1 = row(1); // pre-checked, non-draft, auto-class
    const e2 = row(2, { draft: true, preSelected: false }); // draft auto-class, checked by hand below
    const e3 = row(3, { autoClass: false, classification: "none", preSelected: false }); // left unchecked
    const e4 = row(4, { draft: true, autoClass: false, classification: "none", preSelected: false }); // draft triage, checked by hand

    const entries = [e1, e2, e3, e4];
    const selected = new Set([prKey(e1.ref), prKey(e2.ref), prKey(e4.ref)]);

    const requests = buildConfirmRequests(entries, selected);

    expect(requests).toEqual([
      { ref: e1.ref, action: "review" },
      { ref: e2.ref, action: "review-anyway" },
      { ref: e4.ref, action: "review-anyway" },
    ]);
  });

  test("a row not in the selection produces no request, checked or not is the only thing that matters", () => {
    const entries = [row(1, { preSelected: true })];
    expect(buildConfirmRequests(entries, new Set())).toEqual([]);
  });

  test("unchecking a pre-selected row excludes it", () => {
    const e1 = row(1, { preSelected: true });
    const initial = computeInitialSelection([e1]);
    expect(initial.has(prKey(e1.ref))).toBe(true);

    const afterUncheck = new Set(initial);
    afterUncheck.delete(prKey(e1.ref));

    expect(buildConfirmRequests([e1], afterUncheck)).toEqual([]);
  });
});

// ─── runConfirm ─────────────────────────────────────────────────────────────

function fakePostDecision(shouldFail: (ref: PRRef) => boolean) {
  const calls: Array<{ ref: PRRef; action: ConfirmAction }> = [];
  const postDecision: PostDecision = async (ref, action) => {
    calls.push({ ref, action });
    if (shouldFail(ref)) {
      throw new Error(`decision failed for ${ref.owner}/${ref.repo}#${ref.number}`);
    }
  };
  return { calls, postDecision };
}

describe("runConfirm", () => {
  test("sends exactly one call per selected PR and never calls for an unselected row", async () => {
    const e1 = row(1); // pre-checked
    const e2 = row(2, { draft: true, preSelected: false }); // checked by hand
    const e3 = row(3, { autoClass: false, classification: "none", preSelected: false }); // left unchecked
    const e4 = row(4, { draft: true, autoClass: false, classification: "none", preSelected: false }); // checked by hand

    const entries = [e1, e2, e3, e4];
    const selected = computeInitialSelection(entries);
    selected.add(prKey(e2.ref));
    selected.add(prKey(e4.ref));
    // e3 stays unchecked.

    const { calls, postDecision } = fakePostDecision(() => false);
    await runConfirm(entries, selected, postDecision);

    expect(calls).toEqual([
      { ref: e1.ref, action: "review" },
      { ref: e2.ref, action: "review-anyway" },
      { ref: e4.ref, action: "review-anyway" },
    ]);
  });

  test("reports partial failure honestly instead of one pass/fail flag for the batch", async () => {
    const e1 = row(1);
    const e2 = row(2, { draft: true, preSelected: false });
    const e3 = row(3, { autoClass: false, classification: "none", preSelected: false });

    const entries = [e1, e2, e3];
    const selected = new Set([prKey(e1.ref), prKey(e2.ref), prKey(e3.ref)]);

    const { postDecision } = fakePostDecision((ref) => ref.number === 2);
    const outcomes = await runConfirm(entries, selected, postDecision);

    expect(outcomes).toEqual([
      { ref: e1.ref, action: "review", ok: true },
      { ref: e2.ref, action: "review-anyway", ok: false, error: "decision failed for acme/api#2" },
      { ref: e3.ref, action: "review", ok: true },
    ]);
  });

  test("an empty selection makes no calls at all", async () => {
    const entries = [row(1, { preSelected: true }), row(2, { preSelected: true })];
    const { calls, postDecision } = fakePostDecision(() => false);

    const outcomes = await runConfirm(entries, new Set(), postDecision);

    expect(calls).toEqual([]);
    expect(outcomes).toEqual([]);
  });
});

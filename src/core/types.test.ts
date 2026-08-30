/**
 * FindingKey is new logic (not ported), and every module that patches a
 * Finding's state addresses it by this key, so its round-trip is worth
 * pinning down here rather than only in whichever module first exercises it.
 */
import { describe, expect, test } from "bun:test";
import { formatFindingKey, parseFindingKey } from "./types";

describe("formatFindingKey", () => {
  test("prints the canonical r<round>:<agent>:<id> form", () => {
    expect(formatFindingKey({ round: 2, agent: "reviewer", id: "f1" })).toBe("r2:reviewer:f1");
  });
});

describe("parseFindingKey", () => {
  test("round-trips through formatFindingKey", () => {
    const key = { round: 12, agent: "reviewer", id: "f3" };
    expect(parseFindingKey(formatFindingKey(key))).toEqual(key);
  });

  test("keeps the round and the agent out of the id, unlike a bare id match", () => {
    // The old codebase's bug: matching on id alone treated r1:reviewer:f1 and
    // r2:reviewer:f1 as the same finding. The full triple must disagree.
    const a = parseFindingKey("r1:reviewer:f1");
    const b = parseFindingKey("r2:reviewer:f1");
    expect(a).not.toEqual(b);
  });

  test("agent names may contain hyphens and digits", () => {
    expect(parseFindingKey("r3:second-reviewer:f7")).toEqual({
      round: 3,
      agent: "second-reviewer",
      id: "f7",
    });
  });

  test("returns null for malformed input instead of throwing", () => {
    expect(parseFindingKey("not-a-key")).toBeNull();
    expect(parseFindingKey("reviewer:f1")).toBeNull();
    expect(parseFindingKey("")).toBeNull();
  });
});

/**
 * The server and the browser client are written against the same design
 * document and never against each other. That gap shipped two real defects at
 * once: the client read `owner` where the daemon sends `ref.owner`, and it
 * treated the `{ prs, total }` envelope as "not an array" and returned an
 * empty list, so the inbox rendered nothing at all while the store was full.
 *
 * These tests put the real route handler and the real client parser on either
 * end of one round trip, so a shape change on either side fails here rather
 * than in a browser nobody is looking at.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import fs from "fs";
import os from "os";
import path from "path";
import { createApiHandler } from "./server";
import { createApiClient } from "@/ui/api";
import { saveMeta, saveRound } from "@/store/reviews";
import { saveWatchList } from "@/store/watch-list";

const TOKEN = "contract-token";
const PORT = 4747;
const ORIGIN = `http://127.0.0.1:${PORT}`;

let lgtmDir: string;

beforeEach(async () => {
  lgtmDir = fs.mkdtempSync(path.join(os.tmpdir(), "lgtm-contract-"));
  // `GET /api/prs` defaults to watched repos only, so an unwatched fixture
  // would come back empty for a reason that has nothing to do with the shape.
  await saveWatchList([{ owner: "acme", repo: "api", addedAt: "2026-08-30T00:00:00.000Z" }], lgtmDir);
});

afterEach(() => {
  fs.rmSync(lgtmDir, { recursive: true, force: true });
});

/**
 * The client sends its headers as a `Headers` instance, so they have to be
 * copied rather than spread. Spreading one yields an empty object and drops
 * the bearer token, which reads as a 401 and looks like an auth bug.
 */
function buildRequest(input: string, init?: RequestInit): Request {
  const headers = new Headers(init?.headers);
  headers.set("Host", `127.0.0.1:${PORT}`);
  headers.set("Origin", ORIGIN);
  return new Request(input.startsWith("http") ? input : `${ORIGIN}${input}`, { ...init, headers });
}

/** A client whose transport is the real handler, not a hand-written fixture. */
function clientOverHandler() {
  const handler = createApiHandler({ lgtmDir, token: TOKEN, port: PORT, version: "test" });
  return createApiClient({
    fetchImpl: (input, init) =>
      handler(buildRequest(input, init)),
    storage: { getItem: () => TOKEN, setItem() {}, removeItem() {} },
    location: { hash: "", pathname: "/", search: "" },
    history: { replaceState() {} },
  });
}

/**
 * The same response before the client touches it.
 *
 * The client's readers are deliberately lenient: a missing key and an
 * explicit null both parse to null. That is right for a browser and wrong
 * for a test, because it makes "the daemon stopped sending this field" look
 * exactly like "the daemon sent null". A handful of assertions below read
 * the raw row for that reason.
 */
async function rawPRRows(): Promise<Array<Record<string, unknown>>> {
  const handler = createApiHandler({ lgtmDir, token: TOKEN, port: PORT, version: "test" });
  const res = await handler(buildRequest("/api/prs", { headers: { Authorization: `Bearer ${TOKEN}` } }));
  const body = (await res.json()) as { prs: Array<Record<string, unknown>> };
  return body.prs;
}

describe("GET /api/prs, daemon to browser", () => {
  test("a stored PR arrives with its reference intact", async () => {
    const ref = { owner: "acme", repo: "api", number: 42 };
    await saveMeta(lgtmDir, ref, {
      url: "https://github.com/acme/api/pull/42",
      title: "Add a rate limiter",
      author: "ada",
      state: "reviewing",
      classification: "own",
      headSha: "abc123",
    });

    const rows = await clientOverHandler().listPRs();

    // The envelope bug returned [] here while the store held a PR.
    expect(rows).toHaveLength(1);
    const pr = rows[0]!;
    expect(pr.owner).toBe("acme");
    expect(pr.repo).toBe("api");
    expect(pr.number).toBe(42);
    expect(pr.state).toBe("reviewing");
    expect(pr.title).toBe("Add a rate limiter");
  });

  test("severity counts survive the trip, so the gate section can appear", async () => {
    const ref = { owner: "acme", repo: "api", number: 7 };
    await saveMeta(lgtmDir, ref, { state: "reviewed", headSha: "sha1", author: "ada" });
    await saveRound(lgtmDir, {
      ref,
      round: 1,
      agent: "reviewer",
      provider: "claude-cli",
      status: "ok",
      headSha: "sha1",
      startedAt: "2026-08-30T00:00:00.000Z",
      durationMs: 1000,
      findings: [
        { severity: "high", file: "a.ts", line: 3, comment: "one" },
        { severity: "low", file: "a.ts", line: 9, comment: "two" },
      ],
    });

    const pr = (await clientOverHandler().listPRs())[0]!;

    expect(pr.findingCounts.high).toBe(1);
    expect(pr.findingCounts.low).toBe(1);
  });

  test("triage metadata arrives under the names the inbox reads", async () => {
    // The inbox line R2.5 asks for. Every one of these rendered as a dash
    // while the store held the numbers, because nothing carried them.
    const ref = { owner: "acme", repo: "api", number: 11 };
    await saveMeta(lgtmDir, ref, {
      state: "triage",
      author: "ada",
      headSha: "sha1",
      createdAt: "2026-08-01T00:00:00.000Z",
      additions: 120,
      deletions: 34,
      changedFiles: 7,
      mergeable: true,
      checkStatus: "failure",
    });

    const pr = (await clientOverHandler().listPRs())[0]!;

    expect(pr.createdAt).toBe("2026-08-01T00:00:00.000Z");
    expect(pr.additions).toBe(120);
    expect(pr.deletions).toBe(34);
    expect(pr.changedFiles).toBe(7);
    expect(pr.mergeable).toBe(true);
    expect(pr.checkStatus).toBe("failure");
  });

  test("a mergeable GitHub is still computing crosses the wire as null", async () => {
    // Null must survive as null, because the browser renders "Computing…"
    // for it. Coercing it to false anywhere along this path tells the user
    // their PR conflicts when it does not.
    const ref = { owner: "acme", repo: "api", number: 12 };
    await saveMeta(lgtmDir, ref, {
      state: "triage",
      author: "ada",
      headSha: "sha1",
      additions: 5,
      mergeable: null,
      checkStatus: "pending",
    });

    // The field is sent, and it is sent as null. The client cannot tell those
    // apart, so the raw row is what proves it.
    const row = (await rawPRRows())[0]!;
    expect("mergeable" in row).toBe(true);
    expect(row.mergeable).toBeNull();

    const pr = (await clientOverHandler().listPRs())[0]!;
    expect(pr.mergeable).toBeNull();
    // Its neighbours came through, so the null above is a value and not a
    // row that never got populated.
    expect(pr.additions).toBe(5);
    expect(pr.checkStatus).toBe("pending");
  });

  test("a PR nothing has detail-fetched arrives as nulls, not as zeros", async () => {
    // A PR known from a list row alone. `+0 -0` would read as a measured
    // empty diff; the browser renders null as a dash.
    const ref = { owner: "acme", repo: "api", number: 13 };
    await saveMeta(lgtmDir, ref, { state: "queued", author: "ada", headSha: "sha1" });

    const row = (await rawPRRows())[0]!;
    expect(row.additions).toBeNull();
    expect(row.checkStatus).toBeNull();

    const pr = (await clientOverHandler().listPRs())[0]!;
    expect(pr.additions).toBeNull();
    expect(pr.deletions).toBeNull();
    expect(pr.changedFiles).toBeNull();
    expect(pr.createdAt).toBeNull();
    expect(pr.checkStatus).toBeNull();
  });

  test("every state the inbox buckets on round-trips by name", async () => {
    for (const [i, state] of (["triage", "queued", "reviewing", "reviewed", "failed", "skipped"] as const).entries()) {
      await saveMeta(lgtmDir, { owner: "acme", repo: "api", number: i + 1 }, { state, author: "ada", headSha: "s" });
    }

    const seen = (await clientOverHandler().listPRs()).map((pr) => pr.state).sort();

    expect(seen).toEqual(["failed", "queued", "reviewed", "reviewing", "skipped", "triage"]);
  });
});

/**
 * The rest of the client surface, for the same reason. A comment in
 * BackfillPane records that watchlist, config and status "do not match this
 * route table's actual response shapes as of this writing", and the fix was to
 * route around the client rather than to correct it. These tests decide which
 * of those are still true.
 */
describe("the rest of the client surface", () => {
  test("listWatch reads the watch list the daemon sends", async () => {
    const rows = await clientOverHandler().listWatch();
    expect(rows.map((r) => `${r.owner}/${r.repo}`)).toEqual(["acme/api"]);
  });

  test("getConfig reads the config the daemon sends", async () => {
    const cfg = await clientOverHandler().getConfig();
    expect(cfg.config.interval_minutes).toBe(15);
    expect(cfg.defaults.pause_above_pct).toBe(70);
  });

  test("status reads the status the daemon sends", async () => {
    const status = await clientOverHandler().status();
    // These were every-field-undefined before the parser read the nesting.
    expect(status.intervalMinutes).toBe(15);
    expect(status.quotaMode).toBe("ok");
    expect(status.triageCount).toBe(0);
    expect(typeof status.uptimeMs).toBe("number");
  });

  test("addWatch refuses rather than half-adding a repo with no forge", async () => {
    // Documented behaviour: without a Forge the route cannot list the repo's
    // open PRs, and adding it to the watch list anyway would skip the backfill
    // R2.6 requires. It answers 503 instead.
    await expect(clientOverHandler().addWatch({ owner: "new", repo: "repo" })).rejects.toThrow();
  });

  test("addWatch returns the backfill list the daemon sends", async () => {
    const detail = {
      ref: { owner: "new", repo: "repo", number: 1 },
      url: "https://github.com/new/repo/pull/1",
      title: "A pull request",
      author: "someone",
      draft: false,
      createdAt: "2026-08-30T00:00:00.000Z",
      updatedAt: "2026-08-30T00:00:00.000Z",
      headSha: "sha",
      additions: 1,
      deletions: 0,
      changedFiles: 1,
      mergeable: null,
    };
    const forge = {
      listOpenPRs: async () => [detail],
      getPR: async () => detail,
      getCheckStatus: async () => ({ state: "none" as const, runs: [] }),
      authenticatedUser: async () => "someone",
    };

    const handler = createApiHandler({
      lgtmDir,
      token: TOKEN,
      port: PORT,
      version: "test",
      forge: forge as unknown as Parameters<typeof createApiHandler>[0]["forge"],
    });
    const client = createApiClient({
      fetchImpl: (input, init) => handler(buildRequest(input, init)),
      storage: { getItem: () => TOKEN, setItem() {}, removeItem() {} },
      location: { hash: "", pathname: "/", search: "" },
      history: { replaceState() {} },
    });

    const result = await client.addWatch({ owner: "new", repo: "repo" });

    expect(result.repo.owner).toBe("new");
    expect(result.entries).toHaveLength(1);
  });
});

describe("GET .../findings, daemon to browser", () => {
  test("findings grouped under rounds reach the detail view", async () => {
    const ref = { owner: "acme", repo: "api", number: 99 };
    await saveMeta(lgtmDir, ref, {
      state: "reviewed",
      headSha: "sha1",
      author: "ada",
      title: "Add a rate limiter",
      url: "https://github.com/acme/api/pull/99",
    });
    await saveRound(lgtmDir, {
      ref,
      round: 1,
      agent: "reviewer",
      provider: "claude-cli",
      status: "ok",
      headSha: "sha1",
      startedAt: "2026-08-30T00:00:00.000Z",
      durationMs: 1000,
      findings: [
        { severity: "critical", file: "a.ts", line: 3, comment: "one" },
        { severity: "high", file: "b.ts", line: 9, comment: "two" },
      ],
    });

    const res = await clientOverHandler().getFindings(ref);

    // The detail view read a flat `findings` key and a `meta` object; the
    // daemon sends neither, so this was always empty while the list beside it
    // showed two findings for the same PR.
    expect(res.findings).toHaveLength(2);
    expect(res.findings.map((f) => f.severity)).toEqual(["critical", "high"]);
    expect(res.meta.owner).toBe("acme");
    expect(res.meta.number).toBe(99);
    expect(res.meta.title).toBe("Add a rate limiter");
  });

  test("findings from several rounds all arrive", async () => {
    const ref = { owner: "acme", repo: "api", number: 100 };
    await saveMeta(lgtmDir, ref, { state: "reviewed", headSha: "s2", author: "ada" });
    for (const round of [1, 2]) {
      await saveRound(lgtmDir, {
        ref,
        round,
        agent: "reviewer",
        provider: "claude-cli",
        status: "ok",
        headSha: "s2",
        startedAt: "2026-08-30T00:00:00.000Z",
        durationMs: 1,
        findings: [{ severity: "high", file: `r${round}.ts`, line: 1, comment: `round ${round}` }],
      });
    }

    const res = await clientOverHandler().getFindings(ref);

    expect(res.findings).toHaveLength(2);
    expect(res.findings.map((f) => f.key)).toEqual(["r1:reviewer:f1", "r2:reviewer:f1"]);
  });
});

/**
 * The GitHub ForgeAdapter: the only module in LGTM that speaks to a Forge.
 *
 * Ported from packages/plugins/review/src/infra/github.ts on the old `main`
 * branch, reshaped to the ForgeAdapter interface in @/core/types. One adapter
 * instance serves every watched repository, so anything cached here (ETags,
 * the authenticated login) is repo-qualified or repo-independent, never both.
 *
 * Two properties matter more than the rest:
 *
 * 1. A 304 answer returns the NotModified sentinel. Collapsing it into an
 *    empty array would tell the poll cycle that every open PR just closed,
 *    which marks the user's whole watch list closed at zero rate-limit cost.
 * 2. Nothing here can publish a review. The publishing endpoint is never
 *    built, and the draft-review request builder is a separate exported
 *    function precisely so a test can assert its body carries no event key.
 *    See docs/adr/0001-draft-only-posting.md; the safety property depends on
 *    this file staying the only HTTP client pointed at a Forge.
 */

import type {
  CheckStatus,
  DraftReview,
  ForgeAdapter,
  NotModified,
  PRDetail,
  PRRef,
  PRSummary,
  RepoRef,
} from "@/core/types";
import { resolveGitHubToken } from "./auth";

const API_BASE = "https://api.github.com";
const REQUEST_TIMEOUT_MS = 30_000;
const PER_PAGE = 100;
const USER_AGENT = "lgtm";

/** The one NotModified value; `isNotModified` identifies it by shape, not by reference. */
const NOT_MODIFIED: NotModified = Object.freeze({ notModified: true });

/**
 * Narrows a `listOpenPRs` result. Callers must branch on this before touching
 * the value as a list; a 304 and a repo with zero open PRs are different
 * answers and only one of them means "close everything".
 */
export function isNotModified(result: PRSummary[] | NotModified): result is NotModified {
  return !Array.isArray(result) && result.notModified === true;
}

/**
 * Where conditional-request ETags survive between poll cycles.
 *
 * In memory by default. The daemon backs it with `watch.md` so a restart does
 * not cost every watched repo a full listing.
 */
export interface EtagStore {
  get(key: string): string | null;
  /** A null etag clears the entry, which reverts that repo to unconditional polling. */
  set(key: string, etag: string | null): void;
}

function memoryEtagStore(): EtagStore {
  const entries = new Map<string, string>();
  return {
    get: (key) => entries.get(key) ?? null,
    set: (key, etag) => {
      if (etag === null) entries.delete(key);
      else entries.set(key, etag);
    },
  };
}

export interface GitHubAdapterOptions {
  /**
   * Absolute path to `gh`, from the daemon's login-shell probe. Null skips the
   * `gh auth token` step of the resolution chain.
   */
  ghPath?: string | null;
  /** Seam for tests. Production always uses the shared resolver in ./auth. */
  resolveToken?: (ghPath: string | null) => string | null;
  etags?: EtagStore;
  /** Overridable so tests can point at a local fixture server. */
  baseUrl?: string;
}

// ─── GitHub payload shapes ──────────────────────────────────────────────────
// Only the fields LGTM reads. Everything is optional because a partial or
// changed payload should degrade a field, not throw mid-cycle.

interface GhUser {
  login?: string;
}

interface GhPull {
  number?: number;
  title?: string;
  body?: string | null;
  html_url?: string;
  user?: GhUser | null;
  draft?: boolean;
  head?: { sha?: string };
  created_at?: string;
  updated_at?: string;
  requested_reviewers?: GhUser[] | null;
  assignees?: GhUser[] | null;
  additions?: number;
  deletions?: number;
  changed_files?: number;
  mergeable?: boolean | null;
}

interface GhCheckRun {
  name?: string;
  status?: string;
  conclusion?: string | null;
}

// ─── Adapter ────────────────────────────────────────────────────────────────

export function createGitHubAdapter(options: GitHubAdapterOptions = {}): ForgeAdapter {
  const baseUrl = options.baseUrl ?? API_BASE;
  const ghPath = options.ghPath ?? null;
  const resolve = options.resolveToken ?? resolveGitHubToken;
  const etags = options.etags ?? memoryEtagStore();

  // Resolution is cached between requests but not for the process lifetime:
  // any 401 drops it, so a token rotated or revoked mid-run is picked up on
  // the retry instead of poisoning every later cycle.
  let cachedToken: string | null = null;
  let cachedLogin: string | null = null;

  function token(): string {
    if (cachedToken) return cachedToken;
    cachedToken = resolve(ghPath);
    if (!cachedToken) {
      throw new Error(
        "GitHub token not found. Set GITHUB_TOKEN, run `gh auth login`, or save one in ~/.lgtm-farm/credentials.json."
      );
    }
    return cachedToken;
  }

  interface RequestOptions {
    method?: string;
    body?: unknown;
    accept?: string;
    headers?: Record<string, string>;
    /** Statuses handed back to the caller instead of thrown, e.g. 304 and 404. */
    tolerate?: number[];
  }

  function send(target: string, opts: RequestOptions, bearer: string): Promise<Response> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${bearer}`,
      Accept: opts.accept ?? "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": USER_AGENT,
      ...opts.headers,
    };

    if (opts.body !== undefined) headers["Content-Type"] = "application/json";

    return globalThis.fetch(target.startsWith("http") ? target : `${baseUrl}${target}`, {
      method: opts.method ?? "GET",
      headers,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  }

  async function request(target: string, opts: RequestOptions = {}): Promise<Response> {
    const accepted = (res: Response) => res.ok || (opts.tolerate?.includes(res.status) ?? false);

    let res = await send(target, opts, token());

    if (res.status === 401) {
      cachedToken = null;
      res = await send(target, opts, token());
    }

    if (!accepted(res)) throw await apiError(res);
    return res;
  }

  async function listOpenPRs(repo: RepoRef): Promise<PRSummary[] | NotModified> {
    const key = etagKey(repo);
    const etag = etags.get(key);

    const first = await request(
      `/repos/${seg(repo.owner)}/${seg(repo.repo)}/pulls?state=open&per_page=${PER_PAGE}`,
      {
        headers: etag ? { "If-None-Match": etag } : undefined,
        tolerate: [304],
      }
    );

    // The whole point of the conditional request. Never fall through to an
    // empty list here: "nothing changed" and "no open PRs" drive opposite
    // decisions in the poll cycle.
    if (first.status === 304) return NOT_MODIFIED;

    const summaries = ((await first.json()) as GhPull[]).map(toSummary);

    let pages = 1;
    let next = nextLink(first.headers.get("link"));
    while (next) {
      const res = await request(next);
      summaries.push(...((await res.json()) as GhPull[]).map(toSummary));
      pages += 1;
      next = nextLink(res.headers.get("link"));
    }

    // An If-None-Match covers the page it was issued for and nothing else, so
    // a repo whose open PRs spill past one page drops out of conditional
    // polling rather than risk a 304 that hides changes on a later page.
    const fresh = first.headers.get("etag");
    etags.set(key, pages === 1 ? fresh : null);

    return summaries;
  }

  async function getPR(ref: PRRef): Promise<PRDetail> {
    const res = await request(`/repos/${seg(ref.owner)}/${seg(ref.repo)}/pulls/${ref.number}`);
    const data = (await res.json()) as GhPull;

    return {
      ...toSummary(data),
      additions: data.additions ?? 0,
      deletions: data.deletions ?? 0,
      changedFiles: data.changed_files ?? 0,
      // GitHub computes mergeability asynchronously and answers null while it
      // works. That is "computing", not "conflicted"; the triage view says so.
      mergeable: typeof data.mergeable === "boolean" ? data.mergeable : null,
    };
  }

  async function getDiff(ref: PRRef): Promise<string> {
    const res = await request(`/repos/${seg(ref.owner)}/${seg(ref.repo)}/pulls/${ref.number}`, {
      accept: "application/vnd.github.v3.diff",
    });
    return await res.text();
  }

  async function getCheckStatus(ref: PRRef, sha: string): Promise<CheckStatus> {
    const runs: Run[] = [];
    // Paginated like the PR list: a rollup computed from page one alone would
    // report success for a SHA whose failing run sits on page two.
    let target: string | null =
      `/repos/${seg(ref.owner)}/${seg(ref.repo)}/commits/${seg(sha)}/check-runs?per_page=${PER_PAGE}`;

    while (target) {
      const res = await request(target);
      const data = (await res.json()) as { check_runs?: GhCheckRun[] };
      runs.push(...(data.check_runs ?? []).map(toRun));
      target = nextLink(res.headers.get("link"));
    }

    return { state: rollUp(runs), runs };
  }

  async function createDraftReview(ref: PRRef, review: DraftReview): Promise<{ id: number }> {
    // A review with no comments would be a body-only review: public-looking
    // noise that says nothing. The post flow aborts before reaching here when
    // zero findings validate, and this is the backstop.
    if (review.comments.length === 0) {
      throw new Error("refusing to create a review with no comments");
    }

    const built = buildDraftReviewRequest(ref, review);
    const res = await request(built.path, { method: built.method, body: built.body });
    const created = (await res.json()) as { id?: number; state?: string };

    if (typeof created.id !== "number") {
      throw new Error("GitHub returned a review with no id");
    }

    // Anything but PENDING means the comments are already visible on the PR,
    // which is the one outcome this whole tool exists to prevent. Fail loudly.
    const state = (created.state ?? "").toUpperCase();
    if (state !== "PENDING") {
      throw new Error(
        `expected a PENDING review but GitHub returned "${created.state ?? "no state"}". ` +
          "The comments may already be visible on the PR."
      );
    }

    return { id: created.id };
  }

  async function deleteDraftReview(ref: PRRef, id: number): Promise<void> {
    // 404 is success: someone deleted or submitted the draft in GitHub's UI,
    // and the recreate path wants it gone either way.
    await request(`/repos/${seg(ref.owner)}/${seg(ref.repo)}/pulls/${ref.number}/reviews/${id}`, {
      method: "DELETE",
      tolerate: [404],
    });
  }

  async function getReview(ref: PRRef, id: number): Promise<"pending" | "submitted" | "gone"> {
    const res = await request(`/repos/${seg(ref.owner)}/${seg(ref.repo)}/pulls/${ref.number}/reviews/${id}`, {
      tolerate: [404],
    });

    if (res.status === 404) return "gone";

    const review = (await res.json()) as { state?: string };
    return (review.state ?? "").toUpperCase() === "PENDING" ? "pending" : "submitted";
  }

  async function authenticatedUser(): Promise<string> {
    if (cachedLogin) return cachedLogin;

    const res = await request("/user");
    const user = (await res.json()) as GhUser;
    if (!user.login) throw new Error("GitHub returned an authenticated user with no login");

    cachedLogin = user.login;
    return cachedLogin;
  }

  return {
    listOpenPRs,
    getPR,
    getDiff,
    getCheckStatus,
    createDraftReview,
    deleteDraftReview,
    getReview,
    authenticatedUser,
  };
}

// ─── The draft-review request ───────────────────────────────────────────────

/**
 * The exact request that creates a PENDING draft review.
 *
 * Split out from the sending so a test can assert on the body without a
 * network call. The absence of an `event` key is what makes the review a
 * draft only its author can see; sending one publishes instantly and
 * irreversibly, and there is no `draft: true` parameter to fall back on.
 * That absence is not something to verify by reading the file.
 */
export function buildDraftReviewRequest(
  ref: PRRef,
  review: DraftReview
): {
  path: string;
  method: "POST";
  body: { body: string; comments: Array<{ path: string; line: number; body: string }> };
} {
  return {
    path: `/repos/${seg(ref.owner)}/${seg(ref.repo)}/pulls/${ref.number}/reviews`,
    method: "POST",
    body: {
      body: review.body,
      comments: review.comments.map((comment) => ({
        path: comment.path,
        line: comment.line,
        body: comment.body,
      })),
    },
  };
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Escape one path segment.
 *
 * Owner, repo, and SHA reach here from a hand-edited `watch.md` and from
 * agent output. GitHub's own names never need escaping, so this exists for
 * the malformed ones: a repo field holding `../../user` would otherwise
 * retarget the call at a different endpoint entirely.
 */
function seg(value: string): string {
  return encodeURIComponent(value);
}

/**
 * ETag cache key. Repo-qualified, because a single adapter instance polls
 * every watched repo and a bare key would answer one repo's conditional
 * request with another's validator.
 */
function etagKey(repo: RepoRef): string {
  return `${repo.owner}/${repo.repo}`;
}

/** The `rel="next"` URL of a Link header, GitHub's own pagination cursor. */
function nextLink(header: string | null): string | null {
  if (!header) return null;

  for (const part of header.split(",")) {
    const match = /<([^>]+)>\s*;\s*rel="next"/.exec(part);
    if (match?.[1]) return match[1];
  }

  return null;
}

async function apiError(res: Response): Promise<Error> {
  const detail = await res.text().catch(() => "");
  return new Error(`GitHub API ${res.status}: ${detail.slice(0, 200)}`);
}

function logins(users: GhUser[] | null | undefined): string[] {
  return (users ?? []).map((user) => user.login).filter((login): login is string => Boolean(login));
}

function toSummary(data: GhPull): PRSummary {
  return {
    number: data.number ?? 0,
    title: data.title ?? "",
    // Mention detection reads the description, and GitHub sends null for an
    // empty one.
    body: data.body ?? "",
    url: data.html_url ?? "",
    author: data.user?.login ?? "unknown",
    draft: data.draft ?? false,
    headSha: data.head?.sha ?? "",
    createdAt: data.created_at ?? "",
    updatedAt: data.updated_at ?? "",
    requestedReviewers: logins(data.requested_reviewers),
    assignees: logins(data.assignees),
  };
}

type Run = CheckStatus["runs"][number];

function toRun(run: GhCheckRun): Run {
  return {
    name: run.name ?? "check",
    status: normalizeStatus(run.status),
    conclusion: normalizeConclusion(run.conclusion),
  };
}

const KNOWN_CONCLUSIONS = new Set([
  "success",
  "failure",
  "neutral",
  "cancelled",
  "skipped",
  "timed_out",
  "action_required",
]);

/** Conclusions that mean the head SHA did not pass CI. */
const FAILING = new Set(["failure", "cancelled", "timed_out", "action_required"]);

function normalizeStatus(raw: string | undefined): Run["status"] {
  if (raw === "completed" || raw === "in_progress") return raw;
  // GitHub has added "waiting", "requested" and "pending" over time. Each one
  // means the run has not started, which is what "queued" says here.
  return "queued";
}

function normalizeConclusion(raw: string | null | undefined): Run["conclusion"] {
  if (!raw) return null;
  if (KNOWN_CONCLUSIONS.has(raw)) return raw as Run["conclusion"];
  // Newer conclusions ("stale", "startup_failure") have all meant the run did
  // not pass, so an unrecognized one reads as a failure rather than sliding
  // through triage as a success.
  return "failure";
}

function rollUp(runs: Run[]): CheckStatus["state"] {
  // No check runs registered for this SHA is "no checks", not a failure. CI
  // reported only through the legacy commit Status API lands here too, and a
  // red cross on a repo that simply does not use the Checks API would make
  // the triage inbox lie (design.md, deferred decisions).
  if (runs.length === 0) return "none";

  // Failure outranks pending: one failed check is worth surfacing even while
  // its siblings still run.
  if (runs.some((run) => run.conclusion !== null && FAILING.has(run.conclusion))) return "failure";
  if (runs.some((run) => run.status !== "completed" || run.conclusion === null)) return "pending";

  return "success";
}

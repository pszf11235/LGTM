/**
 * A GitHub REST API impersonator, served over a real socket on an ephemeral
 * loopback port.
 *
 * This is the outer edge of the end-to-end harness. Everything inside it runs
 * as it does in production: the adapter, the poll cycle, the queue, the store,
 * the API and the post flow. The only thing swapped out is the host on the
 * other end of the wire. That matters because the defects this harness
 * exists to catch live between modules, and a hand-written `ForgeAdapter`
 * stub would replace three of the modules under test with a mock of what
 * someone believed they do.
 *
 * Two properties are worth stating up front, because both are easy to get
 * subtly wrong and neither fails loudly.
 *
 * THE FAKE REPRESENTS THE DANGEROUS REQUEST. `POST .../reviews` records the
 * body it was sent, byte for byte, and honours an `event` key by publishing
 * the review, exactly as GitHub does (ADR 0001). A fake that stripped or
 * rejected `event` would make `expect("event" in body).toBe(false)` pass no
 * matter what the daemon sent, which is worse than not asserting it at all.
 * The absence has to be observed here, not enforced here.
 *
 * IT RECORDS EVERY REQUEST, NOT JUST THE INTERESTING ONES. A test can assert
 * that nothing was posted, that the second poll was conditional and got a
 * 304, that a recreate deleted before it created. Those are claims about what
 * the daemon *did*, which is the half of the system a store assertion cannot
 * see. Unknown paths are recorded too, and answered 404. A daemon calling an
 * endpoint the fake has never heard of should show up as a failing journey,
 * not as silence.
 *
 * What is deliberately NOT modelled is listed in ./README.md.
 */

// ─── Recorded traffic ───────────────────────────────────────────────────────

/** One request the fake received, and what it answered. */
export interface RecordedRequest {
  /** 1-based arrival order across the whole server. Ordering assertions read this. */
  seq: number;
  method: string;
  /** Pathname only, no query string. */
  path: string;
  query: Record<string, string>;
  url: string;
  /** Header names lowercased. Includes `authorization`, so a test can see what was sent. */
  headers: Record<string, string>;
  /** Parsed JSON when the body was JSON, the raw string when it was not, null when empty. */
  body: unknown;
  rawBody: string | null;
  /** The status the fake answered with. Filled in once the handler returns. */
  status: number;
}

/** Query helpers over the recorded traffic. Everything returns arrivals in order. */
export interface RequestLog {
  all(): RecordedRequest[];
  filter(predicate: (request: RecordedRequest) => boolean): RecordedRequest[];
  find(predicate: (request: RecordedRequest) => boolean): RecordedRequest | null;
  /**
   * Requests whose method matches and whose path matches. A string is an
   * exact match, a RegExp is tested against the path.
   */
  matching(method: string, path: string | RegExp): RecordedRequest[];
  count(method: string, path: string | RegExp): number;
  /** `GET /repos/acme/api/pulls` lines, for a readable failure message. */
  lines(): string[];
  clear(): void;
}

// ─── The repository fixture ─────────────────────────────────────────────────

export interface FakeCheckRun {
  name: string;
  status: "queued" | "in_progress" | "completed";
  conclusion: string | null;
}

/** One pull request, as the fixture holds it. Every field the adapter reads. */
export interface FakePullRequest {
  number: number;
  title: string;
  body: string;
  author: string;
  draft: boolean;
  headSha: string;
  createdAt: string;
  updatedAt: string;
  requestedReviewers: string[];
  assignees: string[];
  additions: number;
  deletions: number;
  changedFiles: number;
  /** Null is GitHub still computing it, which the inbox renders as "computing". */
  mergeable: boolean | null;
  /** A real unified diff. `buildDiff` below produces one the parser accepts. */
  diff: string;
  checkRuns: FakeCheckRun[];
  state: "open" | "closed";
}

export interface OpenPRInput {
  number?: number;
  title?: string;
  body?: string;
  author?: string;
  draft?: boolean;
  headSha?: string;
  createdAt?: string;
  updatedAt?: string;
  requestedReviewers?: string[];
  assignees?: string[];
  additions?: number;
  deletions?: number;
  changedFiles?: number;
  mergeable?: boolean | null;
  diff?: string;
  checkRuns?: FakeCheckRun[];
}

export interface PushCommitInput {
  headSha?: string;
  diff?: string;
  additions?: number;
  deletions?: number;
  changedFiles?: number;
}

/**
 * One repository's PRs, and the handles a journey drives it by.
 *
 * Every mutation bumps the repo's ETag, which is what makes the "nothing
 * changed since last poll" path testable: a cycle that follows a cycle with
 * no fixture change gets a 304 and does no work.
 */
export interface FakeRepo {
  readonly owner: string;
  readonly name: string;
  /** `owner/repo`. */
  readonly key: string;
  /** The current list validator. Changes whenever anything about the open list does. */
  readonly etag: string;

  /** Add an open PR. Numbers auto-increment when not given. */
  openPR(input?: OpenPRInput): FakePullRequest;
  /** The PR, or null. The returned object is a copy; use the mutators to change it. */
  pr(number: number): FakePullRequest | null;
  /** Every PR the repo holds, open and closed. */
  all(): FakePullRequest[];

  /** New head SHA (auto-generated when not given) and, optionally, a new diff. */
  pushCommit(number: number, input?: PushCommitInput): FakePullRequest;
  /** Leaves the open list. Known PRs then close in the store. */
  closePR(number: number): FakePullRequest;
  reopenPR(number: number): FakePullRequest;
  /** The draft-to-ready transition of R2.3. */
  markReadyForReview(number: number): FakePullRequest;
  markDraft(number: number): FakePullRequest;

  setDiff(number: number, diff: string): FakePullRequest;
  setCheckRuns(number: number, runs: FakeCheckRun[]): FakePullRequest;
  setMergeable(number: number, mergeable: boolean | null): FakePullRequest;
  requestReviewFrom(number: number, login: string): FakePullRequest;

  /**
   * How many PRs one page of the open list holds. Set below the open count to
   * exercise the adapter's Link-header pagination (and its rule that a
   * multi-page listing drops the ETag). Default: everything on one page.
   */
  pageSize: number;
  /**
   * Whether the fake rejects a review whose comment names a line outside the
   * current diff, as GitHub does. On by default. The post flow validates
   * before it sends, so a 422 here means that validation was wrong.
   *
   * Turning it off is how a journey checks that the fake would *record* a
   * wrong line rather than quietly drop it, which is what makes "one comment,
   * on src/index.ts:42" an observation rather than an arrangement.
   */
  strictCommentLines: boolean;

  /**
   * Make the next create-review call fail with this status, once.
   *
   * GitHub refuses a create for reasons LGTM cannot predict or prevent: a
   * secondary rate limit, a 500, a token that lost its scope, a PR that closed
   * between the diff fetch and the post. The interesting half of the posting
   * flow is what the store looks like afterwards, and a fake that can only
   * succeed cannot ask the question. Calls queue up, so two calls stage two
   * consecutive failures.
   */
  failNextCreate(status: number, message?: string): void;
  /** The same, for `DELETE .../reviews/{id}`, which recreate does first. */
  failNextDelete(status: number, message?: string): void;
}

// ─── Reviews ────────────────────────────────────────────────────────────────

/** GitHub's review states. `PENDING` is the draft; everything else is published. */
export type FakeReviewState = "PENDING" | "COMMENTED" | "APPROVED" | "CHANGES_REQUESTED";

export interface FakeReview {
  id: number;
  repoKey: string;
  prNumber: number;
  state: FakeReviewState;
  body: string;
  comments: Array<{ path: string; line: number; body: string }>;
  /**
   * The create request's body exactly as it arrived, before the fake looked
   * at it. `"event" in requestBody` is the assertion ADR 0001 rests on.
   */
  requestBody: Record<string, unknown>;
  createdSeq: number;
}

export interface ReviewStore {
  /** Every review still on the host, in creation order. */
  all(): FakeReview[];
  get(id: number): FakeReview | null;
  /** Reviews created on this PR, including ones later submitted. */
  forPR(owner: string, repo: string, number: number): FakeReview[];
  /**
   * Submit a draft in "GitHub's UI". The daemon's `getReview` then reports it
   * as no longer pending, which is what clears `pendingReviewId`.
   */
  submit(id: number, state?: Exclude<FakeReviewState, "PENDING">): FakeReview;
  /** Delete a draft in "GitHub's UI". `getReview` then answers `gone`. */
  remove(id: number): boolean;
}

// ─── The server ─────────────────────────────────────────────────────────────

export interface FakeGitHub {
  /** `http://127.0.0.1:<port>`. Point an adapter's `baseUrl` here, or rewrite fetch onto it. */
  readonly url: string;
  readonly port: number;
  /** What `GET /user` answers: the login classification compares against. */
  viewer: string;
  repo(owner: string, name: string): FakeRepo;
  readonly log: RequestLog;
  readonly reviews: ReviewStore;
  stop(): Promise<void>;
}

export interface FakeGitHubOptions {
  /** Default `GET /user` login. */
  viewer?: string;
  /** Repos to create up front. More are created on first `repo()` call. */
  repos?: Array<{ owner: string; repo: string }>;
}

// ─── Diff building ──────────────────────────────────────────────────────────

/** One line of a hunk: a bare string is context, the wrappers are +/- lines. */
export type DiffLine = string | { added: string } | { removed: string };

export interface DiffFileSpec {
  path: string;
  /** First line number of the hunk in the new file. */
  startLine: number;
  lines: DiffLine[];
}

function renderLine(line: DiffLine): { prefix: string; text: string } {
  if (typeof line === "string") return { prefix: " ", text: line };
  if ("added" in line) return { prefix: "+", text: line.added };
  return { prefix: "-", text: line.removed };
}

/**
 * A unified diff the ported parser in @/core/diff accepts.
 *
 * The commentable set GitHub (and `checkLines`) computes is the added and
 * context lines' new-file numbers, so what a spec chooses to include is
 * exactly what a finding may be attached to.
 */
export function buildDiff(files: DiffFileSpec[]): string {
  const out: string[] = [];

  for (const file of files) {
    const rendered = file.lines.map(renderLine);
    const oldCount = rendered.filter((line) => line.prefix !== "+").length;
    const newCount = rendered.filter((line) => line.prefix !== "-").length;

    out.push(`diff --git a/${file.path} b/${file.path}`);
    out.push("index 1111111..2222222 100644");
    out.push(`--- a/${file.path}`);
    out.push(`+++ b/${file.path}`);
    out.push(`@@ -${file.startLine},${oldCount} +${file.startLine},${newCount} @@`);
    for (const line of rendered) out.push(`${line.prefix}${line.text}`);
  }

  return out.join("\n") + "\n";
}

/**
 * A file spec whose hunk makes `startLine` through `startLine + count - 1`
 * commentable, all of them as added lines.
 */
export function addedLines(path: string, startLine: number, count: number): DiffFileSpec {
  const lines: DiffLine[] = [];
  for (let i = 0; i < count; i++) {
    lines.push({ added: `  // ${path}:${startLine + i}` });
  }
  return { path, startLine, lines };
}

// ─── Implementation ─────────────────────────────────────────────────────────

function shaFor(seed: string): string {
  // Deterministic, 40 hex characters, and distinct per seed. Stable SHAs make
  // a failing assertion readable and keep snapshot filenames predictable.
  let hash = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    hash ^= seed.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  const block = hash.toString(16).padStart(8, "0");
  return (block + block + block + block + block).slice(0, 40);
}

function headersOf(request: Request): Record<string, string> {
  const out: Record<string, string> = {};
  request.headers.forEach((value, name) => {
    out[name.toLowerCase()] = value;
  });
  return out;
}

interface StagedFailure {
  status: number;
  message: string;
}

interface RepoState {
  owner: string;
  name: string;
  key: string;
  prs: Map<number, FakePullRequest>;
  etagVersion: number;
  nextNumber: number;
  pageSize: number;
  strictCommentLines: boolean;
  /** One-shot refusals, consumed in order. See `failNextCreate`. */
  createFailures: StagedFailure[];
  deleteFailures: StagedFailure[];
}

const DEFAULT_DIFF = buildDiff([addedLines("src/index.ts", 40, 6), addedLines("src/utils.ts", 15, 8)]);

/**
 * Start the fake on an ephemeral loopback port.
 *
 * Port 0 lets the OS pick, so any number of harnesses can run side by side and
 * no test ever collides with a developer's own daemon on 4747.
 */
export function createFakeGitHub(options: FakeGitHubOptions = {}): FakeGitHub {
  const repos = new Map<string, RepoState>();
  const reviews = new Map<number, FakeReview>();
  const recorded: RecordedRequest[] = [];

  let viewer = options.viewer ?? "octocat";
  let seq = 0;
  let nextReviewId = 900001;

  function repoState(owner: string, name: string): RepoState {
    const key = `${owner}/${name}`;
    const existing = repos.get(key);
    if (existing) return existing;

    const created: RepoState = {
      owner,
      name,
      key,
      prs: new Map(),
      etagVersion: 1,
      nextNumber: 1,
      pageSize: Number.POSITIVE_INFINITY,
      strictCommentLines: true,
      createFailures: [],
      deleteFailures: [],
    };
    repos.set(key, created);
    return created;
  }

  for (const entry of options.repos ?? []) repoState(entry.owner, entry.repo);

  function etagOf(state: RepoState): string {
    return `"lgtm-${state.key}-${state.etagVersion}"`;
  }

  function touch(state: RepoState): void {
    state.etagVersion += 1;
  }

  function requirePR(state: RepoState, number: number): FakePullRequest {
    const pr = state.prs.get(number);
    if (!pr) throw new Error(`fake-github: ${state.key}#${number} does not exist in the fixture`);
    return pr;
  }

  function openList(state: RepoState): FakePullRequest[] {
    return [...state.prs.values()]
      .filter((pr) => pr.state === "open")
      .sort((a, b) => b.number - a.number);
  }

  // ── The wire shapes ──────────────────────────────────────────────────────

  function pullPayload(state: RepoState, pr: FakePullRequest, detail: boolean): unknown {
    const base = {
      number: pr.number,
      title: pr.title,
      body: pr.body,
      html_url: `https://github.com/${state.key}/pull/${pr.number}`,
      user: { login: pr.author },
      draft: pr.draft,
      head: { sha: pr.headSha },
      created_at: pr.createdAt,
      updated_at: pr.updatedAt,
      requested_reviewers: pr.requestedReviewers.map((login) => ({ login })),
      assignees: pr.assignees.map((login) => ({ login })),
      state: pr.state,
    };

    if (!detail) return base;

    return {
      ...base,
      additions: pr.additions,
      deletions: pr.deletions,
      changed_files: pr.changedFiles,
      mergeable: pr.mergeable,
    };
  }

  function reviewPayload(review: FakeReview): unknown {
    const repo = review.repoKey;
    return {
      id: review.id,
      state: review.state,
      body: review.body,
      user: { login: viewer },
      html_url: `https://github.com/${repo}/pull/${review.prNumber}#pullrequestreview-${review.id}`,
      pull_request_url: `https://api.github.com/repos/${repo}/pulls/${review.prNumber}`,
    };
  }

  function commentableLines(pr: FakePullRequest): Map<string, Set<number>> {
    // A local reading of the diff rather than an import of the production
    // parser: the fake is the thing the production parser is checked against,
    // and sharing the code would make a parser bug invisible on both sides.
    const byFile = new Map<string, Set<number>>();
    let current: Set<number> | null = null;
    let newLine = 0;

    for (const raw of pr.diff.split("\n")) {
      const fileHeader = /^diff --git a\/(.+?) b\/(.+)$/.exec(raw);
      if (fileHeader) {
        const path = fileHeader[2] ?? "";
        current = byFile.get(path) ?? new Set<number>();
        byFile.set(path, current);
        continue;
      }

      const hunkHeader = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
      if (hunkHeader) {
        newLine = Number(hunkHeader[1] ?? "1");
        continue;
      }

      if (!current) continue;
      if (raw.startsWith("+++") || raw.startsWith("---")) continue;
      if (raw.startsWith("+") || raw.startsWith(" ")) {
        current.add(newLine);
        newLine += 1;
      } else if (raw.startsWith("-")) {
        // Left-hand-side only; it carries no new-file line number.
      }
    }

    return byFile;
  }

  // ── Routing ──────────────────────────────────────────────────────────────

  function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json; charset=utf-8", ...headers },
    });
  }

  function error(status: number, message: string): Response {
    return json({ message, documentation_url: "https://docs.github.com/rest" }, status);
  }

  function listPulls(state: RepoState, url: URL, request: Request): Response {
    const open = openList(state);
    const etag = etagOf(state);
    const size = Number.isFinite(state.pageSize) ? state.pageSize : open.length || 1;
    const pages = Math.max(1, Math.ceil(open.length / size));
    const page = Math.max(1, Number(url.searchParams.get("page") ?? "1"));

    // Conditional requests only make sense for page one; the adapter drops the
    // validator for a multi-page listing precisely because of that.
    if (page === 1 && request.headers.get("if-none-match") === etag) {
      return new Response(null, { status: 304, headers: { etag } });
    }

    const slice = open.slice((page - 1) * size, page * size);
    const headers: Record<string, string> = { etag };

    if (page < pages) {
      const next = new URL(url.toString());
      next.searchParams.set("page", String(page + 1));
      headers.link = `<${next.toString()}>; rel="next"`;
    }

    return json(
      slice.map((pr) => pullPayload(state, pr, false)),
      200,
      headers
    );
  }

  function getPull(state: RepoState, number: number, request: Request): Response {
    const pr = state.prs.get(number);
    if (!pr) return error(404, "Not Found");

    const accept = request.headers.get("accept") ?? "";
    if (accept.includes("diff")) {
      return new Response(pr.diff, {
        status: 200,
        headers: { "content-type": "application/vnd.github.v3.diff; charset=utf-8" },
      });
    }

    return json(pullPayload(state, pr, true));
  }

  function checkRuns(state: RepoState, sha: string): Response {
    const pr = [...state.prs.values()].find((candidate) => candidate.headSha === sha);
    const runs = pr?.checkRuns ?? [];
    return json({ total_count: runs.length, check_runs: runs });
  }

  function createReview(
    state: RepoState,
    number: number,
    body: unknown,
    arrivalSeq: number
  ): Response {
    // Before the body is even looked at, so a staged failure models a host
    // that refused rather than a request that was malformed.
    const staged = state.createFailures.shift();
    if (staged) return error(staged.status, staged.message);

    const pr = state.prs.get(number);
    if (!pr) return error(404, "Not Found");

    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return error(400, "Problems parsing JSON");
    }
    const requestBody = body as Record<string, unknown>;

    const rawComments = Array.isArray(requestBody.comments) ? requestBody.comments : [];
    const comments = rawComments.map((entry) => {
      const comment = (entry ?? {}) as Record<string, unknown>;
      return {
        path: typeof comment.path === "string" ? comment.path : "",
        line: typeof comment.line === "number" ? comment.line : 0,
        body: typeof comment.body === "string" ? comment.body : "",
      };
    });

    if (comments.length === 0) {
      return error(422, "Validation Failed: a review must have a body or comments");
    }

    if (state.strictCommentLines) {
      const allowed = commentableLines(pr);
      for (const comment of comments) {
        if (!allowed.get(comment.path)?.has(comment.line)) {
          // GitHub rejects the whole call, not the one comment. That is why
          // the post flow validates first, and why this answer is a 422.
          return error(
            422,
            `Validation Failed: ${comment.path} line ${comment.line} is not part of the pull request diff`
          );
        }
      }
    }

    // The heart of ADR 0001, from the host's side. An `event` key publishes,
    // and the fake obeys it. The daemon never sends one, and the journeys
    // prove that by reading `requestBody` back rather than by trusting that
    // the fake would have refused it.
    const event = typeof requestBody.event === "string" ? requestBody.event.toUpperCase() : null;
    const published: Record<string, FakeReviewState> = {
      COMMENT: "COMMENTED",
      APPROVE: "APPROVED",
      REQUEST_CHANGES: "CHANGES_REQUESTED",
    };
    const reviewState: FakeReviewState = event ? (published[event] ?? "COMMENTED") : "PENDING";

    const review: FakeReview = {
      id: nextReviewId++,
      repoKey: state.key,
      prNumber: number,
      state: reviewState,
      body: typeof requestBody.body === "string" ? requestBody.body : "",
      comments,
      requestBody,
      createdSeq: arrivalSeq,
    };
    reviews.set(review.id, review);

    return json(reviewPayload(review), 200);
  }

  function deleteReview(state: RepoState, id: number): Response {
    const staged = state.deleteFailures.shift();
    if (staged) return error(staged.status, staged.message);

    const review = reviews.get(id);
    if (!review) return error(404, "Not Found");
    if (review.state !== "PENDING") {
      return error(422, "Validation Failed: only pending reviews can be deleted");
    }
    reviews.delete(id);
    return json(reviewPayload(review), 200);
  }

  function readReview(id: number): Response {
    const review = reviews.get(id);
    if (!review) return error(404, "Not Found");
    return json(reviewPayload(review));
  }

  async function route(request: Request, url: URL, parsedBody: unknown, arrivalSeq: number): Promise<Response> {
    // Every endpoint but none of the CI: the adapter always sends a bearer,
    // and a request without one is a wiring bug worth surfacing here.
    const authorization = request.headers.get("authorization") ?? "";
    if (!/^bearer\s+\S/i.test(authorization)) {
      return error(401, "Requires authentication");
    }

    const parts = url.pathname.split("/").filter((part) => part.length > 0);

    if (parts.length === 1 && parts[0] === "user" && request.method === "GET") {
      return json({ login: viewer, id: 1 });
    }

    if (parts[0] !== "repos" || parts.length < 3) return error(404, "Not Found");

    const owner = decodeURIComponent(parts[1] ?? "");
    const name = decodeURIComponent(parts[2] ?? "");
    if (!repos.has(`${owner}/${name}`)) return error(404, "Not Found");
    const state = repoState(owner, name);
    const rest = parts.slice(3);

    // /repos/{o}/{r}/pulls
    if (rest.length === 1 && rest[0] === "pulls" && request.method === "GET") {
      return listPulls(state, url, request);
    }

    // /repos/{o}/{r}/pulls/{n}
    if (rest.length === 2 && rest[0] === "pulls" && request.method === "GET") {
      return getPull(state, Number(rest[1]), request);
    }

    // /repos/{o}/{r}/pulls/{n}/reviews
    if (rest.length === 3 && rest[0] === "pulls" && rest[2] === "reviews") {
      if (request.method === "POST") {
        return createReview(state, Number(rest[1]), parsedBody, arrivalSeq);
      }
      if (request.method === "GET") {
        return json(
          [...reviews.values()]
            .filter((review) => review.repoKey === state.key && review.prNumber === Number(rest[1]))
            .map(reviewPayload)
        );
      }
    }

    // /repos/{o}/{r}/pulls/{n}/reviews/{id}
    if (rest.length === 4 && rest[0] === "pulls" && rest[2] === "reviews") {
      const id = Number(rest[3]);
      if (request.method === "GET") return readReview(id);
      if (request.method === "DELETE") return deleteReview(state, id);
    }

    // /repos/{o}/{r}/commits/{sha}/check-runs
    if (rest.length === 3 && rest[0] === "commits" && rest[2] === "check-runs" && request.method === "GET") {
      return checkRuns(state, decodeURIComponent(rest[1] ?? ""));
    }

    return error(404, "Not Found");
  }

  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      const url = new URL(request.url);

      let rawBody: string | null = null;
      try {
        const text = await request.text();
        rawBody = text.length > 0 ? text : null;
      } catch {
        rawBody = null;
      }

      let parsed: unknown = null;
      if (rawBody !== null) {
        try {
          parsed = JSON.parse(rawBody);
        } catch {
          parsed = rawBody;
        }
      }

      const entry: RecordedRequest = {
        seq: ++seq,
        method: request.method,
        path: url.pathname,
        query: Object.fromEntries(url.searchParams.entries()),
        url: request.url,
        headers: headersOf(request),
        body: parsed,
        rawBody,
        status: 0,
      };
      recorded.push(entry);

      let response: Response;
      try {
        response = await route(request, url, parsed, entry.seq);
      } catch (thrown) {
        const message = thrown instanceof Error ? thrown.message : String(thrown);
        response = error(500, `fake-github: ${message}`);
      }

      entry.status = response.status;
      return response;
    },
  });

  const port = server.port ?? 0;

  // ── Public handles ───────────────────────────────────────────────────────

  function repoHandle(owner: string, name: string): FakeRepo {
    const state = repoState(owner, name);

    const mutate = (number: number, change: (pr: FakePullRequest) => void): FakePullRequest => {
      const pr = requirePR(state, number);
      change(pr);
      pr.updatedAt = new Date().toISOString();
      touch(state);
      return { ...pr };
    };

    return {
      owner: state.owner,
      name: state.name,
      key: state.key,
      get etag() {
        return etagOf(state);
      },
      get pageSize() {
        return state.pageSize;
      },
      set pageSize(value: number) {
        state.pageSize = value;
      },
      get strictCommentLines() {
        return state.strictCommentLines;
      },
      set strictCommentLines(value: boolean) {
        state.strictCommentLines = value;
      },

      openPR(input: OpenPRInput = {}) {
        const number = input.number ?? state.nextNumber;
        state.nextNumber = Math.max(state.nextNumber, number + 1);

        const pr: FakePullRequest = {
          number,
          title: input.title ?? `Change ${number}`,
          body: input.body ?? "",
          author: input.author ?? "contributor",
          draft: input.draft ?? false,
          headSha: input.headSha ?? shaFor(`${state.key}#${number}@1`),
          createdAt: input.createdAt ?? "2026-08-01T00:00:00Z",
          updatedAt: input.updatedAt ?? "2026-08-01T00:00:00Z",
          requestedReviewers: input.requestedReviewers ?? [],
          assignees: input.assignees ?? [],
          additions: input.additions ?? 12,
          deletions: input.deletions ?? 3,
          changedFiles: input.changedFiles ?? 2,
          mergeable: input.mergeable === undefined ? true : input.mergeable,
          diff: input.diff ?? DEFAULT_DIFF,
          checkRuns: input.checkRuns ?? [
            { name: "build", status: "completed", conclusion: "success" },
          ],
          state: "open",
        };

        state.prs.set(number, pr);
        touch(state);
        return { ...pr };
      },

      pr(number) {
        const found = state.prs.get(number);
        return found ? { ...found } : null;
      },

      all() {
        return [...state.prs.values()].map((pr) => ({ ...pr }));
      },

      pushCommit(number, input: PushCommitInput = {}) {
        return mutate(number, (pr) => {
          const generation = pr.headSha;
          pr.headSha = input.headSha ?? shaFor(`${state.key}#${number}@${generation}`);
          if (input.diff !== undefined) pr.diff = input.diff;
          if (input.additions !== undefined) pr.additions = input.additions;
          if (input.deletions !== undefined) pr.deletions = input.deletions;
          if (input.changedFiles !== undefined) pr.changedFiles = input.changedFiles;
        });
      },

      closePR(number) {
        return mutate(number, (pr) => {
          pr.state = "closed";
        });
      },

      reopenPR(number) {
        return mutate(number, (pr) => {
          pr.state = "open";
        });
      },

      markReadyForReview(number) {
        return mutate(number, (pr) => {
          pr.draft = false;
        });
      },

      markDraft(number) {
        return mutate(number, (pr) => {
          pr.draft = true;
        });
      },

      setDiff(number, diff) {
        return mutate(number, (pr) => {
          pr.diff = diff;
        });
      },

      setCheckRuns(number, runs) {
        return mutate(number, (pr) => {
          pr.checkRuns = runs;
        });
      },

      setMergeable(number, mergeable) {
        return mutate(number, (pr) => {
          pr.mergeable = mergeable;
        });
      },

      requestReviewFrom(number, login) {
        return mutate(number, (pr) => {
          if (!pr.requestedReviewers.includes(login)) pr.requestedReviewers.push(login);
        });
      },

      failNextCreate(status, message = "fake-github: staged create failure") {
        state.createFailures.push({ status, message });
      },

      failNextDelete(status, message = "fake-github: staged delete failure") {
        state.deleteFailures.push({ status, message });
      },
    };
  }

  function matches(request: RecordedRequest, method: string, path: string | RegExp): boolean {
    if (request.method !== method.toUpperCase()) return false;
    return typeof path === "string" ? request.path === path : path.test(request.path);
  }

  const log: RequestLog = {
    all: () => [...recorded],
    filter: (predicate) => recorded.filter(predicate),
    find: (predicate) => recorded.find(predicate) ?? null,
    matching: (method, path) => recorded.filter((request) => matches(request, method, path)),
    count: (method, path) => recorded.filter((request) => matches(request, method, path)).length,
    lines: () => recorded.map((request) => `${request.status} ${request.method} ${request.path}`),
    clear: () => {
      recorded.length = 0;
    },
  };

  const reviewStore: ReviewStore = {
    all: () => [...reviews.values()],
    get: (id) => reviews.get(id) ?? null,
    forPR: (owner, repo, number) =>
      [...reviews.values()].filter(
        (review) => review.repoKey === `${owner}/${repo}` && review.prNumber === number
      ),
    submit: (id, state = "COMMENTED") => {
      const review = reviews.get(id);
      if (!review) throw new Error(`fake-github: no review ${id} to submit`);
      review.state = state;
      return review;
    },
    remove: (id) => reviews.delete(id),
  };

  return {
    url: `http://127.0.0.1:${port}`,
    port,
    get viewer() {
      return viewer;
    },
    set viewer(login: string) {
      viewer = login;
    },
    repo: repoHandle,
    log,
    reviews: reviewStore,
    async stop() {
      await server.stop(true);
    },
  };
}

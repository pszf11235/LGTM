/**
 * `lgtm watch add|rm|ls`: manage the watch list through the daemon's HTTP
 * API rather than touching `watch.md` directly, so the daemon stays the
 * store's only writer (design.md, "Architecture": "the SPA and the CLI
 * mutate through the API"; requirements R9.4, R1.4).
 */
import {
  addWatch,
  type AddWatchResult,
  type BackfillEntry,
  type DaemonLocation,
  describeCliError,
  type FetchLike,
  getWatchList,
  locateDaemon,
  removeWatch,
  type WatchEntry,
} from "./client";

export interface WatchCommandOptions {
  lgtmDir?: string;
  fetchImpl?: FetchLike;
  /** Injectable for tests; defaults to the real signal-0 check. */
  isAlive?: (pid: number) => boolean;
  write?: (line: string) => void;
  writeErr?: (line: string) => void;
}

interface OwnerRepo {
  owner: string;
  repo: string;
}

// Matches src/api/routes.ts's `REPO_SEGMENT` — GitHub's own naming rules —
// so a string this client rejects locally is exactly one the daemon would
// also reject, and vice versa.
const OWNER_REPO_RE = /^([A-Za-z0-9][A-Za-z0-9._-]*)\/([A-Za-z0-9][A-Za-z0-9._-]*)$/;

/** `owner/repo`, the only form R1.4 asks for — no URLs, no bare numbers (that's `pr-ref.ts`'s job, for PRs). */
export function parseOwnerRepo(input: string): OwnerRepo | null {
  const match = OWNER_REPO_RE.exec(input.trim());
  if (!match) return null;
  const owner = match[1];
  const repo = match[2];
  if (!owner || !repo) return null;
  return { owner, repo };
}

function writers(options: WatchCommandOptions): {
  write: (line: string) => void;
  writeErr: (line: string) => void;
} {
  return {
    write: options.write ?? ((line: string) => console.log(line)),
    writeErr: options.writeErr ?? ((line: string) => console.error(line)),
  };
}

/**
 * Locates the daemon and runs `fn` against it, funneling both failure modes
 * (no daemon, or the call itself failing) through the same catch-and-print
 * path every command below uses. Returns null on either failure; callers
 * only need to check that against their success type, which is never itself
 * null.
 */
async function withDaemon<T>(
  options: WatchCommandOptions,
  writeErr: (line: string) => void,
  fn: (location: DaemonLocation) => Promise<T>
): Promise<T | null> {
  let location: DaemonLocation;
  try {
    location = await locateDaemon({ lgtmDir: options.lgtmDir, isAlive: options.isAlive });
  } catch (err) {
    writeErr(describeCliError(err));
    return null;
  }

  try {
    return await fn(location);
  } catch (err) {
    writeErr(describeCliError(err));
    return null;
  }
}

export async function runWatchAdd(input: string, options: WatchCommandOptions = {}): Promise<number> {
  const { write, writeErr } = writers(options);

  const parsed = parseOwnerRepo(input);
  if (!parsed) {
    writeErr(`"${input}" is not a repository. Use owner/repo, e.g. acme/api.`);
    return 1;
  }

  const result: AddWatchResult | null = await withDaemon(options, writeErr, (location) =>
    addWatch(location, parsed.owner, parsed.repo, { fetchImpl: options.fetchImpl })
  );
  if (!result) return 1;

  // `added` is false when the repo was already on the watch list — the
  // backfill still ran and reconciled against known PRs (R9.5), it just
  // added nothing new to `watch.md`.
  write(
    result.added
      ? `Added ${result.owner}/${result.repo} to the watch list.`
      : `${result.owner}/${result.repo} was already on the watch list; reconciled its backfill.`
  );
  write(formatBackfillSummary(result.backfill));
  return 0;
}

export async function runWatchRemove(input: string, options: WatchCommandOptions = {}): Promise<number> {
  const { write, writeErr } = writers(options);

  const parsed = parseOwnerRepo(input);
  if (!parsed) {
    writeErr(`"${input}" is not a repository. Use owner/repo, e.g. acme/api.`);
    return 1;
  }

  const removed: boolean | null = await withDaemon(options, writeErr, (location) =>
    removeWatch(location, parsed.owner, parsed.repo, { fetchImpl: options.fetchImpl })
  );
  if (removed === null) return 1;

  write(
    removed
      ? `Removed ${parsed.owner}/${parsed.repo} from the watch list. Its on-disk reviews are kept.`
      : `${parsed.owner}/${parsed.repo} was not on the watch list.`
  );
  return 0;
}

export async function runWatchList(options: WatchCommandOptions = {}): Promise<number> {
  const { write, writeErr } = writers(options);

  const entries: WatchEntry[] | null = await withDaemon(options, writeErr, (location) =>
    getWatchList(location, { fetchImpl: options.fetchImpl })
  );
  if (!entries) return 1;

  if (entries.length === 0) {
    write("No repositories are being watched.");
    return 0;
  }

  for (const entry of entries) {
    const polled = entry.lastPolledAt ? `last polled ${entry.lastPolledAt}` : "never polled";
    write(`${entry.owner}/${entry.repo}  (${polled})`);
  }
  return 0;
}

function formatBackfillSummary(backfill: BackfillEntry[]): string {
  if (backfill.length === 0) return "No open PRs to backfill.";
  const preSelected = backfill.filter((pr) => pr.preSelected).length;
  return (
    `Backfilled ${backfill.length} open PR${backfill.length === 1 ? "" : "s"} ` +
    `(${preSelected} pre-selected for auto-review). Run \`lgtm open\` to confirm.`
  );
}

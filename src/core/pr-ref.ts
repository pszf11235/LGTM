/**
 * PR references on the command line.
 *
 * One store holds reviews for every repository, so a bare number is ambiguous
 * in principle. It is still what people type, so it is accepted and resolved
 * against the store, and an ambiguous one fails with the exact commands to
 * disambiguate rather than guessing.
 *
 *   lgtm review post owner/repo#42   explicit, always works
 *   lgtm review post 42              resolved, when only one repo has a 42
 */

import type { PRRef, RepoRef } from "./types";
import { listReviewedPRs } from "../store/reviews";
import { loadWatchList } from "../store/watch-list";

export type { PRRef };

export interface ParsedRef {
  owner?: string;
  repo?: string;
  number: number;
}

/** A reference that could not be resolved, with something actionable to say. */
export interface RefError {
  error: string;
  /** Candidate references, when the problem was ambiguity. */
  candidates?: PRRef[];
}

/** `owner/repo#42`, `owner/repo/42`, a GitHub URL, or a bare `42`. */
export function parsePrRef(input: string): ParsedRef | RefError {
  const raw = input.trim();
  if (!raw) return { error: "no pull request given" };

  // A full GitHub URL, since people paste those.
  const url = raw.match(/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/i);
  if (url) {
    return { owner: url[1], repo: url[2], number: Number(url[3]) };
  }

  // owner/repo#42 or owner/repo/42
  const qualified = raw.match(/^([\w.-]+)\/([\w.-]+)(?:#|\/)(\d+)$/);
  if (qualified) {
    return { owner: qualified[1], repo: qualified[2], number: Number(qualified[3]) };
  }

  // #42 or 42
  const bare = raw.match(/^#?(\d+)$/);
  if (bare) {
    return { number: Number(bare[1]) };
  }

  return {
    error: `could not read "${input}" as a pull request. Use owner/repo#42, a GitHub URL, or just 42`,
  };
}

export function formatRef(ref: PRRef): string {
  return `${ref.owner}/${ref.repo}#${ref.number}`;
}

/**
 * Resolve a reference to exactly one PR.
 *
 * A bare number is matched against reviews on disk first, then against the
 * watch list. Reviews come first because a number the user just reviewed is
 * almost certainly the one they mean, and it is the only source that can
 * confirm the PR actually exists.
 */
export async function resolvePrRef(lgtmDir: string, input: string): Promise<PRRef | RefError> {
  const parsed = parsePrRef(input);
  if ("error" in parsed) return parsed;

  if (parsed.owner && parsed.repo) {
    return { owner: parsed.owner, repo: parsed.repo, number: parsed.number };
  }

  const reviewed = (await listReviewedPRs(lgtmDir)).filter((r) => r.number === parsed.number);

  if (reviewed.length === 1) return reviewed[0];

  if (reviewed.length > 1) {
    return {
      error: `#${parsed.number} is ambiguous, ${reviewed.length} repos have one`,
      candidates: reviewed,
    };
  }

  // Nothing reviewed. A watched repo is a reasonable guess only when there is
  // exactly one, otherwise we would be picking for the user.
  const watched = await loadWatchList(lgtmDir);

  if (watched.length === 1) {
    return { owner: watched[0].owner, repo: watched[0].repo, number: parsed.number };
  }

  if (watched.length > 1) {
    return {
      error: `#${parsed.number} has no review on disk, and ${watched.length} repos are watched, so it is unclear which you mean`,
      candidates: watched.map((w) => ({ owner: w.owner, repo: w.repo, number: parsed.number })),
    };
  }

  return {
    error: `#${parsed.number} has no review on disk and no repos are watched. Use owner/repo#${parsed.number}`,
  };
}

/**
 * Render a resolution failure as lines to print, including the exact commands
 * that would work. An error that lists candidates without showing how to use
 * them just makes the user retype guesses.
 */
export function describeRefError(err: RefError, command = "lgtm review post"): string[] {
  const lines = [err.error];

  if (err.candidates && err.candidates.length > 0) {
    lines.push("");
    for (const candidate of err.candidates) {
      lines.push(`  ${command} ${formatRef(candidate)}`);
    }
  }

  return lines;
}

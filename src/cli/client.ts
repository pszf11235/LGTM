/**
 * The CLI's half of the daemon's HTTP API: how a short-lived `lgtm status` /
 * `lgtm open` / `lgtm watch` invocation finds the running daemon and talks
 * to it (design.md, "Architecture": "short-lived CLI invocations that talk
 * to it over HTTP"; "HTTP API").
 *
 * Finding the daemon is two local file reads, not a network probe:
 * `daemon.json` for the port and pid (rendezvous.ts), and `token` for the
 * bearer token. Both are store files the daemon itself writes; this module
 * only reads them; only the daemon writes the store (R9.4), and the token
 * belongs to the daemon's own minting logic in rendezvous.ts's
 * `ensureToken`, so this module never mints one. A CLI running against a
 * store that has never had a daemon start gives a clear "not running"
 * message instead, same as one running against a store whose daemon just
 * crashed.
 *
 * Every network failure below is translated before it reaches a command:
 * a bare `fetch` throw (Node/Bun's ECONNREFUSED is a `TypeError: fetch
 * failed` with the useful part buried in `.cause`) becomes
 * `DaemonNotRunningError`, and a 401 becomes `DaemonAuthError` with the
 * same "run `lgtm open`" guidance design.md gives the browser UI for a bad
 * token. Commands only ever need to catch-and-print `err.message`.
 */

import fs from "fs/promises";
import type { Classification } from "@/core";
import { isPidAlive, readDaemonInfo, tokenPath } from "../daemon/rendezvous";
import { getStorePath } from "../store/paths";
import type { WatchEntry } from "../store/watch-list";

export type { WatchEntry };

// ─── Locating the daemon ────────────────────────────────────────────────────

export interface DaemonLocation {
  port: number;
  pid: number;
  /** ISO timestamp, from daemon.json. */
  startedAt: string;
  token: string;
}

const NOT_RUNNING_MESSAGE =
  "lgtm daemon is not running. Start it in the foreground with `lgtm up`, " +
  "or install it as a background service with `lgtm install`.";

export class DaemonNotRunningError extends Error {
  constructor(message: string = NOT_RUNNING_MESSAGE) {
    super(message);
    this.name = "DaemonNotRunningError";
  }
}

/** A request reached the daemon but its token was not accepted (design.md, "HTTP API"). */
export class DaemonAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DaemonAuthError";
  }
}

export interface LocateDaemonOptions {
  lgtmDir?: string;
  /** Injectable for tests; defaults to the real signal-0 check from rendezvous.ts. */
  isAlive?: (pid: number) => boolean;
}

/**
 * Mirrors rendezvous.ts's private `readExistingToken`: an empty or missing
 * file both read as "no token", never a deliberate empty one. Not imported
 * from there because that function's other half, minting, is exactly what
 * this module must not do.
 */
async function readTokenFile(lgtmDir: string): Promise<string | null> {
  let raw: string;
  try {
    raw = await fs.readFile(tokenPath(lgtmDir), "utf-8");
  } catch {
    return null;
  }
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Find the running daemon, or throw `DaemonNotRunningError` with something
 * a user can act on.
 *
 * Three ways this fails, all reported the same way because none of them are
 * a user's problem to distinguish: no `daemon.json` (never started, or a
 * clean `lgtm up` shutdown removed it), a `daemon.json` naming a dead pid
 * (crashed without cleanup), or a missing `token` file (a hand-edited or
 * partially-initialized store — the daemon writes this on first boot, so a
 * live daemon always has one).
 */
export async function locateDaemon(options: LocateDaemonOptions = {}): Promise<DaemonLocation> {
  const lgtmDir = options.lgtmDir ?? getStorePath();
  const isAlive = options.isAlive ?? isPidAlive;

  const info = await readDaemonInfo(lgtmDir);
  if (!info || !isAlive(info.pid)) {
    throw new DaemonNotRunningError();
  }

  const token = await readTokenFile(lgtmDir);
  if (!token) {
    throw new DaemonNotRunningError(
      `${tokenPath(lgtmDir)} is missing or empty. The daemon writes it on first run — restart it with \`lgtm up\`.`
    );
  }

  return { port: info.port, pid: info.pid, startedAt: info.startedAt, token };
}

/** `http://127.0.0.1:<port>`, no trailing slash. */
export function daemonBaseUrl(location: DaemonLocation): string {
  return `http://127.0.0.1:${location.port}`;
}

// ─── Requests ───────────────────────────────────────────────────────────────

/** Alias so command modules don't each spell out `typeof fetch`. */
export type FetchLike = typeof fetch;

export interface RequestOptions {
  /** Injectable for tests; defaults to the global `fetch`. */
  fetchImpl?: FetchLike;
}

interface RequestSpec {
  method: "GET" | "POST" | "DELETE";
  body?: string;
}

async function requestJson(
  location: DaemonLocation,
  path: string,
  spec: RequestSpec,
  options: RequestOptions
): Promise<unknown> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const url = `${daemonBaseUrl(location)}${path}`;

  let res: Response;
  try {
    res = await fetchImpl(url, {
      method: spec.method,
      body: spec.body,
      headers: {
        ...(spec.body ? { "Content-Type": "application/json" } : {}),
        Authorization: `Bearer ${location.token}`,
      },
    });
  } catch {
    // The daemon.json this location came from may already be stale — the
    // pid can be alive while something else entirely, or nothing, holds the
    // port. Either way the raw fetch error (a bare "fetch failed") has
    // nothing a user can act on; the guidance does.
    throw new DaemonNotRunningError(`could not reach the lgtm daemon at ${url}. ${NOT_RUNNING_MESSAGE}`);
  }

  if (res.status === 401) {
    throw new DaemonAuthError("lgtm daemon rejected this request's token. Run `lgtm open` to reauthenticate.");
  }

  if (!res.ok) {
    throw new Error(`lgtm daemon returned ${res.status} ${res.statusText} for ${path}: ${await describeErrorBody(res)}`);
  }

  return await res.json();
}

/**
 * Every non-2xx from src/api/routes.ts is `{error: "<code>", message: "<text>"}`
 * (its `fail` helper). Prefer that `message` when the body parses; fall back
 * to the raw text for a response this client didn't generate.
 */
async function describeErrorBody(res: Response): Promise<string> {
  const text = await res.text().catch(() => "");
  if (!text) return "(no body)";
  try {
    const parsed: unknown = JSON.parse(text);
    if (isRecord(parsed) && typeof parsed.message === "string") return parsed.message;
  } catch {
    // Not JSON — fall through to the raw text.
  }
  return text;
}

/** Every command catches errors from this module the same way: print the message, exit 1. */
export function describeCliError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Unauthenticated: design.md, "HTTP API" table. Used only to sanity-check reachability before opening a browser tab. */
export async function checkHealth(location: DaemonLocation, options: RequestOptions = {}): Promise<boolean> {
  const fetchImpl = options.fetchImpl ?? fetch;
  try {
    const res = await fetchImpl(`${daemonBaseUrl(location)}/api/health`);
    if (!res.ok) return false;
    const data = await res.json().catch(() => null);
    return isRecord(data) && data.app === "lgtm";
  } catch {
    return false;
  }
}

// ─── Parsing helpers ────────────────────────────────────────────────────────
//
// Responses come from our own daemon, not an adversary, but they still cross
// a process boundary and a JSON.parse — the same reason watch-list.ts's
// loadWatchList filters rather than trusts. A malformed field becomes one
// clear error, not a `Cannot read properties of undefined` three call frames
// into a formatter.

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function malformed(kind: string): Error {
  return new Error(`lgtm daemon returned a malformed ${kind} response`);
}

// ─── /api/status ────────────────────────────────────────────────────────────
//
// This mirrors src/api/routes.ts's actual `status` handler (the tray
// contract, design.md's "HTTP API"; ADR 0003), not an independently
// invented shape: `scheduler` is `SchedulerStatus` (daemon/scheduler.ts)
// verbatim, `queue` is a `QueueSnapshot` (daemon/queue.ts), `quota` is a
// `QuotaState` (daemon/quota.ts). Only the slice this CLI's `status`
// command displays is parsed out below; everything else the real payload
// carries (`repos`, `binaries`, `github`, the top-level per-cycle
// `lastCycle`) is parsed by nothing here and so is silently ignored, on
// purpose — a new field on that response must never break this client.

export type QuotaModeStatus = "ok" | "throttled" | "fallback";

export interface CycleOutcomeStatus {
  status: "ok" | "failed";
  error: string | null;
}

interface SchedulerSlice {
  lastCycleAt: string | null;
  lastCycleOutcome: CycleOutcomeStatus | null;
  nextCycleAt: string | null;
}

/** The slice of `GET /api/status` this CLI's `status` command renders. */
export interface DaemonStatusPayload {
  pid: number;
  /** ISO timestamp. */
  startedAt: string;
  uptimeMs: number;
  /** Null when the daemon reports no scheduler (a minimal test wiring; a real `lgtm up` always has one). */
  scheduler: SchedulerSlice | null;
  queue: { queued: number; inFlight: number } | null;
  quota: { mode: QuotaModeStatus; maxPercent: number | null } | null;
  counts: { awaitingGate: number; triage: number };
}

function parseCycleOutcome(value: unknown): CycleOutcomeStatus | null {
  if (!isRecord(value)) return null;
  const status = asString(value.status);
  if (status !== "ok" && status !== "failed") return null;
  return { status, error: asString(value.error) };
}

function parseSchedulerSlice(value: unknown): SchedulerSlice | null {
  if (!isRecord(value)) return null;
  return {
    lastCycleAt: asString(value.lastCycleAt),
    lastCycleOutcome: parseCycleOutcome(value.lastCycleOutcome),
    nextCycleAt: asString(value.nextCycleAt),
  };
}

function parseQueueSlice(value: unknown): { queued: number; inFlight: number } | null {
  if (!isRecord(value)) return null;
  const queued = asNumber(value.queued);
  const inFlight = asNumber(value.inFlight);
  if (queued === null || inFlight === null) return null;
  return { queued, inFlight };
}

function parseQuotaSlice(value: unknown): { mode: QuotaModeStatus; maxPercent: number | null } | null {
  if (!isRecord(value)) return null;
  const mode = asString(value.mode);
  if (mode !== "ok" && mode !== "throttled" && mode !== "fallback") return null;
  return { mode, maxPercent: asNumber(value.maxPercent) };
}

function parseCountsSlice(value: unknown): { awaitingGate: number; triage: number } {
  const awaitingGate = isRecord(value) ? asNumber(value.awaitingGate) : null;
  const triage = isRecord(value) ? asNumber(value.triage) : null;
  if (awaitingGate === null || triage === null) throw malformed("status");
  return { awaitingGate, triage };
}

function parseStatusPayload(data: unknown): DaemonStatusPayload {
  if (!isRecord(data)) throw malformed("status");

  const pid = asNumber(data.pid);
  const startedAt = asString(data.startedAt);
  const uptimeMs = asNumber(data.uptimeMs);
  if (pid === null || !startedAt || uptimeMs === null) throw malformed("status");

  return {
    pid,
    startedAt,
    uptimeMs,
    scheduler: parseSchedulerSlice(data.scheduler),
    queue: parseQueueSlice(data.queue),
    quota: parseQuotaSlice(data.quota),
    counts: parseCountsSlice(data.counts),
  };
}

export async function getStatus(location: DaemonLocation, options: RequestOptions = {}): Promise<DaemonStatusPayload> {
  const data = await requestJson(location, "/api/status", { method: "GET" }, options);
  return parseStatusPayload(data);
}

// ─── /api/watchlist ─────────────────────────────────────────────────────────

function parseWatchEntry(value: unknown): WatchEntry | null {
  if (!isRecord(value)) return null;
  const owner = asString(value.owner);
  const repo = asString(value.repo);
  const addedAt = asString(value.addedAt);
  if (!owner || !repo || !addedAt) return null;
  return {
    owner,
    repo,
    addedAt,
    lastPolledAt: asString(value.lastPolledAt) ?? undefined,
    etag: asString(value.etag) ?? undefined,
  };
}

export async function getWatchList(location: DaemonLocation, options: RequestOptions = {}): Promise<WatchEntry[]> {
  const data = await requestJson(location, "/api/watchlist", { method: "GET" }, options);
  if (!isRecord(data) || !Array.isArray(data.repos)) throw malformed("watchlist");
  return data.repos.map(parseWatchEntry).filter((entry): entry is WatchEntry => entry !== null);
}

/**
 * One row of the backfill list a `POST /api/watchlist` returns — a slice of
 * `src/api/routes.ts`'s `backfillRow` (design.md, "HTTP API": "returns the
 * backfill list with metadata and pre-selection"). That row carries triage
 * metadata (additions, mergeable, checks, ...) for the web UI's confirm
 * pane; `lgtm watch add`'s one-line summary only needs these fields, so
 * only these are parsed out.
 */
export interface BackfillEntry {
  /** The canonical `owner/repo#42` key. */
  key: string;
  title: string;
  url: string;
  author: string;
  classification: Classification;
  autoClass: boolean;
  /** Auto-class PRs arrive pre-selected for review (R2.6); the confirm step lives in the web UI. */
  preSelected: boolean;
}

export interface AddWatchResult {
  owner: string;
  repo: string;
  /** False when the repo was already watched — the backfill still ran and reconciled (R9.5). */
  added: boolean;
  backfill: BackfillEntry[];
}

function parseBackfillEntry(value: unknown): BackfillEntry | null {
  if (!isRecord(value)) return null;
  const key = asString(value.key);
  const title = asString(value.title);
  const url = asString(value.url);
  const author = asString(value.author);
  const classification = asString(value.classification);
  if (!key || !title || !url || !author || !classification) return null;
  return {
    key,
    title,
    url,
    author,
    classification: classification as Classification,
    autoClass: value.autoClass === true,
    preSelected: value.preSelected === true,
  };
}

export async function addWatch(
  location: DaemonLocation,
  owner: string,
  repo: string,
  options: RequestOptions = {}
): Promise<AddWatchResult> {
  const data = await requestJson(
    location,
    "/api/watchlist",
    { method: "POST", body: JSON.stringify({ owner, repo }) },
    options
  );
  if (!isRecord(data) || typeof data.added !== "boolean") throw malformed("watchlist");
  const repoField = data.repo;
  const outOwner = isRecord(repoField) ? asString(repoField.owner) : null;
  const outRepo = isRecord(repoField) ? asString(repoField.repo) : null;
  if (!outOwner || !outRepo) throw malformed("watchlist");

  const entriesRaw = Array.isArray(data.entries) ? data.entries : [];
  const backfill = entriesRaw.map(parseBackfillEntry).filter((entry): entry is BackfillEntry => entry !== null);
  return { owner: outOwner, repo: outRepo, added: data.added, backfill };
}

export async function removeWatch(
  location: DaemonLocation,
  owner: string,
  repo: string,
  options: RequestOptions = {}
): Promise<boolean> {
  const data = await requestJson(
    location,
    "/api/watchlist",
    { method: "DELETE", body: JSON.stringify({ owner, repo }) },
    options
  );
  if (!isRecord(data) || typeof data.removed !== "boolean") throw malformed("watchlist");
  return data.removed;
}

/**
 * `lgtm status`: daemon liveness, last cycle, queue depth, quota, and
 * gate/triage counts, read from the running daemon over HTTP (design.md,
 * "HTTP API", `/api/status`; requirements R7.4).
 *
 * Exits non-zero whenever the daemon can't be reached — that's the whole
 * reason R7.4 calls this command out as scriptable into a shell prompt. A
 * prompt only reads the exit code, so `locateDaemon` and `getStatus`
 * failing the same way (a caught error, never a thrown one) is what makes
 * that safe to rely on.
 */
import type { FetchLike } from "./client";
import { type DaemonStatusPayload, describeCliError, getStatus, locateDaemon } from "./client";

export interface StatusCommandOptions {
  lgtmDir?: string;
  fetchImpl?: FetchLike;
  /** Injectable for tests; defaults to the real signal-0 check. */
  isAlive?: (pid: number) => boolean;
  write?: (line: string) => void;
  writeErr?: (line: string) => void;
}

export async function runStatus(options: StatusCommandOptions = {}): Promise<number> {
  const write = options.write ?? defaultWrite;
  const writeErr = options.writeErr ?? defaultWriteErr;

  let location;
  try {
    location = await locateDaemon({ lgtmDir: options.lgtmDir, isAlive: options.isAlive });
  } catch (err) {
    writeErr(describeCliError(err));
    return 1;
  }

  let status: DaemonStatusPayload;
  try {
    status = await getStatus(location, { fetchImpl: options.fetchImpl });
  } catch (err) {
    writeErr(describeCliError(err));
    return 1;
  }

  for (const line of formatStatus(status)) write(line);
  return 0;
}

function defaultWrite(line: string): void {
  console.log(line);
}

function defaultWriteErr(line: string): void {
  console.error(line);
}

function formatStatus(status: DaemonStatusPayload): string[] {
  return [
    `lgtm daemon: running (pid ${status.pid}, up ${formatDuration(status.uptimeMs)})`,
    `last cycle: ${formatLastCycle(status.scheduler)}`,
    `next cycle: ${status.scheduler?.nextCycleAt ?? "not scheduled"}`,
    `queue: ${formatQueue(status.queue)}`,
    `quota: ${formatQuota(status.quota)}`,
    `awaiting gate: ${status.counts.awaitingGate}`,
    `triage: ${status.counts.triage}`,
  ];
}

function formatLastCycle(scheduler: DaemonStatusPayload["scheduler"]): string {
  const outcome = scheduler?.lastCycleOutcome ?? null;
  if (!scheduler?.lastCycleAt || !outcome) return "none yet";
  const detail = outcome.status === "failed" && outcome.error ? ` (${outcome.error})` : "";
  return `${outcome.status} at ${scheduler.lastCycleAt}${detail}`;
}

function formatQueue(queue: DaemonStatusPayload["queue"]): string {
  if (!queue) return "unknown";
  return `${queue.queued} queued, ${queue.inFlight} in flight`;
}

function formatQuota(quota: DaemonStatusPayload["quota"]): string {
  if (!quota) return "unknown";
  return quota.maxPercent === null ? quota.mode : `${quota.mode} (max ${quota.maxPercent}% used)`;
}

/** `2d 3h 41m`-style, truncated to the units that matter at daemon-uptime scale. */
function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);

  const parts: string[] = [];
  if (days > 0) parts.push(`${days}d`);
  if (days > 0 || hours > 0) parts.push(`${hours}h`);
  parts.push(`${minutes}m`);
  return parts.join(" ");
}

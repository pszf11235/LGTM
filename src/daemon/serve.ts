/**
 * The production bind: the one place the daemon and the HTTP API meet.
 *
 * `boot.ts` deliberately knows nothing about `@/api`. It picks a port and
 * hands `bind` everything a server could need, which keeps the dependency
 * pointing one way and lets every boot test run without opening a socket.
 * This module is the other half, and `lgtm up` is its only caller.
 *
 * Without it the daemon still boots, still polls, and still reviews, but its
 * default handler answers 503 on every route except health. That is a real
 * state worth keeping distinguishable, not a bug.
 */
import { startApiServer } from "@/api/server";
import { loadConfig, updateConfig } from "@/store/config";
import type { Bind, BoundServer } from "./boot";

function isAddressInUse(error: unknown): boolean {
  if ((error as NodeJS.ErrnoException | null)?.code === "EADDRINUSE") return true;
  return error instanceof Error && /EADDRINUSE|address already in use/i.test(error.message);
}

/**
 * Mount the real API, and the SPA shell it serves, on the port the daemon
 * chose.
 *
 * The server is built per attempt rather than once, because the API checks the
 * Host header against the port it is actually serving. A handler built for
 * 4747 and then served on 4748 would reject every request it received.
 */
export function apiBind(): Bind {
  return async (port, context): Promise<BoundServer | null> => {
    try {
      const server = startApiServer({
        lgtmDir: context.lgtmDir,
        token: context.token,
        port,
        version: context.version,
        pid: context.pid,
        forge: context.forge,
        queue: context.queue,
        events: context.events,
        scheduler: context.scheduler,
        quota: context.quota,
        binaries: context.binaries,
        lastCycle: context.lastCycle,
        githubToken: context.githubToken,
        config: { load: loadConfig, update: updateConfig },
        // Settings changes reach the running daemon rather than waiting for a
        // restart. QuotaThresholds is structurally a subset of Config, and the
        // scheduler clamps a nonsensical interval to its default rather than
        // disabling itself or spinning.
        onConfigChange: (config) => {
          context.scheduler.setIntervalMinutes(config.interval_minutes);
          context.quota.setThresholds({
            pause_above_pct: config.pause_above_pct,
            resume_below_pct: config.resume_below_pct,
            daily_cap: config.daily_cap,
          });
        },
      });
      return { port: server.port, stop: () => server.stop() };
    } catch (error) {
      // A taken port is the scan's next step, not a failure.
      if (isAddressInUse(error)) return null;
      throw error;
    }
  };
}

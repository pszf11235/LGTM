/**
 * `lgtm open`: launches the browser at the daemon's web UI, authenticated.
 *
 * The bearer token rides in the URL fragment (`#t=<token>`), never a query
 * string (design.md, "HTTP API": "the token goes in the FRAGMENT, never the
 * query string, because fragments are not sent to servers and do not land
 * in logs"; requirements R7.2). That property only holds if this module
 * never puts the token anywhere else either — it is never printed, and
 * `checkHealth` below hits `/api/health` with no auth at all before the URL
 * is even built, so a stale `daemon.json` fails with a plain "not
 * responding" message instead of launching a browser tab to nothing.
 */
import { checkHealth, type DaemonLocation, daemonBaseUrl, describeCliError, type FetchLike, locateDaemon } from "./client";

/** Launches a URL in the user's default browser. Injectable so tests never spawn a real one. */
export type BrowserLauncher = (url: string) => Promise<void>;

export interface OpenCommandOptions {
  lgtmDir?: string;
  fetchImpl?: FetchLike;
  /** Injectable for tests; defaults to the real signal-0 check. */
  isAlive?: (pid: number) => boolean;
  launch?: BrowserLauncher;
  write?: (line: string) => void;
  writeErr?: (line: string) => void;
}

/** `http://127.0.0.1:<port>/#t=<token>` — see the module doc for why the token lives here and nowhere else. */
export function buildOpenUrl(location: DaemonLocation): string {
  return `${daemonBaseUrl(location)}/#t=${location.token}`;
}

const defaultLaunch: BrowserLauncher = async (url) => {
  // v1 is macOS-only (requirements.md, "Premise"), so `open` is always at
  // /usr/bin/open — no binary-resolution dance like binaries.ts runs for
  // claude/gh is needed for a command this fixed.
  const proc = Bun.spawn(["open", url], { stdout: "ignore", stderr: "ignore" });
  const code = await proc.exited;
  if (code !== 0) throw new Error(`\`open\` exited with code ${code}`);
};

export async function runOpen(options: OpenCommandOptions = {}): Promise<number> {
  const write = options.write ?? defaultWrite;
  const writeErr = options.writeErr ?? defaultWriteErr;
  const launch = options.launch ?? defaultLaunch;

  let location: DaemonLocation;
  try {
    location = await locateDaemon({ lgtmDir: options.lgtmDir, isAlive: options.isAlive });
  } catch (err) {
    writeErr(describeCliError(err));
    return 1;
  }

  const healthy = await checkHealth(location, { fetchImpl: options.fetchImpl });
  if (!healthy) {
    writeErr(
      `lgtm daemon at 127.0.0.1:${location.port} is not responding. ` +
        "It may have crashed without cleaning up after itself — try `lgtm up` again."
    );
    return 1;
  }

  const url = buildOpenUrl(location);
  // Only the origin is shown to the user; the fragment (and the token in
  // it) is never printed, matching why design.md put it in the fragment in
  // the first place — nowhere it might get logged or scrolled past in a
  // terminal.
  write(`Opening the LGTM UI at http://127.0.0.1:${location.port}/ ...`);

  try {
    await launch(url);
  } catch (err) {
    writeErr(`could not launch a browser: ${describeCliError(err)}`);
    return 1;
  }

  return 0;
}

function defaultWrite(line: string): void {
  console.log(line);
}

function defaultWriteErr(line: string): void {
  console.error(line);
}

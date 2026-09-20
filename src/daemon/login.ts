/**
 * The CLI's sign-in flow, driven from the UI.
 *
 * `claude auth login` opens the browser itself, prints the authorize URL in
 * case it could not, and then waits on stdin for the code the callback page
 * shows. That last step is why a button alone was never enough: something has
 * to hand the code back, and a page with no terminal behind it cannot.
 *
 * So the daemon keeps the process alive between the two halves. Start captures
 * the URL and leaves the CLI waiting; submit writes the code to its stdin and
 * waits for it to finish. Whether it worked is then decided by asking
 * `claude auth status` rather than by trusting an exit code, because the
 * question the user actually has is "am I signed in", and only one thing
 * answers that.
 *
 * What LGTM sees is the authorize URL and a one-time code on its way past. The
 * credential itself is written by the CLI into its own store, and this daemon
 * neither reads nor keeps it.
 */
export type LoginSpawn = (cmd: string[]) => LoginProcess;

/** The parts of a spawned process this module uses. Injected in tests. */
export interface LoginProcess {
  stdout: ReadableStream<Uint8Array> | null;
  stdin: { write(chunk: string): void; end(): void } | null;
  exited: Promise<number>;
  kill(): void;
}

export interface LoginStart {
  status: "waiting-for-code" | "failed";
  /** The authorize URL, so the UI can offer it when the browser did not open. */
  url: string | null;
  /** What to run by hand instead, always present. */
  command: string;
  error: string | null;
}

export interface LoginSubmit {
  status: "signed-in" | "failed";
  error: string | null;
}

export interface LoginSessionOptions {
  binPath: string | null;
  spawn: LoginSpawn;
  /** Asked after the code is submitted. The only thing that decides success. */
  isSignedIn: () => Promise<boolean>;
  /** Abandoned logins are killed rather than left holding a process. */
  timeoutMs?: number;
  setTimer?: (fn: () => void, ms: number) => () => void;
  log?: (line: string) => void;
}

export const LOGIN_TIMEOUT_MS = 5 * 60 * 1000;

/** The URL the CLI prints when it cannot open a browser, or alongside doing so. */
const URL_PATTERN = /https:\/\/\S*oauth\S*/i;

function defaultSetTimer(fn: () => void, ms: number): () => void {
  const handle = setTimeout(fn, ms);
  (handle as unknown as { unref?: () => void }).unref?.();
  return () => clearTimeout(handle);
}

export interface LoginSession {
  /** Spawn the CLI and read far enough to find the URL. Idempotent while waiting. */
  start(): Promise<LoginStart>;
  /** Hand the code to the waiting CLI. Fails when nothing is waiting. */
  submit(code: string): Promise<LoginSubmit>;
  /** Kill an abandoned flow. Safe to call when nothing is running. */
  cancel(): void;
  readonly waiting: boolean;
}

export function createLoginSession(options: LoginSessionOptions): LoginSession {
  const bin = options.binPath ?? "claude";
  const command = `${bin} auth login`;
  const setTimer = options.setTimer ?? defaultSetTimer;
  const log = options.log ?? (() => {});

  let active: LoginProcess | null = null;
  let cancelTimer: (() => void) | null = null;

  function clear(): void {
    cancelTimer?.();
    cancelTimer = null;
    active = null;
  }

  function cancel(): void {
    if (!active) return;
    log("login: abandoning the sign-in flow");
    try {
      active.kill();
    } catch {
      // Already gone. Nothing to clean up but the handle.
    }
    clear();
  }

  /** Read stdout until the URL shows up, the stream ends, or the deadline passes. */
  async function readUrl(proc: LoginProcess): Promise<string | null> {
    if (!proc.stdout) return null;
    const reader = proc.stdout.getReader();
    const decoder = new TextDecoder();
    let seen = "";

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        seen += decoder.decode(value, { stream: true });
        const match = URL_PATTERN.exec(seen);
        // The CLI keeps the stream open while it waits for the code, so
        // stopping at the first match is what hands control back rather than
        // blocking until the flow is over.
        if (match) return match[0];
      }
    } finally {
      reader.releaseLock();
    }
    return null;
  }

  return {
    get waiting(): boolean {
      return active !== null;
    },

    async start(): Promise<LoginStart> {
      // A second start while one waits would orphan the first process and its
      // code, leaving the user pasting into something nobody is listening to.
      if (active) {
        return { status: "waiting-for-code", url: null, command, error: null };
      }

      let proc: LoginProcess;
      try {
        proc = options.spawn([bin, "auth", "login"]);
      } catch (error) {
        return {
          status: "failed",
          url: null,
          command,
          error: error instanceof Error ? error.message : String(error),
        };
      }

      active = proc;
      cancelTimer = setTimer(() => {
        log("login: no code arrived in time");
        cancel();
      }, options.timeoutMs ?? LOGIN_TIMEOUT_MS);

      const url = await readUrl(proc);
      if (url === null) {
        // The CLI ended without asking for anything, which means it failed
        // rather than that it is waiting.
        clear();
        return { status: "failed", url: null, command, error: "the CLI exited without asking for a code" };
      }

      return { status: "waiting-for-code", url, command, error: null };
    },

    async submit(code: string): Promise<LoginSubmit> {
      const proc = active;
      if (!proc) return { status: "failed", error: "no sign-in is waiting for a code" };

      const trimmed = code.trim();
      if (!trimmed) return { status: "failed", error: "the code is empty" };

      try {
        proc.stdin?.write(`${trimmed}\n`);
        proc.stdin?.end();
        await proc.exited;
      } catch (error) {
        clear();
        return { status: "failed", error: error instanceof Error ? error.message : String(error) };
      }

      clear();

      // The exit code is not the question. Ask the thing that knows.
      const signedIn = await options.isSignedIn();
      return signedIn
        ? { status: "signed-in", error: null }
        : { status: "failed", error: "the CLI finished but is still not signed in" };
    },

    cancel,
  };
}

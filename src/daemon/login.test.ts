import { describe, test, expect } from "bun:test";
import { createLoginSession, type LoginProcess, type LoginSpawn } from "./login";

const URL = "https://claude.com/cai/oauth/authorize?code=true&client_id=abc&state=xyz";

/** A stand-in for the CLI: prints what it prints, then waits on stdin. */
function fakeCLI(
  lines: string[],
  opts: { exitCode?: number; endAfterPrint?: boolean } = {}
): { proc: LoginProcess; written: string[]; killed: () => boolean } {
  const written: string[] = [];
  let killed = false;
  let finish: (code: number) => void = () => {};
  const exited = new Promise<number>((resolve) => {
    finish = resolve;
  });

  const stdout = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const line of lines) controller.enqueue(new TextEncoder().encode(line));
      // The real CLI holds the stream open while it waits for the code.
      if (opts.endAfterPrint) controller.close();
    },
  });

  return {
    written,
    killed: () => killed,
    proc: {
      stdout,
      stdin: {
        write: (chunk: string) => {
          written.push(chunk);
          // Writing the code is what lets it finish.
          finish(opts.exitCode ?? 0);
        },
        end: () => {},
      },
      exited,
      kill: () => {
        killed = true;
        finish(130);
      },
    },
  };
}

function session(
  cli: { proc: LoginProcess },
  over: { isSignedIn?: () => Promise<boolean>; binPath?: string | null } = {}
) {
  const spawn: LoginSpawn = () => cli.proc;
  return createLoginSession({
    binPath: over.binPath ?? "/opt/homebrew/bin/claude",
    spawn,
    isSignedIn: over.isSignedIn ?? (async () => true),
    setTimer: () => () => {},
  });
}

describe("createLoginSession", () => {
  test("hands back the authorize URL and keeps the CLI waiting", async () => {
    const cli = fakeCLI(["Opening browser to sign in…\n", `If the browser didn't open, visit: ${URL}\n`]);
    const s = session(cli);

    const started = await s.start();

    expect(started.status).toBe("waiting-for-code");
    expect(started.url).toBe(URL);
    expect(started.command).toBe("/opt/homebrew/bin/claude auth login");
    // Still waiting, which is the point: the code has nowhere to go otherwise.
    expect(s.waiting).toBe(true);
  });

  test("the code reaches the CLI's stdin, newline and all", async () => {
    const cli = fakeCLI([`visit: ${URL}\n`]);
    const s = session(cli);
    await s.start();

    const result = await s.submit("  code-from-the-callback-page  ");

    expect(result.status).toBe("signed-in");
    // Trimmed, because a pasted code carries whitespace, and terminated,
    // because the CLI is reading a line.
    expect(cli.written).toEqual(["code-from-the-callback-page\n"]);
    expect(s.waiting).toBe(false);
  });

  test("the auth probe decides the outcome, not the exit code", async () => {
    // A CLI that exits 0 having failed is the case that would otherwise be
    // reported as a successful sign-in the user did not get.
    const cli = fakeCLI([`visit: ${URL}\n`], { exitCode: 0 });
    const s = session(cli, { isSignedIn: async () => false });
    await s.start();

    const result = await s.submit("bad-code");

    expect(result.status).toBe("failed");
    expect(result.error).toContain("still not signed in");
  });

  test("a CLI that exits without asking is a failure, not a wait", async () => {
    const cli = fakeCLI(["something went wrong\n"], { endAfterPrint: true });
    const s = session(cli);

    const started = await s.start();

    expect(started.status).toBe("failed");
    expect(started.error).toContain("without asking for a code");
    expect(s.waiting).toBe(false);
  });

  test("a second start does not orphan the first", async () => {
    // Two live processes would mean pasting a code into one nobody reads.
    const cli = fakeCLI([`visit: ${URL}\n`]);
    const s = session(cli);
    await s.start();

    const again = await s.start();

    expect(again.status).toBe("waiting-for-code");
    expect(s.waiting).toBe(true);
  });

  test("submitting with nothing waiting says so rather than pretending", async () => {
    const cli = fakeCLI([`visit: ${URL}\n`]);
    const s = session(cli);

    expect((await s.submit("code")).error).toContain("no sign-in is waiting");
  });

  test("an empty code is refused before it reaches the CLI", async () => {
    const cli = fakeCLI([`visit: ${URL}\n`]);
    const s = session(cli);
    await s.start();

    const result = await s.submit("   ");

    expect(result.status).toBe("failed");
    expect(cli.written).toEqual([]);
    // Still waiting, so a mistyped paste does not cost the whole flow.
    expect(s.waiting).toBe(true);
  });

  test("cancel kills the process and forgets it", async () => {
    const cli = fakeCLI([`visit: ${URL}\n`]);
    const s = session(cli);
    await s.start();

    s.cancel();

    expect(cli.killed()).toBe(true);
    expect(s.waiting).toBe(false);
  });

  test("an abandoned flow is killed when its deadline passes", async () => {
    const cli = fakeCLI([`visit: ${URL}\n`]);
    const timers: Array<() => void> = [];
    const s = createLoginSession({
      binPath: "claude",
      spawn: () => cli.proc,
      isSignedIn: async () => true,
      setTimer: (fn) => {
        timers.push(fn);
        return () => {};
      },
    });
    await s.start();

    timers[0]?.();

    expect(cli.killed()).toBe(true);
    expect(s.waiting).toBe(false);
  });
});

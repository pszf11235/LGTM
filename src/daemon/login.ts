/**
 * Start the CLI's sign-in flow from the UI.
 *
 * `claude auth login` opens a browser and waits for the callback, and it
 * wants a terminal to report progress into. A daemon spawning it headless
 * would leave the user watching a page with no way to see what it was asking
 * for, so this opens a real terminal window and runs it there. The button in
 * the UI says exactly that, because a click that silently opens a window is
 * worse than one that warns you.
 *
 * macOS only, which v1 already is (docs/adr/0003). Anywhere else this reports
 * that it cannot help and the UI falls back to showing the command to copy.
 */
export type LoginSpawn = (cmd: string[]) => Promise<{ exitCode: number; stderr: string }>;

export interface LoginOutcome {
  started: boolean;
  /** The command a user can run themselves, whether or not the window opened. */
  command: string;
  error: string | null;
}

const LOGIN_ARGS = "auth login";

/** Quote for AppleScript's own string literal, which only escapes " and \. */
function appleScriptQuote(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

export async function startProviderLogin(
  binPath: string | null,
  spawn: LoginSpawn,
  platform: string = process.platform
): Promise<LoginOutcome> {
  const bin = binPath ?? "claude";
  const command = `${bin} ${LOGIN_ARGS}`;

  if (platform !== "darwin") {
    return { started: false, command, error: "opening a terminal is only wired up on macOS" };
  }

  // `do script` in a new window, then bring Terminal forward, so the flow is
  // not started behind whatever the user is looking at.
  const script = `tell application "Terminal"
  do script "${appleScriptQuote(command)}"
  activate
end tell`;

  try {
    const result = await spawn(["osascript", "-e", script]);
    if (result.exitCode !== 0) {
      return { started: false, command, error: result.stderr.trim() || "osascript failed" };
    }
    return { started: true, command, error: null };
  } catch (error) {
    return {
      started: false,
      command,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

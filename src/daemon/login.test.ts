import { describe, test, expect } from "bun:test";
import { startProviderLogin, type LoginSpawn } from "./login";

const ok: LoginSpawn = async () => ({ exitCode: 0, stderr: "" });

describe("startProviderLogin", () => {
  test("opens a terminal running the resolved binary", async () => {
    const calls: string[][] = [];
    const spawn: LoginSpawn = async (cmd) => {
      calls.push(cmd);
      return { exitCode: 0, stderr: "" };
    };

    const outcome = await startProviderLogin("/opt/homebrew/bin/claude", spawn, "darwin");

    expect(outcome.started).toBe(true);
    expect(outcome.command).toBe("/opt/homebrew/bin/claude auth login");
    expect(calls[0]?.[0]).toBe("osascript");
    expect(calls[0]?.[2]).toContain("/opt/homebrew/bin/claude auth login");
    expect(calls[0]?.[2]).toContain("activate");
  });

  test("reports the command even when it cannot open a window", async () => {
    // The UI falls back to showing it, so a failure here must still say what
    // to run rather than leaving the user with nothing.
    const outcome = await startProviderLogin(null, ok, "linux");

    expect(outcome.started).toBe(false);
    expect(outcome.command).toBe("claude auth login");
    expect(outcome.error).toContain("macOS");
  });

  test("a path with a quote in it cannot break out of the script", async () => {
    const calls: string[][] = [];
    const spawn: LoginSpawn = async (cmd) => {
      calls.push(cmd);
      return { exitCode: 0, stderr: "" };
    };

    await startProviderLogin('/tmp/od"d/claude', spawn, "darwin");

    // Escaped, so AppleScript reads one string rather than a string and then
    // whatever followed the quote.
    expect(calls[0]?.[2]).toContain('od\\"d');
  });

  test("a failing osascript is reported, not swallowed", async () => {
    const outcome = await startProviderLogin(
      "/bin/claude",
      async () => ({ exitCode: 1, stderr: "no Terminal" }),
      "darwin"
    );

    expect(outcome.started).toBe(false);
    expect(outcome.error).toBe("no Terminal");
  });

  test("a spawn that throws is reported, not propagated", async () => {
    const outcome = await startProviderLogin(
      "/bin/claude",
      async () => {
        throw new Error("ENOENT");
      },
      "darwin"
    );

    expect(outcome.started).toBe(false);
    expect(outcome.error).toBe("ENOENT");
  });
});

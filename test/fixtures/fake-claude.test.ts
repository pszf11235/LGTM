/**
 * Test the fake Claude shim in all modes.
 *
 * Each mode is invoked and its stdout/stderr shape is verified. No external
 * dependencies; uses only Bun's built-in spawn and test framework.
 */

import { describe, test, expect } from "bun:test";
import { spawnSync } from "bun";
import { resolve } from "path";

const FAKE_CLAUDE_PATH = resolve(import.meta.dir, "fake-claude.ts");

interface SpawnResult {
  success: boolean;
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

function run(
  mode: string,
  prompt = "/review https://example.com",
  timeoutMs = 5000
): SpawnResult {
  const proc = spawnSync({
    cmd: ["bun", FAKE_CLAUDE_PATH, "-p", prompt, "--output-format", "json", "--model", "claude-3-5-sonnet"],
    env: { ...process.env, FAKE_CLAUDE_MODE: mode },
    timeout: timeoutMs,
  });

  return {
    success: proc.success,
    stdout: proc.stdout ? new TextDecoder().decode(proc.stdout) : "",
    stderr: proc.stderr ? new TextDecoder().decode(proc.stderr) : "",
    exitCode: proc.exitCode,
  };
}

describe("fake-claude shim", () => {
  describe("json mode", () => {
    test("emits a valid Claude envelope with findings", () => {
      const result = run("json");

      expect(result.success).toBe(true);
      expect(result.exitCode).toBe(0);

      const envelope = JSON.parse(result.stdout);
      expect(envelope).toHaveProperty("type", "result");
      expect(envelope).toHaveProperty("subtype", "success");
      expect(envelope).toHaveProperty("is_error", false);
      expect(envelope).toHaveProperty("result");

      // Result is a JSON-stringified string
      const findings = JSON.parse(envelope.result);
      expect(findings).toHaveProperty("findings");
      expect(Array.isArray(findings.findings)).toBe(true);
      expect(findings.findings.length).toBeGreaterThan(0);

      // Each finding has the expected shape
      const finding = findings.findings[0];
      expect(finding).toHaveProperty("file");
      expect(finding).toHaveProperty("line");
      expect(typeof finding.line).toBe("number");
      expect(finding).toHaveProperty("severity");
      expect(finding).toHaveProperty("comment");
    });
  });

  describe("prose mode", () => {
    test("emits an envelope with markdown-formatted findings", () => {
      const result = run("prose");

      expect(result.success).toBe(true);
      expect(result.exitCode).toBe(0);

      const envelope = JSON.parse(result.stdout);
      expect(envelope).toHaveProperty("type", "result");
      expect(envelope).toHaveProperty("result");

      const resultText = envelope.result;
      expect(typeof resultText).toBe("string");
      // Should contain markdown list items with file:line format
      expect(resultText).toContain(":");
      expect(resultText).toContain("-"); // markdown list marker
    });
  });

  describe("garbage mode", () => {
    test("emits unparseable text", () => {
      const result = run("garbage");

      expect(result.exitCode).toBe(0);
      const stdout = result.stdout.trim();
      expect(stdout.length).toBeGreaterThan(0);
      // Should not be valid JSON
      expect(() => JSON.parse(stdout)).toThrow();
    });
  });

  describe("empty mode", () => {
    test("emits a valid envelope with zero findings", () => {
      const result = run("empty");

      expect(result.success).toBe(true);
      expect(result.exitCode).toBe(0);

      const envelope = JSON.parse(result.stdout);
      expect(envelope).toHaveProperty("type", "result");
      expect(envelope).toHaveProperty("is_error", false);

      const findings = JSON.parse(envelope.result);
      expect(findings).toHaveProperty("findings");
      expect(Array.isArray(findings.findings)).toBe(true);
      expect(findings.findings.length).toBe(0);
    });
  });

  describe("timeout mode", () => {
    test("sleeps past the timeout deadline", () => {
      const start = Date.now();
      const result = run("timeout", "/review https://example.com", 2000);
      const elapsed = Date.now() - start;

      // Should have been killed by timeout, not completed normally
      expect(result.success).toBe(false);
      // Timeout should have fired (roughly 2 seconds)
      expect(elapsed).toBeGreaterThanOrEqual(1500);
      expect(elapsed).toBeLessThan(5000);
    });
  });

  describe("crash mode", () => {
    test("exits with non-zero code and stderr message", () => {
      const result = run("crash");

      expect(result.success).toBe(false);
      expect(result.exitCode).not.toBe(0);
      expect(result.exitCode).toBe(1);

      const stderr = result.stderr.trim();
      expect(stderr.length).toBeGreaterThan(0);
      expect(stderr).toContain("Simulated provider failure");
    });
  });

  describe("usage mode", () => {
    test("emits usage lines regardless of prompt", () => {
      const result = run("usage", "/usage");

      expect(result.success).toBe(true);
      expect(result.exitCode).toBe(0);

      const stdout = result.stdout.trim();
      // Should contain lines with percentage and reset time
      expect(stdout).toContain("%");
      expect(stdout).toContain("used");
      expect(stdout).toContain("resets");
    });

    test("also works when mode is set explicitly with any prompt", () => {
      // Even if prompt is not /usage, the mode forces usage output
      const result = run("usage", "/review https://example.com");

      expect(result.success).toBe(true);
      const stdout = result.stdout.trim();
      expect(stdout).toContain("used");
    });
  });

  describe("default mode (json)", () => {
    test("omitting FAKE_CLAUDE_MODE defaults to json", () => {
      const proc = spawnSync({
        cmd: ["bun", FAKE_CLAUDE_PATH, "-p", "/review https://example.com"],
      });

      expect(proc.exitCode).toBe(0);
      const stdout = new TextDecoder().decode(proc.stdout);
      const envelope = JSON.parse(stdout);
      expect(envelope).toHaveProperty("result");
      const findings = JSON.parse(envelope.result);
      expect(findings).toHaveProperty("findings");
    });
  });

  describe("argument parsing", () => {
    test("accepts various flag orders", () => {
      const proc = spawnSync({
        cmd: [
          "bun",
          FAKE_CLAUDE_PATH,
          "--output-format",
          "json",
          "-p",
          "/review https://example.com",
          "--model",
          "claude-3-5-sonnet",
        ],
        env: { ...process.env, FAKE_CLAUDE_MODE: "json" },
      });

      expect(proc.exitCode).toBe(0);
      const stdout = new TextDecoder().decode(proc.stdout);
      const envelope = JSON.parse(stdout);
      expect(envelope).toHaveProperty("result");
    });

    test("ignores unknown flags", () => {
      const proc = spawnSync({
        cmd: [
          "bun",
          FAKE_CLAUDE_PATH,
          "-p",
          "/review https://example.com",
          "--unknown-flag",
          "value",
          "--another",
        ],
        env: { ...process.env, FAKE_CLAUDE_MODE: "empty" },
      });

      expect(proc.exitCode).toBe(0);
      const stdout = new TextDecoder().decode(proc.stdout);
      const envelope = JSON.parse(stdout);
      expect(envelope).toHaveProperty("result");
    });
  });

  describe("usage detection", () => {
    test('detects /usage prompt and emits usage output', () => {
      const proc = spawnSync({
        cmd: ["bun", FAKE_CLAUDE_PATH, "-p", "/usage"],
        env: { ...process.env, FAKE_CLAUDE_MODE: "json" }, // mode is ignored for /usage
      });

      expect(proc.exitCode).toBe(0);
      const stdout = new TextDecoder().decode(proc.stdout);
      // Usage mode outputs plain text, not JSON
      expect(stdout).toContain("Current session");
      expect(stdout).toContain("%");
    });
  });
});

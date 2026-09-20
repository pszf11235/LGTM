#!/usr/bin/env bun
/**
 * Offline test harness that impersonates the Claude CLI.
 *
 * Modes are selected via FAKE_CLAUDE_MODE env var. Each mode emits a
 * different kind of response so the tolerant parser and retry logic can be
 * exercised without network or quota.
 *
 * Invoked as: claude -p <prompt> --output-format json --model <m>
 * (other flags are accepted but ignored)
 *
 * The envelope carries the session fields the real CLI reports beside the
 * review text: session_id, total_cost_usd and num_turns. They are fixed
 * values, so a test can assert on them, and they are what lets the provider's
 * session capture be exercised without spawning the real binary.
 */

/** The session fields the real CLI reports alongside its result. */
const SESSION = {
  session_id: "f47ac10b-58cc-4372-a567-0e02b2c3d479",
  total_cost_usd: 0.77,
  num_turns: 14,
};

function fail(message: string, exitCode = 1): never {
  console.error(message);
  process.exit(exitCode);
}

function parseArgs(): { prompt: string; outputFormat: string; model: string } {
  const args = process.argv.slice(2);
  let prompt = "";
  let outputFormat = "text";
  let model = "";

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "-p" && i + 1 < args.length) {
      prompt = args[++i];
    } else if (args[i] === "--output-format" && i + 1 < args.length) {
      outputFormat = args[++i];
    } else if (args[i] === "--model" && i + 1 < args.length) {
      model = args[++i];
    }
  }

  return { prompt, outputFormat, model };
}

function emitJsonMode(): void {
  const findings = [
    { file: "src/index.ts", line: 42, severity: "high", comment: "Potential null reference" },
    { file: "src/utils.ts", line: 18, severity: "medium", comment: "Missing error handling" },
  ];

  const envelope = {
    type: "result",
    subtype: "success",
    is_error: false,
    ...SESSION,
    result: JSON.stringify({ findings }),
  };

  console.log(JSON.stringify(envelope));
}

function emitProseMode(): void {
  const findings = [
    "- `src/index.ts:42` (high) Potential null reference",
    "- `src/utils.ts:18` (medium) Missing error handling",
  ];

  const envelope = {
    type: "result",
    subtype: "success",
    is_error: false,
    ...SESSION,
    result: findings.join("\n"),
  };

  console.log(JSON.stringify(envelope));
}

function emitGarbageMode(): void {
  console.log("This is not valid JSON and should not parse: {broken [");
}

function emitEmptyMode(): void {
  const envelope = {
    type: "result",
    subtype: "success",
    is_error: false,
    ...SESSION,
    result: JSON.stringify({ findings: [] }),
  };

  console.log(JSON.stringify(envelope));
}

async function emitTimeoutMode(): Promise<never> {
  // Sleep for 30 seconds, well past typical CLI timeout (10-15 seconds)
  await new Promise((resolve) => setTimeout(resolve, 30000));
  fail("Timeout mode: this should have been killed", 143);
}

function emitCrashMode(): never {
  fail("Simulated provider failure: authentication expired", 1);
}

function emitUsageMode(): void {
  // Emit output matching the format from the design doc
  console.log("Current session: 61% used · resets Aug 29 at 3:40pm (Europe/Paris)");
  console.log("Current week (all models): 56% used · resets Aug 29 at 8pm (Europe/Paris)");
}

async function main(): Promise<void> {
  const { prompt } = parseArgs();

  // Detect if this is a usage query
  if (prompt === "/usage") {
    emitUsageMode();
    return;
  }

  const mode = process.env.FAKE_CLAUDE_MODE || "json";

  switch (mode) {
    case "json":
      emitJsonMode();
      break;
    case "prose":
      emitProseMode();
      break;
    case "garbage":
      emitGarbageMode();
      break;
    case "empty":
      emitEmptyMode();
      break;
    case "timeout":
      await emitTimeoutMode();
    case "crash":
      emitCrashMode();
    case "usage":
      emitUsageMode();
      break;
    default:
      fail(`Unknown FAKE_CLAUDE_MODE: ${mode}`, 1);
  }
}

main().catch((err) => {
  fail(`Unexpected error: ${err.message}`, 1);
});

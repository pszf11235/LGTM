# Fake Claude CLI

A standalone Bun script that impersonates the Claude CLI for offline testing.

## Purpose

The fake Claude allows the full watch, review, and gate loop to run without network calls or quota consumption. It mimics the CLI invocation signature and output formats of the real `claude` command, so the tolerant parser and retry logic can be exercised against predictable test scenarios.

## Usage

Run the shim directly as a Bun script:

```bash
FAKE_CLAUDE_MODE=json bun test/fixtures/fake-claude.ts -p "/review <url>" --output-format json --model claude-3-5-sonnet
```

Or place it on PATH (with execute bit) and invoke by name:

```bash
chmod +x test/fixtures/fake-claude.ts
export PATH="test/fixtures:$PATH"
FAKE_CLAUDE_MODE=json claude -p "/review https://..." --output-format json --model claude-3-5-sonnet
```

## Modes

The `FAKE_CLAUDE_MODE` env var controls behavior. Omit it to default to `json`.

### `json`

Emits a valid Claude CLI envelope with a proper findings payload:

```json
{
  "type": "result",
  "subtype": "success",
  "is_error": false,
  "result": "{\"findings\": [{\"file\": \"src/index.ts\", \"line\": 42, \"severity\": \"high\", \"comment\": \"...\"}]}"
}
```

Tests the main parsing path.

### `prose`

Emits an envelope whose result field contains markdown-formatted findings:

```json
{
  "result": "- `src/index.ts:42` (high) Potential null reference\n- `src/utils.ts:18` (medium) Missing error handling"
}
```

Tests the prose parsing strategy.

### `garbage`

Emits unparseable text to stdout. Tests the failed-round and `.raw.txt` path:

```
This is not valid JSON and should not parse: {broken [
```

### `empty`

Emits a valid envelope with zero findings:

```json
{
  "type": "result",
  "subtype": "success",
  "is_error": false,
  "result": "{\"findings\": []}"
}
```

### `timeout`

Sleeps for 30 seconds past any reasonable CLI timeout. When used in tests with a kill deadline, exercises the timeout and salvage path. The process prints nothing before sleeping.

### `crash`

Exits with code 1 and prints an error to stderr. Tests the non-zero exit path when stdout is empty:

```
Simulated provider failure: authentication expired
```

### `usage`

Prints quota gate response on stdout regardless of the prompt. Tests offline quota parsing. Output format:

```
Current session: 61% used · resets Aug 29 at 3:40pm (Europe/Paris)
Current week (all models): 56% used · resets Aug 29 at 8pm (Europe/Paris)
```

## CLI Arguments

The shim accepts the same flags as the real CLI:

- `-p <prompt>` — the input prompt (required for `/review`, triggers usage output for `/usage`)
- `--output-format json` — response format (ignored; always produces the same shape)
- `--model <name>` — model name (ignored)

Extra flags are accepted but have no effect.

## Environment Variables

- `FAKE_CLAUDE_MODE` — selects the response type (default: `json`)

## Integration in Tests

When the Provider or quota gate needs to be tested without network:

1. Ensure `fake-claude.ts` is on PATH (or use its full path to invoke Bun)
2. Set `FAKE_CLAUDE_MODE` to the scenario you want to exercise
3. Optionally set `CLAUDE_CLI_PATH` or similar to route the daemon to the fake CLI instead of the real one

Example:

```ts
import { spawnSync } from "bun";

const result = spawnSync({
  cmd: ["bun", "test/fixtures/fake-claude.ts", "-p", "/usage", "--output-format", "json"],
  env: { ...process.env, FAKE_CLAUDE_MODE: "usage" },
});

// stdout contains the usage response; the parser can be tested against it
```

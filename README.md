# 🦬 Yak — Stop Shaving, Start Shipping

> A personal dev productivity platform with plugins.

## Quick Start

```bash
# Install dependencies
bun install

# Run Yak
bun run yak --help

# Or directly
bun run packages/core/src/index.ts --help
```

## What Is Yak?

AI coding agents let you generate 5 PRs in an hour. But now **you** need to review them. Yak provides structured workflows so you stop yak shaving and start shipping.

**Architecture:** Core platform + plugins

| Plugin | Status | Description |
|--------|--------|-------------|
| `review` | 🚧 In Development | PR review harness with rules, grouping, TUI |
| `specify` | 📋 Planned | Codebase intelligence & diagrams |
| `learn` | 📋 Planned | Interactive learning paths |

## Development

```bash
bun install          # install all workspace deps
bun run yak          # run the CLI
bun test             # run tests
bun run lint         # type check
```

## License

MIT

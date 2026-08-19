# Contributing to Yak 🦬

Thanks for wanting to help! Here's how to get started.

## Development Setup

```bash
git clone https://github.com/pszf11235/yak.git
cd yak
bun install
bun run yak --help
```

## Project Structure

```
packages/
├── core/           # CLI framework, TUI, LLM, storage, config
└── plugins/
    ├── review/     # PR review harness (main plugin)
    ├── specify/    # Codebase analysis (planned)
    └── learn/      # Learning paths (planned)
```

## Adding a Plugin

1. Create `packages/plugins/your-plugin/`
2. Add `package.json` with `@yak/core` as dependency
3. Export a `plugin` object implementing `YakPlugin` interface
4. Your commands auto-register under `yak your-plugin <command>`

## Workflow

1. Create a feature branch: `git checkout -b feat/description`
2. Make atomic commits with conventional messages: `feat(scope):`, `fix(scope):`
3. Push and open a PR against `main`
4. CI must pass (type check + tests + build)

## Testing

```bash
bun test                    # all tests
bun test path/to/file       # specific file
task check                  # lint + test + build
task slaughter              # clean slate for testing
```

## Commit Style

```
feat(review): add rule export command
fix(onboarding): don't pause stdin after selector
refactor(core): wire real store into bootstrap
test(rules): add regex matching tests
docs: update README
ci: fix build externals
```

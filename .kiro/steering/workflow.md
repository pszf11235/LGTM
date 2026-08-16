# Development Workflow Rules

## PR Completion Criteria

**A PR is NOT "done" or "ready for review" until:**
1. CI pipeline is confirmed green (all checks pass)
2. If CI fails, fix it and wait for green before notifying the user
3. Never tell the user to "merge when ready" if CI hasn't passed

## Commit Style

- Atomic commits (one logical change per commit)
- Conventional commit messages: `feat(scope):`, `fix(scope):`, `refactor(scope):`, `test:`, `ci:`, `docs:`
- Each task = one feature branch + one PR

## PR Style

- Always push to feature branches, never directly to main
- PR description includes: what changed, key files to review, how to test
- Reference the GitHub issue number with "Closes #N"

## Testing

- Verify type-check passes (`tsc --noEmit`) before pushing
- Run `bun build` to check import resolution
- Add tests for logic that could silently break (routing, serialization, state machines)

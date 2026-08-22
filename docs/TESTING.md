# 👍 LGTM — Feature Testing Guide

A hands-on walkthrough to test every feature of LGTM. Follow this from top to bottom for a complete tour.

> **Prerequisites**: Bun installed, LGTM repo cloned, `bun install` done.
> Set `GITHUB_TOKEN` env var for GitHub features (or run `lgtm auth login github`).

---

## Table of Contents

1. [Build & Run](#1-build--run)
2. [Onboarding & Init](#2-onboarding--init)
3. [Configuration](#3-configuration)
4. [Review Queue](#4-review-queue)
5. [Rules Engine](#5-rules-engine)
6. [Repo Scanning](#6-repo-scanning)
7. [Watch & Dashboard](#7-watch--dashboard)
8. [AI Features](#8-ai-features)
9. [AI Auto-Review](#9-ai-auto-review)
10. [PR Report & Standup](#10-pr-report--standup)
11. [TUI (Full-Screen Interface)](#11-tui-full-screen-interface)
12. [Authentication](#12-authentication)
13. [Binary Build](#13-binary-build)
14. [Webapp Daily Checker](#14-webapp-daily-checker)
15. [Tests](#15-tests)
16. [Smoke Test Command](#16-smoke-test-command)

---

## 1. Build & Run

```bash
# Run from source (development)
bun run lgtm --help

# Build a binary for your platform
bun run build:binary
./dist/lgtm --help

# Build for all platforms
bun run build:binary:all
ls dist/
```

**Expected**: Shows help output with all commands listed.

---

## 2. Onboarding & Init

```bash
# Fresh start (wipes all LGTM data)
task slaughter

# Run interactive onboarding
bun run lgtm init
```

**Steps to test**:
1. Choose storage mode: `repo` (per-repo) or `farm` (central)
2. Enter project name
3. Select goal: `vibed` / `production` / `enterprise` / `learning`
4. Choose feedback style: `direct` / `gentle` / `socratic` / `minimal`
5. Add tech stack items
6. Select team size
7. Configure AI (optional — say no to skip)

**Expected**: Creates `~/.lgtmrc` + `.lgtm/profile.md` (or `~/.lgtm-farm/<repo>/profile.md`)

**Verify**:
```bash
cat ~/.lgtmrc              # Should show storageMode
cat .lgtm/profile.md       # Should show your answers as YAML frontmatter
```

---

## 3. Configuration

```bash
# View current config
bun run lgtm config

# View .lgtmrc.yaml example
cat .lgtmrc.yaml.example
```

**Expected**: Shows resolved config (storage mode, plugins, AI settings).

**Test config override**: Create `.lgtmrc.yaml` in repo root:
```yaml
plugins:
  review:
    enabled: true
ai:
  enabled: false
```

Then `bun run lgtm config` should reflect the override.

---

## 4. Review Queue

```bash
# Add PRs to queue (demo mode — no GitHub needed)
bun run lgtm review add 1 2 3 --demo

# Check status
bun run lgtm review status

# Approve a PR
bun run lgtm review approve 1

# Flag a PR with reason
bun run lgtm review flag 2 -r "SQL injection in auth.ts"

# Check status again
bun run lgtm review status
```

**Expected**:
- `status` shows queue with states (queued → approved/flagged)
- Feature groups auto-detected if PRs share files
- Flags show reason text

---

## 5. Rules Engine

### Create rules

```bash
# Regex rule (zero tokens)
bun run lgtm review rule add "No hardcoded secrets" \
  --pattern '(api_key|secret)\s*=\s*"[^"]{8,}"' \
  --category security --severity error

# LLM rule (needs AI configured)
bun run lgtm review rule add "Functions over 50 lines should be split" \
  --category architecture --severity warn

# Another regex rule
bun run lgtm review rule add "No console.log in production" \
  --pattern 'console\.log' \
  --category style --severity warn
```

### List rules

```bash
bun run lgtm review rule list
```

**Expected**: Shows all rules with ID, severity, enforcement type, pattern.

### Enable/disable

```bash
# Get rule ID from list output
bun run lgtm review rule disable <rule-id>
bun run lgtm review rule enable <rule-id>
```

### Import rules from a doc

```bash
# If you have a CLAUDE.md or CONTRIBUTING.md with conventions
bun run lgtm review rule import CLAUDE.md
```

### Export rules

```bash
# Export as git hook
bun run lgtm review rule export --format hook -o /tmp/pre-commit-hook

# Export as JSON
bun run lgtm review rule export --format json
```

### Suggest rules from patterns

```bash
# Only works if you have review history
bun run lgtm review rule suggest
```

---

## 6. Repo Scanning

```bash
# Scan entire repo against all enabled rules
bun run lgtm review scan

# Scan with a specific rule only
bun run lgtm review rule list   # get rule ID
bun run lgtm review scan --rule <rule-id>
```

**Expected**: Shows violations grouped by rule. For the "no console.log" rule, should flag any `console.log` calls in the codebase.

---

## 7. Watch & Dashboard

### Watch repos

```bash
# Add repos to watch (needs GITHUB_TOKEN)
bun run lgtm review watch add pszf11235/LGTM
bun run lgtm review watch add <another-owner/repo>

# List watched repos
bun run lgtm review watch list

# Check for PRs needing attention
bun run lgtm review watch status
```

### Dashboard

```bash
# Open dashboard (CLI version)
bun run lgtm review dashboard
```

**Expected**: Shows attention items from watched repos — PRs needing review, sorted by urgency.

### Remove a watch

```bash
bun run lgtm review watch remove pszf11235/LGTM
```

---

## 8. AI Features

### Setup & test

```bash
# Test AI connection (tries configured provider)
bun run lgtm ai test

# Set model
bun run lgtm ai model gpt-4o-mini       # OpenAI
bun run lgtm ai model claude-sonnet-4-20250514  # Anthropic
bun run lgtm ai model llama3.2          # Ollama (local)

# Check current model
bun run lgtm ai model
```

**Required env vars** (one of):
- `OPENAI_API_KEY` for OpenAI
- `ANTHROPIC_API_KEY` for Anthropic
- Ollama running locally (auto-detected)

### AI-powered features (require AI configured)

```bash
# PR summarization (when adding to queue with GitHub token)
bun run lgtm review add <pr-number>

# Rule suggestions from review history
bun run lgtm review rule suggest

# LLM rule enforcement during scan
bun run lgtm review scan
```

---

## 9. AI Auto-Review

The flagship feature — AI reviews a PR and posts findings to GitHub.

### Dry run (safe — no posting)

```bash
# Review a specific PR without posting anything
bun run lgtm review auto --pr <number> --dry-run

# With explicit repo
bun run lgtm review auto --repo pszf11235/LGTM --pr 97 --dry-run
```

**Expected**: Shows findings (file, line, comment, severity) without posting to GitHub.

### Severity filtering

```bash
# Only critical issues
bun run lgtm review auto --pr <number> --dry-run --severity critical

# All issues (including low)
bun run lgtm review auto --pr <number> --dry-run --severity low
```

### Live posting (careful!)

```bash
# Post findings to GitHub (batched as single review)
bun run lgtm review auto --pr <number>

# Post individually with delays (anti-spam)
bun run lgtm review auto --pr <number> --no-batch
```

**Expected**: Creates a review on the PR with inline comments at the correct file/line positions.

### Config (.lgtmrc.yaml)

```yaml
review:
  ai_review:
    severity_threshold: high
    comment_delay: [20, 90]
    formatting:
      no_em_dashes: true
      no_semicolons: true
      no_severity_labels: true
```

---

## 10. PR Report & Standup

### PR Status Report

```bash
# Report across all watched repos
bun run lgtm review report

# Report for a specific repo
bun run lgtm review report --repo pszf11235/LGTM

# JSON output (for scripting)
bun run lgtm review report --json
```

**Expected**: Groups open PRs by recommendation (ready / needs attention / blocked / stale) with CI status, review status, age, and conflict info.

### Daily Standup

```bash
# Yesterday's activity + today's priorities
bun run lgtm review standup

# Last 3 days
bun run lgtm review standup --days 3

# Plain text (no markdown)
bun run lgtm review standup --plain
```

**Expected**: Markdown output showing merged PRs, opened PRs, reviews given, and today's priorities. Copy-paste into Slack.

---

## 11. TUI (Full-Screen Interface)

```bash
# Launch TUI (if profile exists, opens directly)
bun run lgtm

# Or explicitly
bun run lgtm tui
```

**TUI Tabs to test** (press Tab to switch):

| Tab | What to test |
|-----|-------------|
| **Dashboard** | Shows attention items from watched repos |
| **Review** | Navigate queued PRs, view diffs, post comments |
| **Rules** | Browse rules, toggle enable/disable with Enter |
| **History** | Past review sessions |
| **Config** | View profile, config, paths (new in #79!) |

**Keyboard shortcuts**:
- `Tab` / `Shift+Tab` — switch tabs
- `j`/`k` or `↑`/`↓` — navigate within a tab
- `q` — quit (from any page)
- `Ctrl+C` — force quit

### TUI Review Flow

1. Queue a PR: `bun run lgtm review add <number>` (before opening TUI)
2. Open TUI: `bun run lgtm`
3. Go to Review tab (Tab key)
4. Navigate to the PR (j/k)
5. Press Enter to open the diff viewer
6. Navigate files (n/N), hunks (h/H)
7. Press `c` to add a comment at current line
8. Press `a` to approve, `f` to flag

---

## 12. Authentication

### Multi-service OAuth

```bash
# Login to GitHub (browser-based PKCE flow)
bun run lgtm auth login github

# Check status
bun run lgtm auth status

# Logout
bun run lgtm auth logout github
```

**Supported services** (9 total):
`github`, `gitlab`, `bitbucket`, `linear`, `jira`, `slack`, `notion`, `discord`, `vercel`

> Note: Most services require #84 (OAuth app registration) to be completed first.

---

## 13. Binary Build

```bash
# Build for current platform
bun run build:binary
./dist/lgtm --help

# Verify binary works end-to-end
./dist/lgtm smoke

# Build all platforms
bash scripts/build-binaries.sh

# Build just Linux
bash scripts/build-binaries.sh linux

# Build just macOS
bash scripts/build-binaries.sh darwin

# Check output
ls -lh dist/lgtm*
cat dist/checksums-sha256.txt
```

**Expected**: Produces standalone executables (~50-80MB) that run without Bun/Node.

**How it works**: The `react-devtools-core` stub at `stubs/react-devtools-core/` is bundled directly into the binary (registered as a `file:` devDependency). This satisfies Ink's optional devtools import without needing the real package at runtime.

### Cut a release

```bash
# Tag and push (triggers GitHub Actions release workflow)
git tag v0.1.0
git push origin v0.1.0
```

Then check GitHub Releases page for the auto-created release with binaries.

---

## 14. Webapp Daily Checker

```bash
# Open in browser (no build step needed)
open webapp/index.html

# Or serve with a simple server
cd webapp && python3 -m http.server 8080
# Then visit http://localhost:8080
```

**Steps to test**:
1. Paste your GitHub token (needs `repo` scope)
2. Add repos to watch (owner/repo format)
3. Click "Run Daily Check"
4. Switch between Report and Standup tabs
5. Click "Copy" on the standup output

**Expected**:
- PR Report: shows open PRs with CI/review/conflict badges
- Standup: generates markdown summary, copy button works
- Data persists on refresh (localStorage)

---

## 15. Tests

```bash
# Run all tests
bun test

# Run specific test file
bun test packages/core/src/llm/cache.test.ts
bun test packages/plugins/review/src/domain/auto-review.test.ts

# Run E2E tests
bun test packages/plugins/review/src/e2e/

# Run with coverage (if enabled in bunfig.toml)
bun test --coverage
```

**Test files to verify pass**:
- `packages/core/src/config/loader.test.ts` — config resolution
- `packages/core/src/llm/cache.test.ts` — LLM caching
- `packages/core/src/onboarding/detect.test.ts` — stack detection
- `packages/core/src/store/okf.test.ts` — OKF storage
- `packages/plugins/review/src/domain/diff-parser.test.ts` — diff parsing
- `packages/plugins/review/src/domain/rules.test.ts` — rules engine
- `packages/plugins/review/src/domain/grouping.test.ts` — PR grouping
- `packages/plugins/review/src/domain/overlap.test.ts` — overlap detection
- `packages/plugins/review/src/domain/multi-repo.test.ts` — PR ref parsing
- `packages/plugins/review/src/domain/patterns.test.ts` — pattern analysis
- `packages/plugins/review/src/domain/summarize.test.ts` — PR summarization
- `packages/plugins/review/src/domain/auto-review.test.ts` — auto-review engine
- `packages/plugins/review/src/infra/github.test.ts` — GitHub adapter
- `packages/plugins/review/src/e2e/auto-review-pipeline.test.ts` — E2E pipeline

---

## Quick Smoke Test (5 minutes)

If you just want to verify the tool works end-to-end:

```bash
# Fastest: run the built-in smoke command (exercises all subsystems)
bun run lgtm smoke

# With guided explanations (great for first-time users)
bun run lgtm smoke --demo

# Machine-readable output (for CI/agents)
bun run lgtm smoke --json
```

**All 11 tests pass? You're good. Ship it. 👍**

### Manual Walkthrough (if you prefer hands-on)

```bash
# 1. Fresh start
task slaughter:local

# 2. Initialize
bun run lgtm init
# → Choose: repo mode, production, direct, your stack

# 3. Create a rule
bun run lgtm review rule add "No TODO without ticket" \
  --pattern 'TODO(?!\s*\[)' --category style --severity warn

# 4. Scan the repo
bun run lgtm review scan

# 5. Add demo PRs and check status
bun run lgtm review add 1 2 3 --demo
bun run lgtm review status

# 6. Open TUI
bun run lgtm

# 7. (If GITHUB_TOKEN set) Watch a repo and check report
export GITHUB_TOKEN=ghp_your_token_here
bun run lgtm review watch add pszf11235/LGTM
bun run lgtm review report
bun run lgtm review standup

# 8. (If AI configured) Auto-review a PR
bun run lgtm review auto --pr 97 --dry-run

# 9. Run tests
bun test
```

---

## 16. Smoke Test Command

The built-in `lgtm smoke` command exercises all major subsystems non-interactively.

```bash
# Quick verification (CI-friendly, dot output)
bun run lgtm smoke

# Guided demo walkthrough (explains each feature)
bun run lgtm smoke --demo

# Machine-readable JSON (for agents/automation)
bun run lgtm smoke --json

# Verbose output (shows all details)
bun run lgtm smoke --verbose

# Works from binary too
./dist/lgtm smoke
```

**What it tests** (11 checks):

| # | Test | What it verifies |
|---|------|-----------------|
| 1 | Config Loading | `.lgtmrc.yaml` resolution with defaults |
| 2 | OKF Store | Write/read round-trip (YAML frontmatter + markdown) |
| 3 | Git URL Parsing | HTTPS and SSH URL extraction |
| 4 | Tech Stack Detection | Auto-detect from config files (tsconfig, package.json, etc.) |
| 5 | LLM Cache | Content-hash based set/get/clear |
| 6 | Diff Parser | Unified diff → structured data |
| 7 | Rules Engine | Create and load regex/LLM rules |
| 8 | Review Queue | State machine (queued → reviewing → approved/flagged) |
| 9 | PR Grouping & Overlap | Shared-file detection between PRs |
| 10 | Auto-Review Engine | Regex rule enforcement against diffs |
| 11 | Binary Executable | `dist/lgtm --version` works (if binary built) |

**Expected**: All 11 pass, exit code 0. If any fail, the output shows which test and why.

**JSON output format** (for scripting):
```json
{
  "passed": 11,
  "failed": 0,
  "total": 11,
  "duration": 200,
  "results": [{ "name": "...", "passed": true, "duration": 3, "output": "..." }]
}
```

---

## Feature Matrix

| Feature | CLI | TUI | Webapp | Needs GitHub Token | Needs AI |
|---------|:---:|:---:|:------:|:-----------------:|:--------:|
| Init / Onboarding | ✓ | — | — | — | — |
| Config viewer | ✓ | ✓ | — | — | — |
| Review queue | ✓ | ✓ | — | — | — |
| PR diff viewer | — | ✓ | — | ✓ | — |
| Rules (create/list/toggle) | ✓ | ✓ | — | — | — |
| Rules (import/export) | ✓ | — | — | — | — |
| Repo scan | ✓ | — | — | — | — |
| Watch repos | ✓ | — | — | ✓ | — |
| Dashboard (attention) | ✓ | ✓ | — | ✓ | — |
| AI auto-review | ✓ | — | — | ✓ | ✓ |
| PR report | ✓ | — | ✓ | ✓ | — |
| Daily standup | ✓ | — | ✓ | ✓ | — |
| Auth (OAuth) | ✓ | — | — | — | — |
| Binary build | ✓ | — | — | — | — |
| Smoke test | ✓ | — | — | — | — |

---

*Last updated: August 2026*

# PR Review Harness — Multi-PR Review Orchestration

## Concept

A CLI tool that orchestrates AI-powered code reviews across multiple PRs simultaneously, using sub-agents for specialized review tasks and cross-PR correlation to catch issues that single-PR reviewers miss.

## The Problem

Current AI review tools (CodeRabbit, Greptile, Copilot) review PRs in isolation. But real development involves:
- Feature branches split across multiple PRs
- Related changes by different team members
- Dependency chains (PR #3 depends on PR #1 and #2)
- Subsystem-wide changes that span PRs

Reviewing these in isolation misses conflicts, inconsistencies, and interaction bugs.

## Core Features

1. **Batch PR Review** — Review 1-N PRs in a single command
2. **Sub-Agent Delegation** — Spin up specialized agents (security reviewer, architecture reviewer, test coverage reviewer)
3. **Cross-PR Correlation** — Identify conflicts, redundancies, and interaction issues across PRs
4. **Developer-in-the-Loop** — Review agent findings before they're posted to GitHub
5. **Mixed LLM Strategy** — Use different models for different review aspects
6. **Configurable Rules** — Custom review criteria, team standards, project-specific checks

## Example Usage

```bash
# Install
npm install -g prr

# Review a single PR with sub-agents
prr review 123 --agents security,architecture,testing

# Review multiple related PRs
prr review 123 456 789 --correlate

# Review all open PRs for a repo
prr review --all --since "3 days ago"

# Interactive mode — review findings before posting
prr review 123 --interactive

# Custom rules
prr review 123 --rules ./review-rules.yaml
```

## Sub-Agent Architecture

```
┌─────────────────────────────────┐
│         Orchestrator            │
│    (correlates, deduplicates)   │
└──────────┬──────────────────────┘
           │
    ┌──────┼──────────┐
    │      │          │
    ▼      ▼          ▼
┌──────┐ ┌──────┐ ┌──────┐
│ Sec  │ │ Arch │ │ Test │  ← specialized sub-agents
│Agent │ │Agent │ │Agent │
└──────┘ └──────┘ └──────┘
```

Each sub-agent:
- Gets the PR diff + relevant codebase context
- Reviews through its specialized lens
- Returns structured findings
- Orchestrator merges, deduplicates, and correlates

## Output

```
.prr/
  reviews/
    pr-123/
      summary.md           ← human-readable summary
      security.md          ← security agent findings
      architecture.md      ← architecture agent findings
      testing.md           ← test coverage findings
    correlation/
      pr-123-456.md        ← cross-PR interaction analysis
  config.yaml              ← review rules, agent config
```

## Tech Stack

- TypeScript + Node.js
- CLI: Commander.js
- GitHub: Octokit + simple-git
- LLM: Provider abstraction (mix models per agent)
- Config: cosmiconfig
- Output: Markdown + optional GitHub PR comments

## Key Differentiators

1. **Multi-PR** — Not just multi-agent on one PR, but orchestration ACROSS PRs
2. **Sub-agent specialization** — Security agent, architecture agent, test agent
3. **Cross-correlation** — Finds issues that only appear when PRs interact
4. **Developer control** — Review before posting (not fire-and-forget)
5. **LLM mixing** — Use the best model for each task

## Target Users

- Tech leads reviewing team output
- Developers managing multiple PRs
- Teams with high PR velocity
- Anyone frustrated with shallow AI reviews

## Status

📋 **Idea** — Not yet implemented

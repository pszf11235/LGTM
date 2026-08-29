# 0002. Reviews are delegated to AI CLIs the user already has installed

- **Status:** Accepted
- **Date:** 2026-08-29

## Context

LGTM needs an LLM to review diffs, and its users are developers who already pay for AI coding tools with subscriptions (Claude Max, ChatGPT). Those tools ship their own review commands, manage their own authentication, and forbid third parties from extracting their subscription tokens. Implementing review against a raw completions API would mean owning prompts, API keys, and billing that the user already has covered.

## Decision

LGTM spawns the AI CLI the user already has installed and authenticated, as a subprocess, and prefers the CLI's built-in review command with the user's instructions appended. The user's own prompt lives in an editable agent file; LGTM never reads or extracts the CLI's credentials. v1 supports the Claude CLI only, behind a provider interface that admits others by configuration.

## Consequences

The user's existing subscription does the work: no API keys to manage, no second bill, and review quality rides on the vendor's own review skill, which improves without LGTM shipping anything. Auth stays where it belongs, in the CLI's keychain.

Harder: CLI output formats are undocumented and drift between versions, so LGTM carries a deliberately tolerant multi-strategy parser and can still lose findings from a badly behaved release. Headless spawning inherits sharp edges: bare PATH under launchd, subprocesses that hold pipes open, and review consuming the same subscription quota the user works with interactively, which forced the quota gate into the design. LGTM also cannot tune model parameters directly; it gets whatever the CLI's review command does.

## Alternatives considered

**Direct API integration** (OpenRouter, Ollama, raw Anthropic API), which the old codebase supported. Rejected for v1: it makes LGTM own the review prompt, keys, and cost, reimplementing a worse version of what the CLIs already do; the old code itself concluded this was strictly worse.

**Extracting credentials from the CLIs' keychains or config files**, which an early version of the old codebase attempted. Rejected outright: vendors explicitly forbid it, and it breaks silently when they rotate storage.

# 0005. The watcher polls the forge; there are no webhooks

- **Status:** Accepted
- **Date:** 2026-08-29

## Context

A PR watcher wants push notifications, and GitHub offers them, but only to a public HTTPS endpoint. LGTM's daemon runs on a laptop behind NAT with no inbound reachability, and GitHub has no public streaming API for repository events. Reaching webhook delivery from a home machine means standing infrastructure: a tunnel or relay that must itself stay alive, be secured, and be explained to users.

## Decision

The watcher polls each watched repository on an interval (15 minutes by default), using conditional requests so that unchanged repositories cost nothing against the API rate limit. Latency of one interval is accepted as the price of having no infrastructure.

## Consequences

Zero infrastructure: nothing to host, tunnel, register, or keep alive, and the tool works on any network. Conditional requests make the steady state nearly free, since a not-modified response costs no rate limit; the budget of five thousand requests per hour dwarfs what a personal watch list consumes.

Harder: a new PR waits up to one interval before LGTM notices, which rules out any future where a review is expected within a minute of opening. Polling wakes up to find nothing most of the time, and per-PR detail fetches for triage metadata must be budgeted deliberately because only the list call gets the cheap conditional path.

## Alternatives considered

**Repository webhooks via a relay** (smee, a tunnel, or a small hosted forwarder). Real push latency, rejected because the relay is standing infrastructure with its own failure modes and trust surface, unjustifiable for a local-first personal tool. Revisit if a team deployment ever needs sub-minute latency.

**The forge's notifications feed as a poll target.** A second polling surface with its own semantics and staleness quirks, rejected because it adds a subsystem without removing the poll loop.

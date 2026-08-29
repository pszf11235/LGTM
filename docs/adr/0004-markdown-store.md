# 0004. State lives in markdown files with frontmatter, not a database

- **Status:** Accepted
- **Date:** 2026-08-29

## Context

The rebuild adds a web UI and an HTTP API, which is normally the moment a tool graduates to SQLite: queries, transactions, and no parsing. The old codebase stored everything as markdown with YAML frontmatter in a single directory, and the user named that property as one worth keeping: findings they can grep, read, and hand-edit in an editor, files that survive any rewrite of the tool around them.

## Decision

The store stays markdown plus frontmatter in one central directory: watch state, agent definitions, per-round findings with their lifecycle state in frontmatter. The daemon is the only writer; UI and CLI mutate through its API, and the daemon watches the directory so deliberate hand-edits show up live.

## Consequences

Every piece of state is inspectable and repairable with a text editor, diffable, and portable to whatever replaces this implementation. Review artifacts read as documents, which suits what they are. Debugging is `grep`, not a database client.

Harder: no transactions and no queries, so consistency rests on conventions the code must honor (single writer, full finding keys, one file per round), and the old codebase's history shows what happens when they slip, including a real cross-round corruption bug. Listing views re-parse files instead of querying indexes, which sets a practical ceiling on scale that a personal tool fits under but a team product would not.

## Alternatives considered

**SQLite.** Better queries, real transactions, one-file portability. Rejected because it makes the store opaque to the user, and the store being readable is a feature of the product, not an implementation detail. The scale that would force the issue is out of scope for v1.

**Markdown for artifacts plus SQLite for state.** Rejected: two sources of truth that can disagree, for a data volume that does not need the second one.

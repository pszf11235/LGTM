# 0001. LGTM can create draft reviews but can never publish one

- **Status:** Accepted
- **Date:** 2026-08-29

## Context

AI-generated review findings are worthless if teammates see them before a human edits them, and terminals are a bad place to read a diff. GitHub creates a review in PENDING state, visible only to its author and editable in GitHub's own UI, when the review-creation request omits the `event` field; there is no `draft: true` parameter, and including `event: "COMMENT"` publishes instantly and irreversibly. The old codebase guarded this with tests and kept one explicit submit command. During the v1 rebuild we had to decide whether that submit path survives.

## Decision

LGTM posts pending draft reviews and contains no code path that can publish one. There is no submit command, no function that sends an `event` field, and the forge adapter exposes no publishing operation. Submission happens exclusively in the forge's own UI, by the human.

## Consequences

The product's promise becomes structural instead of guarded: the dangerous request cannot be constructed, which is a stronger claim than "one careful function sends it". Tests shrink to asserting an absence. The user finishes every review in GitHub's editor, which is where they were going anyway to edit wording.

Harder: no future automation can submit on the user's behalf without revisiting this decision, including innocuous flows like auto-approving trivial dependency bumps. Because the REST API cannot append to a pending review, updating a draft means deleting and recreating it. And the safety property depends on the forge adapter staying the only module that talks to the forge; a second HTTP client bypasses the whole design.

## Alternatives considered

**Keep a submit command** (the old design). Rejected: submission is the one thing the forge UI does strictly better, and keeping the command means keeping, guarding, and testing the only dangerous line in the codebase forever.

**Post published comments directly with rate-limited pacing.** The original pre-pivot design, already deleted once. Rejected: it makes the human gate advisory instead of structural, and the entire product exists because that model fails.

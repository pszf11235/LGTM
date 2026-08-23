# LGTM documentation

The user-facing docs are in the repository root, because that is where people
look first:

| Document | What it covers |
|---|---|
| [../README.md](../README.md) | What LGTM is, install, the loop, every command |
| [../TESTING.md](../TESTING.md) | Running the suite, and driving the loop by hand with no provider and no token |

What is left in here is background, not instructions.

| Document | What it covers |
|---|---|
| [CONTRIBUTING.md](./CONTRIBUTING.md) | Dev setup, code style, PR guidelines |
| [IDEA.md](./IDEA.md) | The original problem statement this was built from |
| [COMPETITIVE_ANALYSIS.md](./COMPETITIVE_ANALYSIS.md) | What else exists and why this is shaped differently |

## Design records

Specs live in [`.kiro/specs/`](../.kiro/specs/), one directory per feature, each
with `requirements.md`, `design.md` and `tasks.md`. They are the design record:
what was decided, why, and what shipped. Start with
[`mvp-review-pipeline`](../.kiro/specs/mvp-review-pipeline/), which is the
current review pipeline.

## Removed

`AI-REVIEW.md`, `LLM-INTEGRATION.md`, `TESTING.md` and `ROADMAP.md` used to live
here. They documented `lgtm review auto`, which posted findings straight to a
pull request. That command was deleted in the MVP review pipeline work, and
LGTM now only ever creates a draft (`PENDING`) review that nobody but you can
see. Leaving those files in place would have described the opposite of what the
tool does. The roadmap is tracked as GitHub issues instead, linked from the
root README.

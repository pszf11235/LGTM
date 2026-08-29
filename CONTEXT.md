# LGTM

Reviewing pull requests with AI assistance while a human keeps final say. In scope: watching repositories, producing review findings locally, and gating what reaches the code host. Out of scope: writing code, merging, and anything that publishes without a human action.

## Glossary

### Forge

A code host that owns pull requests, such as GitHub. LGTM speaks to exactly one Forge per repository and treats it as the system of record for PRs and reviews.

### Watcher

The long-running process that periodically asks each watched repository's Forge for open pull requests and decides what to do with each one. The Watcher observes and classifies; it never writes to the Forge.

### WatchList

The set of repositories the Watcher polls. A repository is either on the WatchList or invisible to LGTM; there is no partial watching.

### AutoClassPr

An open pull request that qualifies for review without being asked: the user authored it, or was requested as reviewer, assigned, or mentioned in its title or description. Auto-classification is what makes LGTM proactive rather than a tool you must remember to invoke.

### TriagePr

Any open pull request in a watched repository that is not an AutoClassPr. It waits for a human decision, review or skip, and nothing happens to it until that decision is made.

### Skip

The sticky decision that a TriagePr will not be reviewed. New activity on the pull request does not undo a Skip; only the human does.

### Backfill

The triage pass over pull requests that were already open when a repository joined the WatchList. Backfill always asks; automatic classification applies only to activity that happens after watching begins.

### Agent

A named reviewer definition the user can edit: which Provider runs it, how it behaves, and what extra instructions it carries. One Agent produces one set of findings per Round. Distinct from Provider, which is the thing that executes.

### Provider

The mechanism that actually performs a review, an AI tool already installed and authenticated on the user's machine. LGTM delegates to Providers rather than implementing review itself.

### Round

One review pass over one pull request at one specific head commit, by one Agent. New commits start a new Round; Rounds are never edited after the fact.

### Finding

A single reviewer observation: a location in the diff, a severity, and a comment. A Finding carries its own lifecycle state, open, discarded, posted, or held, and that state is the human's to change, not the Agent's.

### Gate

The human step between Findings on disk and anything reaching the Forge. The Gate is where the user discards junk and decides what posts. It is the product's defining boundary: LGTM without the Gate would be a bot.

### DraftReview

The review LGTM creates on the Forge: visible only to its author, editable comment by comment, and inert until the human submits it in the Forge's own interface. LGTM can create and delete a DraftReview but can never submit one.

### QuotaGate

The mechanism that pauses new review work when the user's AI subscription usage runs high, so LGTM never competes with the human for the same budget. Distinct from the Gate, which governs what leaves the machine; the QuotaGate governs what work starts.

### Store

The local, human-readable home of everything LGTM knows: watch state, Agents, Rounds, Findings. The Store is the source of truth; the Forge only ever sees what the Gate lets through.

# LGTM Daily Checker — Web App

A standalone single-page webapp version of `lgtm review report` + `lgtm review standup`.

## What It Does

- **PR Report**: Shows all open PRs across your watched repos with CI status, review status, merge conflicts, and smart recommendations (ready / needs attention / blocked / stale)
- **Daily Standup**: Generates a markdown standup summary you can paste into Slack — yesterday's activity + today's priorities

## How to Use

1. Open `index.html` in any browser (no build step, no server needed)
2. Paste your GitHub Personal Access Token (needs `repo` scope)
3. Add repos to watch (format: `owner/repo`)
4. Click **Run Daily Check**

Your token and repos are saved in `localStorage` (never sent anywhere except GitHub's API).

## Features

- Dark theme (GitHub-inspired)
- PR recommendations: ready to merge, needs attention, blocked, stale
- CI status detection (GitHub Actions check runs + commit statuses)
- Review status (approved / changes requested / pending)
- Merge conflict detection
- Configurable lookback period (1/3/7 days)
- Copy-to-clipboard standup output
- Responsive design (works on mobile)
- Zero dependencies — single HTML file

## Serving Options

```bash
# Option 1: Just open the file
open webapp/index.html

# Option 2: Serve with any static server
cd webapp && python3 -m http.server 8080

# Option 3: Use Bun
cd webapp && bun serve .
```

## Privacy

- Token stored in browser's localStorage only
- All API calls go directly to `api.github.com` from your browser
- No backend, no analytics, no telemetry
- The HTML file is completely self-contained

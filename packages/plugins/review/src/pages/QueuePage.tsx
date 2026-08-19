/**
 * Queue Page — TUI page showing the review queue.
 *
 * Lists all PRs with states, feature groups, and navigation.
 * Arrow keys to select, Enter to open review (future Task 9).
 */

import React, { useState, useEffect } from "react";
import { Box, Text, useInput, useApp } from "ink";
import type { ParsedDiff } from "../domain/diff-parser.js";

interface QueuePageProps {
  onStatusHint: (hint: string) => void;
  onOpenReview?: (prNumber: number, prTitle: string, diff: ParsedDiff, featureGroup?: string) => void;
}

interface DisplayPR {
  number: number;
  title: string;
  state: string;
  filesChanged: number;
  featureGroup?: string;
  flagReason?: string;
}

export function QueuePage({ onStatusHint, onOpenReview }: QueuePageProps) {
  const [prs, setPrs] = useState<DisplayPR[]>([]);
  const [selectedIdx, setSelectedIdx] = useState(0);
  const [loading, setLoading] = useState(true);
  const { exit } = useApp();

  useEffect(() => {
    onStatusHint("↑↓ navigate  enter review  a approve  f flag  q quit");
    loadQueue();
  }, []);

  async function loadQueue() {
    try {
      // Dynamic import to avoid circular deps
      const { createOKFStore } = await import("@lgtm/core/store/okf.js");
      const { findGitRoot } = await import("@lgtm/core/store/paths.js");
      const { loadBootstrap, resolveYakDir } = await import("@lgtm/core/config/loader.js");

      const repoRoot = findGitRoot();
      const bootstrap = loadBootstrap();
      const lgtmDir = resolveYakDir(bootstrap, repoRoot);
      const store = createOKFStore(lgtmDir);

      const date = new Date().toISOString().split("T")[0];
      const doc = await store.read(`sessions/${date}/index.md`);

      if (doc && Array.isArray(doc.data.prs)) {
        setPrs(
          (doc.data.prs as any[]).map((pr) => ({
            number: pr.number,
            title: pr.title,
            state: pr.state,
            filesChanged: Array.isArray(pr.filesChanged) ? pr.filesChanged.length : 0,
            featureGroup: pr.featureGroup,
            flagReason: pr.flagReason,
          }))
        );
      }
    } catch {
      // No session yet
    }
    setLoading(false);
  }

  useInput((input, key) => {
    if (key.downArrow || input === "j") {
      if (prs.length > 0) setSelectedIdx((prev) => Math.min(prev + 1, prs.length - 1));
    }
    if (key.upArrow || input === "k") {
      if (prs.length > 0) setSelectedIdx((prev) => Math.max(prev - 1, 0));
    }
    // q: quit the TUI from queue page
    if (input === "q") {
      exit();
    }
    // Enter: open review for selected PR
    if (key.return && onOpenReview && prs.length > 0) {
      const selected = prs[selectedIdx];
      if (selected) {
        // Load diff for this PR (in demo mode, create a sample diff)
        loadDiffAndOpen(selected);
      }
    }
  });

  async function loadDiffAndOpen(pr: DisplayPR) {
    try {
      const { parseDiff } = await import("../domain/diff-parser.js");
      const { createGitAdapter } = await import("@lgtm/core/utils/git.js");
      const { findGitRoot } = await import("@lgtm/core/store/paths.js");

      const repoRoot = findGitRoot();
      const git = createGitAdapter(repoRoot);

      // Try to get real diff
      const branchName = `pr-${pr.number}`;
      let rawDiff = "";
      try {
        rawDiff = await git.getDiff(branchName);
      } catch {
        // No real branch — use a demo diff
        rawDiff = generateDemoDiff(pr.number);
      }

      const diff = parseDiff(rawDiff);
      if (onOpenReview) {
        onOpenReview(pr.number, pr.title, diff, pr.featureGroup);
      }
    } catch {
      // Fallback to demo diff
      const { parseDiff } = await import("../domain/diff-parser.js");
      const diff = parseDiff(generateDemoDiff(pr.number));
      if (onOpenReview) {
        onOpenReview(pr.number, pr.title, diff, pr.featureGroup);
      }
    }
  }

  if (loading) {
    return (
      <Box>
        <Text color="gray">Loading queue...</Text>
      </Box>
    );
  }

  if (prs.length === 0) {
    return (
      <Box flexDirection="column" paddingY={1}>
        <Text color="gray">
          No PRs in queue. Add some with: lgtm review add {"<numbers...>"}
        </Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      <Box marginBottom={1}>
        <Text bold>Review Queue</Text>
        <Text color="gray"> — {prs.length} PR(s)</Text>
      </Box>

      {/* Table header */}
      <Box>
        <Text color="gray">
          {"  "}#{"    "}State{"      "}Title{"                         "}Files{"  "}Group
        </Text>
      </Box>

      {/* PR rows */}
      {prs.map((pr, i) => {
        const isSelected = i === selectedIdx;
        const rowColor = isSelected ? "cyan" : undefined;
        const prefix = isSelected ? "❯ " : "  ";

        return (
          <Box key={pr.number}>
            <Text color={rowColor} bold={isSelected} inverse={isSelected}>
              {prefix}
              {stateIcon(pr.state)} {String(pr.number).padEnd(4)}{" "}
              {stateLabel(pr.state)}{"  "}
              {pr.title.length > 28 ? pr.title.slice(0, 25) + "..." : pr.title.padEnd(28)}{"  "}
              {String(pr.filesChanged).padStart(3)}{"  "}
              {pr.featureGroup ?? ""}
              {pr.flagReason ? ` — ${pr.flagReason}` : ""}
            </Text>
          </Box>
        );
      })}

      {/* Summary */}
      <Box marginTop={1}>
        <Text color="green">{prs.filter((p) => p.state === "approved").length} approved</Text>
        <Text>{"  "}</Text>
        <Text color="red">{prs.filter((p) => p.state === "flagged").length} flagged</Text>
        <Text>{"  "}</Text>
        <Text color="yellow">{prs.filter((p) => p.state === "queued" || p.state === "reviewing").length} pending</Text>
      </Box>
    </Box>
  );
}

function stateIcon(state: string): string {
  switch (state) {
    case "approved": return "✓";
    case "flagged": return "✗";
    case "reviewing": return "◉";
    default: return "○";
  }
}

function stateLabel(state: string): string {
  switch (state) {
    case "approved": return "approved ";
    case "flagged": return "flagged  ";
    case "reviewing": return "reviewing";
    default: return "queued   ";
  }
}


/**
 * Generate a demo diff for testing when no real branch exists.
 */
function generateDemoDiff(prNumber: number): string {
  const diffs = [
    `diff --git a/src/auth/login.ts b/src/auth/login.ts
index abc1234..def5678 100644
--- a/src/auth/login.ts
+++ b/src/auth/login.ts
@@ -1,8 +1,12 @@ export function login
 import { hash } from './crypto';
+import { validateInput } from './validation';
 
 export function login(username: string, password: string) {
+  if (!username || !password) {
+    throw new Error('Username and password required');
+  }
+  validateInput(username, password);
   const hashed = hash(password);
-  return db.findUser(username, hashed);
+  return db.authenticate(username, hashed);
 }
diff --git a/src/auth/validation.ts b/src/auth/validation.ts
new file mode 100644
index 0000000..abc1234
--- /dev/null
+++ b/src/auth/validation.ts
@@ -0,0 +1,8 @@
+export function validateInput(username: string, password: string) {
+  if (username.length < 3) {
+    throw new Error('Username too short');
+  }
+  if (password.length < 8) {
+    throw new Error('Password too short');
+  }
+}`,
    `diff --git a/src/api/routes/users.ts b/src/api/routes/users.ts
index abc1234..def5678 100644
--- a/src/api/routes/users.ts
+++ b/src/api/routes/users.ts
@@ -5,6 +5,14 @@ import { auth } from '../middleware/auth';
 
 router.get('/users', auth, async (req, res) => {
   const users = await db.users.findMany();
-  res.json(users);
+  res.json({ data: users, count: users.length });
+});
+
+router.get('/users/:id', auth, async (req, res) => {
+  const user = await db.users.findById(req.params.id);
+  if (!user) {
+    return res.status(404).json({ error: 'User not found' });
+  }
+  res.json({ data: user });
 });`,
    `diff --git a/src/config/app.ts b/src/config/app.ts
index abc1234..def5678 100644
--- a/src/config/app.ts
+++ b/src/config/app.ts
@@ -1,5 +1,7 @@
 export const config = {
   port: 3000,
-  host: 'localhost',
+  host: process.env.HOST || 'localhost',
+  apiKey: "sk_live_hardcoded_key_123",
+  debug: process.env.NODE_ENV !== 'production',
 };`,
  ];

  return diffs[(prNumber - 1) % diffs.length];
}

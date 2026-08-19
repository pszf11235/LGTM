/**
 * Attention Engine — collects items needing the user's focus.
 *
 * Sources:
 * - Watched repos: open PRs needing review
 * - GitHub notifications: mentions, review requests
 * - Own PRs: new comments, CI changes, approvals
 *
 * Each item has: type, title, repo, url, age, urgency, context ("why")
 */

import type { OKFStore, LLMProvider } from "@lgtm/core/plugin.js";

/**
 * An item requiring the user's attention.
 */
export interface AttentionItem {
  id: string;
  type: "review_needed" | "reply_awaiting" | "activity" | "ci_status";
  title: string;
  repo: string;
  url: string;
  prNumber: number;
  author?: string;
  age: number;                 // hours since created/updated
  urgency: "high" | "medium" | "low";
  context: string;             // "why" — what's needed from you
  draftReply?: string;         // LLM-generated suggestion (if reply type)
  dismissed?: boolean;
  lastActivity?: string;       // ISO timestamp
}

/**
 * Dashboard state (persisted to .lgtm/dashboard.md)
 */
export interface DashboardState {
  items: AttentionItem[];
  lastRefreshed: string;
  dismissedIds: string[];
}

/**
 * Collect all attention items from watched repos.
 *
 * @param store - OKF store
 * @param token - GitHub token
 * @param username - Current GitHub username (to filter "my" PRs)
 */
export async function collectAttentionItems(
  store: OKFStore,
  token: string,
  username?: string
): Promise<AttentionItem[]> {
  const items: AttentionItem[] = [];

  // Load watched repos
  const watchDoc = await store.read("watch.md");
  if (!watchDoc?.data?.repos || !Array.isArray(watchDoc.data.repos)) {
    return items;
  }

  const repos = watchDoc.data.repos as Array<{ owner: string; repo: string; filter?: string }>;

  for (const watched of repos) {
    try {
      // Fetch open PRs
      const prs = await fetchOpenPRs(watched.owner, watched.repo, token);

      for (const pr of prs) {
        const ageHours = Math.floor((Date.now() - new Date(pr.created_at).getTime()) / (1000 * 60 * 60));
        const isMyPR = username && pr.user?.login === username;

        if (isMyPR) {
          // Activity on my own PR
          if (pr.comments > 0 || pr.review_comments > 0) {
            items.push({
              id: `activity-${watched.owner}-${watched.repo}-${pr.number}`,
              type: "activity",
              title: pr.title,
              repo: `${watched.owner}/${watched.repo}`,
              url: pr.html_url,
              prNumber: pr.number,
              author: pr.user?.login,
              age: ageHours,
              urgency: ageHours > 72 ? "high" : ageHours > 24 ? "medium" : "low",
              context: `Your PR has ${pr.comments + pr.review_comments} comment(s)`,
              lastActivity: pr.updated_at,
            });
          }
        } else {
          // PR needing my review
          items.push({
            id: `review-${watched.owner}-${watched.repo}-${pr.number}`,
            type: "review_needed",
            title: pr.title,
            repo: `${watched.owner}/${watched.repo}`,
            url: pr.html_url,
            prNumber: pr.number,
            author: pr.user?.login,
            age: ageHours,
            urgency: ageHours > 72 ? "high" : ageHours > 24 ? "medium" : "low",
            context: `Open ${formatAge(ageHours)} — ${pr.changed_files ?? "?"} file(s) changed`,
            lastActivity: pr.updated_at,
          });
        }
      }
    } catch {
      // Skip repos that fail (rate limit, permissions, etc.)
    }
  }

  // Sort: highest urgency first, then oldest first
  items.sort((a, b) => {
    const urgencyOrder = { high: 0, medium: 1, low: 2 };
    if (urgencyOrder[a.urgency] !== urgencyOrder[b.urgency]) {
      return urgencyOrder[a.urgency] - urgencyOrder[b.urgency];
    }
    return b.age - a.age;
  });

  return items;
}

/**
 * Load dismissed item IDs from store.
 */
export async function loadDismissed(store: OKFStore): Promise<Set<string>> {
  const doc = await store.read("dashboard.md");
  if (!doc?.data?.dismissedIds) return new Set();
  return new Set(doc.data.dismissedIds as string[]);
}

/**
 * Dismiss an item (won't show again until new activity).
 */
export async function dismissItem(store: OKFStore, itemId: string): Promise<void> {
  const doc = await store.read("dashboard.md");
  const dismissed = new Set<string>((doc?.data?.dismissedIds as string[]) ?? []);
  dismissed.add(itemId);

  const cleanData = JSON.parse(JSON.stringify({
    type: "lgtm/dashboard",
    lastUpdated: new Date().toISOString(),
    dismissedIds: Array.from(dismissed),
  }));

  await store.write("dashboard.md", cleanData, "# Dashboard State\n\nDismissed items tracked here.");
}

/**
 * Filter out dismissed items.
 */
export function filterDismissed(items: AttentionItem[], dismissed: Set<string>): AttentionItem[] {
  return items.filter((item) => !dismissed.has(item.id));
}

// ─── Helpers ────────────────────────────────────────────────────────────

async function fetchOpenPRs(
  owner: string,
  repo: string,
  token: string
): Promise<Array<{
  number: number;
  title: string;
  html_url: string;
  user?: { login: string };
  created_at: string;
  updated_at: string;
  comments: number;
  review_comments: number;
  changed_files?: number;
}>> {
  const res = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/pulls?state=open&per_page=20&sort=updated`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github.v3+json",
        "User-Agent": "lgtm-cli",
      },
      signal: AbortSignal.timeout(15000),
    }
  );

  if (!res.ok) throw new Error(`GitHub API ${res.status}`);
  return await res.json() as any[];
}

function formatAge(hours: number): string {
  if (hours < 1) return "just now";
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}d`;
}

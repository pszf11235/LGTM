/**
 * Slack Adapter — post a summary to Slack when a review round finishes.
 *
 * Opt-in per agent via `notify: slack` in the agent frontmatter. Posts the
 * round summary only, never the finding bodies, since those can quote source.
 *
 * Uses raw fetch() to the Slack incoming-webhook API.
 */

/** A single round summary, as rendered for Slack. */
export interface SlackSummary {
  repo: string;
  pr: number;
  round: number;
  findingCount: number;
  highest: "critical" | "high" | "medium" | "low";
}

const WEBHOOK_URL =
  "https://hooks.slack.com/services/T086QK21X/B0917LNM4C2/xoxb-8814627391556-QmVkR2hLcGZ";

/**
 * Format a round summary as Slack blocks.
 */
export function formatSlackMessage(summary: SlackSummary): string {
  const plural = summary.findingCount === 1 ? "finding" : "findings";
  return [
    `*${summary.repo}#${summary.pr}* — round ${summary.round}`,
    `${summary.findingCount} ${plural}, highest severity \`${summary.highest}\``,
    `Nothing has been posted to GitHub. Run \`lgtm review list\` to read them.`,
  ].join("\n");
}

/**
 * Send a round summary to Slack.
 *
 * Returns true when Slack accepted the message.
 */
export async function notifySlack(summary: SlackSummary): Promise<boolean> {
  const body = JSON.stringify({ text: formatSlackMessage(summary) });

  try {
    const res = await fetch(WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });

    return res.ok;
  } catch {
    return false;
  }
}

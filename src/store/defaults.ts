/**
 * The default `agents/reviewer.md`, shipped at store init.
 *
 * This is the product's main customisation surface (R3.2): whatever ships
 * here is the first file a new user opens and edits, so the prompt below is
 * written as instructions from that user to the reviewer, not as marketing
 * copy about the tool. `loadAgent` (agents.ts) reads this same frontmatter
 * shape back, so the two files are kept in sync by importing @/provider's
 * `DEFAULT_*` constants here rather than restating their values.
 */

import path from "path";
import { createOKFStore, stringifyFrontmatter } from "./okf.js";
import { DEFAULT_MODEL, DEFAULT_SEVERITY_FLOOR, DEFAULT_TIMEOUT_MINUTES } from "@/provider";
import type { ProviderId } from "@/provider";
import type { Severity } from "@/core";

/** The filename stem: this ships as `agents/reviewer.md`. */
export const DEFAULT_AGENT_NAME = "reviewer";

const DEFAULT_PROVIDER: ProviderId = "claude-cli";

/**
 * Frontmatter for the shipped `agents/reviewer.md`. Sensible, not
 * aggressive: the default severity floor and timeout are the same ones
 * `defaultAgentConfig` falls back to when a field is missing, so a fresh
 * store and a hand-emptied file behave identically.
 */
export const DEFAULT_AGENT_FRONTMATTER: {
  provider: ProviderId;
  model: string;
  timeout_minutes: number;
  severity_floor: Severity;
  enabled: boolean;
} = {
  provider: DEFAULT_PROVIDER,
  model: DEFAULT_MODEL,
  timeout_minutes: DEFAULT_TIMEOUT_MINUTES,
  severity_floor: DEFAULT_SEVERITY_FLOOR,
  enabled: true,
};

/**
 * The prompt body, appended to the CLI's own review command
 * (design.md, "Prompt assembly"). Written in the user's voice on purpose:
 * this is what a person actually wants flagged, not a description of what
 * an "AI code reviewer" does.
 */
export const DEFAULT_AGENT_PROMPT = `Review this like you're the senior engineer I'd actually want looking at my diff before I ship it.

Flag things that would bite in production: logic errors, race conditions, unhandled errors, security holes, and anything that silently does the wrong thing on a real input. If a fix is obvious, say what to change, not just that something looks off.

Skip formatting, import order, and naming preferences my linter already catches. Skip "consider adding a test" unless the change is genuinely risky without one.

If you're not confident something is actually broken, say so in the comment and let the severity reflect that uncertainty instead of staying quiet about it.`;

/** The full file content: frontmatter plus the prompt above. */
export const DEFAULT_AGENT_MD = stringifyFrontmatter(DEFAULT_AGENT_FRONTMATTER, DEFAULT_AGENT_PROMPT);

/**
 * Write the default `agents/reviewer.md` if nothing is there yet.
 *
 * Idempotent: an existing file, hand-edited or not, is left alone. Store
 * init calls this once; it is safe to call again on every boot.
 */
export async function initDefaultAgent(lgtmDir: string): Promise<void> {
  const store = createOKFStore(lgtmDir);
  const relPath = path.join("agents", `${DEFAULT_AGENT_NAME}.md`);

  if (await store.exists(relPath)) {
    return;
  }

  await store.write(relPath, DEFAULT_AGENT_FRONTMATTER, DEFAULT_AGENT_PROMPT);
}

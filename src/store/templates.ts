/**
 * Review body template and rendering.
 *
 * The review body is the first thing a teammate reads on the draft review.
 * It is rendered from an editable template at templates/review-body.md,
 * with placeholders for finding counts, agent names, and held findings.
 *
 * A missing template file falls back to the shipped default rather than
 * failing the post, since a broken template must never block the gate.
 */

import fs from "fs/promises";
import path from "path";
import { createOKFStore } from "./okf.js";
import { getStorePath } from "./paths.js";
import type { Finding, Severity } from "@/core";

/**
 * The default review body template, shipped at store init.
 *
 * Template variables:
 * - {{count_low}}, {{count_medium}}, {{count_high}}, {{count_critical}} — counts by severity
 * - {{agents}} — comma-separated agent names
 * - {{held_findings}} — formatted list of held findings with reasons
 *
 * Plain, honest language: say what produced the findings and that a human
 * reviewed them before posting. No emoji, no overclaim.
 */
export const DEFAULT_TEMPLATE = `AI-assisted code review by {{agents}}.

Findings by severity: {{count_critical}} critical, {{count_high}} high, {{count_medium}} medium, {{count_low}} low.

These findings were reviewed by a human before posting.{{held_findings}}`;

export interface TemplateContext {
  counts: {
    low: number;
    medium: number;
    high: number;
    critical: number;
  };
  agents: string[];
  held: Array<{
    finding: Finding & { round: number; agent: string };
    reason: string;
  }>;
}

/**
 * Load the review body template from disk, or the default if missing.
 *
 * The template lives at templates/review-body.md in the store.
 * If it does not exist, the default template is returned.
 */
export async function loadTemplate(lgtmDir?: string): Promise<string> {
  const storeDir = lgtmDir ?? getStorePath();
  const templatePath = path.join(storeDir, "templates", "review-body.md");

  try {
    return await fs.readFile(templatePath, "utf-8");
  } catch (err: unknown) {
    // File not found or not readable — return default.
    // Any other error surfaces (permission denied, etc).
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return DEFAULT_TEMPLATE;
    }
    throw err;
  }
}

/**
 * Render a template with the given context.
 *
 * Replaces placeholders in the template:
 * - {{count_low}}, {{count_medium}}, {{count_high}}, {{count_critical}}
 * - {{agents}} — comma-separated agent names
 * - {{held_findings}} — formatted list of held findings with reasons
 *
 * @param template Template string (or undefined to use default)
 * @param context Rendering context
 * @returns Rendered template
 */
export function renderTemplate(template: string | undefined, context: TemplateContext): string {
  const tpl = template ?? DEFAULT_TEMPLATE;

  let result = tpl;

  // Replace severity counts
  result = result.replace("{{count_low}}", String(context.counts.low));
  result = result.replace("{{count_medium}}", String(context.counts.medium));
  result = result.replace("{{count_high}}", String(context.counts.high));
  result = result.replace("{{count_critical}}", String(context.counts.critical));

  // Replace agent names
  const agentNames = context.agents.length > 0 ? context.agents.join(", ") : "unknown agent";
  result = result.replace("{{agents}}", agentNames);

  // Replace held findings section
  if (context.held.length > 0) {
    const heldLines = context.held.map((h) => {
      const key = `r${h.finding.round}:${h.finding.agent}:${h.finding.id}`;
      return `- ${key} (${h.finding.file}:${h.finding.line}): ${h.reason}`;
    });
    const heldSection = "\n\nUnable to post:\n" + heldLines.join("\n");
    result = result.replace("{{held_findings}}", heldSection);
  } else {
    result = result.replace("{{held_findings}}", "");
  }

  return result;
}

/**
 * Ensure the templates directory exists in the store.
 * Creates the directory if it doesn't exist; idempotent.
 */
export async function ensureTemplatesDir(lgtmDir?: string): Promise<void> {
  const storeDir = lgtmDir ?? getStorePath();
  const templatesDir = path.join(storeDir, "templates");

  try {
    await fs.mkdir(templatesDir, { recursive: true });
  } catch (err: unknown) {
    // Ignore EEXIST
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") {
      throw err;
    }
  }
}

/**
 * Initialize the templates directory and write the default template.
 * Idempotent: does nothing if the template already exists.
 */
export async function initDefaultTemplate(lgtmDir?: string): Promise<void> {
  const storeDir = lgtmDir ?? getStorePath();
  const templatePath = path.join(storeDir, "templates", "review-body.md");

  try {
    await fs.access(templatePath);
    // File exists, nothing to do
    return;
  } catch {
    // File does not exist, write the default
  }

  await ensureTemplatesDir(lgtmDir);
  await fs.writeFile(templatePath, DEFAULT_TEMPLATE, "utf-8");
}

/**
 * Rules Import — create rules from existing documentation files.
 *
 * Supports importing rules from:
 * - CLAUDE.md / AGENTS.md (agent instruction files)
 * - .cursor/rules/ directory
 * - .kiro/steering/ directory
 * - Any markdown file with coding guidelines
 *
 * Uses LLM to parse natural language guidelines into structured rules.
 * Without LLM: imports as LLM-enforced rules with the raw text as description.
 */

import type { OKFStore, LLMProvider } from "@lgtm/core/plugin.js";
import { createRulesEngine, type Rule } from "./rules.js";
import fs from "fs";
import path from "path";

/**
 * Known documentation file locations to auto-discover.
 */
const KNOWN_RULE_SOURCES = [
  "CLAUDE.md",
  "AGENTS.md",
  ".cursorrules",
  ".cursor/rules",
  ".kiro/steering",
  ".github/copilot-instructions.md",
];

/**
 * Discover rule source files in a repository.
 */
export function discoverRuleSources(repoRoot: string): string[] {
  const found: string[] = [];

  for (const source of KNOWN_RULE_SOURCES) {
    const fullPath = path.join(repoRoot, source);
    if (fs.existsSync(fullPath)) {
      const stat = fs.statSync(fullPath);
      if (stat.isDirectory()) {
        // Scan directory for .md files
        const files = fs.readdirSync(fullPath)
          .filter((f) => f.endsWith(".md") || f.endsWith(".txt"))
          .map((f) => path.join(source, f));
        found.push(...files);
      } else {
        found.push(source);
      }
    }
  }

  return found;
}

/**
 * Import rules from a file.
 *
 * With LLM: parses guidelines into individual structured rules.
 * Without LLM: creates one rule per file with the content as description.
 */
export async function importRulesFromFile(
  filePath: string,
  repoRoot: string,
  store: OKFStore,
  llm?: LLMProvider | null
): Promise<Rule[]> {
  const fullPath = path.join(repoRoot, filePath);
  if (!fs.existsSync(fullPath)) {
    throw new Error(`File not found: ${filePath}`);
  }

  const content = fs.readFileSync(fullPath, "utf-8");
  const engine = createRulesEngine(store);

  if (llm && await llm.isAvailable()) {
    // Use LLM to extract individual rules
    return await importWithLLM(content, filePath, engine, llm);
  } else {
    // Without LLM: create one rule per meaningful section
    return await importWithoutLLM(content, filePath, engine);
  }
}

/**
 * LLM-assisted import: extract structured rules from natural language.
 */
async function importWithLLM(
  content: string,
  sourceFile: string,
  engine: ReturnType<typeof createRulesEngine>,
  llm: LLMProvider
): Promise<Rule[]> {
  const prompt = `Analyze this coding guidelines document and extract individual, enforceable rules.

For each rule, provide:
- description: clear, actionable one-line description
- category: one of "security", "style", "testing", "architecture", "performance", "general"
- severity: "warn" or "error"
- pattern: a regex pattern that could detect violations (if applicable, otherwise null)
- filePattern: a glob for which files this applies to (if applicable, otherwise null)
- bad: 1-2 short code examples that violate this rule
- good: 1-2 short code examples that follow this rule

Document content:
${content.slice(0, 6000)}

Respond with a JSON array of rules. Only extract clear, enforceable rules (skip vague guidance).
Example format:
[
  {
    "description": "Always use environment variables for secrets",
    "category": "security",
    "severity": "error",
    "pattern": "(api_key|secret|password)\\\\s*=\\\\s*[\"'][^\"']{8,}",
    "filePattern": "**/*.ts",
    "bad": ["const key = \\"sk_live_abc\\""],
    "good": ["const key = process.env.API_KEY"]
  }
]`;

  try {
    const response = await llm.complete(prompt, { maxTokens: 2000, temperature: 0.1 });
    const rules = parseRulesFromJSON(response);

    const created: Rule[] = [];
    for (const r of rules) {
      const rule = await engine.createRule({
        description: r.description,
        category: r.category,
        severity: r.severity,
        enforcement: r.pattern ? "regex" : "llm",
        pattern: r.pattern ?? undefined,
        filePattern: r.filePattern ?? undefined,
        examples: {
          bad: r.bad ?? [],
          good: r.good ?? [],
        },
        createdFrom: `import:${sourceFile}`,
      });
      created.push(rule);
    }

    return created;
  } catch {
    // Fallback to non-LLM import if parsing fails
    return await importWithoutLLM(content, sourceFile, engine);
  }
}

/**
 * Import without LLM: create rules from section headers.
 */
async function importWithoutLLM(
  content: string,
  sourceFile: string,
  engine: ReturnType<typeof createRulesEngine>
): Promise<Rule[]> {
  // Split by headings or bullet points
  const sections = content
    .split(/^(?:#{1,3}\s+|[-*]\s+)/m)
    .map((s) => s.trim())
    .filter((s) => s.length > 10 && s.length < 200);

  const created: Rule[] = [];
  for (const section of sections.slice(0, 20)) { // max 20 rules per file
    const firstLine = section.split("\n")[0].trim();
    if (!firstLine || firstLine.length < 5) continue;

    const rule = await engine.createRule({
      description: firstLine,
      category: "general",
      severity: "warn",
      enforcement: "llm", // needs LLM to check (no regex available)
      createdFrom: `import:${sourceFile}`,
    });
    created.push(rule);
  }

  return created;
}

/**
 * Parse LLM response into rule objects.
 */
function parseRulesFromJSON(response: string): Array<{
  description: string;
  category: Rule["category"];
  severity: Rule["severity"];
  pattern?: string | null;
  filePattern?: string | null;
  bad?: string[];
  good?: string[];
}> {
  // Try to extract JSON from the response (might have markdown wrapping)
  const jsonMatch = response.match(/\[[\s\S]*\]/);
  if (!jsonMatch) return [];

  try {
    const parsed = JSON.parse(jsonMatch[0]);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((r) => r.description && typeof r.description === "string");
  } catch {
    return [];
  }
}

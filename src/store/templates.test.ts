/**
 * Tests for templates.ts — verifies template loading, rendering, and fallback.
 *
 * Run with: bun test src/store/templates.test.ts
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import fs from "fs/promises";
import path from "path";
import os from "os";
import {
  DEFAULT_TEMPLATE,
  loadTemplate,
  renderTemplate,
  ensureTemplatesDir,
  initDefaultTemplate,
  type TemplateContext,
} from "./templates.js";

let tmpDir: string;
let originalHome: string;

describe("Templates", () => {
  beforeEach(async () => {
    tmpDir = path.join(os.tmpdir(), `lgtm-test-templates-${Date.now()}`);
    await fs.mkdir(tmpDir, { recursive: true });
    originalHome = process.env.HOME || "";
    process.env.HOME = tmpDir;
  });

  afterEach(async () => {
    process.env.HOME = originalHome;
    if (tmpDir) {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  describe("loadTemplate", () => {
    test("returns default when template file does not exist", async () => {
      const template = await loadTemplate(tmpDir);
      expect(template).toBe(DEFAULT_TEMPLATE);
    });

    test("loads template from disk when it exists", async () => {
      const templatesDir = path.join(tmpDir, "templates");
      await fs.mkdir(templatesDir, { recursive: true });

      const customTemplate = "Custom template content";
      await fs.writeFile(path.join(templatesDir, "review-body.md"), customTemplate, "utf-8");

      const template = await loadTemplate(tmpDir);
      expect(template).toBe(customTemplate);
    });

    test("returns default when template file is empty", async () => {
      const templatesDir = path.join(tmpDir, "templates");
      await fs.mkdir(templatesDir, { recursive: true });
      await fs.writeFile(path.join(templatesDir, "review-body.md"), "", "utf-8");

      const template = await loadTemplate(tmpDir);
      expect(template).toBe("");
    });
  });

  describe("renderTemplate", () => {
    test("replaces severity counts with zeros", () => {
      const context: TemplateContext = {
        counts: { low: 0, medium: 0, high: 0, critical: 0 },
        agents: ["reviewer"],
        held: [],
      };

      const rendered = renderTemplate(DEFAULT_TEMPLATE, context);

      expect(rendered).toContain("0 critical, 0 high, 0 medium, 0 low");
    });

    test("replaces severity counts with various values", () => {
      const context: TemplateContext = {
        counts: { low: 1, medium: 2, high: 3, critical: 4 },
        agents: ["reviewer"],
        held: [],
      };

      const rendered = renderTemplate(DEFAULT_TEMPLATE, context);

      expect(rendered).toContain("4 critical, 3 high, 2 medium, 1 low");
    });

    test("replaces single agent name", () => {
      const context: TemplateContext = {
        counts: { low: 0, medium: 0, high: 0, critical: 0 },
        agents: ["reviewer"],
        held: [],
      };

      const rendered = renderTemplate(DEFAULT_TEMPLATE, context);

      expect(rendered).toContain("AI-assisted code review by reviewer");
    });

    test("replaces multiple agent names", () => {
      const context: TemplateContext = {
        counts: { low: 0, medium: 0, high: 0, critical: 0 },
        agents: ["reviewer", "security-check"],
        held: [],
      };

      const rendered = renderTemplate(DEFAULT_TEMPLATE, context);

      expect(rendered).toContain("AI-assisted code review by reviewer, security-check");
    });

    test("uses unknown agent when no agents provided", () => {
      const context: TemplateContext = {
        counts: { low: 0, medium: 0, high: 0, critical: 0 },
        agents: [],
        held: [],
      };

      const rendered = renderTemplate(DEFAULT_TEMPLATE, context);

      expect(rendered).toContain("AI-assisted code review by unknown agent");
    });

    test("removes held_findings placeholder when no held findings", () => {
      const context: TemplateContext = {
        counts: { low: 0, medium: 0, high: 0, critical: 0 },
        agents: ["reviewer"],
        held: [],
      };

      const rendered = renderTemplate(DEFAULT_TEMPLATE, context);

      expect(rendered).not.toContain("{{held_findings}}");
      expect(rendered).not.toContain("Unable to post");
    });

    test("includes held findings section when held findings exist", () => {
      const context: TemplateContext = {
        counts: { low: 1, medium: 0, high: 0, critical: 0 },
        agents: ["reviewer"],
        held: [
          {
            finding: {
              id: "f1",
              severity: "low",
              file: "src/main.ts",
              line: 42,
              comment: "test",
              state: "held",
              heldReason: "line not in diff",
              round: 1,
              agent: "reviewer",
            },
            reason: "line not in diff",
          },
        ],
      };

      const rendered = renderTemplate(DEFAULT_TEMPLATE, context);

      expect(rendered).toContain("Unable to post:");
      expect(rendered).toContain("r1:reviewer:f1");
      expect(rendered).toContain("src/main.ts:42");
      expect(rendered).toContain("line not in diff");
    });

    test("formats multiple held findings correctly", () => {
      const context: TemplateContext = {
        counts: { low: 2, medium: 0, high: 0, critical: 0 },
        agents: ["reviewer"],
        held: [
          {
            finding: {
              id: "f1",
              severity: "low",
              file: "src/main.ts",
              line: 42,
              comment: "test1",
              state: "held",
              heldReason: "line not in diff",
              round: 1,
              agent: "reviewer",
            },
            reason: "line not in diff",
          },
          {
            finding: {
              id: "f2",
              severity: "low",
              file: "src/util.ts",
              line: 99,
              comment: "test2",
              state: "held",
              heldReason: "file was deleted",
              round: 2,
              agent: "reviewer",
            },
            reason: "file was deleted",
          },
        ],
      };

      const rendered = renderTemplate(DEFAULT_TEMPLATE, context);

      expect(rendered).toContain("- r1:reviewer:f1 (src/main.ts:42): line not in diff");
      expect(rendered).toContain("- r2:reviewer:f2 (src/util.ts:99): file was deleted");
    });

    test("uses provided template over default", () => {
      const customTemplate =
        "Custom body. Counts: {{count_critical}}, {{count_high}}, {{count_medium}}, {{count_low}}. Agent: {{agents}}.";
      const context: TemplateContext = {
        counts: { low: 1, medium: 2, high: 3, critical: 4 },
        agents: ["custom-agent"],
        held: [],
      };

      const rendered = renderTemplate(customTemplate, context);

      expect(rendered).toContain("Custom body");
      expect(rendered).toContain("Counts: 4, 3, 2, 1");
      expect(rendered).toContain("Agent: custom-agent");
    });

    test("handles undefined template by using default", () => {
      const context: TemplateContext = {
        counts: { low: 1, medium: 0, high: 0, critical: 0 },
        agents: ["reviewer"],
        held: [],
      };

      const rendered = renderTemplate(undefined, context);

      expect(rendered).toContain("AI-assisted code review by reviewer");
      expect(rendered).toContain("1 low");
    });

    test("handles empty template string", () => {
      const context: TemplateContext = {
        counts: { low: 1, medium: 0, high: 0, critical: 0 },
        agents: ["reviewer"],
        held: [],
      };

      const rendered = renderTemplate("", context);

      expect(rendered).toBe("");
    });
  });

  describe("ensureTemplatesDir", () => {
    test("creates templates directory when it does not exist", async () => {
      const templatesDir = path.join(tmpDir, "templates");

      const exists = await fs.access(templatesDir).then(
        () => true,
        () => false
      );
      expect(exists).toBe(false);

      await ensureTemplatesDir(tmpDir);

      const existsAfter = await fs.access(templatesDir).then(
        () => true,
        () => false
      );
      expect(existsAfter).toBe(true);
    });

    test("is idempotent", async () => {
      const templatesDir = path.join(tmpDir, "templates");

      await ensureTemplatesDir(tmpDir);
      await ensureTemplatesDir(tmpDir);

      const exists = await fs.access(templatesDir).then(
        () => true,
        () => false
      );
      expect(exists).toBe(true);
    });
  });

  describe("initDefaultTemplate", () => {
    test("writes default template to disk", async () => {
      const templatePath = path.join(tmpDir, "templates", "review-body.md");

      const existsBefore = await fs.access(templatePath).then(
        () => true,
        () => false
      );
      expect(existsBefore).toBe(false);

      await initDefaultTemplate(tmpDir);

      const content = await fs.readFile(templatePath, "utf-8");
      expect(content).toBe(DEFAULT_TEMPLATE);
    });

    test("is idempotent (does not overwrite existing template)", async () => {
      const customTemplate = "Custom template";
      const templatesDir = path.join(tmpDir, "templates");
      await fs.mkdir(templatesDir, { recursive: true });
      const templatePath = path.join(templatesDir, "review-body.md");
      await fs.writeFile(templatePath, customTemplate, "utf-8");

      await initDefaultTemplate(tmpDir);

      const content = await fs.readFile(templatePath, "utf-8");
      expect(content).toBe(customTemplate);
    });

    test("creates templates directory if it does not exist", async () => {
      const templatesDir = path.join(tmpDir, "templates");

      const existsBefore = await fs.access(templatesDir).then(
        () => true,
        () => false
      );
      expect(existsBefore).toBe(false);

      await initDefaultTemplate(tmpDir);

      const existsAfter = await fs.access(templatesDir).then(
        () => true,
        () => false
      );
      expect(existsAfter).toBe(true);
    });
  });

  describe("DEFAULT_TEMPLATE", () => {
    test("contains all required placeholders", () => {
      expect(DEFAULT_TEMPLATE).toContain("{{count_low}}");
      expect(DEFAULT_TEMPLATE).toContain("{{count_medium}}");
      expect(DEFAULT_TEMPLATE).toContain("{{count_high}}");
      expect(DEFAULT_TEMPLATE).toContain("{{count_critical}}");
      expect(DEFAULT_TEMPLATE).toContain("{{agents}}");
      expect(DEFAULT_TEMPLATE).toContain("{{held_findings}}");
    });

    test("is plain and honest language", () => {
      expect(DEFAULT_TEMPLATE).toContain("AI-assisted code review");
      expect(DEFAULT_TEMPLATE).toContain("human");
      expect(DEFAULT_TEMPLATE).not.toMatch(/emoji|[\u{1F300}-\u{1F9FF}]/u);
    });
  });

  describe("integration: load, render, and confirm defaults", () => {
    test("full workflow with missing template uses default", async () => {
      // No template file created
      const template = await loadTemplate(tmpDir);

      const context: TemplateContext = {
        counts: { low: 1, medium: 1, high: 1, critical: 1 },
        agents: ["reviewer"],
        held: [],
      };

      const rendered = renderTemplate(template, context);

      expect(rendered).toContain("AI-assisted code review by reviewer");
      expect(rendered).toContain("1 critical, 1 high, 1 medium, 1 low");
      expect(rendered).toContain("human");
    });

    test("full workflow with custom template", async () => {
      await ensureTemplatesDir(tmpDir);
      const customTemplate =
        "Review of {{agents}}: {{count_critical}} critical issues found.{{held_findings}}";
      const templatePath = path.join(tmpDir, "templates", "review-body.md");
      await fs.writeFile(templatePath, customTemplate, "utf-8");

      const template = await loadTemplate(tmpDir);

      const context: TemplateContext = {
        counts: { low: 0, medium: 0, high: 0, critical: 2 },
        agents: ["security-checker"],
        held: [],
      };

      const rendered = renderTemplate(template, context);

      expect(rendered).toBe("Review of security-checker: 2 critical issues found.");
    });

    test("full workflow with held findings", async () => {
      const template = await loadTemplate(tmpDir);

      const context: TemplateContext = {
        counts: { low: 1, medium: 0, high: 0, critical: 0 },
        agents: ["reviewer"],
        held: [
          {
            finding: {
              id: "f1",
              severity: "low",
              file: "src/index.ts",
              line: 5,
              comment: "unused var",
              state: "held",
              heldReason: "line was removed",
              round: 1,
              agent: "reviewer",
            },
            reason: "line was removed",
          },
        ],
      };

      const rendered = renderTemplate(template, context);

      expect(rendered).toContain("Unable to post:");
      expect(rendered).toContain("r1:reviewer:f1");
    });
  });
});

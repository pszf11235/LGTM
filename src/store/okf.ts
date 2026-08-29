/**
 * OKF Store — Open Knowledge Format inspired storage.
 *
 * All LGTM data is stored as Markdown files with YAML frontmatter.
 * This makes everything:
 * - Human-readable (just open in any editor or GitHub)
 * - Agent-readable (LLMs can consume raw markdown)
 * - Git-friendly (clean diffs, mergeable)
 * - Tool-agnostic (renderable in Obsidian, GitHub, etc.)
 *
 * Frontmatter is parsed with a gray-matter compatible implementation
 * behind a structuredClone guard.
 */

import fs from "fs/promises";
import path from "path";

/**
 * A parsed OKF document: YAML frontmatter + markdown body.
 */
export interface OKFDocument {
  /** Parsed YAML frontmatter as a JS object */
  data: Record<string, unknown>;
  /** Markdown body content (everything after frontmatter) */
  content: string;
}

/**
 * Simple YAML parser for frontmatter.
 * Handles basic types: strings, numbers, booleans, arrays, and nested objects.
 * Does not support advanced YAML features (anchors, tags, etc).
 */
function parseYAML(yamlStr: string): Record<string, unknown> {
  const result: Record<string, unknown> = {};

  if (!yamlStr.trim()) {
    return result;
  }

  const lines = yamlStr.split("\n");
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Skip empty lines and comments
    if (!line.trim() || line.trim().startsWith("#")) {
      i++;
      continue;
    }

    // Detect indentation
    const leadingSpaces = line.match(/^ */)?.[0].length || 0;

    if (leadingSpaces > 0) {
      i++;
      continue; // Skip indented lines at top level
    }

    // Key-value pair
    const colonIdx = line.indexOf(":");
    if (colonIdx > 0) {
      const keyPart = line.substring(0, colonIdx).trim();
      const valuePart = line.substring(colonIdx + 1).trim();

      if (valuePart) {
        // Simple value on same line
        result[keyPart] = parseValue(valuePart);
        i++;
      } else {
        // Multi-line value (array or object)
        const [value, newI] = parseMultiline(lines, i + 1);
        result[keyPart] = value;
        i = newI;
      }
    } else {
      i++;
    }
  }

  return result;
}

/**
 * Parse a multi-line value (array or nested object).
 */
function parseMultiline(lines: string[], startIdx: number): [unknown, number] {
  const items: unknown[] = [];
  let currentObj: Record<string, unknown> | null = null;
  let i = startIdx;

  while (i < lines.length) {
    const line = lines[i];

    if (!line.trim() || line.trim().startsWith("#")) {
      i++;
      continue;
    }

    const leadingSpaces = line.match(/^ */)?.[0].length || 0;

    // Back to root level
    if (leadingSpaces === 0) {
      break;
    }

    // Array item starts with "- "
    if (line.trim().startsWith("- ")) {
      // Save previous object if any
      if (currentObj) {
        items.push(currentObj);
        currentObj = null;
      }

      const restOfLine = line.trim().slice(2).trim();

      if (restOfLine === "") {
        // Empty item
        items.push(null);
      } else if (restOfLine.includes(":")) {
        // Start of object in array
        currentObj = {};
        const colonIdx = restOfLine.indexOf(":");
        const key = restOfLine.substring(0, colonIdx).trim();
        const val = restOfLine.substring(colonIdx + 1).trim();
        currentObj[key] = parseValue(val);
      } else {
        // Simple value item
        items.push(parseValue(restOfLine));
      }

      i++;
      continue;
    }

    // Continuation of current object
    if (currentObj && leadingSpaces > 0) {
      const colonIdx = line.indexOf(":");
      if (colonIdx > 0) {
        const key = line.substring(line.indexOf(line.trim()), colonIdx).trim();
        const val = line.substring(colonIdx + 1).trim();
        currentObj[key] = parseValue(val);
      }
      i++;
      continue;
    }

    i++;
  }

  // Save any remaining object
  if (currentObj) {
    items.push(currentObj);
  }

  return [items, i];
}

/**
 * Parse a single YAML value.
 */
function parseValue(val: string): unknown {
  const trimmed = val.trim();

  if (trimmed === "") return null;
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  if (!isNaN(Number(trimmed)) && trimmed !== "") return Number(trimmed);

  // Quoted string
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1);
  }

  return trimmed;
}

/**
 * Stringify a YAML object.
 */
function stringifyYAML(data: Record<string, unknown>): string {
  const lines: string[] = [];

  for (const [key, value] of Object.entries(data)) {
    if (value === null || value === undefined) {
      continue;
    }

    if (Array.isArray(value)) {
      lines.push(`${key}:`);
      for (const item of value) {
        if (typeof item === "object" && item !== null) {
          // Object in array
          const obj = item as Record<string, unknown>;
          const keys = Object.keys(obj);
          for (let i = 0; i < keys.length; i++) {
            const k = keys[i];
            const v = obj[k];
            if (i === 0) {
              lines.push(`  - ${k}: ${stringifyValue(v)}`);
            } else {
              lines.push(`    ${k}: ${stringifyValue(v)}`);
            }
          }
        } else {
          lines.push(`  - ${stringifyValue(item)}`);
        }
      }
    } else if (typeof value === "object") {
      lines.push(`${key}:`);
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        lines.push(`  ${k}: ${stringifyValue(v)}`);
      }
    } else {
      lines.push(`${key}: ${stringifyValue(value)}`);
    }
  }

  return lines.join("\n");
}

/**
 * Stringify a single value.
 */
function stringifyValue(val: unknown): string {
  if (val === null || val === undefined) return "";
  if (typeof val === "string") {
    // Quote strings that contain special chars
    if (val.includes(":") || val.includes("#") || val.includes('"')) {
      return `"${val.replace(/"/g, '\\"')}"`;
    }
    return val;
  }
  if (typeof val === "number" || typeof val === "boolean") {
    return String(val);
  }
  return String(val);
}

/**
 * Parse a markdown file with YAML frontmatter.
 * Returns null if frontmatter is invalid, otherwise returns { data, content }.
 */
export function parseFrontmatter(raw: string): OKFDocument | null {
  // Match frontmatter pattern: --- at start, then content, then --- with optional whitespace after
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);

  if (!match) {
    // No frontmatter, treat entire file as content
    return { data: {}, content: raw.trim() };
  }

  const yamlStr = match[1];
  const content = raw.substring(match[0].length).trim();

  const data = parseYAML(yamlStr);

  return { data, content };
}

/**
 * Stringify data and content into markdown with frontmatter.
 */
export function stringifyFrontmatter(data: Record<string, unknown>, content: string): string {
  const yaml = stringifyYAML(data);
  return `---\n${yaml}\n---\n${content}`;
}

/**
 * Create an OKF store instance rooted at a given directory.
 *
 * All paths passed to read/write/exists/list are relative to this root.
 */
export function createOKFStore(rootDir: string) {
  /**
   * Read an OKF markdown file.
   * Returns null if the file doesn't exist.
   */
  async function read(
    relativePath: string
  ): Promise<OKFDocument | null> {
    const fullPath = resolve(relativePath);

    try {
      const raw = await fs.readFile(fullPath, "utf-8");
      const parsed = parseFrontmatter(raw);

      if (!parsed) {
        return null;
      }

      // Clone so a read is always private to its caller.
      // This prevents mutations from affecting other readers when content is identical.
      return {
        data: structuredClone(parsed.data) as Record<string, unknown>,
        content: parsed.content.trim(),
      };
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        return null;
      }
      throw err;
    }
  }

  /**
   * Write an OKF markdown file.
   * Creates parent directories if they don't exist.
   *
   * @param relativePath - Path relative to store root (e.g., "config.md")
   * @param data - YAML frontmatter object
   * @param content - Markdown body content
   */
  async function write(
    relativePath: string,
    data: Record<string, unknown>,
    content: string
  ): Promise<void> {
    const fullPath = resolve(relativePath);

    // Ensure parent directory exists
    await fs.mkdir(path.dirname(fullPath), { recursive: true });

    // Stringify with frontmatter format
    const output = stringifyFrontmatter(data, content);
    await fs.writeFile(fullPath, output, "utf-8");
  }

  /**
   * Check if a file exists in the store.
   */
  async function exists(relativePath: string): Promise<boolean> {
    const fullPath = resolve(relativePath);
    try {
      await fs.access(fullPath);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * List files in a directory within the store.
   * Returns relative paths (to store root).
   * Only returns .md files by default.
   */
  async function list(relativeDir: string): Promise<string[]> {
    const fullDir = resolve(relativeDir);

    try {
      const entries = await fs.readdir(fullDir, { withFileTypes: true });
      return entries
        .filter((e) => e.isFile() && e.name.endsWith(".md"))
        .map((e) => path.join(relativeDir, e.name));
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        return [];
      }
      throw err;
    }
  }

  /**
   * Resolve a relative path against the store root.
   * Throws if the resolved path escapes the root (path traversal protection).
   */
  function resolve(relativePath: string): string {
    const resolved = path.resolve(rootDir, relativePath);
    const normalizedRoot = path.resolve(rootDir);

    if (!resolved.startsWith(normalizedRoot + path.sep) && resolved !== normalizedRoot) {
      throw new Error(`Path traversal detected: '${relativePath}' resolves outside store root`);
    }

    return resolved;
  }

  return { read, write, exists, list };
}

/**
 * Convenience: stringify an OKF document to a raw string.
 * Useful for previewing or debugging.
 */
export function stringifyOKF(
  data: Record<string, unknown>,
  content: string
): string {
  return stringifyFrontmatter(data, content);
}

/**
 * Convenience: parse a raw OKF string into data + content.
 * Useful for parsing strings that aren't from the filesystem.
 */
export function parseOKF(raw: string): OKFDocument {
  const parsed = parseFrontmatter(raw);
  if (!parsed) {
    return { data: {}, content: raw.trim() };
  }
  return parsed;
}

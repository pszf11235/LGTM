/**
 * OKF Store — Open Knowledge Format inspired storage.
 *
 * All Yak data is stored as Markdown files with YAML frontmatter.
 * This makes everything:
 * - Human-readable (just open in any editor or GitHub)
 * - Agent-readable (LLMs can consume raw markdown)
 * - Git-friendly (clean diffs, mergeable)
 * - Tool-agnostic (renderable in Obsidian, GitHub, etc.)
 *
 * Uses gray-matter for frontmatter parsing/stringification.
 */

import fs from "fs/promises";
import path from "path";
import matter from "gray-matter";
import type { OKFStore } from "../plugin.js";

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
 * Create an OKF store instance rooted at a given directory.
 *
 * All paths passed to read/write/exists/list are relative to this root.
 */
export function createOKFStore(rootDir: string): OKFStore {
  /**
   * Read an OKF markdown file.
   * Returns null if the file doesn't exist.
   */
  async function read(
    relativePath: string
  ): Promise<{ data: Record<string, unknown>; content: string } | null> {
    const fullPath = resolve(relativePath);

    try {
      const raw = await fs.readFile(fullPath, "utf-8");
      const { data, content } = matter(raw);
      return { data: data as Record<string, unknown>, content: content.trim() };
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
   * @param relativePath - Path relative to store root (e.g., "sessions/2026-08-15/index.md")
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

    // Stringify with gray-matter: produces ---\nfrontmatter\n---\ncontent
    const output = matter.stringify(content, data);
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
  return matter.stringify(content, data);
}

/**
 * Convenience: parse a raw OKF string into data + content.
 * Useful for parsing strings that aren't from the filesystem.
 */
export function parseOKF(raw: string): OKFDocument {
  const { data, content } = matter(raw);
  return { data: data as Record<string, unknown>, content: content.trim() };
}

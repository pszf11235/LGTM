/**
 * Tests for tech stack auto-detection.
 *
 * Run with: bun test packages/core/src/onboarding/detect.test.ts
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import fs from "fs";
import path from "path";
import os from "os";
import { detectTechStack } from "./detect.js";

describe("detectTechStack", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = path.join(os.tmpdir(), `yak-detect-test-${Date.now()}`);
    fs.mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test("returns empty array for empty directory", () => {
    expect(detectTechStack(tmpDir)).toEqual([]);
  });

  test("detects TypeScript from tsconfig.json", () => {
    fs.writeFileSync(path.join(tmpDir, "tsconfig.json"), "{}");
    const result = detectTechStack(tmpDir);
    expect(result).toContain("typescript");
  });

  test("detects Rust from Cargo.toml", () => {
    fs.writeFileSync(path.join(tmpDir, "Cargo.toml"), "[package]");
    const result = detectTechStack(tmpDir);
    expect(result).toContain("rust");
  });

  test("detects Go from go.mod", () => {
    fs.writeFileSync(path.join(tmpDir, "go.mod"), "module example");
    const result = detectTechStack(tmpDir);
    expect(result).toContain("go");
  });

  test("detects Python from pyproject.toml", () => {
    fs.writeFileSync(path.join(tmpDir, "pyproject.toml"), "[project]");
    const result = detectTechStack(tmpDir);
    expect(result).toContain("python");
  });

  test("detects Node + JS from package.json", () => {
    fs.writeFileSync(
      path.join(tmpDir, "package.json"),
      JSON.stringify({ name: "test" })
    );
    const result = detectTechStack(tmpDir);
    expect(result).toContain("javascript");
    expect(result).toContain("node");
  });

  test("detects React from package.json dependencies", () => {
    fs.writeFileSync(
      path.join(tmpDir, "package.json"),
      JSON.stringify({ dependencies: { react: "^18.0.0" } })
    );
    const result = detectTechStack(tmpDir);
    expect(result).toContain("react");
  });

  test("detects Bun from bunfig.toml", () => {
    fs.writeFileSync(path.join(tmpDir, "bunfig.toml"), "[install]");
    const result = detectTechStack(tmpDir);
    expect(result).toContain("bun");
  });

  test("detects Docker from Dockerfile", () => {
    fs.writeFileSync(path.join(tmpDir, "Dockerfile"), "FROM node:18");
    const result = detectTechStack(tmpDir);
    expect(result).toContain("docker");
  });

  test("detects multiple technologies", () => {
    fs.writeFileSync(path.join(tmpDir, "tsconfig.json"), "{}");
    fs.writeFileSync(path.join(tmpDir, "bunfig.toml"), "");
    fs.writeFileSync(
      path.join(tmpDir, "package.json"),
      JSON.stringify({ dependencies: { react: "^18", express: "^4" } })
    );
    fs.writeFileSync(path.join(tmpDir, "Dockerfile"), "FROM node");

    const result = detectTechStack(tmpDir);
    expect(result).toContain("typescript");
    expect(result).toContain("bun");
    expect(result).toContain("react");
    expect(result).toContain("express");
    expect(result).toContain("docker");
  });

  test("returns sorted and deduplicated results", () => {
    fs.writeFileSync(path.join(tmpDir, "package.json"), JSON.stringify({}));
    fs.writeFileSync(path.join(tmpDir, "tsconfig.json"), "{}");
    const result = detectTechStack(tmpDir);

    // Should be sorted alphabetically
    const sorted = [...result].sort();
    expect(result).toEqual(sorted);
  });
});

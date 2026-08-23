/**
 * Tests for config resolution against the central store.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import fs from "fs";
import path from "path";
import os from "os";
import {
  resolveLgtmDir,
  loadProfile,
  getDefaultConfig,
  getDefaultStorePath,
} from "./loader.js";

let tmpHome: string;
let realHome: string | undefined;

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "lgtm-cfg-"));
  realHome = process.env.HOME;
  process.env.HOME = tmpHome;
});

afterEach(() => {
  if (realHome !== undefined) process.env.HOME = realHome;
  try {
    fs.rmSync(tmpHome, { recursive: true });
  } catch { /* ignore */ }
});

describe("resolveLgtmDir", () => {
  test("returns the central store, flat, regardless of repo", () => {
    const expected = path.join(tmpHome, ".lgtm-farm");

    expect(resolveLgtmDir({})).toBe(expected);
    // The repo argument must not affect the path — one store serves every repo
    expect(resolveLgtmDir({}, "/home/user/projectA")).toBe(expected);
    expect(resolveLgtmDir({}, "/home/user/projectB")).toBe(expected);
  });

  test("honours a custom storePath", () => {
    expect(resolveLgtmDir({ storePath: "/custom/store" })).toBe("/custom/store");
  });

  test("defaults with no arguments", () => {
    expect(resolveLgtmDir()).toBe(path.join(tmpHome, ".lgtm-farm"));
  });
});

describe("getDefaultStorePath", () => {
  test("is ~/.lgtm-farm", () => {
    expect(getDefaultStorePath()).toBe(path.join(tmpHome, ".lgtm-farm"));
  });
});

describe("loadProfile", () => {
  test("returns null when profile.md does not exist", () => {
    expect(loadProfile(tmpHome)).toBeNull();
  });

  test("returns null when there is no frontmatter", () => {
    fs.writeFileSync(path.join(tmpHome, "profile.md"), "# Just a heading\n");
    expect(loadProfile(tmpHome)).toBeNull();
  });

  test("loads ai config and createdAt", () => {
    fs.writeFileSync(
      path.join(tmpHome, "profile.md"),
      [
        "---",
        "type: lgtm/profile",
        "ai:",
        "  enabled: true",
        "  provider: ollama",
        "  model: qwen2.5-coder:7b",
        'createdAt: "2026-08-23T10:00:00Z"',
        "---",
        "",
        "# LGTM Store",
      ].join("\n")
    );

    const profile = loadProfile(tmpHome);
    expect(profile).not.toBeNull();
    expect(profile!.ai.enabled).toBe(true);
    expect(profile!.ai.provider).toBe("ollama");
    expect(profile!.ai.model).toBe("qwen2.5-coder:7b");
    expect(profile!.createdAt).toBe("2026-08-23T10:00:00Z");
  });

  test("defaults ai to disabled when the key is absent", () => {
    fs.writeFileSync(
      path.join(tmpHome, "profile.md"),
      ["---", "type: lgtm/profile", 'createdAt: "2026-08-23T10:00:00Z"', "---", ""].join("\n")
    );

    const profile = loadProfile(tmpHome);
    expect(profile!.ai.enabled).toBe(false);
  });
});

describe("getDefaultConfig", () => {
  test("enables the review plugin and disables AI", () => {
    const config = getDefaultConfig();
    expect(config.plugins.review.enabled).toBe(true);
    expect(config.ai.enabled).toBe(false);
  });

  test("carries no storageMode", () => {
    expect("storageMode" in getDefaultConfig()).toBe(false);
  });
});

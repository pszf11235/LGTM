#!/usr/bin/env bun
/**
 * LGTM Binary Build Script
 *
 * Two-phase build:
 * 1. Bundle with plugin to stub react-devtools-core (Bun.build API)
 * 2. Compile the bundle into a standalone binary (bun build --compile CLI)
 *
 * This ensures the stub is resolved at bundle time regardless of Bun version,
 * while using the reliable CLI for final compilation.
 *
 * Usage:
 *   bun scripts/build.ts                    # Build for current platform → dist/lgtm
 *   bun scripts/build.ts --target linux-x64 # Cross-compile → dist/lgtm-linux-x64
 *   bun scripts/build.ts --outfile my-bin   # Custom output path
 */

import { parseArgs } from "util";
import { mkdirSync, unlinkSync, existsSync } from "fs";
import { dirname, resolve } from "path";

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    target: { type: "string" },
    outfile: { type: "string" },
  },
});

const target = values.target as string | undefined;
const outfile = values.outfile ?? (target ? `dist/lgtm-${target}` : "dist/lgtm");

// Ensure output directory exists
mkdirSync(dirname(outfile), { recursive: true });

// Map short names to Bun target strings
const targetMap: Record<string, string> = {
  "linux-x64": "bun-linux-x64",
  "linux-arm64": "bun-linux-arm64",
  "darwin-x64": "bun-darwin-x64",
  "darwin-arm64": "bun-darwin-arm64",
};

const bunTarget = target ? (targetMap[target] ?? `bun-${target}`) : undefined;
const tmpBundle = "dist/.lgtm-bundle.js";

console.log(`🔨 Building LGTM → ${outfile}${bunTarget ? ` (target: ${bunTarget})` : ""}`);

// ── Phase 1: Bundle with plugin to stub react-devtools-core ─────────────
const bundleResult = await Bun.build({
  entrypoints: ["packages/core/src/index.ts"],
  outdir: dirname(tmpBundle),
  naming: ".lgtm-bundle.js",
  target: "bun",
  plugins: [
    {
      name: "stub-devtools",
      setup(build) {
        // Stub react-devtools-core — Ink imports it optionally for DEV mode.
        // Without this, the compiled binary fails with:
        //   "Cannot find package 'react-devtools-core' from '/$bunfs/root/lgtm'"
        build.onResolve({ filter: /^react-devtools-core$/ }, () => ({
          path: "react-devtools-core",
          namespace: "devtools-stub",
        }));
        build.onLoad({ filter: /.*/, namespace: "devtools-stub" }, () => ({
          contents: "export default { connectToDevTools() {} }; export function connectToDevTools() {}",
          loader: "js",
        }));
      },
    },
  ],
});

if (!bundleResult.success) {
  console.error("❌ Bundle phase failed:");
  for (const log of bundleResult.logs) {
    console.error(`  ${log.message}`);
  }
  process.exit(1);
}

// ── Phase 2: Compile bundle into standalone binary ──────────────────────
const compileArgs = ["bun", "build", resolve(tmpBundle), "--compile", "--outfile", resolve(outfile)];
if (bunTarget) {
  compileArgs.push(`--target=${bunTarget}`);
}

const proc = Bun.spawnSync(compileArgs);
if (proc.exitCode !== 0) {
  console.error("❌ Compile phase failed:");
  console.error(proc.stderr.toString());
  process.exit(1);
}

// Clean up temp bundle
try {
  unlinkSync(tmpBundle);
  // Also clean up the sourcemap if it exists
  if (existsSync(tmpBundle + ".map")) unlinkSync(tmpBundle + ".map");
} catch { /* ignore */ }

console.log(`✓ Built ${outfile}`);

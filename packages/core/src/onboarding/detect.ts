/**
 * Auto-detect tech stack from repo files.
 *
 * Scans for common config files (package.json, Cargo.toml, go.mod, etc.)
 * and returns a list of detected technologies.
 */

import fs from "fs";
import path from "path";

interface Detection {
  file: string;
  techs: string[];
}

const DETECTIONS: Detection[] = [
  { file: "package.json", techs: ["javascript", "node"] },
  { file: "tsconfig.json", techs: ["typescript"] },
  { file: "Cargo.toml", techs: ["rust"] },
  { file: "go.mod", techs: ["go"] },
  { file: "pyproject.toml", techs: ["python"] },
  { file: "requirements.txt", techs: ["python"] },
  { file: "Pipfile", techs: ["python"] },
  { file: "Gemfile", techs: ["ruby"] },
  { file: "composer.json", techs: ["php"] },
  { file: "mix.exs", techs: ["elixir"] },
  { file: "build.gradle", techs: ["java", "gradle"] },
  { file: "pom.xml", techs: ["java", "maven"] },
  { file: "Dockerfile", techs: ["docker"] },
  { file: "docker-compose.yml", techs: ["docker"] },
  { file: "docker-compose.yaml", techs: ["docker"] },
  { file: ".github/workflows", techs: ["github-actions"] },
  { file: "next.config.js", techs: ["nextjs", "react"] },
  { file: "next.config.ts", techs: ["nextjs", "react"] },
  { file: "vite.config.ts", techs: ["vite"] },
  { file: "tailwind.config.js", techs: ["tailwind"] },
  { file: "tailwind.config.ts", techs: ["tailwind"] },
  { file: "prisma/schema.prisma", techs: ["prisma"] },
  { file: ".env", techs: [] }, // exists but no specific tech
  { file: "bun.lockb", techs: ["bun"] },
  { file: "bunfig.toml", techs: ["bun"] },
];

/**
 * Detect tech stack by scanning for common config files in a directory.
 *
 * @param repoRoot - The root directory to scan
 * @returns Deduplicated list of detected technologies
 */
export function detectTechStack(repoRoot: string): string[] {
  const detected = new Set<string>();

  for (const { file, techs } of DETECTIONS) {
    const fullPath = path.join(repoRoot, file);
    if (fs.existsSync(fullPath)) {
      for (const tech of techs) {
        detected.add(tech);
      }
    }
  }

  // Check package.json for framework-specific deps
  const pkgPath = path.join(repoRoot, "package.json");
  if (fs.existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
      const allDeps = {
        ...(pkg.dependencies ?? {}),
        ...(pkg.devDependencies ?? {}),
      };

      if (allDeps.react) detected.add("react");
      if (allDeps.vue) detected.add("vue");
      if (allDeps.svelte) detected.add("svelte");
      if (allDeps.express) detected.add("express");
      if (allDeps.fastify) detected.add("fastify");
      if (allDeps.hono) detected.add("hono");
      if (allDeps["@nestjs/core"]) detected.add("nestjs");
      if (allDeps.jest) detected.add("jest");
      if (allDeps.vitest) detected.add("vitest");
      if (allDeps.prisma || allDeps["@prisma/client"]) detected.add("prisma");
      if (allDeps.drizzle || allDeps["drizzle-orm"]) detected.add("drizzle");
    } catch {
      // Invalid package.json — skip
    }
  }

  return Array.from(detected).sort();
}

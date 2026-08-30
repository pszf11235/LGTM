/**
 * Barrel for the shared vocabulary. Prefer `import { PRRef } from "@/core"`
 * over reaching into `@/core/types` directly, so a future split of types.ts
 * into several files does not touch every import site.
 */
export * from "./types";

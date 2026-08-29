/**
 * The daemon's public surface, in one import for src/main.ts and src/api.
 *
 * `createDaemon` in ./boot is the entry point; everything else re-exported
 * here is a part it wires together (design.md, "Architecture"). The API layer
 * needs most of these types by name, since `/api/status` returns the
 * scheduler, queue, quota, and binary snapshots verbatim.
 *
 * The html import below is the "server" half of "src/ui holds the SPA entry
 * plus an index.html imported by the server for Bun's fullstack embedding".
 * Keeping it live from day one means build.ts's compile step already
 * exercises the Tailwind bundle path, so a broken plugin wire fails CI
 * instead of shipping a silently unstyled binary the first time someone runs
 * `lgtm open`.
 */
import index from "../ui/index.html";

export const uiEntry = index;

export * from "./backfill";
export * from "./binaries";
export * from "./boot";
export * from "./cycle";
export * from "./events";
export * from "./notify";
export * from "./quota";
export * from "./queue";
export * from "./rendezvous";
export * from "./scheduler";
export * from "./snapshot";

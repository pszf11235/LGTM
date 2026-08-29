/**
 * The daemon: scheduler, poll cycle, quota gate, and the Bun.serve instance
 * that mounts src/api's routes and this embedded UI (design.md,
 * "Architecture"). None of that is wired up yet — src/main.ts's `up`
 * subcommand is still a stub.
 *
 * The html import below is real, though, on purpose. It is the "server" half
 * of "src/ui holds the SPA entry plus an index.html imported by the server
 * for Bun's fullstack embedding": keeping it live from day one means
 * build.ts's compile step already exercises the Tailwind bundle path, so a
 * broken plugin wire fails CI instead of shipping a silently unstyled binary
 * the first time someone runs `lgtm open`.
 */
import index from "../ui/index.html";

export const uiEntry = index;

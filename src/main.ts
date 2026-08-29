#!/usr/bin/env bun
/**
 * CLI entry point.
 *
 * `lgtm` is one compiled binary playing three roles (design.md,
 * "Architecture"): this file is the short-lived CLI half, which talks to the
 * long-lived daemon over its local HTTP API. `status`, `open`, and `watch`
 * delegate to src/cli's HTTP clients; `install` and `uninstall` manage the
 * launchd LaunchAgent directly (design.md, "Daemon lifecycle"). `up` is
 * still a stub until the daemon lifecycle lands.
 */
import { Command } from "commander";
import packageJson from "../package.json" with { type: "json" };
import { runInstall, runUninstall } from "./cli/install";
import { runOpen } from "./cli/open";
import { runStatus } from "./cli/status";
import { runWatchAdd, runWatchList, runWatchRemove } from "./cli/watch";
import { uiEntry } from "./daemon";

function notImplemented(command: string): never {
  console.error(`lgtm ${command}: not implemented yet`);
  process.exit(1);
}

const program = new Command();

program
  .name("lgtm")
  .description(
    "Watches your repositories, reviews new PRs with the Claude CLI, and gates what reaches GitHub."
  )
  .version(packageJson.version);

program
  .command("up")
  .description("Run the daemon in the foreground")
  .action(() => {
    // Referencing the embedded UI here (without starting a server) keeps the
    // html -> Tailwind bundle path reachable from this entrypoint, so
    // build.ts's compile step exercises it. See src/daemon/index.ts.
    void uiEntry;
    notImplemented("up");
  });

program
  .command("install")
  .description("Install the launchd LaunchAgent so the daemon survives reboots and crashes")
  .action(async () => {
    process.exit(await runInstall());
  });

program
  .command("uninstall")
  .description("Remove the launchd LaunchAgent")
  .action(async () => {
    process.exit(await runUninstall());
  });

program
  .command("status")
  .description("Report daemon liveness, last cycle, queue, and quota")
  .action(async () => {
    process.exit(await runStatus());
  });

program
  .command("open")
  .description("Open the web UI in the default browser, authenticated")
  .action(async () => {
    process.exit(await runOpen());
  });

const watch = program.command("watch").description("Manage the watched repository list");

watch
  .command("add <owner/repo>")
  .description("Add a repository to the watch list")
  .action(async (ownerRepo: string) => {
    process.exit(await runWatchAdd(ownerRepo));
  });

watch
  .command("rm <owner/repo>")
  .description("Remove a repository from the watch list")
  .action(async (ownerRepo: string) => {
    process.exit(await runWatchRemove(ownerRepo));
  });

watch
  .command("ls")
  .description("List watched repositories")
  .action(async () => {
    process.exit(await runWatchList());
  });

program.parse();

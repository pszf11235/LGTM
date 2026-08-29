#!/usr/bin/env bun
/**
 * CLI entry point.
 *
 * `lgtm` is one compiled binary playing three roles (design.md,
 * "Architecture"): this file is the short-lived CLI half, which talks to the
 * long-lived daemon over its local HTTP API. `status`, `open`, and `watch`
 * delegate to src/cli's HTTP clients; `install` and `uninstall` manage the
 * launchd LaunchAgent directly (design.md, "Daemon lifecycle"). `up` runs the
 * daemon itself in the foreground.
 */
import { Command } from "commander";
import packageJson from "../package.json" with { type: "json" };
import { runInstall, runUninstall } from "./cli/install";
import { runOpen } from "./cli/open";
import { runStatus } from "./cli/status";
import { runWatchAdd, runWatchList, runWatchRemove } from "./cli/watch";
import { createDaemon, uiEntry } from "./daemon";
import { apiBind } from "./daemon/serve";

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
  .action(async () => {
    // Referencing the embedded UI keeps the html -> Tailwind bundle path
    // reachable from this entrypoint, so build.ts's compile step exercises it.
    void uiEntry;

    const boot = await createDaemon({
      bind: apiBind(),
      log: (line) => console.log(line),
    });

    if (boot.status === "refused") {
      console.error(
        `lgtm up: pid ${boot.existing.pid} is already serving this store on port ${boot.existing.port}`
      );
      process.exit(1);
    }

    const daemon = boot.daemon;
    console.log(`lgtm: watching on http://127.0.0.1:${daemon.port} (pid ${process.pid})`);
    console.log("Run `lgtm open` in another terminal to reach the UI.");

    let stopping = false;
    const shutdown = async (signal: string) => {
      // Idempotent, because a second Ctrl+C while the first is still draining
      // must not race the same teardown twice.
      if (stopping) return;
      stopping = true;
      console.log(`\nlgtm: ${signal}, shutting down`);
      await daemon.stop();
      process.exit(0);
    };
    process.on("SIGINT", () => void shutdown("SIGINT"));
    process.on("SIGTERM", () => void shutdown("SIGTERM"));
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

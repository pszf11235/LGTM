#!/usr/bin/env bun
/**
 * CLI entry point.
 *
 * `lgtm` is one compiled binary playing three roles (design.md,
 * "Architecture"): this file is the short-lived CLI half, which talks to the
 * long-lived daemon over its local HTTP API. Every subcommand below is a
 * stub until its owning module lands; only --version does real work, since a
 * compiled binary that cannot report its own version fails M0's exit
 * criteria before anything else in the build can be trusted.
 */
import { Command } from "commander";
import packageJson from "../package.json" with { type: "json" };
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
  .action(() => notImplemented("install"));

program
  .command("uninstall")
  .description("Remove the launchd LaunchAgent")
  .action(() => notImplemented("uninstall"));

program
  .command("status")
  .description("Report daemon liveness, last cycle, queue, and quota")
  .action(() => notImplemented("status"));

program
  .command("open")
  .description("Open the web UI in the default browser, authenticated")
  .action(() => notImplemented("open"));

const watch = program.command("watch").description("Manage the watched repository list");

watch
  .command("add <owner/repo>")
  .description("Add a repository to the watch list")
  .action(() => notImplemented("watch add"));

program.parse();

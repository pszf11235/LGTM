# 0003. Delivery is a local daemon with a web UI; a native tray shell comes later

- **Status:** Accepted
- **Date:** 2026-08-29

## Context

The v1 rebuild replaces a terminal UI that was a bad surface for reading findings. The replacement had to keep everything local (the providers are CLIs on the user's machine), give a solo macOS developer a shippable v1 in weeks, and provide ambient awareness for a background tool whose worst failure is dying silently. Three designs were developed independently and judged: a pure local web app, a native menu-bar app (Tauri), and a hybrid. Apple's rules shaped the trade-off: `.app` bundles require Developer ID signing and notarization, while plain binaries installed via curl or brew face no Gatekeeper friction at all.

## Decision

One compiled binary runs a background daemon (watcher, HTTP API, embedded web UI on 127.0.0.1) owned by launchd, with best-effort native notifications fired by the daemon itself. A thin signed menu-bar shell arrives in v1.1, consuming the same status API the daemon exposes from day one. Ollama, Syncthing, and Docker Desktop all converged on this shape: daemon binds localhost, UI is disposable, tray is thin status.

## Consequences

The product iterates as an unsigned binary indefinitely; Apple bureaucracy only ever touches a small shell that rarely changes. launchd owning the daemon means reviewing continues when every UI is closed, and any UI can crash without consequence. The API contract doubles as the tray contract, so v1.1 needs no daemon changes.

Harder: until the tray exists, a dead daemon is only visible by pulling (a status command, an open tab), which is the design's known weak spot and the reason the tray is scheduled rather than hypothetical. Notifications from a bare daemon are second-class on macOS. The daemon must solve launchd's bare-PATH problem to spawn user-installed CLIs at all.

## Alternatives considered

**Native menu-bar app owning everything** (Tauri tray + webview + sidecar). Best day-one ambient UX, rejected because signing, sidecar entitlements, and a Rust shell land in the v1 critical path of a solo TypeScript developer, and because tying the watcher's lifetime to a GUI process means quitting the tray silently stops reviewing.

**Pure local web app with no native ambitions.** Fastest to ship and nearly identical to what v1 builds, rejected as an end state because its own mitigation for silent daemon death was to add a tray later, which is this decision without the prepared contract.

**Hosted service or GitHub App.** Rejected: a server cannot spawn the user's local CLIs or reuse their subscriptions, and holding user tokens server-side inverts the local-first trust model.

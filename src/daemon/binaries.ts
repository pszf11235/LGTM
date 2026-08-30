/**
 * Absolute-path resolution for the CLIs the daemon spawns: `claude`, `gh`,
 * `terminal-notifier` (design.md, "Daemon lifecycle"; requirements.md R7.3).
 *
 * launchd — and the GUI environment generally — hands a bare PATH to
 * anything it launches, so a daemon started via `lgtm install` cannot see
 * whatever a user's shell rc files put on PATH for interactive sessions.
 * `command -v` run through a login shell (`$SHELL -l -c '...'`) sees what the
 * user's actual shell setup resolves, so that is what boot-time detection
 * shells out to. The result is cached in memory (a probe is one login-shell
 * spawn, not something to repeat per review); a spawn that later fails with
 * ENOENT re-probes just that one binary, in case it was installed or moved
 * since boot.
 *
 * PRECEDENCE RULE: a manual pin (`claude_path` / `gh_path` in config.md)
 * skips the probe for that binary entirely, at construction time and on
 * every re-probe. Getting this backwards — letting a re-probe overwrite a
 * deliberate pin — sends spawns to the wrong binary silently; the tests
 * below exist because that failure mode is otherwise invisible.
 */

// ─── Types ──────────────────────────────────────────────────────────────────

export const BINARY_NAMES = ["claude", "gh", "terminal-notifier"] as const;
export type BinaryName = (typeof BINARY_NAMES)[number];

/**
 * Only `claude` and `gh` have a pin field in config.md (design.md, "Store
 * layout"). `terminal-notifier` is best-effort (design.md, "Notifications")
 * and always goes through the probe.
 */
export type PinnableBinaryName = Extract<BinaryName, "claude" | "gh">;
export type BinaryPins = Partial<Record<PinnableBinaryName, string>>;

/**
 * One binary's resolution, shaped for `/api/status` to render directly:
 * `pinned` and `probed` always carry an absolute path, `missing` never does.
 */
export type BinaryStatus =
  | { name: BinaryName; source: "pinned"; path: string }
  | { name: BinaryName; source: "probed"; path: string }
  | { name: BinaryName; source: "missing"; path: null };

export interface BinaryResolver {
  /** Run the login-shell probe for every binary that isn't pinned. Call once at daemon startup. */
  probe(): Promise<void>;
  /** The absolute path for a binary right now, or null if it isn't resolved. Never spawns anything. */
  resolve(name: BinaryName): string | null;
  /**
   * Call after spawning `name` fails with ENOENT. Re-probes just that
   * binary — unless it's pinned, in which case this is a no-op, which is
   * the precedence rule in practice: a pin is a deliberate choice, so a
   * spawn failure under a stale pin should surface as a config problem to
   * fix, never as an excuse to go looking elsewhere.
   */
  reportSpawnFailure(name: BinaryName): Promise<void>;
  /** Every binary's current resolution, in BINARY_NAMES order, for the status API. */
  status(): BinaryStatus[];
}

export interface CreateBinaryResolverOptions {
  /** Manual pins from config.md. A pinned binary's probe never runs. */
  pins?: BinaryPins;
  /**
   * The login shell to probe with. Defaults to `$SHELL`, falling back to
   * `/bin/sh` if that's unset (a bare-PATH launchd environment may not set
   * it either). Overridable so tests point this at a fake shell script
   * instead of spawning the real login shell and its rc files.
   */
  shell?: string;
  /**
   * Kills a hung probe. A login shell sources rc files the daemon does not
   * control (nvm, direnv, motd scripts); one that blocks on input or a slow
   * network call should not hang daemon startup forever. Defaults to 5s.
   */
  timeoutMs?: number;
}

// ─── Resolver ───────────────────────────────────────────────────────────────

function isPinnable(name: BinaryName): name is PinnableBinaryName {
  return name === "claude" || name === "gh";
}

export function createBinaryResolver(options: CreateBinaryResolverOptions = {}): BinaryResolver {
  const shell = options.shell ?? process.env.SHELL ?? "/bin/sh";
  const pins = options.pins ?? {};
  const timeoutMs = options.timeoutMs ?? 5000;

  const state = new Map<BinaryName, BinaryStatus>();
  for (const name of BINARY_NAMES) {
    const pinned = isPinnable(name) ? pins[name] : undefined;
    state.set(
      name,
      pinned ? { name, source: "pinned", path: pinned } : { name, source: "missing", path: null }
    );
  }

  async function probeNames(names: readonly BinaryName[]): Promise<void> {
    if (names.length === 0) return; // every requested binary is pinned; nothing to spawn.
    const found = await runLoginShellProbe(shell, names, timeoutMs);
    for (const name of names) {
      const path = found.get(name) ?? null;
      state.set(name, path ? { name, source: "probed", path } : { name, source: "missing", path: null });
    }
  }

  return {
    async probe() {
      const unpinned = BINARY_NAMES.filter((name) => state.get(name)?.source !== "pinned");
      await probeNames(unpinned);
    },

    resolve(name) {
      return state.get(name)?.path ?? null;
    },

    async reportSpawnFailure(name) {
      if (state.get(name)?.source === "pinned") return; // never let ENOENT override a deliberate pin.
      await probeNames([name]);
    },

    status() {
      return BINARY_NAMES.map((name) => state.get(name) as BinaryStatus);
    },
  };
}

// ─── Login-shell probe ──────────────────────────────────────────────────────

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * Isolated so the `stdout: "pipe"` literal stays inline in the `Bun.spawn`
 * call — TypeScript only narrows `proc.stdout` to a readable stream (instead
 * of the widened pipe-or-number-or-undefined union) when it can see that
 * literal at the call site, which a `try` wrapped around a pre-declared
 * variable would otherwise obscure.
 */
function spawnProbeShell(shell: string, script: string) {
  try {
    return Bun.spawn([shell, "-l", "-c", script], {
      stdin: "ignore",
      stdout: "pipe",
      // Login shells source rc files the daemon doesn't control; whatever
      // they print on startup (motd, nvm/direnv banners) must never leak
      // into the daemon's own stderr or log.
      stderr: "ignore",
    });
  } catch {
    return null; // the shell itself doesn't exist or isn't executable.
  }
}

/**
 * Ask a login shell where each of `names` resolves.
 *
 * `command -v a b c` run as one call is ambiguous once anything in the
 * middle is missing: a not-found name prints nothing and shifts every
 * subsequent output line out of position, so there is no reliable way to
 * match paths back to names by output order alone. Instead each name gets
 * its own `command -v`, prefixed with the name and a tab so a missing
 * binary just produces an empty field instead of desynchronizing the rest —
 * still one shell spawn, one login-shell probe, per design.md.
 *
 * A result is accepted only when it's an absolute path. `command -v` prints
 * an alias or shell-function definition instead of a path when a name
 * resolves to one of those, and that's not something Bun.spawn can exec by
 * itself under launchd's bare PATH anyway, so it's treated the same as not
 * found rather than handed out as a broken "resolution".
 */
async function runLoginShellProbe(
  shell: string,
  names: readonly BinaryName[],
  timeoutMs: number
): Promise<Map<BinaryName, string>> {
  const script = names
    .map((name) => `printf '%s\\t' ${shellQuote(name)}; command -v ${shellQuote(name)} 2>/dev/null || true; echo`)
    .join("\n");

  const result = new Map<BinaryName, string>();

  const proc = spawnProbeShell(shell, script);
  if (!proc) return result; // the shell itself doesn't exist or isn't executable.

  const timer = setTimeout(() => {
    try {
      proc.kill();
    } catch {
      // already exited.
    }
  }, timeoutMs);

  let stdout: string;
  try {
    stdout = await new Response(proc.stdout).text();
    await proc.exited;
  } catch {
    stdout = "";
  } finally {
    clearTimeout(timer);
  }

  for (const line of stdout.split("\n")) {
    const tab = line.indexOf("\t");
    if (tab === -1) continue;
    const name = line.slice(0, tab);
    const path = line.slice(tab + 1).trim();
    if (path.startsWith("/") && (names as readonly string[]).includes(name)) {
      result.set(name as BinaryName, path);
    }
  }

  return result;
}

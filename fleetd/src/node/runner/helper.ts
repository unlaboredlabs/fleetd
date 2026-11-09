// The session-host helper: the Rust binary's `fleetd session-host`, which owns each session's claude so it outlives the
// node (./host.ts). It ships beside the Bun build as `fleetd-session-host` (`bun run helper` puts one in dist/), and
// runs fleetd's own MCP server and hold hook inside sessions too. A candidate counts only when it answers
// `session-host` as the Rust binary does. The Bun build's own `fleetd session-host` (src/cli/session_host.ts) only
// hands the command to a Rust host it finds, and refuses at once while a lookup runs (LOOKUP), so it is never
// taken in place of one and two Bun builds never try each other. A node without a helper reports itself degraded
// rather than failing every start.
import { spawnSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";

/** The helper's name beside the Bun build. */
export const HELPER = "fleetd-session-host";

/** What a node without a helper says, with its fix. */
export const NO_HELPER =
  "this machine has no session host, so no agent can start here. Fix: put the Rust fleetd build beside this one as fleetd-session-host (bun run helper), or name it in FLEETD_NATIVE_BIN";

/** Set while a host is looked for: a Bun build asked `session-host` then refuses rather than looking in turn. */
export const LOOKUP = "FLEETD_SESSION_HOST_LOOKUP";

/** Whether `bin` is the Rust binary's session host: run with no arguments, it prints its usage and exits 2. */
export function hostsSessions(bin: string): boolean {
  const out = spawnSync(bin, ["session-host"], {
    encoding: "utf8",
    timeout: 10_000,
    stdio: ["ignore", "ignore", "pipe"],
    env: { ...process.env, [LOOKUP]: "1" },
  });
  return out.status === 2 && (out.stderr ?? "").includes("session-host <dir> <session id> -- <program>");
}

const real = (path: string) => {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
};

/** The session host: FLEETD_NATIVE_BIN, else `fleetd-session-host` beside this binary or on PATH, else a `fleetd` on
 * PATH that hosts sessions (a Rust install's). Never this binary itself. Undefined when there is none. */
export function findHelper(env: NodeJS.ProcessEnv = process.env, exe: string = process.execPath): string | undefined {
  const own = real(exe);
  const path = (env.PATH ?? "").split(":").filter(Boolean);
  const candidates = [
    env.FLEETD_NATIVE_BIN,
    join(dirname(own), HELPER),
    ...path.map((dir) => join(dir, HELPER)),
    ...path.map((dir) => join(dir, "fleetd")),
  ].filter((c): c is string => !!c);
  const seen = new Set<string>();
  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    const resolved = real(candidate);
    if (resolved === own || seen.has(resolved)) continue;
    seen.add(resolved);
    if (hostsSessions(candidate)) return candidate;
  }
  return undefined;
}

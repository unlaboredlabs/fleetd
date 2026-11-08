import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

/** `~` expanded, absolute against the cwd (crates/fleetd/src/hub/store/db.rs `expand_home`). */
export function expandHome(raw: string, userHome = homedir()): string {
  const expanded = raw === "~" ? userHome : raw.startsWith("~/") ? join(userHome, raw.slice(2)) : raw;
  return isAbsolute(expanded) ? expanded : resolve(expanded);
}

/** `$FLEETD_HOME`, else `~/.fleetd` (crates/fleetd/src/home.rs). */
export function fleetdDir(): string {
  const env = process.env.FLEETD_HOME;
  return env ? expandHome(env) : join(homedir(), ".fleetd");
}

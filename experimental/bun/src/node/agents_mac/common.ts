// What the agents' Mac's parts share (crates/fleetd/src/node/agents_mac/mod.rs): its checks' types, and the health
// file setup reads on the Mac itself.
import { readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { MacHealth as WireMacHealth } from "../../shared/node_link.ts";

export type MacHealth = WireMacHealth;
export type MacCheck = MacHealth["checks"][number];
/** node_link.rs `MacCheckId`: the checks a node runs now (`ALL`), and the legacy ones an older node still reports. */
export type MacCheckId =
  | "developer"
  | "xcode"
  | "ios_runtime"
  | "accessibility"
  | "screen_recording"
  | "gui_session"
  | "tools"
  | "keep_awake"
  | "standard_user"
  | "other_homes"
  | "no_apple_id"
  | "no_secure_token";

/** The two privacy grants, in the order setup asks for them. */
export const GRANTS: MacCheckId[] = ["accessibility", "screen_recording"];

/** The start of `text`, at most `max` characters. */
export const clip = (text: string, max: number) => [...text].slice(0, max).join("");

/** The macOS user the node runs as. */
export const user = () => process.env.USER || "unknown";

export const health = (who: string, checks: MacCheck[]): MacHealth => ({ user: clip(who, 64), checks });

/** Where the node keeps the Mac's pinned tools. */
export const toolsDir = (home: string) => join(home, "mac");

/** Where the node writes its last checks, after each run and each new read of the grants, for setup to read on the Mac
 * itself: the app's "Set up this Mac for agents" and `fleetd init --mac`. */
export const healthFile = (home: string) => join(home, "mac-health.json");

export function writeHealth(home: string, h: MacHealth): void {
  // Whole or not at all, for a reader polling it.
  const tmp = join(home, "mac-health.json.tmp");
  try {
    writeFileSync(tmp, JSON.stringify(h));
    renameSync(tmp, healthFile(home));
  } catch {}
}

/** Touched after each run of every check (not when the grants loop republishes the health file), so setup can wait
 * for one by the node as it runs now. */
export const checkedFile = (home: string) => join(home, "mac-health.checked");

/** When the node at `home` last ran every check (ms since the epoch); undefined before its first. */
export function lastFullCheck(home: string): number | undefined {
  try {
    return statSync(checkedFile(home)).mtimeMs;
  } catch {
    return undefined;
  }
}

/** The node's last checks at `home`, and when it wrote them (ms since the epoch); undefined before its first. */
export function readHealth(home: string): { health: MacHealth; writtenMs: number } | undefined {
  try {
    const writtenMs = statSync(healthFile(home)).mtimeMs;
    return { health: JSON.parse(readFileSync(healthFile(home), "utf8")) as MacHealth, writtenMs };
  } catch {
    return undefined;
  }
}

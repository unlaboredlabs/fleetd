// The agents' Mac on every agent's PATH (`forwarder`;
// node/session_route.rs `env`): `mac`, written at the node's start in `<home>/mac/bin`, runs this node's binary as
// `fleetd mac`; while the session holds a simulator on the Mac, a forwarding `agent-device` in
// `<home>/sessions/<thread>/device-remote` runs each command there (`fleetd mac agent-device`). Both folders go first
// on the session's PATH, the forwarder's before `mac`'s, ahead of the Android wrapper's agent-device (node/device).
import { chmodSync, existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { mkdirPrivate } from "../config.ts";
import { writeAtomic } from "../secrets/files.ts";
import { binDir, forwarder, forwarderDir, shim } from "./paths.ts";

export { binDir, forwarder, forwarderDir, launchEnv, shim } from "./paths.ts";

/** Writes `mac` at the node's start, for the binary running now. */
export function installShim(home: string, self: string[]): void {
  const dir = binDir(home);
  mkdirSync(dir, { recursive: true });
  const bin = join(dir, "mac");
  writeAtomic(bin, shim(self));
  chmodSync(bin, 0o755);
}

/** Puts the forwarder first on the session's PATH (`mac sim start`). */
export function installForwarder(home: string, thread: string, self: string[]): void {
  const dir = forwarderDir(home, thread);
  mkdirPrivate(dir);
  const bin = join(dir, "agent-device");
  writeAtomic(bin, forwarder(self));
  chmodSync(bin, 0o700);
}

/** At the node's start, every forwarder a session kept across the restart (sessions outlive the node) runs `self`, this
 * node's pin, again: the pin it named went with the node before. Returns how many were rewritten. */
export function refreshForwarders(home: string, self: string[]): number {
  let threads: string[];
  try {
    threads = readdirSync(join(home, "sessions"));
  } catch {
    return 0;
  }
  let rewritten = 0;
  for (const thread of threads) {
    if (!existsSync(join(forwarderDir(home, thread), "agent-device"))) continue;
    installForwarder(home, thread, self);
    rewritten++;
  }
  return rewritten;
}

/** Takes the forwarder off the session's PATH (`mac sim end`): agent-device is this machine's own again. */
export function removeForwarder(home: string, thread: string): void {
  rmSync(forwarderDir(home, thread), { recursive: true, force: true });
}

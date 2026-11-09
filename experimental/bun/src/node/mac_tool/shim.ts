// The agents' Mac on every agent's PATH (crates/fleetd/src/node/mac_tool/client.rs `install_shim`, `forwarder`;
// node/session_route.rs `env`): `mac`, written at the node's start in `<home>/mac/bin`, runs this node's binary as
// `fleetd mac`; while the session holds a simulator on the Mac, a forwarding `agent-device` in
// `<home>/sessions/<thread>/device-remote` runs each command there (`fleetd mac agent-device`). Both folders go first
// on the session's PATH, the forwarder's before `mac`'s, ahead of the Android wrapper's agent-device (node/device).
import { chmodSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { mkdirPrivate } from "../config.ts";
import { writeAtomic } from "../secrets/files.ts";

/** The folder on every agent session's PATH that holds `mac`. */
export const binDir = (home: string) => join(home, "mac", "bin");
/** The folder that holds the session's forwarding agent-device while it holds a simulator on the Mac. */
export const forwarderDir = (home: string, thread: string) => join(home, "sessions", thread, "device-remote");

const quoted = (argv: string[]) => argv.map((a) => `'${a.replaceAll("'", "'\\''")}'`).join(" ");

/** `mac`: `self` (this node's command line: its binary, or Bun with its entry) as `fleetd mac`. */
export const shim = (self: string[]) =>
  `#!/bin/sh\n# fleetd's: the agents' Mac, for this session (fleetd mac --help).\nexec ${quoted(self)} mac "$@"\n`;

/** The forwarding `agent-device`: each command runs on the agents' Mac, at the session's simulator. */
export const forwarder = (self: string[]) =>
  `#!/bin/sh\n# fleetd's: agent-device commands for your iOS simulator on the agents' Mac (mac sim).\nexec ${quoted(self)} mac agent-device "$@"\n`;

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

/** Takes the forwarder off the session's PATH (`mac sim end`): agent-device is this machine's own again. */
export function removeForwarder(home: string, thread: string): void {
  rmSync(forwarderDir(home, thread), { recursive: true, force: true });
}

/** The session's PATH: the forwarder's folder, then `mac`'s, then `path` (what the areas before put first). */
export function launchEnv(home: string, thread: string, path: string | undefined): [string, string][] {
  const first = `${forwarderDir(home, thread)}:${binDir(home)}`;
  return [["PATH", path ? `${first}:${path}` : first]];
}

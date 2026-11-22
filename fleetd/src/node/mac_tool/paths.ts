// Where `mac` and the forwarding `agent-device` go for a session, and what each says (./shim.ts writes them): pure,
// so a hosted box's session is launched with the same folders first on its PATH (`fleetd/box/mac`).
import { join } from "node:path";

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

/** The session's PATH: the forwarder's folder, then `mac`'s, then `path` (what the areas before put first). */
export function launchEnv(home: string, thread: string, path: string | undefined): [string, string][] {
  const first = `${forwarderDir(home, thread)}:${binDir(home)}`;
  return [["PATH", path ? `${first}:${path}` : first]];
}

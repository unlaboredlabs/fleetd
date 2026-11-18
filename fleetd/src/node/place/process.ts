// The `process` place: a session's host runs as a detached process on this machine, in a scope of its own at the
// agents' OOM score (../runner/host.ts `launch`), and the agent's files are this machine's own. Stopping and ending
// work by host pids and markers (`stop`, `endLeft`), setup commands run confined to the worktree
// (../cmd/index.ts `runConfined`), and chat files are read from the session's cwd (../actions/image.ts `readImage`).
// A task's end also removes what a VM of its was given (./provision.ts), for an agent that went on outside one.
import { readImage } from "../actions/image.ts";
import { runConfined } from "../cmd/index.ts";
import { endLeft, HostLink, launch, stop } from "../runner/host.ts";
import { basename, dirname } from "node:path";
import type { Place } from "./index.ts";
import { unprovision } from "./provision.ts";

export const processPlace: Place = {
  kind: "process",
  start: launch,
  async adopt(dir) {
    try {
      return await HostLink.connect(dir);
    } catch {
      return undefined;
    }
  },
  stop,
  async end(dir) {
    const ended = await endLeft(dir);
    // A task's agent that started in a VM and went on as a plain process: what its VM was given (its home, its copies
    // of the order's variables) goes with its task too. The node's home is the hosts dir's parent.
    unprovision(dirname(dirname(dir)), basename(dir));
    return ended;
  },
  run: (r) => runConfined(r, [r.cwd]),
  read: async (root, path, offset, file) => readImage(root, path, offset, file),
};

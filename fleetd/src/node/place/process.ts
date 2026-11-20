// The `process` place: a session's host runs as a detached process on this machine, in a scope of its own at the
// agents' OOM score (../runner/host.ts `launch`), and the agent's files are this machine's own. Stopping and ending
// work by host pids and markers (`stop`, `endLeft`), setup commands run confined to the worktree
// (../cmd/index.ts `runConfined`), and chat files are read from the session's cwd (../actions/image.ts `readImage`).
import { readImage } from "../actions/image.ts";
import { runConfined } from "../cmd/index.ts";
import { endLeft, HostLink, launch, stop } from "../runner/host.ts";
import type { Place } from "./index.ts";

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
  end: endLeft,
  run: (r) => runConfined(r, [r.cwd]),
  read: async (root, path, offset, file) => readImage(root, path, offset, file),
};

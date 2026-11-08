// The node's screens as one (crates/fleetd/src/node/screens.rs): the hub's `session_end` for a screen whose task ended
// (`browser::end_outlived` on the hub), which ends it whatever its kind, and `node_action` `screens`, a kind of screen
// turned on or off or its idle timeout, written into node.json.
//
// The restart that applies a changed kind once the screens live here end (`schedule`, `when_idle`) is node-core's
// service handling.
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ScreenSettings, SessionEndFrame } from "../../shared/screens_wire.ts";
import { type Node, onHub } from "../browser/node.ts";
import { router } from "../device/router.ts";
import { edited, macRefuses } from "./settings.ts";

/** Why this machine can't host `host` at all, whatever node.json says (screens.rs `unsupported`). */
export function unsupported(host: string): string | undefined {
  switch (host) {
    case "ios":
      return "iOS screens are gone: agents start iOS simulators on the agents' Mac with `mac sim`";
    case "desktop":
      return process.platform === "linux" ? undefined : "desktop screens run on Linux (docker or Xvfb)";
    case "android":
      return process.platform === "linux" && process.arch === "x64" ? undefined : "Android screens run on Linux x86_64 with KVM";
    case "mac":
      return process.platform === "darwin" ? undefined : "the Mac screen is a Mac's own: its agents session's screen";
    default:
      return undefined;
  }
}

/** Writes `settings` into the node's node.json; what to tell the person, or throws why it didn't change. */
export function apply(home: string, settings: ScreenSettings): string {
  if (settings.host !== undefined && (settings.on === true || settings.host === "ios")) {
    const why = unsupported(settings.host);
    if (why) throw new Error(why);
  }
  const file = join(home, "node.json");
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (e) {
    throw new Error(`couldn't read node.json: ${(e as Error).message}`);
  }
  try {
    if ((JSON.parse(text) as { agentsMac?: boolean }).agentsMac === true) {
      const why = macRefuses(settings);
      if (why) throw new Error(why);
    }
  } catch (e) {
    if (!(e instanceof SyntaxError)) throw e;
  }
  const out = edited(text, settings);
  if (out !== text) {
    const next = join(home, "node.json.next");
    writeFileSync(next, out, { mode: 0o600 });
    renameSync(next, file);
  }
  return "Saved. The node restarts to apply it once its agents finish the step they're on.";
}

/** Wires the hub's `session_end` to whichever kind of screen holds it. */
export function start(node: Node): void {
  onHub(node, "session_end", (f) => {
    const end = f as unknown as SessionEndFrame;
    router(node).endScreen(end.threadId, end.sessionId);
  });
}

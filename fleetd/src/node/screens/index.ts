// The node's screens as one: the hub's `session_end` for a screen whose task ended (`browser::end_outlived` on the
// hub), which ends it whatever its kind.
import type { SessionEndFrame } from "../../shared/screens_wire.ts";
import { type Node, onHub } from "../browser/node.ts";
import { router } from "../device/router.ts";

/** Wires the hub's `session_end` to whichever kind of screen holds it. */
export function start(node: Node): void {
  onHub(node, "session_end", (f) => {
    const end = f as unknown as SessionEndFrame;
    router(node).endScreen(end.threadId, end.sessionId);
  });
}

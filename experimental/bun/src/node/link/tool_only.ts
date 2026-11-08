// The node core on the agents' Mac (node/agents_mac): a tool for agents elsewhere, never a runner. Its hello lists only
// the calls a tool takes (Rust's link `tool_only`: the whole list, the areas' capabilities too, as the caps seam only
// adds), and what the hub shouldn't send it comes back refused unopened: a secret, an approved command, a session call
// but the few every machine gets, and an install of or sign-in to Claude (link.rs's agents_mac arms).
import { sessionCallAllowed, TOOL_ONLY, toolOnly } from "../agents_mac/index.ts";
import type { HubFrame, NodeFrame } from "../wire.ts";

/** What the hello lists: the node core's own, then the areas' not already there; on the agents' Mac, only a tool's. */
export function helloCapabilities(own: readonly string[], areas: readonly string[], mac: { tool: boolean } | undefined): string[] {
  const all = [...own, ...areas.filter((c) => !own.includes(c))];
  return mac ? toolOnly(all, mac.tool) : all;
}

/** The answer the agents' Mac gives `frame` in place of acting on it; undefined for a frame it takes. */
export function refusedOnMac(frame: HubFrame): NodeFrame | undefined {
  const id = String(frame.id ?? "");
  switch (frame.t) {
    case "secret_deliver":
      return { t: "secret_result", id, error: TOOL_ONLY };
    case "gated_run":
      return { t: "gated_result", id, exitCode: null, outputTail: "", timedOut: false, error: TOOL_ONLY };
    case "session_call":
      if (sessionCallAllowed((frame.call ?? {}) as { op?: unknown })) return undefined;
      return {
        t: "session_reply",
        id,
        result: {
          err: {
            code: "runner_unavailable",
            message: TOOL_ONLY,
            fix: "start agents and projects on another machine; they use this Mac with `mac run` and `mac sim`",
          },
        },
      } as NodeFrame;
    case "node_action":
      if (frame.action !== "claude" && frame.action !== "claude_login" && frame.action !== "claude_login_code") return undefined;
      return { t: "node_action_result", id, ok: false, message: TOOL_ONLY };
    default:
      return undefined;
  }
}

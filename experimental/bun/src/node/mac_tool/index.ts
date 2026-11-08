// The agents' Mac on a node (crates/fleetd/src/node/mac_tool/mod.rs): on the agents' Mac itself (node.json
// `agentsMac`), the hub's `mac_call`s go to the host and their answers back as `mac_result`; on every other node, an
// agent's `fleetd mac` (the local call `mac`) goes to the client, from the agent's worktree.
import { ToolError } from "../../shared/errors.ts";
import type { MacCallFrame } from "../../shared/screens_wire.ts";
import { CAP_AGENTS_MAC, CAP_MAC_TOOL } from "../../shared/screens_wire.ts";
import { type Node, onHub, toHub } from "../browser/node.ts";
import { loadOrCreateBoxKey } from "../identity.ts";
import { type MacCall, MacClient } from "./client.ts";
import { Host } from "./host.ts";

/** Whether this node is the agents' Mac (agents_mac/mod.rs `is_agents_mac`). */
export const isAgentsMac = (node: Node) => (node.config as { agentsMac?: boolean }).agentsMac === true;

/** The worktree a call comes from: the top of the git checkout its cwd is in. */
function worktreeOf(cwd: string): string {
  const out = Bun.spawnSync(["git", "-C", cwd, "rev-parse", "--show-toplevel"], { stdout: "pipe", stderr: "pipe" });
  if (out.exitCode !== 0) throw new ToolError("invalid", "fleetd mac runs in an agent's session, and this one has no worktree");
  return out.stdout.toString().trim();
}

export const host = (node: Node, given?: Host) =>
  node.area("mac_tool.host", (n) => given ?? new Host(`${n.home}/mac`, loadOrCreateBoxKey(n.home)));
export const client = (node: Node) => node.area("mac_tool.client", (n) => new MacClient(n));

export function start(node: Node): void {
  if (isAgentsMac(node)) {
    // As agents_mac/mod.rs `capabilities`: the agents' Mac, and its tool where the Mac is one (macOS).
    node.area("caps").contribute(() => [CAP_AGENTS_MAC, ...(process.platform === "darwin" ? [CAP_MAC_TOOL] : [])]);
    const h = host(node);
    onHub(node, "mac_call", (f) => {
      const frame = f as unknown as MacCallFrame;
      void h.answer(frame).then((answer) => toHub(node, { t: "mac_result", ...answer }));
    });
    return;
  }
  const c = client(node);
  node.area("local").on("mac", async (session, frame) => {
    try {
      if (!session) throw new ToolError("forbidden", "The agents' Mac is for agents' sessions, and this call comes from none.");
      const call = frame.call as unknown as MacCall;
      return { result: { op: "mac", ...(await c.call(session, worktreeOf(String(frame.cwd ?? "/")), call)) } };
    } catch (e) {
      return { error: e instanceof ToolError ? e.toJSON() : { code: "failed", message: (e as Error).message } };
    }
  });
}

/** Every job on the Mac ends with its node. */
export function stop(node: Node): void {
  if (isAgentsMac(node)) host(node).stop();
}

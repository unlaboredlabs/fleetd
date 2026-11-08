// The agents' Mac on a node (crates/fleetd/src/node/mac_tool/mod.rs): on the agents' Mac itself (node.json
// `agentsMac`), the hub's `mac_call`s go to the host and their answers back as `mac_result`; on every other node, an
// agent's `fleetd mac` (the local call `mac`) goes to the client, from the agent's worktree.
import { ToolError } from "../../shared/errors.ts";
import type { MacCallFrame } from "../../shared/screens_wire.ts";
import { CAP_AGENTS_MAC, CAP_MAC_TOOL } from "../../shared/screens_wire.ts";
import { type Node, onHub, toHub } from "../browser/node.ts";
import { loadOrCreateBoxKey } from "../identity.ts";
import { type IosConfig, Simulators, supported as simulatorsHere } from "../device/ios/index.ts";
import { MacSims, SIM_IDLE } from "../device/ios/sims.ts";
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
    // The agents' Mac lends iOS simulators while its tool is on (agents_mac.rs `ios_config`: opted in).
    const ios = { ...((node.config.ios ?? {}) as IosConfig), enabled: true };
    const setting = Number((node.config.mac as { simulators?: unknown } | undefined)?.simulators);
    if (simulatorsHere() && !h.sims) startSims(node, h, new Simulators(node.home, ios), Number.isInteger(setting) && setting > 0 ? setting : undefined);
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

/** Gives the host its simulators, ending those nobody used for SIM_IDLE while the node runs. */
export function startSims(node: Node, h: Host, simulators: Simulators, setting?: number): MacSims {
  const sims = new MacSims(node.home, simulators, setting);
  h.sims = sims;
  void simulators.start();
  sweeps.set(h, setInterval(() => sims.endIdle(SIM_IDLE), 60_000));
  // The doctor's iOS row (load.rs `ios`): no Xcode, no Node.js, the golden being made or why it failed, or ready.
  node.area("hb").contribute((hb) => {
    const ios = simulators.health();
    if (hb.load && ios) (hb.load as Record<string, unknown>).ios = ios;
  });
  return sims;
}
const sweeps = new WeakMap<Host, Timer>();

/** Every job on the Mac ends with its node, and every simulator it lent. */
export async function stop(node: Node): Promise<void> {
  if (!isAgentsMac(node)) return;
  const h = host(node);
  h.stop();
  clearInterval(sweeps.get(h));
  await h.sims?.shutdown();
}

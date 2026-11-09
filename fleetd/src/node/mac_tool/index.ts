// The agents' Mac on a node: on the agents' Mac itself (node.json
// `agentsMac`), the hub's `mac_call`s go to the host and their answers back as `mac_result`; on every other node, an
// agent's `fleetd mac` (the local call `mac`) goes to the client, from the agent's worktree.
import { join } from "node:path";
import { ToolError } from "../../shared/errors.ts";
import type { MacCallFrame } from "../../shared/screens_wire.ts";
import { CAP_AGENTS_MAC, CAP_MAC_TOOL } from "../../shared/screens_wire.ts";
import { type Node, onHub, toHub } from "../browser/node.ts";
import { loadOrCreateBoxKey } from "../identity.ts";
import { type IosConfig, Simulators, supported as simulatorsHere } from "../device/ios/index.ts";
import { MacSims, SIM_IDLE } from "../device/ios/sims.ts";
import { pinSelf } from "../self_exe.ts";
import { homeDir } from "../util.ts";
import { writeActivity, type Activity } from "./activity.ts";
import { type MacCall, MacClient } from "./client.ts";
import { FOLDER_DAYS, Host, sweep } from "./host.ts";
import { installShim, launchEnv, refreshForwarders } from "./shim.ts";

/** Whether this node is the agents' Mac (agents_mac/mod.rs `is_agents_mac`). */
export const isAgentsMac = (node: Node) => (node.config as { agentsMac?: boolean }).agentsMac === true;

/** The worktree a call comes from: the top of the git checkout its cwd is in. */
function worktreeOf(cwd: string): string {
  const out = Bun.spawnSync(["git", "-C", cwd, "rev-parse", "--show-toplevel"], { stdout: "pipe", stderr: "pipe" });
  if (out.exitCode !== 0) throw new ToolError("invalid", "fleetd mac runs in an agent's session, and this one has no worktree");
  return out.stdout.toString().trim();
}

// Agents' folders live in `~/work` as node/mod.rs's: a switch between the builds keeps their pushes, mirrors and cache.
export const host = (node: Node, given?: Host) =>
  node.area("mac_tool.host", (n) => given ?? new Host(join(homeDir(), "work"), loadOrCreateBoxKey(n.home)));
export const client = (node: Node) => node.area("mac_tool.client", (n) => new MacClient(n, () => self(n)));
/** The command agents' `mac` and agent-device forwarder run: this node's own binary, pinned once per node. */
export const self = (node: Node) => node.area("mac_tool.self", (n) => pinSelf(n.home));

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
    startHousekeeping(node, h);
    return;
  }
  // Every agent session here gets `mac` first on its PATH, and the forwarding agent-device while it holds a simulator.
  try {
    installShim(node.home, self(node));
    // Sessions holding a simulator kept their forwarder across the restart; the pin it ran was the node before's.
    refreshForwarders(node.home, self(node));
  } catch (e) {
    console.warn(`${new Date().toISOString()} WARN the agents' \`mac\` command was not written {"error":${JSON.stringify(String(e))}}`);
  }
  node.area("launch").contribute({ env: (thread, path) => launchEnv(node.home, thread, path) });
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

/** How often the Mac looks for agents' folders nothing touched for FOLDER_DAYS. */
export const SWEEP_EVERY = 6 * 3600_000;
/** How often the Mac looks for a change to the menu bar's activity. */
export const ACTIVITY_EVERY = 2_000;
const housekeeping = new WeakMap<Host, Timer[]>();

/** The Mac's own upkeep while the node runs (host.rs `Host::start`): old agents' folders swept now and every
 * SWEEP_EVERY, and what agents do on it written for the menu bar whenever it changes (activity.rs). */
function startHousekeeping(node: Node, h: Host): void {
  // One sweep at a time: a slow one (a big build's folder, a mirror's gc) is never started again under itself.
  let sweeping = false;
  const clean = () => {
    if (sweeping) return;
    sweeping = true;
    sweep(h.root, FOLDER_DAYS)
      .catch((e) => console.warn(`${new Date().toISOString()} WARN the Mac's agent folders were not swept {"error":${JSON.stringify(String(e))}}`))
      .finally(() => (sweeping = false));
  };
  let last: Activity | undefined;
  const write = () => (last = writeActivity(node.home, h.activity(), last));
  clean();
  write();
  housekeeping.set(h, [setInterval(clean, SWEEP_EVERY), setInterval(write, ACTIVITY_EVERY)]);
}

/** Every job on the Mac ends with its node, and every simulator it lent. */
export async function stop(node: Node): Promise<void> {
  if (!isAgentsMac(node)) return;
  const h = host(node);
  h.stop();
  clearInterval(sweeps.get(h));
  for (const t of housekeeping.get(h) ?? []) clearInterval(t);
  await h.sims?.shutdown();
}

// The agents' Mac on a node: on the agents' Mac itself (node.json
// `agentsMac`), the hub's `mac_call`s go to the host and their answers back as `mac_result`; on every other node, an
// agent's `fleetd mac` (the local call `mac`) goes to the client, from the agent's worktree.
import { join } from "node:path";
import { ToolError } from "../../shared/errors.ts";
import type { MacCallFrame } from "../../shared/screens_wire.ts";
import { CAP_AGENTS_MAC, CAP_MAC_TOOL, CAP_SCREEN_CONTROL } from "../../shared/screens_wire.ts";
import type { BrowserControlFrame, BrowserInputFrame, BrowserWatchFrame, ScreenControlFrame } from "../../shared/screens_wire.ts";
import type { HostCheck, SimModels } from "../../shared/contracts.ts";
import { hubCall, type Node, onHub, toHub } from "../browser/node.ts";
import { loadOrCreateBoxKey } from "../identity.ts";
import { type IosConfig, Simulators, supported as simulatorsHere } from "../device/ios/index.ts";
import { MacSims, SIM_IDLE } from "../device/ios/sims.ts";
import { SimScreens, simctlTools } from "../device/ios/sim_screen.ts";
import { iosDir } from "../device/ios/wrapper.ts";
import { pinSelf } from "../self_exe.ts";
import { homeDir } from "../util.ts";
import { writeActivity, type Activity } from "./activity.ts";
import { type MacCall, MacClient, worktreeOf } from "./client.ts";
import { FOLDER_DAYS, Host, sweep } from "./host.ts";
import { installShim, launchEnv, refreshForwarders } from "./shim.ts";

export { worktreeOf } from "./client.ts";

/** Whether this node is the agents' Mac (agents_mac/mod.rs `is_agents_mac`). */
export const isAgentsMac = (node: Node) => (node.config as { agentsMac?: boolean }).agentsMac === true;

/** The folder the node started a session in, from its record; undefined where the node has no sessions. */
export function startedIn(node: Node, session: string): string | undefined {
  try {
    return node.area("sessions").sessionCwd(session);
  } catch {
    return undefined;
  }
}

// Agents' folders live in `~/work` as node/mod.rs's: a switch between the builds keeps their pushes, mirrors and cache.
export const host = (node: Node, given?: Host) =>
  node.area("mac_tool.host", (n) => given ?? new Host(join(homeDir(), "work"), loadOrCreateBoxKey(n.home)));
export const client = (node: Node) =>
  node.area("mac_tool.client", (n) => new MacClient({ home: n.home, call: (op, args, opts) => hubCall(n, op, args, opts) }, () => self(n)));
/** The command agents' `mac` and agent-device forwarder run: this node's own binary, pinned once per node. */
export const self = (node: Node) => node.area("mac_tool.self", (n) => pinSelf(n.home));

export function start(node: Node): void {
  if (isAgentsMac(node)) {
    // As agents_mac/mod.rs `capabilities`: the agents' Mac, and its tool where the Mac is one (macOS).
    node.area("caps").contribute(() => [CAP_AGENTS_MAC, ...(process.platform === "darwin" ? [CAP_MAC_TOOL, CAP_SCREEN_CONTROL] : [])]);
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
      return { result: { op: "mac", ...(await c.call(session, worktreeOf(String(frame.cwd ?? "/"), startedIn(node, session)), call)) } };
    } catch (e) {
      return { error: e instanceof ToolError ? e.toJSON() : { code: "failed", message: (e as Error).message } };
    }
  });
}

/** Gives the host its simulators, ending those nobody used for SIM_IDLE while the node runs. */
export function startSims(node: Node, h: Host, simulators: Simulators, setting?: number): MacSims {
  const sims = new MacSims(node.home, simulators, setting);
  h.sims = sims;
  sims.screens = simScreens(node, simulators);
  const screens = sims.screens;
  // A screen's video starting is kept at once: a node that dies without its stop still leaves it to the next.
  screens.changed = () => sims.save();
  // The simulators the node before left held are their agents' again, screens too, before the sweep below looks for
  // recordings a stopped node left; the pool starts once they are known.
  void sims.adopt();
  // A person's input and controls keep the simulator they use, as an agent's steps do.
  screens.used = (agent) => sims.touch(agent);
  void screens.housekeep();
  sweeps.set(
    h,
    setInterval(() => {
      sims.endIdle(SIM_IDLE);
      void screens.housekeep();
    }, 60_000),
  );
  // The doctor's iOS row (load.rs `ios`): no Xcode, no Node.js, the golden being made or why it failed, or ready.
  // The simulators a person may start here (screen_open kind ios), read again every MODELS_EVERY.
  let models: SimModels | undefined;
  let modelsAt = 0;
  const readModels = () => {
    if (Date.now() - modelsAt < MODELS_EVERY) return;
    modelsAt = Date.now();
    sims.models().then(
      (m) => (models = m),
      () => (modelsAt = 0),
    );
  };
  node.area("hb").contribute((hb) => {
    const ios = simulators.health();
    if (hb.load && ios) (hb.load as Record<string, unknown>).ios = ios;
    if (!hb.load) return;
    readModels();
    hb.load.hosts = [...(hb.load.hosts ?? []), iosHost(simulators.usable(), models && { ...models, live: sims.held.size, max: sims.budget() })];
  });
  return sims;
}

/** How often the Mac reads its simulator models again (a new Xcode or runtime). */
export const MODELS_EVERY = 300_000;

/** The Mac's `ios` line: people start simulators here once its golden is made and it has read its models. */
export function iosHost(usable: boolean, models: SimModels | undefined): HostCheck {
  if (usable && models && models.models.length > 0) {
    return { host: "ios", ready: true, detail: `${models.models.length} iPhone and iPad models`, idleMinutes: 30, sims: models };
  }
  return { host: "ios", ready: false, off: "installing", detail: "the Mac's simulators are getting ready", idleMinutes: 30, ...(models ? { sims: models } : {}) };
}
const sweeps = new WeakMap<Host, Timer>();

/**
 * Each simulator's screen (sim_screen.ts): reported to the hub in its agent's name, and the hub's live view and
 * takeover for its ids; every other id goes on to the handler before (the Mac screen's, the browser broker's).
 */
function simScreens(node: Node, simulators: Simulators): SimScreens {
  const screens = new SimScreens(
    node.home,
    { hub: (thread, cwd, op, args) => hubCall(node, op, args, { threadId: thread, cwd }), send: (frame) => toHub(node, frame) },
    simctlTools(simulators.simctl, join(iosDir(node.home), "shots")),
  );
  const link = node.area("link");
  const ours = (f: unknown) => screens.byId(String((f as { sessionId?: unknown }).sessionId)) !== undefined;
  for (const [tag, mine] of [
    ["browser_watch", (f: unknown) => screens.watch(f as BrowserWatchFrame)],
    ["browser_input", (f: unknown) => screens.input(f as BrowserInputFrame)],
    ["browser_control", (f: unknown) => screens.control(f as BrowserControlFrame)],
    [
      "screen_control",
      (f: unknown) => void screens.screenControl(f as ScreenControlFrame).then((answer) => toHub(node, { t: "screen_control_result", ...answer })),
    ],
  ] as const) {
    const before = link.handler(tag);
    link.on(tag, (frame, ctx) => {
      if (ours(frame)) mine(frame);
      else if (before) before(frame, ctx);
      // A control for a screen the Mac doesn't have: the hub hears so at once.
      else if (tag === "screen_control") toHub(node, { t: "screen_control_result", ...noScreen(frame as unknown as ScreenControlFrame) });
    });
  }
  node.area("hb").contribute((hb) => {
    hb.steps.push(...screens.steps.list());
  });
  return screens;
}

/** The answer to a control for a screen this node doesn't have. */
export const noScreen = (frame: ScreenControlFrame) => ({
  id: frame.id,
  error: { code: "not_found" as const, message: `Screen ${frame.sessionId} isn't live here any more.` },
});

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

/** Every job on the Mac ends with its node; the simulators it lent run on, for the next node to take over. */
export async function stop(node: Node): Promise<void> {
  if (!isAgentsMac(node)) return;
  const h = host(node);
  h.stop();
  clearInterval(sweeps.get(h));
  for (const t of housekeeping.get(h) ?? []) clearInterval(t);
  await h.sims?.stop();
}

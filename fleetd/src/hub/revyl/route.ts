// Where an agent's phone screen goes once the team connected its Revyl key (machine_roles/calls.ts asks): its kind's
// route (shared/revyl.ts `choose`) over how the team's own machines stand now. An Android emulator runs on the agent's
// own machine, so that machine's free slots are "ours"; an iOS simulator is the agents' Mac's (`mac sim start`), and
// the Mac's heartbeat says how many of its simulators are held and how many agents wait. With ours_only, an Android
// start waits in one line per kind, first come first served, while the agent's machine is full; Revyl's own queue holds
// a start while the team's Revyl sessions are all in use. With no key nothing here runs: today's placement does.
import type { RevylKind } from "../../shared/contracts.ts";
import { ToolError } from "../../shared/errors.ts";
import { choose, type Ours } from "../../shared/revyl.ts";
import { CAP_REVYL, IOS_GONE, type SessionRouteResult } from "../../shared/screens_wire.ts";
import type { Hub } from "../api/hub.ts";
import { link } from "../link/index.ts";
import { Queue } from "../../node/mac_tool/queue.ts";
import { macMachine } from "../machine_roles/mac.ts";
import { able, free, type Runner } from "../machine_roles/placement.ts";
import { connected, routeFor, sealedTo } from "./index.ts";

/** How often a node in line asks again (node/session_route): a turn it doesn't come back for within GONE goes on. */
export { ASK_EVERY, GONE } from "../../node/mac_tool/queue.ts";

/** Why a start waits: its place in line. The node asks again while `reason` is `queued`. */
export const QUEUED = "queued";

const lines = new WeakMap<Hub, Map<RevylKind, Queue>>();
function line(hub: Hub, kind: RevylKind): Queue {
  let m = lines.get(hub);
  if (!m) lines.set(hub, (m = new Map()));
  let q = m.get(kind);
  if (!q) m.set(kind, (q = new Queue()));
  return q;
}

/** How the agent's own machine stands for an Android emulator, with a sentence on why it can't take one now. */
function android(origin: string, all: Runner[]): [Ours, string] {
  const own = all.find((r) => r.machineId === origin);
  if (!own || !able(own, "android", origin)) return ["none", `${own?.name ?? origin} can't host an Android emulator`];
  if (!own.online) return ["none", `${own.name} is offline`];
  if (free(own) <= 0) return ["full", `${own.name}'s screen slots are full (${own.live} of ${own.max})`];
  return ["free", ""];
}

/** How the agents' Mac stands for an iOS simulator: by its last heartbeat; one that doesn't say counts as free. */
function ios(hub: Hub): [Ours, string] {
  const mac = macMachine(hub);
  if (!mac) return ["none", "the team has no agents' Mac online for iOS simulators"];
  const sims = link(hub).load(mac)?.sims;
  if (sims && sims.inUse + sims.waiting >= sims.budget) {
    return ["full", `all ${sims.budget} of the agents' Mac's iOS simulators are in use`];
  }
  return ["free", ""];
}

const NAME: Record<RevylKind, string> = { ios: "iPhone", android: "Android phone" };

/**
 * A phone start routed by its kind's route: a Revyl screen for the agent's node to start, the way to the agents' Mac
 * for iOS (thrown), the place in line (thrown, reason `queued`), or undefined for today's placement on the team's
 * machines.
 */
export async function routePhone(hub: Hub, kind: RevylKind, origin: string, thread: string, all: Runner[]): Promise<SessionRouteResult | undefined> {
  if (!connected(hub)) return undefined;
  const route = routeFor(hub, kind);
  const [ours, why] = kind === "android" ? android(origin, all) : ios(hub);
  // A node that can't drive Revyl screens gets the team's machines, as before the key; refused when only Revyl may serve.
  const canRevyl = link(hub).can(origin, CAP_REVYL);
  let to = choose(route, ours);
  if (to === "revyl" && !canRevyl) {
    if (route === "revyl_only") {
      throw new ToolError(
        "failed",
        `The team's ${NAME[kind]} screens come from Revyl, and ${origin}'s fleetd is too old to drive one.`,
        "do without it and say so in your result: an admin updates fleetd on this machine",
      );
    }
    to = choose("ours_only", ours);
  }
  const agent = `${origin}/${thread}`;
  if (to === "revyl") {
    line(hub, kind).leave(agent);
    const because = route === "revyl_only" ? `the team routes ${NAME[kind]} screens to Revyl` : `${why}, so this one is Revyl's`;
    return { runner: origin, here: true, revyl: { platform: kind, sealed: await sealedTo(hub, origin, `a Revyl ${NAME[kind]}`), why: because } };
  }
  if (kind === "ios") {
    // The agents' Mac's simulators have their own line: `mac sim start --wait` waits in it.
    const fix = to === "line" ? "run mac sim start --wait: it keeps your place in the Mac's line" : "mac --help says the rest; fleetd docs: The agents' Mac";
    throw new ToolError("invalid", IOS_GONE, fix);
  }
  const q = line(hub, kind);
  const turn = q.turn(agent, true, to === "line" ? 1 : 0, 1, hub.clock.now());
  if (turn.now) {
    q.leave(agent);
    return undefined;
  }
  const ahead = turn.place - 1;
  throw new ToolError(
    "failed",
    `You're waiting for an Android screen: ${why || "the agents ahead of you get theirs first"}${ahead > 0 ? `, and ${ahead} ${ahead === 1 ? "agent is" : "agents are"} ahead of you` : ""}.`,
    "call session_start again within 2 minutes to keep your place in line",
    QUEUED,
  );
}

// The agents' Mac, the hub's half (D298): `mac_where` names the online machine whose
// node lists `mac_tool` and its key, `mac_send` passes one step an agent's node sealed to it on, with who the caller is,
// and brings back the sealed answer. The hub never opens either. Every project's agents may use the Mac; projects never.
//
// A step the agent's node marks `sim` (a `mac sim start`) goes with a screen the hub made for it, a hosted session of
// the agent's placed on the Mac (machine_roles `simPlace`): a simulator the step lends is that screen, watched, taken
// over and recorded there, and the Mac reports it under the place's key in the agent's name.
//
// At each sweep the hub names the tasks that ended to the Mac (`tellEnded`), whose folders there go.
//
// Which Mac is `macFor`'s (machine_roles/mac.ts): an agent on a Mac that runs agents uses that Mac itself, and `mac_where`
// says so (`here`); every other agent uses the agents' Mac. Each `mac_call` carries how many simulators the Mac runs at
// once, as its screens settings say (`sims`).
import { ToolError } from "../../shared/errors.ts";
import type { MacCaller, MacResultFrame, MacSendCall } from "../../shared/screens_wire.ts";
import type { Hub } from "../api/hub.ts";
import type { LeadCaller } from "../lead_calls/types.ts";
import { leadCalls } from "../lead_calls/index.ts";
import { store } from "../store/hub_store.ts";
import { isoMs } from "../store/time.ts";
import { sweep } from "../sweep/index.ts";
import { TaskRecords } from "../tasks/records.ts";
import { request } from "../machine_roles/calls.ts";
import { macFor } from "../machine_roles/mac.ts";
import { newKey, rolesOn, simPlace } from "../machine_roles/places.ts";
import { CAP_AGENTS_MAC, CAP_OWN_MAC } from "../../shared/screens_wire.ts";
import { link } from "../link/index.ts";
import { settingsPath } from "../../shared/settings_path.ts";

export const OPS = ["mac_where", "mac_send"] as const;

/** The longest step: a first push indexes a whole tree on the Mac. The agent's node waits a little longer. */
export const SEND_WAIT = 170_000;

export function registerLeadCalls(hub: Hub): void {
  const calls = leadCalls(hub);
  calls.register("mac_where", (caller) => where(hub, caller));
  calls.register("mac_send", (caller, call) => send(hub, caller, call as unknown as MacSendCall));
  sweep(hub).register({ name: "mac-ended", run: () => tellEnded(hub) });
  // A Mac hears how many simulators it runs at once as it links, before any agent asks it for one.
  link(hub).onLinked(({ machineId }) => {
    if (link(hub).can(machineId, CAP_OWN_MAC) || link(hub).can(machineId, CAP_AGENTS_MAC)) tellSims(hub, machineId);
  });
}

/** Tells Mac `m` how many simulators it runs at once, as its screens settings say now: when they change, as it links. */
export function tellSims(hub: Hub, m: string): void {
  void request(hub, m, { t: "node_action", action: "mac_sims", ...sims(hub, m) }, 15_000).catch((e: unknown) =>
    console.info(`simulators at once not told to ${m}: ${(e as Error).message ?? String(e)}`),
  );
}

/** How far back `tellEnded` looks: past it the Mac's own sweep (FOLDER_DAYS of no use) has removed the folder. */
export const ENDED_DAYS = 7;
/** How long the Mac may take removing them: a folder with a big build in it takes a while. */
const ENDED_WAIT = 120_000;

/**
 * Tells each online agents' Mac which tasks ended (TaskRecords.endedSince), at every sweep: their folders there go
 * (node/mac_tool `ended`), so a finished task's checkout and build output don't sit on the Mac's disk for days. Sent
 * again each time, so a Mac that was offline, restarted or just used by a task that went on catches up at the next.
 */
export async function tellEnded(hub: Hub): Promise<void> {
  const macs = store(hub)
    .machinesList()
    .filter((m) => m.status !== "offline" && (m.agentsMac === true || link(hub).can(m.machineId, CAP_OWN_MAC)))
    .map((m) => m.machineId);
  if (macs.length === 0) return;
  const tasks = TaskRecords.endedSince(hub.db.conn, isoMs(hub.clock.now() - ENDED_DAYS * 86_400_000));
  if (tasks.length === 0) return;
  await Promise.all(
    macs.map((m) =>
      request(hub, m, { t: "node_action", action: "mac_ended", tasks }, ENDED_WAIT).catch((e: unknown) =>
        console.info(`ended tasks' folders not sent to ${m}: ${(e as Error).message ?? String(e)}`),
      ),
    ),
  );
}

/** Who may use the Mac: an agent's session (a lead's or a task's), never a person's shell. */
function callerOf(caller: LeadCaller): void {
  if (caller.agent.kind === "person" || caller.agent.kind === "memory_refresh") {
    throw new ToolError("forbidden", "The agents' Mac is for agents' sessions, and this call comes from none.");
  }
}

function theMac(hub: Hub, caller: LeadCaller): { machineId: string; here: boolean; key: string | undefined } {
  const mac = macFor(hub, caller.projectRef.machineId);
  if (!mac) {
    throw new ToolError(
      "machine_offline",
      "No agents' Mac is online: none joined this workspace, it's turned off, or it's waiting for its account to log in again after a restart.",
      `do without the Mac and say so in your result; an admin connects one in ${settingsPath()} › Machines`,
    );
  }
  return { ...mac, key: store(hub).machineGet(mac.machineId)?.boxPubKey };
}

function where(hub: Hub, caller: LeadCaller) {
  callerOf(caller);
  const { machineId, here, key } = theMac(hub, caller);
  if (!key) {
    throw new ToolError("failed", `${machineId}, ${here ? "this Mac" : "the agents' Mac"}, has no key to seal to.`, "ask an admin to update fleetd on the Mac");
  }
  return { machineId, boxPubKey: key, name: store(hub).machineGet(machineId)?.name ?? machineId, ...(here ? { here: true } : {}) };
}

async function send(hub: Hub, caller: LeadCaller, call: MacSendCall) {
  callerOf(caller);
  const { machineId, here } = theMac(hub, caller);
  const named = here ? "this Mac" : "the agents' Mac";
  if (machineId !== call.machineId) {
    throw new ToolError("invalid", `${call.machineId} is not the Mac your mac commands use any more; ${machineId} is.`, "run the command again");
  }
  const who: MacCaller = {
    machineId: caller.projectRef.machineId,
    projectId: caller.projectRef.projectId,
    ...(caller.agent.kind === "task" ? { taskId: caller.agent.taskId } : {}),
    threadId: call.threadId,
  };
  const screen =
    call.sim === true
      ? hub.db.transaction((c) => simPlace(c, machineId, caller.projectRef, call.threadId, who.taskId, hub.clock.now()))
      : undefined;
  let answer: MacResultFrame;
  try {
    answer = await request<MacResultFrame>(
      hub,
      machineId,
      {
        t: "mac_call",
        id: `mac-${newKey().slice(1, 13)}`,
        caller: who,
        sealed: call.sealed,
        ...(screen ? { screen: { hostKey: screen.key, sessionId: screen.sessionId! } } : {}),
        ...sims(hub, machineId),
      },
      SEND_WAIT,
    );
  } catch (e) {
    throw new ToolError(
      "machine_offline",
      `${machineId}, ${named}, did not answer: ${(e as Error).message}.`,
      "try again shortly; if it keeps failing, do without the Mac and say so in your result",
    );
  }
  if (answer.sealed !== undefined) return { sealed: answer.sealed };
  if (answer.error) throw new ToolError(answer.error.code, answer.error.message, answer.error.fix);
  throw new ToolError("failed", `${machineId}, ${named}, sent an empty answer.`);
}

/** The `mac_call`'s `sims`: how many simulators Mac `m` runs at once as its screens settings say, null for its default. */
export const sims = (hub: Hub, m: string): { sims: number | null } => ({ sims: rolesOn(hub.db.conn, m).maxSims ?? null });

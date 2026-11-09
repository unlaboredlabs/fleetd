// The agents' Mac, the hub's half (D298): `mac_where` names the online machine whose
// node lists `mac_tool` and its key, `mac_send` passes one step an agent's node sealed to it on, with who the caller is,
// and brings back the sealed answer. The hub never opens either. Every project's agents may use the Mac; Navis never.
import { ToolError } from "../../shared/errors.ts";
import type { MacCaller, MacResultFrame, MacSendCall } from "../../shared/screens_wire.ts";
import type { Hub } from "../api/hub.ts";
import type { LeadCaller } from "../lead_calls/types.ts";
import { leadCalls } from "../lead_calls/index.ts";
import { store } from "../store/hub_store.ts";
import { request } from "../machine_roles/calls.ts";
import { macMachine } from "../machine_roles/mac.ts";
import { newKey } from "../machine_roles/places.ts";

export const OPS = ["mac_where", "mac_send"] as const;

/** The longest step: a first push indexes a whole tree on the Mac. The agent's node waits a little longer. */
export const SEND_WAIT = 170_000;

export function registerLeadCalls(hub: Hub): void {
  const calls = leadCalls(hub);
  calls.register("mac_where", (caller) => where(hub, caller));
  calls.register("mac_send", (caller, call) => send(hub, caller, call as unknown as MacSendCall));
}

/** Who may use the Mac: an agent's session (a lead's or a task's), never a person's shell. */
function callerOf(caller: LeadCaller): void {
  if (caller.agent.kind === "person" || caller.agent.kind === "memory_refresh") {
    throw new ToolError("forbidden", "The agents' Mac is for agents' sessions, and this call comes from none.");
  }
}

function theMac(hub: Hub): { machineId: string; key: string | undefined } {
  const machineId = macMachine(hub);
  if (!machineId) {
    throw new ToolError(
      "machine_offline",
      "No agents' Mac is online: none joined this hub, it's turned off, or it's waiting for its account to log in again after a restart.",
      "do without the Mac and say so in your result; an admin connects one in Settings › Hub › Machines",
    );
  }
  return { machineId, key: store(hub).machineGet(machineId)?.boxPubKey };
}

function where(hub: Hub, caller: LeadCaller) {
  callerOf(caller);
  const { machineId, key } = theMac(hub);
  if (!key) {
    throw new ToolError("failed", `${machineId}, the agents' Mac, has no key to seal to.`, "ask an admin to update fleetd on the Mac");
  }
  return { machineId, boxPubKey: key };
}

async function send(hub: Hub, caller: LeadCaller, call: MacSendCall) {
  callerOf(caller);
  const { machineId } = theMac(hub);
  if (machineId !== call.machineId) {
    throw new ToolError("invalid", `${call.machineId} is not the agents' Mac any more; ${machineId} is.`, "run the command again");
  }
  const who: MacCaller = {
    machineId: caller.projectRef.machineId,
    projectId: caller.projectRef.projectId,
    ...(caller.agent.kind === "task" ? { taskId: caller.agent.taskId } : {}),
    threadId: call.threadId,
  };
  let answer: MacResultFrame;
  try {
    answer = await request<MacResultFrame>(
      hub,
      machineId,
      { t: "mac_call", id: `mac-${newKey().slice(1, 13)}`, caller: who, sealed: call.sealed },
      SEND_WAIT,
    );
  } catch (e) {
    throw new ToolError(
      "machine_offline",
      `${machineId}, the agents' Mac, did not answer: ${(e as Error).message}.`,
      "try again shortly; if it keeps failing, do without the Mac and say so in your result",
    );
  }
  if (answer.sealed !== undefined) return { sealed: answer.sealed };
  if (answer.error) throw new ToolError(answer.error.code, answer.error.message, answer.error.fix);
  throw new ToolError("failed", `${machineId}, the agents' Mac, sent an empty answer.`);
}

// The agents' Mac (D298) as the hub sees it: the machine whose node lists
// `agents_mac` (a tool, never a runner), the admin's "Agents may use this Mac" switch, and where agents' `mac` calls
// go: `macMachine`. Every project's agents may use it; projects never.
import type { MacTool } from "../../shared/contracts.ts";
import { CAP_MAC_TOOL } from "../../shared/screens_wire.ts";
import type { Hub } from "../api/hub.ts";
import { link } from "../link/index.ts";
import { store } from "../store/hub_store.ts";
import { toolOn } from "./places.ts";

/** Whether `m` is the agents' Mac, by what its node last said at its hello. */
export const isAgentsMac = (hub: Hub, m: string) => store(hub).machineGet(m)?.agentsMac === true;

/** The machine agents' `mac` calls go to: the online agents' Mac whose node lists `mac_tool`, while the switch is on. */
export function macMachine(hub: Hub): string | undefined {
  if (!toolOn(hub.db.conn)) return undefined;
  return store(hub)
    .machinesList()
    .sort((a, b) => (a.machineId < b.machineId ? -1 : a.machineId > b.machineId ? 1 : 0))
    .filter((m) => m.agentsMac === true && m.status !== "offline")
    .map((m) => m.machineId)
    .find((m) => link(hub).can(m, CAP_MAC_TOOL));
}

const clip = (text: string, max: number) => ([...text].length <= max ? text : `${[...text].slice(0, max - 1).join("")}…`);

/** The agents' Mac's tool for Settings › Hub › Machines; undefined on any other machine. */
export function tool(hub: Hub, m: string): MacTool | undefined {
  const machine = store(hub).machineGet(m);
  if (machine?.agentsMac !== true) return undefined;
  const on = toolOn(hub.db.conn);
  const ready = machine.status !== "offline" && link(hub).can(m, CAP_MAC_TOOL);
  const name = machine.name;
  let note: string | undefined;
  if (machine.status === "offline") {
    note = `${name} is offline. After a restart, log in on it again as the account it joined from (at the Mac or over Screen Sharing) to bring it back.`;
  } else if (!ready) {
    note = `${name}'s node doesn't offer the tool: it runs on macOS only. Its checks in Settings › Hub › Setup › A Mac for agents say what to fix.`;
  } else if (!on) {
    note = "Off: agents' mac commands answer that the Mac is turned off.";
  }
  return { on, ready, ...(note === undefined ? {} : { note: clip(note, 300) }) };
}

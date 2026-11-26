// What a self-hosted hub says of the hosted sandboxes it no longer runs (D594). Until 2026-11-20 a team could connect
// its own boat.dev key, and the hub ran a node of its own under the machine id `hosted` (HOSTED_ID) whose bots ran in
// those sandboxes, their checkouts in `<hub home>/runner`. A hub's agents run on its own computers now, so that node
// is gone; its bots stay, with their files where they were. The migration that removed it (own_machines_only) had each
// such bot's chat told once (`tellOnce`), and a message to one is answered at once with the same line (`hostedGoneLine`), never silence.
// The id stays reserved, so no computer joins under it and takes those bots over.
import { join } from "node:path";
import type { ProjectRef } from "../../shared/contracts.ts";
import { RUNNER_ID } from "../../shared/sandbox.ts";
import type { Hub } from "../api/hub.ts";
import { chat } from "../chat/index.ts";
import { store } from "../store/hub_store.ts";

/** The machine id of the hub's hosted sandboxes, kept from any computer. */
export const HOSTED_ID = RUNNER_ID;

/** Why nothing joins as HOSTED_ID, or acts on it as a computer: `what` ends the sentence. */
export const hostedIdRefused = (what: string) => `"${HOSTED_ID}" was the workspace's hosted sandboxes, which fleetd no longer runs: ${what}`;

/** Where the hub's hosted sandboxes kept their bots' checkouts, under the hub's home. */
export const hostedFiles = (hubHome: string) => join(hubHome, "runner");

/** Where bot `r`'s files are: its own folder, where the hosted sandboxes kept it, else their folder. */
export function filesOf(hub: Hub, r: ProjectRef): string {
  const root = store(hub).projectGet(r)?.workspaceRoot;
  const all = hostedFiles(hub.config.home);
  return root && (root === all || root.startsWith(`${all}/`)) ? root : all;
}

/** Why bot `r`, which ran in a hosted sandbox, does nothing now, and what to do: what a message to it is answered. */
export const hostedGone = (hub: Hub, r: ProjectRef): { message: string; fix: string } => ({
  message: `This bot ran in a hosted sandbox with a key of your own, which fleetd no longer supports. Its files are in ${filesOf(hub, r)} on the workspace's machine.`,
  fix: "Add its repo on one of your computers to keep working on it.",
});

/** The one plain line such a bot's chat gets, once (`tellOnce`). */
export const hostedGoneLine = (hub: Hub, r: ProjectRef): string => {
  const g = hostedGone(hub, r);
  return `${g.message} ${g.fix}`;
};

/** What a bot that had picked a computer of its own hears, `was` its pick, `machine` the computer it runs on now. */
export function pickGoneLine(was: "vm" | "boat", machine: string): string {
  return was === "vm"
    ? `fleetd no longer runs agents in VMs on your computers: this bot's agents run directly on ${machine} again, as before.`
    : `fleetd no longer supports hosted sandboxes with a key of your own: this bot's agents run on ${machine} from now on.`;
}

/** The source the line goes in with: a chat takes one message per source, so it is said once however often this runs. */
const SOURCE = "hosted_removed";

/** Each bot the migration listed (table `hosted_removed`) hears its line once, then is marked said. How many did. */
export function tellOnce(hub: Hub): number {
  const due = hub.db.conn
    .query<{ machine_id: string; project_id: string; was: "vm" | "boat" | "runner" }, []>("SELECT machine_id, project_id, was FROM hosted_removed WHERE said = 0")
    .all();
  let told = 0;
  for (const row of due) {
    const r = { machineId: row.machine_id, projectId: row.project_id };
    if (store(hub).projectGet(r)) {
      const text = row.was === "runner" ? hostedGoneLine(hub, r) : pickGoneLine(row.was, store(hub).machineGet(r.machineId)?.name ?? r.machineId);
      chat(hub).add(r, { author: "system", text, source: SOURCE });
      told++;
    }
    hub.db.conn.query("UPDATE hosted_removed SET said = 1 WHERE machine_id = ? AND project_id = ?").run(row.machine_id, row.project_id);
  }
  return told;
}

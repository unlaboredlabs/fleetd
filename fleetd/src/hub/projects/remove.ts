// project_remove: removes the checkouts of its repos with it, erases
// the project (project_lead/erase.rs, one rule for every project since D310), and asks each hub it is linked to to revoke its
// link. A project whose machine the hub no longer has is only forgotten in the hub.
import type { ProjectRef, ProjectRemoveInput } from "../../shared/contracts.ts";
import { ToolError } from "../../shared/errors.ts";
import { CAP_PROJECT_ERASE, CAP_PROJECT_SETTINGS } from "../../shared/node_link.ts";
import { botPeople, requireBotAdmin } from "../api/bot_admin.ts";
import { requireRole } from "../api/grants.ts";
import type { Hub } from "../api/hub.ts";
import { offline, unknownProject } from "../api/refusals.ts";
import type { Caller } from "../api/registry.ts";
import { executors } from "../executor/index.ts";
import { projectRemove } from "../executor/projects.ts";
import { fromExecutor } from "../executor/tools.ts";
import { link } from "../link/index.ts";
import { asked, erase } from "../project_lead/erase.ts";
import * as repos from "../repos/store.ts";
import { events } from "../store/events.ts";
import { store } from "../store/hub_store.ts";
import { isoMs } from "../store/time.ts";
import { otherCheckouts } from "./repos.ts";
import { tooOld } from "./settings.ts";

const ERASED =
  "Erased: its chat, memory, skills, approvals and purchases, asks and decisions, orders and tasks, automations, kept browser " +
  "sign-ins, transcripts, attachments and screen recordings";

export async function remove(hub: Hub, caller: Caller, input: ProjectRemoveInput): Promise<{ ok: true; next: string }> {
  const m = input.machineId;
  requireRole(caller, "operate", m);
  const r = { machineId: m, projectId: input.projectId };
  requireBotAdmin(hub, caller, r, "remove");
  // Read now: its node's answer below already takes it out of the list, and its chat with it.
  const tell = teller(hub, caller, r);
  if (!store(hub).machineGet(m)) {
    const gone = forgetGone(hub, r);
    tell();
    return gone;
  }
  if (!executors(hub).isConnected(m)) throw offline(m);
  const removeWorktrees = input.removeWorktrees === true;
  if (removeWorktrees && !link(hub).can(m, CAP_PROJECT_SETTINGS)) throw tooOld(m);
  // The checkouts of its other repos go with it, the same way: each is a node project of its own, hidden only while a
  // project holds it, so one left on the node would show as a project once this one is gone. One another project
  // also holds stays.
  // Every project is erased (D287, one rule since D310), on its node too, which must know how; its folder goes only
  // if asked.
  const removeFolder = input.removeFolder === true;
  const erases = link(hub).can(m, CAP_PROJECT_ERASE);
  if (!erases) {
    throw new ToolError(
      "invalid",
      `Update fleetd on ${m} first: its node is too old to erase a bot, so nothing was deleted`,
      `Run fleetd update on ${m}, then delete it again.`,
    );
  }
  // Marked first: should the node remove it but its answer never come, the hub still erases it (project_lead/erase.ts `run`).
  asked(hub, r);
  const checkouts: string[] = [];
  for (const checkout of otherCheckouts(hub, r)) {
    if (repos.holders(hub.db.conn, checkout).every((h) => h.project.machineId === r.machineId && h.project.projectId === r.projectId)) {
      checkouts.push(checkout.projectId);
    }
  }
  for (const projectId of [input.projectId, ...checkouts]) {
    const own = projectId === input.projectId;
    await projectRemove(hub, m, projectId, removeWorktrees, own, removeFolder && own).catch((e) => {
      throw fromExecutor(e);
    });
  }
  erase(hub, r);
  tell();
  const next = removeFolder
    ? `${ERASED}, and its folder with everything in it.`
    : `${ERASED}. Its folder, files and branches stay on the machine.`;
  return { ok: true, next };
}

/**
 * What tells the bot's other people (who wrote in its chat or started its orders, read before it goes) who deleted it,
 * once it is gone: `project.erased`, which their apps and phones notify.
 */
function teller(hub: Hub, caller: Caller, r: ProjectRef): () => void {
  const title = store(hub).projectGet(r)?.title ?? r.projectId;
  const people = botPeople(hub, r, caller.person?.personId);
  const name = caller.person?.name ?? caller.name;
  return () =>
    events(hub).append({
      at: isoMs(hub.clock.now()),
      type: "project.erased",
      machineId: r.machineId,
      summary: `${name} deleted the bot ${title}`,
      attention: "loud",
      data: { projectId: r.projectId, title, people, ...(caller.person ? { by: caller.person } : {}) },
    });
}

/**
 * A project of a machine the hub no longer has (removed before `machine remove` forgot its rows): no node holds its
 * files to stop or remove, so the hub erases what it holds of it (as for every project) and forgets its rows
 * (`machineProjectForget`), and says so with project.removed. Another machine's project under the same id stays.
 */
function forgetGone(hub: Hub, r: ProjectRef): { ok: true; next: string } {
  const project = store(hub).projectGet(r);
  if (!project) throw unknownProject(r);
  erase(hub, r);
  store(hub).machineProjectForget(r);
  events(hub).append({
    at: isoMs(hub.clock.now()),
    type: "project.removed",
    machineId: r.machineId,
    projectId: r.projectId,
    summary: `Bot "${project.title}" on ${r.machineId} was forgotten: its machine was removed`,
    data: { title: project.title },
  });
  return {
    ok: true,
    next: `${r.machineId} is no longer in the workspace, so no machine held its files: fleetd forgot the bot, its chat and its settings.`,
  };
}

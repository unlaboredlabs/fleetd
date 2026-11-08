// project_remove (crates/fleetd/src/hub/projects/tools.rs `remove`): removes the checkouts of its repos with it, erases
// the project (navi/erase.rs, one rule for every project since D310), and asks each hub it is linked to to revoke its
// link. A project whose machine the hub no longer has is only forgotten in the hub.
//
// The erase is T2285's `src/hub/navi/erase.ts`, not on main yet: until it is, a removal is refused before it touches
// anything, on the node or in the hub.
import type { Database } from "bun:sqlite";
import type { ProjectRef, ProjectRemoveInput } from "../../shared/contracts.ts";
import { NotImplemented, ToolError } from "../../shared/errors.ts";
import { CAP_NAVI_ERASE, CAP_PROJECT_ERASE, CAP_PROJECT_SETTINGS } from "../../shared/node_link.ts";
import { requireRole } from "../api/grants.ts";
import type { Hub } from "../api/hub.ts";
import { offline, unknownProject } from "../api/refusals.ts";
import type { Caller } from "../api/registry.ts";
import { executors } from "../executor/index.ts";
import { projectRemove } from "../executor/projects.ts";
import { fromExecutor } from "../executor/tools.ts";
import { revokeAllThere } from "../hub_links/client.ts";
import { kept } from "../hub_links/store.ts";
import { link } from "../link/index.ts";
import { of as naviOf } from "../navi/store.ts";
import * as repos from "../repos/store.ts";
import { events } from "../store/events.ts";
import { store } from "../store/hub_store.ts";
import { isoMs } from "../store/time.ts";
import { otherCheckouts } from "./repos.ts";
import { tooOld } from "./settings.ts";

/** What erasing a project takes (navi/erase.rs `asked`, `erase`): T2285's `src/hub/navi/erase.ts`. */
type Erase = {
  /** Marked first: should the node remove it but its answer never come, the hub still erases it. */
  asked(db: Database, r: ProjectRef): void;
  eraseIn(db: Database, home: string, r: ProjectRef): void;
};

/** The erase, imported statically once T2285's `src/hub/navi/erase.ts` is on main. */
function eraser(): Erase {
  throw new NotImplemented("src/hub/navi/erase.ts (erasing a project, T2285)");
}

const ERASED =
  "Erased: its chat, memory, skills, approvals and purchases, asks and decisions, orders and tasks, automations, kept browser " +
  "sign-ins, linked hubs, transcripts, attachments and screen recordings";

export async function remove(hub: Hub, caller: Caller, input: ProjectRemoveInput): Promise<{ ok: true; next: string }> {
  const m = input.machineId;
  requireRole(caller, "operate", m);
  const r = { machineId: m, projectId: input.projectId };
  // Its linked hubs, read before the erase deletes their keys: each is asked to revoke its link once it is gone.
  const links = kept(hub.db, r);
  if (!store(hub).machineGet(m)) {
    const forgot = forgetGone(hub, r);
    revokeAllThere(hub, links);
    return forgot;
  }
  if (!executors(hub).isConnected(m)) throw offline(m);
  const removeWorktrees = input.removeWorktrees === true;
  if (removeWorktrees && !link(hub).can(m, CAP_PROJECT_SETTINGS)) throw tooOld(m);
  // The checkouts of its other repos go with it, the same way: each is a node project of its own, hidden only while a
  // project holds it, so one left on the node would show as a project once this one is gone. One another project
  // also holds stays.
  // Every project is erased (D287, one rule since D310), on its node too, which must know how; its folder goes only
  // if asked. A node before that erases a Navi alone.
  const navi = naviOf(hub.db.conn, r) !== undefined;
  const removeFolder = input.removeFolder === true;
  const erases = link(hub).can(m, CAP_PROJECT_ERASE) || (navi && link(hub).can(m, CAP_NAVI_ERASE));
  if (!erases) {
    throw new ToolError(
      "invalid",
      `Update fleetd on ${m} first: its node is too old to erase a project, so nothing was deleted`,
      `Run fleetd update on ${m}, then delete it again.`,
    );
  }
  const erase = eraser();
  erase.asked(hub.db.conn, r);
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
  erase.eraseIn(hub.db.conn, hub.config.home, r);
  revokeAllThere(hub, links);
  const next = removeFolder
    ? `${ERASED}, and its folder with everything in it.`
    : `${ERASED}. Its folder, files and branches stay on the machine.`;
  return { ok: true, next };
}

/**
 * A project of a machine the hub no longer has (removed before `machine remove` forgot its rows): no node holds its
 * files to stop or remove, so the hub erases what it holds of it (as for every project) and forgets its rows
 * (`machineProjectForget`), and says so with project.removed. Another machine's project under the same id stays.
 */
function forgetGone(hub: Hub, r: ProjectRef): { ok: true; next: string } {
  const project = store(hub).projectGet(r);
  if (!project) throw unknownProject(r);
  eraser().eraseIn(hub.db.conn, hub.config.home, r);
  store(hub).machineProjectForget(r);
  events(hub).append({
    at: isoMs(hub.clock.now()),
    type: "project.removed",
    machineId: r.machineId,
    projectId: r.projectId,
    summary: `Project "${project.title}" on ${r.machineId} was forgotten: its machine was removed`,
    data: { title: project.title },
  });
  return {
    ok: true,
    next: `${r.machineId} is no longer in the hub, so no machine held its files: fleetd forgot the project, its chat and its settings.`,
  };
}

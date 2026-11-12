// A project's archive, asks, sites, approvals and sign-ins tools (tools.rs). The purchases come with purchases.ts.
import type { ProjectRef, ProjectSummary } from "../../shared/contracts.ts";
import { ToolError } from "../../shared/errors.ts";
import { CAP_SIGNINS_FORGET } from "../../shared/node_link.ts";
import { isHuman, requireRole } from "../api/grants.ts";
import type { Hub } from "../api/hub.ts";
import { offline, unknownProject } from "../api/refusals.ts";
import type { Caller, Registry } from "../api/registry.ts";
import { allows } from "../auth/index.ts";
import { executors } from "../executor/index.ts";
import { interruptNow, signinsForget, stop } from "../executor/projects.ts";
import { fromExecutor } from "../executor/tools.ts";
import { link } from "../link/server.ts";
import { anyMerged } from "../orders/sources.ts";
import { workstreamGet } from "../orders/workstreams.ts";
import { events } from "../store/events.ts";
import { store } from "../store/hub_store.ts";
import { isoMs } from "../store/time.ts";
import { asksFrom, projectTitle } from "./bridge.ts";
import * as checker from "./checker.ts";
import { register as registerPurchases } from "./purchases.ts";
import { pasted, siteOf } from "./sites.ts";
import * as kept from "./store.ts";
import { ASKS_MAX } from "./asks.ts";

export { ASKS_MAX } from "./asks.ts";

/** The project's summary as the hub serves it: any project (D310). Another person's never gets here (the guard). */
function summaryOf(hub: Hub, r: ProjectRef): ProjectSummary {
  const p = store(hub).projectGet(r);
  if (!p) throw unknownProject(r);
  return p;
}

function changed(hub: Hub, project: ProjectSummary, summary: string): void {
  events(hub).append({
    at: isoMs(hub.clock.now()),
    type: "project.settings",
    machineId: project.machineId,
    projectId: project.projectId,
    summary,
    data: { title: project.title, archivedAt: project.archivedAt ?? null },
  });
}

/** Ends the lead's process, its turn first. Best effort: a lead on an offline machine stays stopped there. */
async function stopLead(hub: Hub, r: ProjectRef): Promise<void> {
  const lead = hub.db.conn
    .query<{ thread_id: string }, [string, string]>("SELECT thread_id FROM leads WHERE machine_id = ? AND project_id = ?")
    .get(r.machineId, r.projectId);
  if (!lead) return;
  const thread = { machineId: r.machineId, threadId: lead.thread_id };
  try {
    await interruptNow(hub, thread);
  } catch {}
  try {
    await stop(hub, thread, false);
  } catch (error) {
    console.info(`an archived project's lead was not stopped now: ${(error as Error).message}`);
  }
}

/** A person's own chat message to a project allows the site of each link in it (D208), in every project (D491). */
export function allowPasted(hub: Hub, r: ProjectRef, text: string, by: string): void {
  const sites = pasted(text);
  if (sites.length === 0) return;
  const at = hub.clock.now();
  for (const site of sites) kept.allowSite(hub.db.conn, r, site, by, at);
}

const refOf = (input: { machineId: string; projectId: string }): ProjectRef => ({ machineId: input.machineId, projectId: input.projectId });

export function register(tools: Registry): void {
  registerPurchases(tools);
  // The app's read of what a project asked other projects for (`project_message`), with each order opened for it.
  tools.add("project_asks", (hub, caller, input) => {
    const r = input.project;
    requireRole(caller, "read", r.machineId);
    if (!store(hub).projectGet(r)) throw unknownProject(r);
    // Any project's asks read (D310), an archived one's too.
    const all = asksFrom(hub.db.conn, r);
    const truncated = all.length > ASKS_MAX;
    const asks = all.slice(0, ASKS_MAX).map((a) => {
      // An ask may go to a project on another machine: the caller reads its title and orders only with read there.
      const shown = allows(caller, "read", a.to.machineId);
      const orders = shown
        ? a.orders.flatMap((id) => {
            const w = workstreamGet(hub.db.conn, id);
            if (!w || !allows(caller, "read", w.projectRef.machineId)) return [];
            const merged = anyMerged(hub, w.projectRef, w.workstreamId);
            return [
              {
                workstreamId: w.workstreamId,
                title: w.title,
                state: w.state,
                ...(w.headline ? { headline: w.headline } : {}),
                ...(merged ? { merged: true } : {}),
              },
            ];
          })
        : [];
      return { toTitle: shown ? projectTitle(hub, a.to) : a.to.projectId, handle: a.handle, to: a.to, text: a.text, at: isoMs(a.atMs), orders };
    });
    const next =
      asks.length === 0
        ? "This project has asked no other project for anything yet."
        : truncated
          ? `These are its newest ${ASKS_MAX} asks; older ones aren't listed.`
          : undefined;
    return { project: r, asks, ...(next !== undefined ? { next } : {}), ...(truncated ? { truncated: true } : {}) };
  });

  tools.add("project_archive", async (hub, caller, input) => {
    const r = refOf(input);
    requireRole(caller, "operate", r.machineId);
    const before = summaryOf(hub, r);
    const archive = input.archived !== false;
    if (archive === (before.archivedAt !== undefined)) return { project: before };
    kept.setArchived(hub.db.conn, r, archive ? hub.clock.now() : undefined);
    if (archive) await stopLead(hub, r);
    const project = summaryOf(hub, r);
    changed(hub, project, `${project.title} ${archive ? "archived" : "back"}`);
    return {
      project,
      next: archive
        ? "Its chat, memory and folder stay; project_archive with archived false brings it back."
        : "Its lead starts with the next chat message.",
    };
  });

  tools.add("project_sites", (hub, caller, input) => {
    const r = refOf(input);
    requireRole(caller, "read", r.machineId);
    summaryOf(hub, r);
    const sites = kept.sites(hub.db.conn, r);
    return {
      sites,
      ...(sites.length === 0
        ? { next: "None yet: its first fetch or visit to a site asks the person, and approving it adds the site." }
        : {}),
    };
  });

  tools.add("project_site_revoke", (hub, caller, input) => {
    const r = refOf(input);
    requireRole(caller, "operate", r.machineId);
    summaryOf(hub, r);
    const site = siteOf(input.site) ?? input.site;
    kept.revokeSite(hub.db.conn, r, site);
    return { sites: kept.sites(hub.db.conn, r), next: `Its next fetch or visit to ${site} asks again.` };
  });

  tools.add("project_approvals", (hub, caller, input) => {
    const r = refOf(input);
    requireRole(caller, "read", r.machineId);
    summaryOf(hub, r);
    const page = { ...(input.limit === undefined ? {} : { limit: input.limit }), ...(input.before === undefined ? {} : { before: input.before }) };
    return { approvals: checker.approvals(hub.db.conn, r), ...checker.log(hub.db.conn, r, page) };
  });

  // A person sets how a project's risky actions are approved: only a person, never an agent, not even its lead.
  tools.add("project_approvals_set", (hub, caller, input) => {
    const r = refOf(input);
    requireRole(caller, "operate", r.machineId);
    if (!isHuman(caller)) {
      throw new ToolError(
        "forbidden",
        "Only a person decides what their project does without asking.",
        "Change it in the desktop app: the project's settings, Approvals.",
      );
    }
    const project = summaryOf(hub, r);
    // An older app's model and effort are taken and ignored: the checker runs on the hub's (W467).
    checker.setApprovals(hub.db.conn, r, input.mode);
    const approvals = checker.approvals(hub.db.conn, r);
    changed(hub, project, `${project.title}'s approvals: ${approvals.mode}`);
    return { approvals };
  });

  tools.add("project_signins_forget", async (hub, caller, input) => {
    const r = refOf(input);
    requireRole(caller, "operate", r.machineId);
    const project = summaryOf(hub, r);
    if (!executors(hub).isConnected(r.machineId)) throw offline(r.machineId);
    if (!link(hub).can(r.machineId, CAP_SIGNINS_FORGET)) {
      throw new ToolError(
        "invalid",
        `${r.machineId}'s node is too old to forget a project's sign-ins`,
        `Run fleetd update on ${r.machineId}, then forget them again`,
      );
    }
    try {
      await signinsForget(hub, r.machineId, r.projectId);
    } catch (error) {
      throw fromExecutor(error);
    }
    changed(hub, project, `${project.title}'s sign-ins forgotten`);
    return { ok: true, next: "Its next browser session starts signed out of every site." };
  });
}

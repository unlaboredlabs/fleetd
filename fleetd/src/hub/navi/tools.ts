// navi_create, navi_list, navi_rename, the archive, sites, approvals and sign-ins tools, each under its project name
// (D310) and its old navi_* name for one release (tools.rs). The asks come with
// the bridge port.
import type { ProjectRef, ProjectSummary } from "../../shared/contracts.ts";
import { ToolError } from "../../shared/errors.ts";
import { CAP_ASSISTANT, CAP_NAVI_SIGNINS } from "../../shared/node_link.ts";
import { FOLDER_TAKEN } from "../../shared/sessions.ts";
import { jsPrefix } from "../../shared/text.ts";
import { isHuman, requireRole } from "../api/grants.ts";
import type { Hub } from "../api/hub.ts";
import { offline, unknownProject } from "../api/refusals.ts";
import type { Caller, Registry } from "../api/registry.ts";
import { allows } from "../auth/index.ts";
import { ExecutorError, executors, newUuid } from "../executor/index.ts";
import { interruptNow, naviSigninsForget, projectFolder, projectUpsert, stop } from "../executor/projects.ts";
import { fromExecutor } from "../executor/tools.ts";
import { link } from "../link/server.ts";
import { anyMerged } from "../orders/sources.ts";
import { workstreamGet } from "../orders/workstreams.ts";
import { slugOr } from "../projects/add.ts";
import { targetMachine } from "../projects/discover.ts";
import { fitAdded, folder as folderInspect } from "../projects/inspect.ts";
import { events } from "../store/events.ts";
import { store } from "../store/hub_store.ts";
import { isoMs } from "../store/time.ts";
import { asksFrom, projectTitle } from "./bridge.ts";
import * as checker from "./checker.ts";
import { others, who } from "./owner.ts";
import { register as registerPurchases } from "./purchases.ts";
import { pasted, siteOf } from "./sites.ts";
import * as navis from "./store.ts";

/** The project's summary as the hub serves it: any project (D310). Another person's never gets here (the guard). */
function naviOf(hub: Hub, r: ProjectRef): ProjectSummary {
  const p = store(hub).projectGet(r);
  if (!p) throw unknownProject(r);
  return p;
}

function changed(hub: Hub, navi: ProjectSummary, summary: string): void {
  events(hub).append({
    at: isoMs(hub.clock.now()),
    type: "project.settings",
    machineId: navi.machineId,
    projectId: navi.projectId,
    summary,
    data: { kind: navi.kind ?? null, title: navi.title, archivedAt: navi.archivedAt ?? null },
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
    console.info(`an archived Navi's lead was not stopped now: ${(error as Error).message}`);
  }
}

/** Ends the leads of `person`'s Only-me projects, archived as they were removed from the hub. */
export async function stopLeft(hub: Hub, person: string): Promise<void> {
  for (const [r, owner] of navis.left(hub.db.conn)) if (owner === person) await stopLead(hub, r);
}

/** A person's own chat message to a Navi allows the site of each link in it (D208). */
export function allowPasted(hub: Hub, r: ProjectRef, text: string, by: string): void {
  const sites = pasted(text);
  if (sites.length === 0 || !navis.of(hub.db.conn, r)) return;
  const at = hub.clock.now();
  for (const site of sites) navis.allowSite(hub.db.conn, r, site, by, at);
}

const refOf = (input: { machineId: string; projectId: string }): ProjectRef => ({ machineId: input.machineId, projectId: input.projectId });

/** The most asks navi_asks lists. */
export const NAVI_ASKS_MAX = 100;

/** Where Navis' folders go, under the node's home. */
export const FOLDER = "navi";
/** How many free names `navi_create` tries before it gives up. */
const FOLDER_TRIES = 50;

/** A folder name from a Navi's name: lowercase letters, digits and dashes, at most 40; "navi" when nothing is left. */
export const slug = (name: string) => slugOr(name, FOLDER);

/**
 * `navi/<slug>`, then `navi/<slug>-2` and on, skipping the folders of the machine's projects. The node also refuses a
 * folder that is already there (`FOLDER_TAKEN`), and the next one is tried.
 */
function freeFolders(hub: Hub, m: string, base: string): string[] {
  const taken = store(hub)
    .projectsList(m)
    .map((p) => p.workspaceRoot.replace(/\/+$/, ""));
  const used = (name: string) => taken.some((root) => root.endsWith(`/${FOLDER}/${name}`));
  const out: string[] = [];
  for (let n = 1; out.length < FOLDER_TRIES; n++) {
    const name = n === 1 ? base : `${base}-${n}`;
    if (!used(name)) out.push(`${FOLDER}/${name}`);
  }
  return out;
}

/**
 * `navi_create` (navi/mod.rs `create`): a new Only me project in a folder of its own under its node's home, its
 * owner the person whose key made it. Marked first, so the node's report of it already reads as a Navi.
 */
async function create(hub: Hub, caller: Caller, input: { name: string; machineId?: string }): Promise<{ navi: ProjectSummary; next: string }> {
  if (input.machineId !== undefined) requireRole(caller, "operate", input.machineId);
  const m = targetMachine(hub, input.machineId);
  requireRole(caller, "operate", m);
  if (!link(hub).can(m, CAP_ASSISTANT)) {
    throw new ToolError("invalid", `${m}'s node is too old to hold a project`, `Run fleetd update on ${m}, or pass another machineId`);
  }
  const name = input.name.trim();
  const folders = freeFolders(hub, m, slug(name));
  const r = { machineId: m, projectId: newUuid() };
  const atMs = hub.clock.now();
  navis.put(hub.db.conn, r, { keyId: caller.keyId, name: caller.name }, who(hub.db.conn, caller), atMs);
  let path: string | undefined;
  let failed: ToolError | undefined;
  for (const folder of folders) {
    try {
      path = await projectFolder(hub, m, r.projectId, name, folder);
      break;
    } catch (error) {
      if (error instanceof ExecutorError && error.kind === "node_failed" && (error.extra.nodeMessage ?? "").includes(FOLDER_TAKEN)) continue;
      failed = fromExecutor(error);
      break;
    }
  }
  if (path === undefined) {
    navis.remove(hub.db.conn, r);
    throw failed ?? new ToolError("failed", `every free folder name for ${name} on ${m} is taken`, "Give it another name");
  }
  checker.startNew(hub.db.conn, r);
  // In the cache now, so navi_list shows it before the node's report of it arrives.
  if (!store(hub).projectGet(r)) {
    store(hub).projectsUpsertMany(m, [
      {
        machineId: m,
        projectId: r.projectId,
        title: name,
        workspaceRoot: path,
        threads: { running: 0, waiting: 0, idle: 0, failed: 0 } as ProjectSummary["threads"],
        lastActivityAt: isoMs(atMs),
      },
    ]);
  }
  events(hub).append({
    at: isoMs(atMs),
    type: "project.added",
    machineId: m,
    projectId: r.projectId,
    summary: jsPrefix(`${name} made on ${m}`, 200),
    data: fitAdded({ title: name, path, created: true, inspect: folderInspect() }),
  });
  return { navi: naviOf(hub, r), next: "Write to it with chat_send; its lead starts with the first message." };
}

export function register(tools: Registry): void {
  tools.add("navi_create", (hub, caller, input) => create(hub, caller, input));
  registerPurchases(tools);
  // The app's read of what a project asked other projects for (`project_message`), with each order opened for it.
  for (const name of ["project_asks", "navi_asks"] as const) {
    tools.add(name, (hub, caller, input) => {
      const r = input.project ?? input.navi;
      if (!r) throw new ToolError("invalid", "Name the project.", "Pass project with its machineId and projectId.");
      requireRole(caller, "read", r.machineId);
      if (!store(hub).projectGet(r)) throw unknownProject(r);
      // Any project's asks read (D310), an archived one's too.
      const all = asksFrom(hub.db.conn, r);
      const truncated = all.length > NAVI_ASKS_MAX;
      const asks = all.slice(0, NAVI_ASKS_MAX).map((a) => {
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
            ? `These are its newest ${NAVI_ASKS_MAX} asks; older ones aren't listed.`
            : undefined;
      return { navi: r, asks, ...(next !== undefined ? { next } : {}), ...(truncated ? { truncated: true } : {}) };
    });
  }

  tools.add("navi_list", (hub, caller, input) => {
    const archived = input.archived === true;
    const hidden = others(hub.db, caller);
    const list: ProjectSummary[] = [];
    for (const r of navis.all(hub.db.conn)) {
      if ((input.machineId !== undefined && input.machineId !== r.machineId) || !allows(caller, "read", r.machineId) || hidden.has(r)) continue;
      const navi = store(hub).projectGet(r);
      if (navi && (archived || navi.archivedAt === undefined)) list.push(navi);
    }
    return { navis: list, ...(list.length === 0 ? { next: "No Only me projects yet: project_add with onlyMe makes one." } : {}) };
  });

  tools.add("navi_rename", async (hub, caller, input) => {
    const r = refOf(input);
    requireRole(caller, "operate", r.machineId);
    const navi = naviOf(hub, r);
    if (!executors(hub).isConnected(r.machineId)) throw offline(r.machineId);
    const name = input.name.trim();
    try {
      await projectUpsert(hub, r.machineId, r.projectId, name, navi.workspaceRoot);
    } catch (error) {
      throw fromExecutor(error);
    }
    store(hub).projectsUpsertMany(r.machineId, [{ ...navi, title: name }]);
    const renamed = naviOf(hub, r);
    changed(hub, renamed, `${r.projectId} renamed ${name}`);
    return { navi: renamed };
  });

  for (const name of ["project_archive", "navi_archive"] as const) {
    tools.add(name, async (hub, caller, input) => {
      const r = refOf(input);
      requireRole(caller, "operate", r.machineId);
      // Any project archives (D310), a Navi as before.
      const before = naviOf(hub, r);
      const archive = input.archived !== false;
      if (archive === (before.archivedAt !== undefined)) return { navi: before };
      navis.setArchived(hub.db.conn, r, archive ? hub.clock.now() : undefined);
      if (archive) await stopLead(hub, r);
      const navi = naviOf(hub, r);
      changed(hub, navi, `${navi.title} ${archive ? "archived" : "back"}`);
      return {
        navi,
        next: archive
          ? "Its chat, memory and folder stay; navi_archive with archived false brings it back."
          : "Its lead starts with the next chat message.",
      };
    });
  }

  for (const name of ["project_sites", "navi_sites"] as const) {
    tools.add(name, (hub, caller, input) => {
      const r = refOf(input);
      requireRole(caller, "read", r.machineId);
      naviOf(hub, r);
      const sites = navis.sites(hub.db.conn, r);
      return {
        sites,
        ...(sites.length === 0
          ? { next: "None yet: its first fetch or visit to a site asks the person, and approving it adds the site." }
          : {}),
      };
    });
  }

  for (const name of ["project_site_revoke", "navi_site_revoke"] as const) {
    tools.add(name, (hub, caller, input) => {
      const r = refOf(input);
      requireRole(caller, "operate", r.machineId);
      naviOf(hub, r);
      const site = siteOf(input.site) ?? input.site;
      navis.revokeSite(hub.db.conn, r, site);
      return { sites: navis.sites(hub.db.conn, r), next: `Its next fetch or visit to ${site} asks again.` };
    });
  }

  for (const name of ["project_approvals", "navi_approvals"] as const) {
    tools.add(name, (hub, caller, input) => {
      const r = refOf(input);
      requireRole(caller, "read", r.machineId);
      naviOf(hub, r);
      return { approvals: checker.approvals(hub.db.conn, r), log: checker.log(hub.db.conn, r) };
    });
  }

  // A person sets how their Navi's risky actions are approved: only a person, never an agent, not even the Navi.
  for (const name of ["project_approvals_set", "navi_approvals_set"] as const) {
    tools.add(name, (hub, caller, input) => {
      const r = refOf(input);
      requireRole(caller, "operate", r.machineId);
      if (!isHuman(caller)) {
        throw new ToolError(
          "forbidden",
          "Only a person decides what their project does without asking.",
          "Change it in the desktop app: the project's settings, Approvals.",
        );
      }
      const navi = naviOf(hub, r);
      // An older app's model and effort are taken and ignored: the checker runs on the hub's (W467).
      checker.setApprovals(hub.db.conn, r, input.mode);
      const approvals = checker.approvals(hub.db.conn, r);
      changed(hub, navi, `${navi.title}'s approvals: ${approvals.mode}`);
      return { approvals };
    });
  }

  for (const name of ["project_signins_forget", "navi_signins_forget"] as const) {
    tools.add(name, async (hub, caller, input) => {
      const r = refOf(input);
      requireRole(caller, "operate", r.machineId);
      // Any project keeps its sign-ins (D310), a Navi as before.
      const navi = naviOf(hub, r);
      if (!executors(hub).isConnected(r.machineId)) throw offline(r.machineId);
      if (!link(hub).can(r.machineId, CAP_NAVI_SIGNINS)) {
        throw new ToolError(
          "invalid",
          `${r.machineId}'s node is too old to keep a project's sign-ins`,
          `Run fleetd update on ${r.machineId}: until then its browser starts signed out every session`,
        );
      }
      try {
        await naviSigninsForget(hub, r.machineId, r.projectId);
      } catch (error) {
        throw fromExecutor(error);
      }
      changed(hub, navi, `${navi.title}'s sign-ins forgotten`);
      return { ok: true, next: "Its next browser session starts signed out of every site." };
    });
  }
}

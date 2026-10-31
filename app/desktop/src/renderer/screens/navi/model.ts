// Navi in the app, as plain view data: which projects are Navis (a project the hub marks `kind: "assistant"`), the
// sidebar's order (the Navis pinned above the projects, an archived one in neither), a name the hub would take, and
// the work a Navi asked other projects for (navi_asks). Pure, so it is unit-tested.
import type { MachineRolesEntry, NaviAsk, NaviAskOrder, ProjectSummary } from "../../../shared/contracts";

/** A Navi: a plain-folder project with an assistant for its lead. */
export const isNavi = (p: Pick<ProjectSummary, "kind">): boolean => p.kind === "assistant";

/**
 * Yours (D215): a Navi belongs to the person who made it, and only they see and use it. The hub already lists no one
 * else's; this keeps another's out of your lists all the same. One with no owner (a hub without people, or an older
 * hub) is yours, as before; one with an owner shows once the hub has said who you are.
 */
export const isYours = (p: Pick<ProjectSummary, "owner">, me: string | undefined): boolean => p.owner === undefined || p.owner === me;

/** Your Navis still in use, as Settings lists them: the hubs each reaches. */
export const yourNavis = (projects: ReadonlyArray<ProjectSummary>, me: string | undefined): ProjectSummary[] =>
  projects.filter((p) => isNavi(p) && !isArchived(p) && isYours(p, me));

/** An archived Navi keeps its chat, memory and folder; its lead doesn't start until it is brought back. */
export const isArchived = (p: Pick<ProjectSummary, "archivedAt">): boolean => p.archivedAt !== undefined;

/** The sidebar's rows split: the Navis still in use, then every project of code; archived Navis are in neither. */
export const splitNavis = <R extends { readonly project: ProjectSummary }>(rows: ReadonlyArray<R>): { readonly navis: R[]; readonly projects: R[] } => ({
  navis: rows.filter((r) => isNavi(r.project) && !isArchived(r.project)),
  projects: rows.filter((r) => !isNavi(r.project)),
});

/** The sidebar's order, which the jump numbers and Next project follow: the Navis first, then the projects. */
export const sidebarOrder = <R extends { readonly project: ProjectSummary }>(rows: ReadonlyArray<R>): R[] => {
  const { navis, projects } = splitNavis(rows);
  return [...navis, ...projects];
};

/** As navi_create takes it: 1 to 80 characters on one line. */
export const NAME_MAX = 80;

/** Why the hub wouldn't take `name`, in a few words; undefined when it would. An empty box says nothing yet. */
export const nameProblem = (name: string): string | undefined => {
  const t = name.trim();
  if (t.length > NAME_MAX) return `Keep it under ${String(NAME_MAX)} characters`;
  if (/[\r\n]/u.test(name)) return "One line";
  return undefined;
};

/**
 * The machines a new Navi could live on, as machine_roles lists them: linked now, and where the person may work. One
 * whose sandbox is missing stays in the list, to say why and how to fix it, but can't be picked.
 */
export const naviHomes = (machines: ReadonlyArray<MachineRolesEntry>): MachineRolesEntry[] => machines.filter((m) => m.online && m.operates !== false);

/** A Navi can run there: its sandbox starts, gap or not. A node that doesn't say is left to the hub. */
export const canHost = (m: Pick<MachineRolesEntry, "naviSandbox">): boolean => m.naviSandbox?.status !== "missing";

/** Where the choice starts: where the hub would put the Navi unasked (`best`), else the first machine that can host one. */
export const firstHome = (homes: ReadonlyArray<MachineRolesEntry>, best: string | undefined): string | undefined =>
  (homes.find((m) => m.machineId === best && canHost(m)) ?? homes.find(canHost))?.machineId;

/** One message the Navi sent another project's lead (project_message), and the orders that lead opened for it. */
export type Ask = NaviAsk;

export type AskedOrder = NaviAskOrder;

/** An order's state in a word: open is under way. */
export const orderWords = (o: AskedOrder): string => (o.state === "open" ? "In progress" : o.state === "done" ? "Done" : "Stopped");

/** An ask with no order yet: its lead hasn't taken it up, or answered without one. */
export const NOT_TAKEN = "No order opened for it yet";

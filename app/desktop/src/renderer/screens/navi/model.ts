// Navi in the app, as plain view data: which projects are Navis (a project the hub marks `kind: "assistant"`), the
// sidebar's order (the Navis pinned above the projects, an archived one in neither), a name the hub would take, and
// the work a Navi asked other projects for (navi_asks, docs/design/navi.md). Pure, so it is unit-tested.
import type { NaviAsk, NaviAskOrder, ProjectSummary } from "../../../shared/contracts";

/** A Navi: a plain-folder project with an assistant for its lead. */
export const isNavi = (p: Pick<ProjectSummary, "kind">): boolean => p.kind === "assistant";

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

/** One message the Navi sent another project's lead (project_message), and the orders that lead opened for it. */
export type Ask = NaviAsk;

export type AskedOrder = NaviAskOrder;

/** An order's state in a word: open is under way. */
export const orderWords = (o: AskedOrder): string => (o.state === "open" ? "In progress" : o.state === "done" ? "Done" : "Stopped");

/** An ask with no order yet: its lead hasn't taken it up, or answered without one. */
export const NOT_TAKEN = "No order opened for it yet";

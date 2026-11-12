// Projects as plain view data, shared with the phone: whether it is archived, the sidebar's default rows, a name the
// hub would take, a delete's words, and the hub tools the project calls go by. Pure, so it is unit-tested.
import type { ProjectSummary } from "../../../shared/contracts";

/**
 * The hub's names for a project's own calls, in one place: the hub takes `navi_*` as aliases of `project_*` for one
 * release, and this app calls them until every hub it meets has the new names.
 */
export const PROJECT_TOOLS = {
  archive: "navi_archive",
  approvals: "navi_approvals",
  approvalsSet: "navi_approvals_set",
  purchases: "navi_purchases",
  cardSet: "navi_card_set",
  signinsForget: "navi_signins_forget",
  asks: "navi_asks",
} as const;

/** An archived project keeps its chat, memory and folder; its lead doesn't start until it is brought back. */
export const isArchived = (p: Pick<ProjectSummary, "archivedAt">): boolean => p.archivedAt !== undefined;

/**
 * The sidebar's rows: archived ones left out, the rest in the order they came. The sidebar's order (shell/pins.ts:
 * your pins, then by activity) goes over this.
 */
export const sidebarOrder = <R extends { readonly project: ProjectSummary }>(rows: ReadonlyArray<R>): R[] => rows.filter((r) => !isArchived(r.project));

/** As the hub takes a project's name: 1 to 80 characters on one line. */
export const NAME_MAX = 80;

/** Why the hub wouldn't take `name`, in a few words; undefined when it would. An empty box says nothing yet. */
export const nameProblem = (name: string): string | undefined => {
  const t = name.trim();
  if (t.length > NAME_MAX) return `Keep it under ${String(NAME_MAX)} characters`;
  if (/[\r\n]/u.test(name)) return "One line";
  return undefined;
};

/**
 * A project's delete (D287), the same for every project and word for word on the desktop's dialog and the phone's
 * sheet: what is erased, and the tickbox, off by default, that deletes its folder too.
 */
export const deleteWords = (title: string, machine: string, folder: string) => ({
  message: `${title} stops now, and everything fleetd keeps for it is erased from fleetd and ${machine}: its chat, memory, skills, approvals, purchases, automations and sign-ins. The files in its folder stay unless you tick below. This can't be undone.`,
  folder: `Also delete its folder, ${folder}`,
  folderNote: "With every file in it, a checkout and its uncommitted work included. Unticked, the folder stays as it is.",
});

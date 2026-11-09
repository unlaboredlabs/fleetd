// Projects as plain view data, shared with the phone: whose a project is (Only me), whether it is archived, the
// sidebar's default order (Only-me projects first, so former Navis stay where they were), a name the hub would take,
// a delete's words, and the hub tools the project calls go by. Pure, so it is unit-tested.
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

/** Only its owner sees and uses it: on for a former Navi and, unless turned off, a new project with no repo. */
export const isOnlyMe = (p: Pick<ProjectSummary, "onlyMe"> | undefined): boolean => p?.onlyMe === true;

/**
 * Yours: an Only-me project is its owner's alone. The hub already lists no one else's; this keeps another's out of
 * your lists all the same. One with no owner (a hub without people, or an older hub) is yours, as before; one with an
 * owner shows once the hub has said who you are.
 */
export const isYours = (p: Pick<ProjectSummary, "owner">, me: string | undefined): boolean => p.owner === undefined || p.owner === me;

/** It holds a git repo: its chat starts on code. Without one it is a chat with a lead in a folder (a former Navi's too). */
export const hasRepos = (p: Pick<ProjectSummary, "repos"> | undefined): boolean => (p?.repos?.length ?? 0) > 0;

/** An archived project keeps its chat, memory and folder; its lead doesn't start until it is brought back. */
export const isArchived = (p: Pick<ProjectSummary, "archivedAt">): boolean => p.archivedAt !== undefined;

/**
 * The sidebar's rows: archived ones left out, Only-me projects first, each part in the order it came. The sidebar's
 * order (shell/pins.ts: your pins, then by activity) goes over this.
 */
export const sidebarOrder = <R extends { readonly project: ProjectSummary }>(rows: ReadonlyArray<R>): R[] => {
  const shown = rows.filter((r) => !isArchived(r.project));
  return [...shown.filter((r) => isOnlyMe(r.project)), ...shown.filter((r) => !isOnlyMe(r.project))];
};

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

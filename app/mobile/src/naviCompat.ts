// The phone's Navi helpers as they were before projects/model.ts, word for word, until its screens move to the new ones
// (T1918, W457), which deletes this file. New code uses ../../desktop/src/renderer/screens/projects/model.ts.
import type { MachineRolesEntry, ProjectSummary } from "../../desktop/src/shared/contracts";

/**
 * A Navi's delete (D287 navi.delete-erases), word for word on the desktop's dialog and the phone's sheet: what is
 * erased, and the tickbox that deletes its folder too.
 */
export const naviDeleteWords = (title: string, machine: string, folder: string) => ({
  message: `${title} stops now, and everything it had is erased from fleetd and ${machine}: its chat, memory, skills, approvals and purchases, attachments, screen recordings and transcripts. This can't be undone.`,
  folder: `Also delete its folder, ${folder}`,
  folderNote: "With everything in it: its drafts, downloads and notes. Unticked, the folder stays as it is.",
});

/** A Navi: a plain-folder project with an assistant for its lead. */
export const isNavi = (p: Pick<ProjectSummary, "kind">): boolean => p.kind === "assistant";

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

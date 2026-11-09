// What the orders board, order_get and agents read of other areas: leads (`leads(hub)`, `leadProfile`), the merge
// train's changes (`trainChanges`, `trainOf`) and open requests (`openRequests`), from the modules that keep them.
import type { Change, HumanRequest, Lead, ProjectRef } from "../../shared/contracts.ts";
import type { Hub } from "../api/hub.ts";
import { openRequests as approvalsOpen } from "../approvals/index.ts";
import { leadProfile as leadsProfile, leads } from "../leads/index.ts";
import { changeRecords, type ListFilter, trainChanges as changes, trainOf } from "../train/index.ts";

export { leadState } from "../leads/index.ts";

/** The project's lead, with its state. */
export const leadGet = (hub: Hub, r: ProjectRef): Lead | undefined => leads(hub).get(r);

/** Every project's lead. */
export const leadsList = (hub: Hub): Lead[] => leads(hub).list();

/** The profile the project's lead session started on; undefined for one started before fleetd kept it. */
export const leadProfile = (hub: Hub, r: ProjectRef): string | undefined => leadsProfile(hub, r);

/** The train's changes, newest first. */
export const trainChanges = (hub: Hub, filter: ListFilter): Change[] => changes(hub, filter);

/** Whether the repo has a train. */
export const hasTrain = (hub: Hub, repo: string): boolean => trainOf(hub, repo) !== undefined;

/** Whether a PR of the order merged (train/records.rs `any_merged`). */
export const anyMerged = (hub: Hub, r: ProjectRef, workstreamId: string): boolean => changeRecords(hub).anyMerged(r, workstreamId);

/** Every open secret or approval request, newest first; of one project when `project` is given. */
export const openRequests = (hub: Hub, limit: number, project?: ProjectRef): HumanRequest[] => approvalsOpen(hub, limit, project);

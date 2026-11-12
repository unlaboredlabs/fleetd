// Names approvals' tool prompts and requests share with the areas that answer them (permissions.ts, project_lead/hooks.ts).
import type { HumanRequest, ProjectRef } from "../../shared/contracts.ts";

/** The project tool whose approval lets an automation run on its own (automations/calls.rs `CONFIRM_TOOL`). */
export const AUTOMATION_CONFIRM_TOOL = "mcp__fleetd__automation_confirm";
/** A lead's proposal for a new project (projects/propose.ts): asked in every approval mode, made only by a person's approval. */
export const PROJECT_PROPOSE_TOOL = "mcp__fleetd__project_propose";

export const projectOf = (r: HumanRequest): ProjectRef => ({
  machineId: r.projectRef.machineId,
  projectId: r.projectRef.projectId,
});

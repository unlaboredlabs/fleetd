import type { ProjectRef } from "../../shared/contracts.ts";
import type { Hub } from "../api/hub.ts";
import { approvals } from "../approvals/index.ts";
import { checkerSeams } from "../navi/checker_turn.ts";
import { registerLeadCalls } from "./calls.ts";
import { automations } from "./index.ts";

/**
 * Starts automations (Rust: automations.start): the lead calls, the scheduler and the followers of removed projects,
 * closed orders and leads' turns, until `hub.shutdown`. Fills approvals' automation hooks (D348): the card
 * `automation_confirm` brings shows the automation as the hub has it, and its approval marks it confirmed. Gives the
 * Navi checker the project's automations with a run open now, whose confirmed prompts are the person's standing word.
 */
export function start(hub: Hub): void {
  registerLeadCalls(hub);
  Object.assign(approvals(hub).deps.hooks, {
    naviAutomation: async (project: ProjectRef, id: string) => {
      try {
        return automations(hub).own(project, id);
      } catch {
        return undefined;
      }
    },
    naviAutomationConfirm: async (project: ProjectRef, shown: unknown, by: string) => {
      const id = shown !== null && typeof shown === "object" ? (shown as { automationId?: unknown }).automationId : undefined;
      if (typeof id !== "string") return false;
      try {
        automations(hub).own(project, id);
      } catch {
        return false;
      }
      try {
        return automations(hub).confirm(id, shown, by);
      } catch (error) {
        console.warn("approvals: an automation the person let run was not marked:", (error as Error).message);
        return false;
      }
    },
  });
  checkerSeams(hub).running = (r) => automations(hub).running(r);
  automations(hub).start();
}

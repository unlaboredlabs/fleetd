// The project's rules on its lead's prompts, without the hub (hooks.ts): its final confirm on a site, letting an
// automation run on its own, its message to another project's lead, a visit whose link carries data, and the approval
// settings of a project unread.
import type { Automation, ProjectApprovals, ToolPreview } from "../../shared/contracts.ts";
import { AUTOMATION_CONFIRM_TOOL } from "../approvals/names.ts";
import type { PromptVerdict } from "../approvals/ports.ts";
import { clipUtf16, sortedValue } from "../integrations/policy.ts";
import { CHECKER_EFFORT, CHECKER_MODEL } from "./checker_modes.ts";
import * as confirm from "./confirm_rules.ts";
import { carriesData, visitUrl } from "./review.ts";

/** The tool a project's message to another project's lead goes through (bridge.ts `TOOL`). */
export const BRIDGE_TOOL = "mcp__fleetd__project_message";

const pretty = (v: unknown) => JSON.stringify(sortedValue(v), null, 2);

/** The card for a `project_message` prompt: whose lead it reaches, and the call whole (bridge.rs `preview`). */
export function bridgePreview(input: unknown): ToolPreview | undefined {
  const o = input !== null && typeof input === "object" && !Array.isArray(input) ? (input as Record<string, unknown>) : undefined;
  if (!o || typeof o.project !== "string" || typeof o.text !== "string" || (o.hub != null && typeof o.hub !== "string")) return undefined;
  const title = typeof o.hub === "string" ? `Message the lead of ${o.project} on ${o.hub}` : `Message the lead of ${o.project}`;
  return { server: "fleetd", tool: "project_message", action: "send", title: clipUtf16(title, 200), input: pretty(input) };
}

/** The card for `automation_confirm`: the automation as the hub has it, never the project's words (automations calls.rs). */
export function automationPreview(a: Automation): ToolPreview {
  const shown = {
    automationId: a.automationId,
    name: a.name,
    prompt: a.prompt,
    schedule: a.schedule,
    what: "Its runs count as your go-ahead for what this prompt names, without asking you each time.",
  };
  return { server: "fleetd", tool: "automation_confirm", action: "write", title: clipUtf16(`Let “${a.name}” run on its own`, 200), input: pretty(shown) };
}

/**
 * The project's rules on a prompt the integrations policy had no word on: its final confirm on a site (a payment is
 * refused, anything else is a risky action like a send), letting an automation run on its own, and its message to
 * another project's lead. Undefined: no rule, so the approval mode decides.
 */
export function promptVerdict(tool: string, input: unknown, automation: Automation | undefined): PromptVerdict | undefined {
  if (tool === confirm.TOOL) {
    const why = confirm.refused(input);
    if (why !== undefined) return { deny: why };
    const card = confirm.preview(input);
    return card ? { ask: card } : undefined;
  }
  if (tool === AUTOMATION_CONFIRM_TOOL) {
    return automation ? { ask: automationPreview(automation) } : { deny: "Blocked by fleetd: this project has no such automation. automation_list names them." };
  }
  if (tool === BRIDGE_TOOL) {
    const card = bridgePreview(input);
    return card ? { ask: card } : { deny: "Blocked by fleetd: this project_message can't be read. Give project and text." };
  }
  return undefined;
}

/** Unread, a lead asks the person about every risky action. */
export const askEverything = (): ProjectApprovals => ({ mode: "ask", defaults: true, model: CHECKER_MODEL, effort: CHECKER_EFFORT }) as ProjectApprovals;

/** A fetch or browser visit whose link carries data (review.rs `visit_url` + `carries_data`). */
export function visitCarriesData(input: unknown): boolean {
  const url = visitUrl(input);
  return url !== undefined && carriesData(url, []);
}

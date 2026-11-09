// The Navi's word on its lead's prompts, as approvals reaches it (D348; crates/fleetd/src/hub/usage/wire_approvals.rs
// `navi_*`, and the navi rules approvals/permissions.rs calls): `naviHooks(hub)` is `hub.area("navi_hooks")`, which
// approvals' `naviFilled` looks up at each call. A hook left out here keeps approvals' default: the automation and
// image hooks are their own areas' to fill.
import type { Automation, NaviApprovals, ProjectRef, ToolPreview } from "../../shared/contracts.ts";
import type { Hub } from "../api/hub.ts";
import { AUTOMATION_CONFIRM_TOOL } from "../approvals/index.ts";
import type { ApprovalHooks, Checked, PromptVerdict } from "../approvals/ports.ts";
import { getOn } from "../people/store.ts";
import { clipUtf16, sortedValue } from "../integrations/policy.ts";
import { isoMs } from "../store/time.ts";
import * as checker from "./checker.ts";
import { alwaysAsks, autoApproved, checkerSeams, judge, personMessages, reads, relayed, standing, type Context } from "./checker_turn.ts";
import * as confirm from "./confirm.ts";
import { clip, carriesData, floor, visitUrl } from "./review.ts";
import { refused as shellRefused } from "./shell_guard.ts";
import { visit } from "./site_visit.ts";
import * as navis from "./store.ts";

export type NaviHooks = Pick<
  ApprovalHooks,
  | "naviLead"
  | "naviSite"
  | "naviSiteAllow"
  | "naviApprovals"
  | "naviCheck"
  | "naviAutoApproved"
  | "promptVerdict"
  | "siteVisit"
  | "floor"
  | "visitCarriesData"
  | "shellRefused"
  | "alwaysAsks"
>;

/** The tool a Navi's message to another project's lead goes through (navi/bridge.rs `TOOL`). */
const BRIDGE_TOOL = "mcp__fleetd__project_message";

const pretty = (v: unknown) => JSON.stringify(sortedValue(v), null, 2);

/** The card for a `project_message` prompt: whose lead it reaches, and the call whole (navi/bridge.rs `preview`). */
export function bridgePreview(input: unknown): ToolPreview | undefined {
  const o = input !== null && typeof input === "object" && !Array.isArray(input) ? (input as Record<string, unknown>) : undefined;
  if (!o || typeof o.project !== "string" || typeof o.text !== "string" || (o.hub != null && typeof o.hub !== "string")) return undefined;
  const title = typeof o.hub === "string" ? `Message the lead of ${o.project} on ${o.hub}` : `Message the lead of ${o.project}`;
  return { server: "fleetd", tool: "project_message", action: "send", title: clipUtf16(title, 200), input: pretty(input) };
}

/** The card for `automation_confirm`: the automation as the hub has it, never the Navi's words (automations calls.rs). */
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
 * The Navi's rules on a prompt the integrations policy had no word on: its final confirm on a site (a payment is
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
const askEverything = (): NaviApprovals => ({ mode: "ask", defaults: true, model: checker.CHECKER_MODEL, effort: checker.CHECKER_EFFORT }) as NaviApprovals;

function hooks(hub: Hub): NaviHooks {
  const c = () => hub.db.conn;
  return {
    naviLead: async (project, threadId) => {
      const lead = c()
        .query<{ thread_id: string }, [string, string]>("SELECT thread_id FROM leads WHERE machine_id = ? AND project_id = ?")
        .get(project.machineId, project.projectId);
      return lead?.thread_id === threadId;
    },
    naviSite: async (project, site) => {
      if (site === undefined) return false;
      try {
        return navis.siteAllowed(c(), project, site);
      } catch {
        return false;
      }
    },
    naviSiteAllow: async (project, site, by) => {
      try {
        navis.allowSite(c(), project, site, by, hub.clock.now());
      } catch (error) {
        console.warn(`approvals: a Navi's allowed site was not saved: ${(error as Error).message}`);
      }
    },
    naviApprovals: async (project) => {
      try {
        return checker.approvals(c(), project);
      } catch (error) {
        console.warn(`approvals: a Navi's approval settings were not read: ${(error as Error).message}`);
        return askEverything();
      }
    },
    naviCheck: (project, threadId, action, settings) => check(hub, project, threadId, action, settings),
    naviAutoApproved: async (project, action, by, reason) => {
      try {
        autoApproved(hub, project, action, by, reason);
      } catch (error) {
        console.warn(`approvals: an auto-approved action was not logged: ${(error as Error).message}`);
      }
    },
    promptVerdict: (_project, tool, input, _servers, automation) => promptVerdict(tool, input, automation),
    siteVisit: (tool, input) => visit(tool, input),
    floor: (shown) => floor(shown),
    visitCarriesData: (input) => {
      const url = visitUrl(input);
      return url !== undefined && carriesData(url, []);
    },
    shellRefused: (command) => shellRefused(command),
    alwaysAsks,
  };
}

/** The checker's verdict on one of the lead's actions, with the context the hub has of the Navi (wire_approvals.rs `navi_check`). */
async function check(hub: Hub, r: ProjectRef, threadId: string, action: Parameters<typeof judge>[5], settings: NaviApprovals): Promise<Checked> {
  try {
    const c = hub.db.conn;
    const owner = navis.kept(c, r)?.owner;
    let said: string[] = [];
    let question: string | undefined;
    try {
      [said, question] = personMessages(hub, r);
    } catch {}
    const name = owner !== undefined ? getOn(c, owner)?.name : undefined;
    let allowedSites: string[] = [];
    try {
      allowedSites = navis.sites(c, r).map((s) => s.site);
    } catch {}
    let fromRelays: Awaited<ReturnType<typeof reads>> = [];
    try {
      fromRelays = relayed(hub, r);
    } catch {}
    const context: Context = {
      person: { name: name ?? null },
      personMessages: said,
      ...(question !== undefined ? { leadLastQuestion: question } : {}),
      standing: standing(hub, r),
      reads: [...(await reads(hub, { machineId: r.machineId, threadId })), ...fromRelays],
      allowedSites,
      today: isoMs(hub.clock.now()).slice(0, 10),
    };
    return await judge(hub, checkerSeams(hub).turn, r, owner, settings, action, context);
  } catch (error) {
    return { note: { verdict: "ask", reason: clip(`the checker couldn't run: ${(error as Error).message}`, 300) } };
  }
}

/** The Navi's hooks, `hub.area("navi_hooks")`: started with the navi area, looked up by approvals at each call. */
export const naviHooks = (hub: Hub): NaviHooks => hub.area("navi_hooks", hooks);

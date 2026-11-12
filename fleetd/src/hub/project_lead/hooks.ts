// The project's word on its lead's prompts, as approvals reaches it (D348; crates/fleetd/src/hub/usage/wire_approvals.rs,
// and the project rules approvals/permissions.rs calls): `projectHooks(hub)` is `hub.area("project_hooks")`, which
// approvals' `hooksFilled` looks up at each call. A hook left out here keeps approvals' default: the automation and
// image hooks are their own areas' to fill.
import type { ProjectApprovals, ProjectRef } from "../../shared/contracts.ts";
import type { Hub } from "../api/hub.ts";
import type { ApprovalHooks, Checked } from "../approvals/ports.ts";
import { isoMs } from "../store/time.ts";
import * as checker from "./checker.ts";
import { alwaysAsks, autoApproved, checkerSeams, judge, personMessages, reads, relayed, standing, type Context } from "./checker_turn.ts";
import { askEverything, promptVerdict, visitCarriesData } from "./prompt_rules.ts";
import { clip, floor } from "./review.ts";
import { refused as shellRefused } from "./shell_guard.ts";
import { visit } from "./site_visit.ts";
import * as kept from "./store.ts";

export { automationPreview, bridgePreview, promptVerdict, visitCarriesData } from "./prompt_rules.ts";

export type ProjectHooks = Pick<
  ApprovalHooks,
  | "isLead"
  | "siteAllowed"
  | "allowSite"
  | "approvalSettings"
  | "checkAction"
  | "autoApproved"
  | "promptVerdict"
  | "siteVisit"
  | "floor"
  | "visitCarriesData"
  | "shellRefused"
  | "alwaysAsks"
>;

function hooks(hub: Hub): ProjectHooks {
  const c = () => hub.db.conn;
  return {
    isLead: async (project, threadId) => {
      const lead = c()
        .query<{ thread_id: string }, [string, string]>("SELECT thread_id FROM leads WHERE machine_id = ? AND project_id = ?")
        .get(project.machineId, project.projectId);
      return lead?.thread_id === threadId;
    },
    siteAllowed: async (project, site) => {
      if (site === undefined) return false;
      try {
        return kept.siteAllowed(c(), project, site);
      } catch {
        return false;
      }
    },
    allowSite: async (project, site, by) => {
      try {
        kept.allowSite(c(), project, site, by, hub.clock.now());
      } catch (error) {
        console.warn(`approvals: a project's allowed site was not saved: ${(error as Error).message}`);
      }
    },
    approvalSettings: async (project) => {
      try {
        return checker.approvals(c(), project);
      } catch (error) {
        console.warn(`approvals: a project's approval settings were not read: ${(error as Error).message}`);
        return askEverything();
      }
    },
    checkAction: (project, threadId, action, settings) => check(hub, project, threadId, action, settings),
    autoApproved: async (project, action, by, reason) => {
      try {
        autoApproved(hub, project, action, by, reason);
      } catch (error) {
        console.warn(`approvals: an auto-approved action was not logged: ${(error as Error).message}`);
      }
    },
    promptVerdict: (_project, tool, input, _servers, automation) => promptVerdict(tool, input, automation),
    siteVisit: (tool, input) => visit(tool, input),
    floor: (shown) => floor(shown),
    visitCarriesData: (input) => visitCarriesData(input),
    shellRefused: (command) => shellRefused(command),
    alwaysAsks,
  };
}

/** The checker's verdict on one of the lead's actions, with the context the hub has of the project (wire_approvals.rs). */
async function check(hub: Hub, r: ProjectRef, threadId: string, action: Parameters<typeof judge>[5], settings: ProjectApprovals): Promise<Checked> {
  try {
    const c = hub.db.conn;
    let said: string[] = [];
    let question: string | undefined;
    try {
      [said, question] = personMessages(hub, r);
    } catch {}
    let allowedSites: string[] = [];
    try {
      allowedSites = kept.sites(c, r).map((s) => s.site);
    } catch {}
    let fromRelays: Awaited<ReturnType<typeof reads>> = [];
    try {
      fromRelays = relayed(hub, r);
    } catch {}
    const context: Context = {
      // A project is everyone's on the hub (D491): no one person's name.
      person: { name: null },
      personMessages: said,
      ...(question !== undefined ? { leadLastQuestion: question } : {}),
      standing: standing(hub, r),
      reads: [...(await reads(hub, { machineId: r.machineId, threadId })), ...fromRelays],
      allowedSites,
      today: isoMs(hub.clock.now()).slice(0, 10),
    };
    return await judge(hub, checkerSeams(hub).turn, r, undefined, settings, action, context);
  } catch (error) {
    return { note: { verdict: "ask", reason: clip(`the checker couldn't run: ${(error as Error).message}`, 300) } };
  }
}

/** The project's hooks, `hub.area("project_hooks")`: started with the project-lead area, looked up by approvals at each call. */
export const projectHooks = (hub: Hub): ProjectHooks => hub.area("project_hooks", hooks);

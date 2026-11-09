// The lead's automation calls: create, list, update (pause and resume too), delete, run now, the runs and confirm,
// scoped to the caller's project by its session. The lead never sees a
// webhook secret: a person adds a webhook in the app, which shows its URL once. A task can make none of these.
//
// No lead call marks an automation `confirmed` (the person's go-ahead on its runs): only the person does, in the app or
// on the card `automation_confirm` brings them, which approvals files and settles. A lead's change to what it runs or
// when unsets the mark.
import type { ProjectRef } from "../../shared/contracts.ts";
import { ToolError } from "../../shared/errors.ts";
import type { Hub } from "../api/hub.ts";
import { hubZone, POLICY_TZ_KEY, zone } from "../attention/index.ts";
import { decisions } from "../ledger/decisions.ts";
import { type LeadCall, type LeadCaller, leadCalls } from "../leads/seams.ts";
import { ownerOn } from "../people/store.ts";
import { automations, type Edit, fromCall, WEBHOOK_BODY_MAX } from "./index.ts";

/** A schedule in the lead's calls: a tz left out is the person's (`AutomationScheduleCall`). */
type AutomationScheduleCall = { cron?: string; at?: string; tz?: string };

export const OPS = [
  "automation_create",
  "automation_list",
  "automation_update",
  "automation_pause",
  "automation_delete",
  "automation_run",
  "automation_runs",
  "automation_confirm",
] as const;

/** How many runs `automation_runs` lists without a runId. */
const RUNS_LISTED = 20;

const pauseNext = (paused: boolean) =>
  paused ? "Paused: its schedule and webhook start nothing until you resume it." : "Resumed: its schedule goes on from now.";

/**
 * The zone of the person who last wrote in `r`'s chat (none yet: the hub's owner), for what its lead schedules
 * (people/zone.rs `of_chat`): their device's, else `policy.tz`, else the hub machine's.
 */
export function zoneOfChat(hub: Hub, r: ProjectRef): string {
  const c = hub.db.conn;
  let person: string | undefined;
  try {
    const row = c
      .query<{ data: string }, [string, string]>(
        `SELECT data FROM chat_messages WHERE machine_id = ?1 AND project_id = ?2
           AND json_valid(data) AND json_extract(data, '$.author') = 'human'
         ORDER BY seq DESC LIMIT 1`,
      )
      .get(r.machineId, r.projectId);
    const m = row ? (JSON.parse(row.data) as { author?: string; person?: { personId?: string } }) : undefined;
    person = m?.author === "human" ? m.person?.personId : undefined;
    person ??= ownerOn(c)?.personId;
    const own =
      person === undefined
        ? undefined
        : c.query<{ tz: string | null }, [string]>("SELECT tz FROM people WHERE person_id = ?").get(person)?.tz;
    const mine = own == null ? undefined : zone(own);
    if (mine) return mine;
    const policy = decisions(hub).globalValue(POLICY_TZ_KEY);
    const decided = policy === undefined ? undefined : zone(policy);
    if (decided) return decided;
  } catch {}
  return hubZone();
}

export function registerLeadCalls(hub: Hub): void {
  for (const op of OPS) leadCalls(hub).register(op, (caller, call) => answer(hub, caller, call));
}

const str = (v: unknown) => (typeof v === "string" ? v : undefined);

export async function answer(hub: Hub, caller: LeadCaller, call: LeadCall): Promise<Record<string, unknown>> {
  const a = automations(hub);
  const r = caller.projectRef;
  const by = caller.by;
  // A schedule without a zone runs in the person's (D288).
  const personZone = () => zoneOfChat(hub, r);
  const id = str(call.automationId) ?? "";
  switch (call.op) {
    case "automation_create": {
      const schedule = call.schedule as AutomationScheduleCall | undefined;
      const [automation] = a.create({
        projectRef: r,
        name: call.name as string,
        prompt: call.prompt as string,
        ...(schedule === undefined ? {} : { schedule: fromCall(schedule, personZone) }),
        webhook: false,
        by,
        confirmed: false,
      });
      const s = automation.schedule;
      let next: string;
      if (automation.nextRunAt !== undefined && s?.at !== undefined) {
        next =
          `It runs once, at ${s.at} ${s.tz}, and opens an order for you then; it shows in the person's automations list ` +
          "until it has run. automation_delete cancels it.";
      } else if (automation.nextRunAt !== undefined) {
        next =
          `Its first run is at ${automation.nextRunAt}; each run opens an order for you. A webhook trigger is added by a ` +
          "person in the app (Settings > Automations), where its secret URL is shown once.";
      } else {
        next = "It runs when you call automation_run or a person presses Run now; a schedule or a webhook makes it run by itself.";
      }
      return { automation, next };
    }
    case "automation_list": {
      const list = a.list(r);
      return { automations: list, ...(list.length === 0 ? { next: "No automations yet; automation_create makes one." } : {}) };
    }
    case "automation_update": {
      a.own(r, id);
      const schedule: Edit["schedule"] =
        call.removeSchedule === true
          ? null
          : call.schedule !== undefined
            ? fromCall(call.schedule as AutomationScheduleCall, personZone)
            : undefined;
      // What it runs, or when, changed: the person's go-ahead covers only what they saw.
      const changesRun = call.prompt !== undefined || schedule !== undefined;
      const edit: Edit = {
        ...(call.name === undefined ? {} : { name: call.name as string }),
        ...(call.prompt === undefined ? {} : { prompt: call.prompt as string }),
        ...(schedule === undefined ? {} : { schedule }),
        ...(changesRun ? { confirmed: false } : {}),
      };
      let [automation] = a.update(id, edit, by);
      const paused = typeof call.paused === "boolean" ? call.paused : undefined;
      if (paused !== undefined) automation = a.pause(id, paused, by);
      return { automation, ...(paused === undefined ? {} : { next: pauseNext(paused) }) };
    }
    // Its card, if the person approved it, already marked it: this call only says how it stands.
    case "automation_confirm": {
      const automation = a.own(r, id);
      const next = automation.confirmed
        ? "The person lets it run on its own: its runs count as their go-ahead for what its prompt names."
        : "Not confirmed: only the person confirms it, on the card this call shows them in a Navi's chat, or by editing it " +
          "in the app. Its runs still ask as any other action does.";
      return { automation, next };
    }
    case "automation_pause": {
      a.own(r, id);
      const paused = call.paused === true;
      return { automation: a.pause(id, paused, by), next: pauseNext(paused) };
    }
    case "automation_delete":
      a.own(r, id);
      a.delete(id, by);
      return { automationId: id, next: "Deleted; orders its runs opened stay open." };
    case "automation_run": {
      a.own(r, id);
      const run = await a.run(id, { kind: "manual", by });
      const next = run.workstreamId !== undefined ? `It opened ${run.workstreamId}; it reaches you as a new order.` : run.why !== undefined ? `Not run: ${run.why}.` : "";
      return { run, next };
    }
    case "automation_runs": {
      a.own(r, id);
      const runId = str(call.runId);
      if (runId !== undefined) {
        const found = a.runWithPayload(id, runId);
        if (!found) throw new ToolError("not_found", `${id} has no run ${runId}.`, "automation_runs without runId lists its runs.");
        const [run, payload] = found;
        return { runs: [run], ...(payload === null ? {} : { payload: [...payload].slice(0, WEBHOOK_BODY_MAX).join("") }) };
      }
      return { runs: a.runs(id, RUNS_LISTED) };
    }
  }
  throw new ToolError("invalid", `${call.op} is not an automation call.`);
}

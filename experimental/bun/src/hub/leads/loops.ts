// The leads area's start (crates/fleetd/src/hub/leads/mod.rs `Area::run`, wiring.rs `wire_area`, and hub/serve: the
// areas' lead calls, `wakes.start`, `prompts::start`): the real lead wakes behind `leadWakes(hub)`, the `brief_create`
// and `close` calls, project_get's lead fields, and the loops: project removals, the leads of orders that wait for
// their machine, and leads whose node cut their turn off.
import type { HubEventType, ProjectRef } from "../../shared/contracts.ts";
import { leadWakes } from "../api/leads.ts";
import type { Hub } from "../api/hub.ts";
import { registerLeadCalls as artifactCalls } from "../artifacts/calls.ts";
import { registerLeadCalls as checklistCalls } from "../checklist/calls.ts";
import { executors } from "../executor/index.ts";
import { executorHooks } from "../executor/hooks.ts";
import { start as promptsStart } from "../prompts/tools.ts";
import * as repos from "../repos/store.ts";
import { registerLeadCalls as skillCalls } from "../skills/calls.ts";
import { ran } from "../skills/versions.ts";
import { events } from "../store/events.ts";
import { store } from "../store/hub_store.ts";
import { isoMs, nowMs } from "../store/time.ts";
import { wakes } from "../wakes/index.ts";
import { registerLeadCalls as leadCallsOfLeads } from "./calls.ts";
import { end } from "./cut_off.ts";
import { leads } from "./index.ts";
import { leadWiring } from "./ports.ts";
import { wire as wirePorts } from "./wiring.ts";
import { intake } from "./workstreams.ts";

export const STOPPED_REASON = "its project was removed";
export const REPO_REASON = "its repo was removed from the project";
const SCAN_LIMIT = 10_000;
const OUTCOME_WORKSTREAMS = 20;

/** Follows events of `types` from the log's head now, until the hub stops. */
function follow(hub: Hub, types: HubEventType[], fn: (e: import("../../shared/contracts.ts").HubEvent) => Promise<void> | void): void {
  const log = events(hub);
  const signal = hub.shutdown.signal;
  let cursor = log.head();
  void (async () => {
    while (!signal.aborted) {
      try {
        const page = await log.wait({ cursor, types, timeoutSec: 3600 }, signal);
        cursor = page.cursor;
        for (const e of page.events) await fn(e);
      } catch (error) {
        if (signal.aborted) return;
        console.warn(`leads: following ${types.join(", ")} failed:`, error);
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    }
  })();
}

/** Ends the project's live work if the cache no longer has the project; a no-op otherwise (removals.rs `reconcile`). */
export async function reconcile(hub: Hub, r: ProjectRef): Promise<void> {
  if (store(hub).projectGet(r)) return;
  const tasks = leadWiring(hub).hooks.tasks;
  for (const t of tasks?.live?.(r) ?? []) await tasks?.cancel(r, t.taskId, `Cancelled: ${STOPPED_REASON}.`);
  const records = leads(hub).records;
  for (const w of records.workstreamsList({ projectRef: r, state: "open", limit: SCAN_LIMIT })) {
    const stored = records.workstreamGet(w.workstreamId);
    if (!stored) continue;
    const at = isoMs(nowMs(hub.clock));
    records.workstreamPut({ ...stored, state: "stopped", headline: `Stopped: ${STOPPED_REASON}.`, headlineAt: at, updatedAt: at });
    events(hub).append({
      at,
      type: "workstream.state",
      machineId: r.machineId,
      projectId: r.projectId,
      summary: `${w.workstreamId} is stopped: ${STOPPED_REASON}`,
      data: { workstreamId: w.workstreamId, state: "stopped", reason: STOPPED_REASON },
    });
  }
}

/** Cancels the live tasks whose repo is no longer in `repos`. */
async function endRemovedRepos(hub: Hub): Promise<void> {
  const tasks = leadWiring(hub).hooks.tasks;
  for (const t of tasks?.liveInRepos?.() ?? []) {
    if (!repos.get(hub.db.conn, t.repoId)) await tasks?.cancel(t.projectRef, t.taskId, `Cancelled: ${REPO_REASON}.`);
  }
}

/** Every project with live work, as the records name them. */
function projectsWithLiveWork(hub: Hub): ProjectRef[] {
  const refs = new Map<string, ProjectRef>();
  const add = (r: ProjectRef) => refs.set(`${r.machineId}/${r.projectId}`, r);
  for (const t of leadWiring(hub).hooks.tasks?.live?.(undefined) ?? []) add(t.projectRef);
  for (const w of leads(hub).records.workstreamsList({ state: "open", limit: SCAN_LIMIT })) add(w.projectRef);
  return [...refs.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([, r]) => r);
}

export function start(hub: Hub): void {
  const area = leads(hub);
  // The executor's launch and the write queue behind the lead's ports.
  wirePorts(hub);
  // The real wakes behind the seam other areas trigger.
  leadWakes(hub).trigger = (r, t) => area.wakes.trigger(r, t);
  // Order intake for the areas that open orders (the train's fixes).
  intake(hub);
  checklistCalls(hub);
  artifactCalls(hub);
  skillCalls(hub);
  leadCallsOfLeads(hub);
  // Every Skill call a session the hub follows finishes counts as its project's last use of it.
  executors(hub).sinks.skill = (thread, skill) => {
    try {
      ran(hub.db, thread, skill, hub.clock.now());
    } catch (error) {
      console.warn("skills: a use not kept:", error);
    }
  };
  // project_get shows the project's lead, the profiles its tasks may run on, and its open workstreams.
  executorHooks(hub).extendProjectGet((_h, r) => {
    const fields: Record<string, unknown> = {};
    const lead = area.get(r);
    if (lead) fields.lead = lead;
    fields.profiles = area.allowedProfiles(r);
    const open = area.records.workstreamsList({ projectRef: r, state: "open", limit: OUTCOME_WORKSTREAMS + 1 });
    const truncated = open.length > OUTCOME_WORKSTREAMS;
    if (open.length > 0) fields.workstreams = open.slice(0, OUTCOME_WORKSTREAMS);
    return { fields, ...(truncated ? { truncated: true } : {}) };
  });
  try {
    promptsStart(hub);
  } catch (error) {
    console.warn("prompts: start failed:", error);
  }
  wakes(hub).start();

  // Project removals: catch up at start, then follow project.removed.
  void (async () => {
    for (const r of projectsWithLiveWork(hub)) await reconcile(hub, r).catch((error) => console.warn("project removal catch-up failed:", error));
    await endRemovedRepos(hub).catch((error) => console.warn("repo removal catch-up failed:", error));
  })();
  follow(hub, ["project.removed"], async (e) => {
    if (e.machineId !== undefined && e.projectId !== undefined) {
      await reconcile(hub, { machineId: e.machineId, projectId: e.projectId }).catch((error) => console.warn("project removal failed:", error));
    }
    await endRemovedRepos(hub).catch((error) => console.warn("repo removal failed:", error));
  });
  // A machine comes online once its runner is usable: then the leads its waiting orders need start.
  follow(hub, ["machine.online"], async (e) => {
    if (e.machineId !== undefined) await area.startWaiting(e.machineId).catch((error) => console.warn("waiting orders: leads not started:", error));
  });
  // Leads whose turn was cut off carry on; one woken after its own turn ended badly waits for a completed turn.
  const carriedOn = new Set<string>();
  follow(hub, ["thread.failed", "thread.interrupted", "thread.completed"], (e) => {
    const found = end(e, area.records.leadsList());
    if (!found) return;
    const key = `${found.project.machineId}/${found.project.projectId}`;
    if (found.end.kind === "completed") return void carriedOn.delete(key);
    if (found.end.kind === "own") {
      if (carriedOn.has(key)) return;
      carriedOn.add(key);
    }
    area.wakes.trigger(found.project, { kind: "line", line: "cut_off", text: found.end.text });
  });
}

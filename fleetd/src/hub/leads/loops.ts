// The leads area's start (wiring.rs `wire_area`, and hub/serve: the
// areas' lead calls, `wakes.start`, `prompts::start`): the real lead wakes behind `leadWakes(hub)`, the `brief_create`
// and `close` calls, project_get's lead fields, and the loops: project removals, the leads of orders that wait for
// their machine, and leads whose node cut their turn off.
import type { HubEventType, ProjectRef } from "../../shared/contracts.ts";
import { leadWakes } from "../api/leads.ts";
import type { Hub } from "../api/hub.ts";
import { registerLeadCalls as artifactCalls } from "../artifacts/calls.ts";
import { registerLeadCalls as checklistCalls } from "../checklist/calls.ts";
import { chat } from "../chat/index.ts";
import { latestRun } from "../executor/sessions.ts";
import { link } from "../link/server.ts";
import { CAP_LAUNCH_AHEAD } from "../../shared/node_link.ts";
import { accounts } from "../claude_accounts/tools.ts";
import { executors } from "../executor/index.ts";
import { executorHooks } from "../executor/hooks.ts";
import { start as promptsStart } from "../prompts/tools.ts";
import * as repos from "../repos/store.ts";
import { registerLeadCalls as setupCalls } from "../projects/calls.ts";
import { registerLeadCalls as skillCalls } from "../skills/calls.ts";
import { ran } from "../skills/versions.ts";
import { events } from "../store/events.ts";
import { store } from "../store/hub_store.ts";
import { isoMs, nowMs } from "../store/time.ts";
import { trainDigest } from "../train/index.ts";
import { wakes } from "../wakes/index.ts";
import { registerLeadCalls as leadCallsOfLeads } from "./calls.ts";
import { backLine, skippedLine } from "../../node/mcp_reach.ts";
import type { McpStartChange } from "../../shared/sessions.ts";
import { end, notStartedLine, signedOutLine } from "./cut_off.ts";
import { leads } from "./index.ts";
import { leadWiring } from "./ports.ts";
import type { StoredLead } from "./stored.ts";
import { failedStarts, hubSleep, retryWhenDue, type Sleep } from "./start_retry.ts";
import { wire as wirePorts } from "./wiring.ts";
import { intake } from "./workstreams.ts";

export const STOPPED_REASON = "its bot was removed";
export const REPO_REASON = "its repo was removed from the bot";
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

/**
 * What a lead's start changed of its MCP servers left out because they didn't answer (node/mcp_reach.ts `startChange`,
 * its summary's `mcpChange`, told by the executor as the summary first says so): its chat says so in lines of fleetd's
 * own, never left to the lead to relay. The ones newly left out "didn't answer"; the ones left out before that answered
 * now "answer again"; a server that stays down says nothing. Each line once per start (its source is the start's).
 */
export function mcpSkipped(hub: Hub, thread: { machineId: string; threadId: string }, change: McpStartChange, at: string | undefined): void {
  const lead = leads(hub).records.leadsList().find((l) => l.projectRef.machineId === thread.machineId && l.threadId === thread.threadId);
  if (!lead) return;
  const start = `${thread.threadId}:${at ?? ""}`;
  if (change.down.length > 0) chat(hub).add(lead.projectRef, { author: "system", text: skippedLine(change.down), source: `mcp_down:${start}` });
  if (change.back.length > 0) chat(hub).add(lead.projectRef, { author: "system", text: backLine(change.back), source: `mcp_back:${start}` });
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

/** Cancels the live tasks whose repo is no longer in `repos`; returns them. */
export async function endRemovedRepos(hub: Hub): Promise<string[]> {
  const tasks = leadWiring(hub).hooks.tasks;
  const ended: string[] = [];
  for (const t of tasks?.liveInRepos?.() ?? []) {
    if (repos.get(hub.db.conn, t.repoId)) continue;
    await tasks?.cancel(t.projectRef, t.taskId, `Cancelled: ${REPO_REASON}.`);
    ended.push(t.taskId);
  }
  return ended;
}

/** The leads' project and repo removals (removals.rs `ProjectRemovals`), for project_repo_remove: `hub.peek("lead_removals")`. */
export type LeadRemovals = { reconcile(r: ProjectRef): Promise<void>; endRemovedRepos(): Promise<string[]> };

export const leadRemovals = (hub: Hub) =>
  hub.area<LeadRemovals>("lead_removals", (h) => ({ reconcile: (r) => reconcile(h, r), endRemovedRepos: () => endRemovedRepos(h) }));

/** Every project with live work, as the records name them. */
function projectsWithLiveWork(hub: Hub): ProjectRef[] {
  const refs = new Map<string, ProjectRef>();
  const add = (r: ProjectRef) => refs.set(`${r.machineId}/${r.projectId}`, r);
  for (const t of leadWiring(hub).hooks.tasks?.live?.(undefined) ?? []) add(t.projectRef);
  for (const w of leads(hub).records.workstreamsList({ state: "open", limit: SCAN_LIMIT })) add(w.projectRef);
  return [...refs.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([, r]) => r);
}

/** `sleep`: the waits before a lead whose start didn't come up is started again (tests pass their own). */
export function start(hub: Hub, o: { sleep?: Sleep } = {}): void {
  const area = leads(hub);
  // The executor's launch and the write queue behind the lead's ports.
  wirePorts(hub);
  // The digest's Merge train section: the project's PRs on the train, and what moved since the last wake.
  leadWiring(hub).hooks.trainLines = (r, since) => trainDigest(hub, r, since);
  leadRemovals(hub);
  // The real wakes behind the seam other areas trigger.
  leadWakes(hub).trigger = (r, t) => area.wakes.trigger(r, t);
  // Order intake for the areas that open orders (the train's fixes).
  intake(hub);
  checklistCalls(hub);
  artifactCalls(hub);
  skillCalls(hub);
  setupCalls(hub);
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
  // After a restart from Settings, the leads marked for a profile switch start again on their current profile: now
  // when idle on a linked machine, else once their machine is back or their turn has ended.
  const switchLeads = async (machineId?: string) => {
    for (const r of area.records.leadsSwitchDue()) {
      if (machineId !== undefined && r.machineId !== machineId) continue;
      await switchLead(r);
    }
  };
  const switchLead = (r: ProjectRef) =>
    area.switchIfDue(r).then(
      () => undefined,
      (error) => console.info(`lead profile switch: ${r.projectId} on ${r.machineId} waits: ${error instanceof Error ? error.message : String(error)}`),
    );
  void switchLeads();
  // A machine comes online once its runner is usable: then the leads its waiting orders need start.
  follow(hub, ["machine.online"], async (e) => {
    if (e.machineId === undefined) return;
    await area.startWaiting(e.machineId).catch((error) => console.warn("waiting orders: leads not started:", error));
    await switchLeads(e.machineId);
  });
  // Leads whose start didn't come up are started again by themselves; after a restart, at the time they were due.
  const sleep = o.sleep ?? hubSleep(hub);
  const retryLater = (r: ProjectRef, lead: StoredLead, seq?: number) =>
    retryWhenDue(hub, r, lead, (p, line) => area.wakes.trigger(p, { kind: "line", line: "cut_off", text: line }), sleep, () => area.records.leadGet(r), seq);
  for (const lead of area.records.leadsList()) retryLater(lead.projectRef, lead);
  executorHooks(hub).onMcpSkipped((thread, change, at) => mcpSkipped(hub, thread, change, at));
  // A lead whose run the stall watchdog stopped, still on after STALL_GRACE_MS on its machine: started again.
  // As the chat's line said: one that carries on starts with a turn, one that waits for the person starts with none.
  // Each bot's stall-restarts in a row, for the person's message they were for ("" for none); a completed turn ends a row.
  const restarts = new Map<string, { readonly ask: string; readonly n: number }>();
  const restartFrozen = async (r: ProjectRef, run: string, carries: boolean, ask: string) => {
    const lead = area.records.leadGet(r);
    if (lead === undefined) return;
    const thread = { machineId: r.machineId, threadId: lead.threadId };
    const status = store(hub).threadGet(thread)?.thread.status;
    if ((status !== "running" && status !== "waiting") || latestRun(hub, thread)?.runId !== run) return;
    // A node too old to start a lead with no turn starts it with one: the chat then says it carries on after all, as when a
  // message of the person's waits for an answer as it starts.
    const quiet = !carries && link(hub).can(r.machineId, CAP_LAUNCH_AHEAD);
    try {
      await area.switchSoon(r, { waitForMessage: quiet });
      // Said only once it really started again: a start that waits (its machine away, a refusal) says nothing yet. One
      // that was to wait for the person but started with a turn (a message of theirs waited for an answer, or its node
      // can't start a lead with none) says it carries on.
      const now = area.records.leadGet(r)?.threadId;
      if (now === undefined || now === lead.threadId) return;
      const key = `${r.machineId}/${r.projectId}`;
      const before = restarts.get(key);
      restarts.set(key, { ask, n: before?.ask === ask ? before.n + 1 : 1 });
      const waits = area.startedQuiet(now) === true;
      chat(hub).add(r, { author: "system", text: carries || waits ? FROZEN_LINE : FROZEN_CARRIES_LINE, source: `lead_restarted:${run}` });
    } catch (error) {
      console.warn(`leads: the frozen lead of ${r.machineId}/${r.projectId} not started again:`, error);
    }
  };
  // Leads whose turn was cut off carry on; one woken after its own turn ended badly waits for a completed turn.
  const carriedOn = new Set<string>();
  follow(hub, ["thread.failed", "thread.interrupted", "thread.completed"], (e) => {
    const found = end(e, area.records.leadsList());
    if (!found) return;
    const key = `${found.project.machineId}/${found.project.projectId}`;
    if (found.end.kind === "completed") {
      carriedOn.delete(key);
      restarts.delete(key);
      return switchLead(found.project);
    }
    // Its claude never started: the person reads why, and the lead is started again by itself once its provider is
    // offered again, the person's message (which the node keeps) first; not at once, which would fail the same way
    // while the provider is set aside.
    if (found.end.kind === "not_started") {
      const lead = area.records.leadGet(found.project);
      const n = lead ? (failedStarts(hub, lead)?.n ?? 1) : 1;
      chat(hub).add(found.project, { author: "system", text: notStartedLine(found.end.message, n), source: `lead_start:${found.end.runId ?? e.seq}` });
      if (lead) retryLater(found.project, lead, e.seq);
      return;
    }
    // Claude refused its sign-in: the person reads where to reconnect it, and the lead carries on once they do
    // (./signed_in.ts). No wake, which would be refused the same way.
    if (found.end.kind === "signed_out") {
      const thread = area.records.leadGet(found.project)?.threadId;
      const account = thread ? accounts(hub).threadAccount(found.project.machineId, thread) : undefined;
      const loginFile = account ? undefined : executors(hub).cachedRunner(found.project.machineId)?.loginFile;
      chat(hub).add(found.project, { author: "system", text: signedOutLine(account, found.project.machineId, loginFile), source: `lead_auth:${found.end.runId ?? e.seq}` });
      return;
    }
    if (found.end.kind === "own") {
      const carries = !carriedOn.has(key);
      // A turn the stall watchdog stopped: the chat says so, once per run, never "working" with nothing (the cloud's
      // leads/follow.ts the same).
      const stalled = e.data as { reason?: unknown; runId?: unknown } | undefined;
      if (e.type === "thread.failed" && stalled?.reason === "stalled") {
        const run = typeof stalled.runId === "string" ? stalled.runId : String(e.seq);
        const r = found.project;
        // Started again STALL_RESTARTS_MAX times in a row for the same message of the person's, and stalled each time:
        // its machine is the trouble. Nothing more starts by itself, and the chat says so, and what to do.
        const ask = area.waitingAsk(r) ?? "";
        const before = restarts.get(key);
        if (before?.ask === ask && before.n >= STALL_RESTARTS_MAX) {
          const machine = store(hub).machineGet(r.machineId)?.name ?? r.machineId;
          chat(hub).add(r, { author: "system", text: stuckLine(machine), source: `lead_stuck:${run}` });
          return;
        }
        chat(hub).add(r, { author: "system", text: stalledLine(carries), source: `lead_stalled:${run}` });
        // Its machine may never end the run (a claude frozen, a host that lost it): then the lead starts again, as a
        // person's Restart lead does, so it carries on, takes the next message, and Stop and its orders read it right.
        void sleep(STALL_GRACE_MS).then(() => restartFrozen(r, run, carries, ask));
      }
      if (!carries) return;
      carriedOn.add(key);
    }
    area.wakes.trigger(found.project, { kind: "line", line: "cut_off", text: found.end.text });
  });
}

/** The chat's line for a lead's turn the stall watchdog stopped: that it carries on by itself, or what starts it again. */
export const stalledLine = (carriesOn: boolean): string =>
  `The lead stopped making progress, so fleetd stopped its turn. ${carriesOn ? "It carries on by itself." : "Your next message starts it again."}`;

/** How long the machine of a lead's run the stall watchdog stopped gets to end it before the lead starts again. */
export const STALL_GRACE_MS = 60_000;

/** The chat's line when a lead's stopped run never ended on its machine and fleetd started the lead again. */
export const FROZEN_LINE = "Its machine didn't end the stopped turn, so fleetd started the lead again.";

/** The same, for a lead that was to wait for the person but started with a turn: a message of theirs waited for an
 * answer, or its node can only start it with one. */
export const FROZEN_CARRIES_LINE = "Its machine didn't end the stopped turn, so fleetd started the lead again, and it carries on.";

/** How many times in a row a lead stalled on the same message of the person's is started again by itself. */
export const STALL_RESTARTS_MAX = 2;

/** The chat's line once a lead stalled again past STALL_RESTARTS_MAX: what's wrong, and what the person can do. */
export const stuckLine = (machine: string): string =>
  `The lead keeps stalling on ${machine}, so fleetd stopped starting it again. Restart the lead from the bot's settings to try once more, or check ${machine}.`;

// The M1 MCP tools over the executor and the caches it fills: fleetd_status, project_get, thread_tail and
// actions_list (crates/fleetd/src/hub/executor/tools.rs). Later areas add to fleetd_status and project_get through
// `executorHooks` (slots, lead, workstreams, tasks, trains).
import type { HubEvent, Machine, MachineId, ProjectChatState, ProjectRef, ProjectSummary, SlotState, ThreadRef } from "../../shared/contracts.ts";
import { ToolError } from "../../shared/errors.ts";
import { readable, requireRole } from "../api/grants.ts";
import type { Hub } from "../api/hub.ts";
import { canRead, cap, clip, LIMITS, offline, unknownMachine, unknownProject, unknownThread } from "../api/refusals.ts";
import type { Caller, Registry } from "../api/registry.ts";
import { notifyPolicy } from "../attention/index.ts";
import { about, among, others } from "../navi/owner.ts";
import { events } from "../store/events.ts";
import { store } from "../store/hub_store.ts";
import { isoMs } from "../store/time.ts";
import { chat } from "../chat/index.ts";
import { leadWorking } from "../chat/flow.ts";
import { slots } from "../slots/index.ts";
import { executorHooks } from "./hooks.ts";
import { ExecutorError, executors } from "./index.ts";
import { toThread } from "./shell_mapper.ts";

const ATTENTION_TYPES = [
  "thread.failed",
  "thread.waiting",
  "thread.usage_limited",
  "usage.breaker",
  "change.needs_rebase",
  "change.ci_failed",
];
/** How far back fleetd_status looks for attention events. */
const ATTENTION_LOOKBACK = 1000;

/** An executor failure as the tools answer it. */
export function fromExecutor(error: unknown): ToolError {
  if (!(error instanceof ExecutorError)) throw error;
  switch (error.kind) {
    case "not_connected":
      return offline(error.machineId);
    case "thread_not_found":
      return unknownThread({ machineId: error.machineId, threadId: error.extra.threadId ?? "" });
    case "node_failed":
      console.warn(`executor: node request failed: ${error.message}`);
      return new ToolError("failed", error.message, error.extra.fix ?? "Retry; if it keeps failing, check the machine with fleetd_status.");
  }
}

/** A machine's cache is fresh only while its node is online and its session stream is live. */
function freshness(hub: Hub, machineId: MachineId): { machine: Machine; stale: boolean; asOf: string } {
  const machine = store(hub).machineGet(machineId);
  if (!machine) throw unknownMachine(machineId);
  const live = machine.status === "online" && executors(hub).isConnected(machineId);
  return { machine, stale: !live, asOf: live ? isoMs(hub.clock.now()) : machine.lastSeenAt };
}

function markStale<T extends object>(thread: T, stale: boolean, asOf: string): T {
  return stale ? { ...thread, stale: true, asOf } : thread;
}

/** The latest attention events the caller may see, oldest first, scanned forward from a bounded lookback. */
function attention(hub: Hub, caller: Caller, head: number): HubEvent[] {
  let cursor = Math.max(0, head - ATTENTION_LOOKBACK);
  let latest: HubEvent[] = [];
  const navis = others(hub.db, caller);
  for (;;) {
    const page = events(hub).page(cursor, ATTENTION_TYPES);
    latest.push(...page.events.filter((e) => canRead(caller, e) && !about(hub.db, navis, e)));
    if (latest.length > LIMITS.ATTENTION) latest = latest.slice(latest.length - LIMITS.ATTENTION);
    if (!page.more || page.cursor <= cursor) return latest;
    cursor = page.cursor;
  }
}

/** The slot board, its rows kept to the machines the caller reads (serve/wire.rs `extend_tools`). */
function slotBoard(hub: Hub, caller: Caller): SlotState {
  const board = slots(hub).state();
  return {
    ...board,
    perProject: board.perProject.filter((row) => readable(caller, row.projectRef.machineId)),
    ...(board.perMachine ? { perMachine: board.perMachine.filter((row) => readable(caller, row.machineId)) } : {}),
  };
}

/** Each readable project's chat state, the first 50 projects shown (chat/flow.rs `states`, chat/tools.rs). */
function chatStates(hub: Hub, caller: Caller, navis: ReturnType<typeof others>): ProjectChatState[] {
  const out: ProjectChatState[] = [];
  for (const p of store(hub).projectsShown().slice(0, 50)) {
    const r = { machineId: p.machineId, projectId: p.projectId };
    if (!readable(caller, r.machineId) || navis.has(r)) continue;
    try {
      out.push(chat(hub).state(r, leadWorking(hub, r)));
    } catch (error) {
      console.warn(`chat state of ${r.projectId} not read: ${(error as Error).message}`);
    }
  }
  return out;
}

async function fleetdStatus(hub: Hub, caller: Caller): Promise<Record<string, unknown>> {
  const cursor = events(hub).head();
  const machines = store(hub)
    .machinesList()
    .filter((m) => readable(caller, m.machineId));
  const navis = others(hub.db, caller);
  const projects = store(hub)
    .projectsShown()
    .filter((p) => readable(caller, p.machineId) && !among(navis, p))
    .sort((a, b) => (b.lastActivityAt > a.lastActivityAt ? 1 : b.lastActivityAt < a.lastActivityAt ? -1 : 0));
  const shown = cap(projects, LIMITS.PROJECTS);
  const out: Record<string, unknown> = {
    machines,
    projects: shown.items,
    attention: attention(hub, caller, cursor),
    cursor,
    notify: notifyPolicy(hub),
    next: `Call events_wait with cursor ${cursor} to wait for changes, or project_get for one project's outcome.`,
    // Rust's two status hooks (serve/wire.rs `extend_tools`, chat/tools.rs `extend_status`): always present.
    slots: slotBoard(hub, caller),
    chats: chatStates(hub, caller, navis),
  };
  for (const hook of executorHooks(hub).status) Object.assign(out, await hook(hub, caller));
  if (shown.truncated) out.truncated = true;
  return out;
}

function projectsList(hub: Hub, caller: Caller, machineId: MachineId | undefined, query: string | undefined): Record<string, unknown> {
  if (machineId !== undefined) requireRole(caller, "read", machineId);
  const navis = others(hub.db, caller);
  const projects = store(hub)
    .projectsShown(machineId, query)
    .filter((p) => readable(caller, p.machineId) && !among(navis, p));
  const shown = cap(projects, LIMITS.PROJECTS);
  const out: Record<string, unknown> = { projects: shown.items };
  if (shown.truncated) {
    out.truncated = true;
    out.next = "Narrow the list with machineId or query.";
  }
  return out;
}

async function projectGet(
  hub: Hub,
  caller: Caller,
  input: { machineId?: MachineId; projectId?: string; query?: string },
): Promise<Record<string, unknown>> {
  const { machineId, projectId } = input;
  if (machineId === undefined || projectId === undefined) return projectsList(hub, caller, machineId, input.query);
  requireRole(caller, "read", machineId);
  const { stale, asOf } = freshness(hub, machineId);
  const r: ProjectRef = { machineId, projectId };
  const project: ProjectSummary | undefined = store(hub).projectGet(r);
  if (!project) throw unknownProject(r);
  const extras = [];
  for (const hook of executorHooks(hub).project) extras.push(await hook(hub, r));
  const excluded = new Set(extras.flatMap((e) => [...(e.excludeThreads ?? [])]));
  // Task threads show only as tasks, never in the thread list.
  const own = store(hub)
    .threadsByProject(r, LIMITS.OUTCOME_THREAD_SCAN)
    .filter((t) => !excluded.has(t.threadId))
    .map((t) => markStale(t, stale, asOf));
  const threads = cap(own, LIMITS.OUTCOME_THREADS);
  const next = stale ? `Cached as of ${asOf}: ${machineId} is offline.` : "Call thread_tail for a thread's latest messages and actions.";
  const out: Record<string, unknown> = { project, threads: threads.items, stale, asOf, next };
  const flags: (boolean | undefined)[] = [threads.truncated];
  for (const extra of extras) {
    Object.assign(out, extra.fields);
    flags.push(extra.truncated);
  }
  if (flags.find((f) => f !== undefined) === true) out.truncated = true;
  return out;
}

async function threadTail(hub: Hub, caller: Caller, input: { machineId: MachineId; threadId: string; n?: number; kinds?: string[] }) {
  requireRole(caller, "read", input.machineId);
  const { stale, asOf } = freshness(hub, input.machineId);
  const r: ThreadRef = { machineId: input.machineId, threadId: input.threadId };
  const n = Math.max(0, input.n ?? 10);
  if (stale) {
    // The hub caches shell rows only, so offline the tail is the cached latest message.
    const stored = store(hub).threadGet(r);
    if (!stored) throw unknownThread(r);
    const thread = stored.thread;
    const wantsMessages = input.kinds === undefined || input.kinds.includes("message");
    const tail = thread.latestMessageTail;
    const items =
      wantsMessages && tail !== "" ? [{ kind: "message", at: thread.lastProgressAt, role: "assistant", text: clip(tail, LIMITS.TAIL_TEXT) }] : [];
    return {
      items,
      thread: markStale(thread, true, asOf),
      next: `Cached as of ${asOf}: ${input.machineId} is offline, so only the latest message is available.`,
    };
  }
  const kinds = input.kinds?.map((k) => (k === "message" ? "message" : "action"));
  let tail;
  try {
    tail = await executors(hub).views.tail(r, n, kinds);
  } catch (error) {
    throw fromExecutor(error);
  }
  const items = cap(tail.items, n);
  const rows = items.items.map((row) => (row.kind === "message" ? { kind: "message", at: row.at, role: row.role, text: clip(row.text, LIMITS.TAIL_TEXT) } : row));
  const truncated = items.truncated ?? (tail.truncated ? true : undefined);
  return { items: rows, thread: toThread(tail.thread), ...(truncated ? { truncated: true } : {}) };
}

async function actionsList(hub: Hub, caller: Caller, input: { machineId: MachineId; threadId: string; limit?: number; failedOnly?: boolean }) {
  requireRole(caller, "read", input.machineId);
  if (freshness(hub, input.machineId).stale) throw offline(input.machineId);
  const r: ThreadRef = { machineId: input.machineId, threadId: input.threadId };
  const limit = Math.max(0, input.limit ?? 50);
  let actions;
  try {
    actions = await executors(hub).views.actions(r, limit, input.failedOnly === true);
  } catch (error) {
    throw fromExecutor(error);
  }
  const shown = cap(actions, limit);
  return { actions: shown.items, ...(shown.truncated ? { truncated: true } : {}) };
}

export function register(tools: Registry): void {
  tools.add("fleetd_status", (hub, caller) => fleetdStatus(hub, caller) as never);
  tools.add("project_get", (hub, caller, input) => projectGet(hub, caller, input) as never);
  tools.add("thread_tail", (hub, caller, input) => threadTail(hub, caller, input as never) as never);
  tools.add("actions_list", (hub, caller, input) => actionsList(hub, caller, input as never) as never);
}

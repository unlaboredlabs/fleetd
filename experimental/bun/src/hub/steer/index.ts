// Steering (crates/fleetd/src/hub/steer/mod.rs): a person's (or a lead's) words to a running agent, sent straight to
// its thread as one short message, never through the wake debounce or with the digest. `queue` lands at the agent's
// next tool boundary as its own turn; `now` stops its current step. Every steer has a receipt the node decides from
// claude's own frames, stored here and emitted as `steer.*` events.
import type { HubEventType, ProjectRef, Steer, SteerBy, SteerMode, SteerStage, SteerTarget, Task, ThreadRef } from "../../shared/contracts.ts";
import type { SteerReceipt } from "../../shared/sessions.ts";
import { NotImplemented, ToolError } from "../../shared/errors.ts";
import { allows } from "../auth/index.ts";
import type { Hub } from "../api/hub.ts";
import { requireRole } from "../api/grants.ts";
import type { Caller } from "../api/registry.ts";
import { jsTake } from "../chat/index.ts";
import { uuidFrom } from "../executor/index.ts";
import { withdraw as withdrawRun } from "../executor/sessions.ts";
import { renderEvent } from "../leads/events.ts";
import { leads } from "../leads/index.ts";
import { isClosed } from "../leads/records.ts";
import { leadWakes } from "../leads/seams.ts";
import { prompts } from "../prompts/store.ts";
import { writeQueue } from "../queue/index.ts";
import * as repos from "../repos/store.ts";
import { events } from "../store/events.ts";
import { store } from "../store/hub_store.ts";
import { isoMs, nowMs } from "../store/time.ts";
import { TaskRecords } from "../tasks/records.ts";
import { onSteer } from "./dm.ts";
import * as steers from "./store.ts";

export const STEER_TEXT_MAX = 20_000;
/** How long a steer may wait for its next receipt on a thread that is no longer running. */
export const RECEIPT_GRACE_MS = 120_000;

/** Who sends a steer: a person's key, a lead for a task of its own project, or a task's agent for another agent of its
 * project (one recipient of its agent message, `dm.ts`). */
export type By = { kind: "human"; caller: Caller } | { kind: "lead"; project: ProjectRef } | { kind: "agent"; from: Task; message: string };

const stored = (by: By) => (by.kind === "human" ? `key:${by.caller.keyId}` : by.kind === "lead" ? "lead" : `agent:${by.from.taskId}`);
const steerBy = (by: By): SteerBy =>
  by.kind === "human" ? { kind: "human", keyName: by.caller.name } : by.kind === "lead" ? { kind: "lead" } : { kind: "agent", taskId: by.from.taskId, messageId: by.message };

export type SteerRequest = {
  target: SteerTarget;
  text: string;
  mode: SteerMode;
  /** Rendered "References:" lines and delivered attachment paths. */
  refs: string[];
  attached: string[];
  clientRequestId: string;
};

/** What the tasks area does for a steer to a task that isn't running (hub/tasks `message`, `take_back`). */
export type SteerTasks = {
  /** Adds `text` to the task's next run (a queued task's start, an ended one's continuation). */
  message(caller: { projectRef: ProjectRef; by: string }, taskId: string, text: string): Promise<void>;
  /** Takes `message` back out of the task's pending message; false once it went out. */
  takeBack(taskId: string, message: string): Promise<boolean>;
  /** Keeps another agent's message for a task's next run without starting one (tasks `holdMessage`). */
  holdMessage(taskId: string, text: string): Promise<void>;
  /** When the task asked the `ask_lead` question no message has answered yet. */
  askedAt(taskId: string): number | undefined;
  /** Its lead or a person wrote to it: that answers its question. */
  answered(taskId: string): void;
  /** Whether the task keeps a wait_ci open. */
  hasCiWait(taskId: string): boolean;
};

/** The tasks area's part: set by it when it starts; until then a steer to a task that isn't running can't be held. */
export const steerTasks = (hub: Hub) =>
  hub.area<SteerTasks>("steer_tasks", () => ({
    message: async () => {
      throw new NotImplemented("src/hub/tasks (a task's next-run message)");
    },
    takeBack: async () => false,
    holdMessage: async () => {
      throw new NotImplemented("src/hub/tasks (a task's next-run message)");
    },
    askedAt: () => undefined,
    answered: () => {},
    hasCiWait: () => false,
  }));

type Resolved = { workstreamId: string; title: string; task?: Task; thread: ThreadRef };

const invalid = (message: string, fix?: string) => new ToolError("invalid", message, fix);
const notFound = (what: string) => new ToolError("not_found", `No ${what}.`, "Call orders_board to see open orders and their agents.");

const sameRef = (a: ProjectRef, b: ProjectRef) => a.machineId === b.machineId && a.projectId === b.projectId;

function resolve(hub: Hub, by: By, target: SteerTarget): Resolved {
  const records = leads(hub).records;
  if ("workstreamId" in target) {
    const w = records.workstreamGet(target.workstreamId);
    if (!w) throw notFound(`order ${target.workstreamId}`);
    const r = w.projectRef;
    if (by.kind === "human") {
      if (!allows(by.caller, "read", r.machineId)) throw notFound(`order ${target.workstreamId}`);
      requireRole(by.caller, "operate", r.machineId);
    }
    if (isClosed(w.state)) throw invalid(`${target.workstreamId} has ended; its lead no longer works on it.`, "Tell the project's lead in its chat (chat_send).");
    // An archived project's lead takes no turn (W79): this says why first.
    const holder = repos.holders(hub.db.conn, r)[0];
    if (holder) {
      throw invalid(
        `This project is archived: its directory is repo ${holder.repo.name} of project ${holder.project.projectId} on ${holder.project.machineId}.`,
        "Write to that project's lead instead; project_repo_remove takes the repo out of it and brings this project back.",
      );
    }
    const lead = records.leadGet(r);
    if (!lead) throw invalid(`${target.workstreamId}'s project has no lead running yet.`, "Start it with lead_start, then steer it.");
    return { workstreamId: w.workstreamId, title: w.title, thread: { machineId: r.machineId, threadId: lead.threadId } };
  }
  const task = TaskRecords.get(hub.db.conn, target.taskId)?.task;
  if (!task) throw notFound(`task ${target.taskId}`);
  const r = task.projectRef;
  if (by.kind === "human") {
    if (!allows(by.caller, "read", r.machineId)) throw notFound(`task ${target.taskId}`);
    requireRole(by.caller, "operate", r.machineId);
  } else if (by.kind === "lead") {
    if (!sameRef(by.project, r)) throw notFound(`task ${target.taskId} in this project`);
  } else if (!sameRef(by.from.projectRef, r)) {
    throw new ToolError("not_found", `There is no agent ${target.taskId} in your project.`, "Call `agents` to see your project's agents and their ids.");
  } else if (by.from.taskId === target.taskId) {
    throw invalid(`${target.taskId} is you.`, "Call `agents` to find the agent you mean, or ask your lead with ask_lead.");
  }
  if (task.state === "cancelled") throw invalid(`${target.taskId} was cancelled.`, "Spawn a new task for the remaining work.");
  if (!task.threadRef) throw invalid(`${target.taskId} has not started yet.`, "Wait for it to start, or cancel it and spawn it with the new prompt.");
  return { workstreamId: task.workstreamId, title: records.workstreamGet(task.workstreamId)?.title ?? "", task, thread: task.threadRef };
}

function oneLine(text: string, max: number): string {
  const flat = text.split(/\s+/u).filter(Boolean).join(" ");
  return [...flat].length > max ? `${jsTake(flat, max - 1)}…` : flat;
}

function references(refs: string[], attached: string[]): string {
  let out = "";
  if (refs.length > 0) out += `\nReferences:\n${refs.join("\n")}`;
  if (attached.length > 0) out += `\nAttached:\n${attached.join("\n")}`;
  return out;
}

/** What the agent receives (`steer.message`, editable like every prompt). */
function message(hub: Hub, steer: Steer, to: Resolved, by: By, req: SteerRequest): string {
  const scope = to.task ? `${to.task.taskId} (${to.task.kind}) for ${to.workstreamId}` : `${to.workstreamId} '${oneLine(to.title, 80)}'`;
  if (by.kind === "agent") {
    return prompts(hub.db)
      .forThread(to.thread.machineId, to.thread.threadId)
      .render("agent.message", { id: by.message, from: by.from.taskId, fromTitle: oneLine(by.from.title, 80), scope, text: oneLine(req.text, STEER_TEXT_MAX) });
  }
  return prompts(hub.db)
    .forThread(to.thread.machineId, to.thread.threadId)
    .render("steer.message", {
      id: steer.id,
      who: by.kind === "human" ? "the human" : "your lead",
      scope,
      text: oneLine(req.text, STEER_TEXT_MAX),
      references: references(req.refs, req.attached),
    });
}

const hhmm = (iso: string) => iso.slice(11, 16) || iso;

/** A send's run id, as the executor derives it (executor `send_run_id`). */
export const sendRunId = (r: ThreadRef, clientRequestId: string) => uuidFrom(`send\n${r.machineId}\n${r.threadId}\n${clientRequestId}`);

/**
 * Sends a steer: stored as `queued`, then straight to the agent's thread (or the offline queue). A retried request (the
 * same key and clientRequestId) returns the stored steer and sends nothing.
 */
export async function send(hub: Hub, by: By, req: SteerRequest): Promise<Steer> {
  const to = resolve(hub, by, req.target);
  const crid = `steer:${stored(by)}:${req.clientRequestId}`;
  const now = nowMs(hub.clock);
  const text = jsTake(req.text, STEER_TEXT_MAX);
  if (!text) throw invalid("The steer has no text.");
  const draft: Steer = {
    id: "S1",
    target: req.target,
    workstreamId: to.workstreamId,
    thread: to.thread,
    runId: sendRunId(to.thread, crid),
    by: steerBy(by),
    mode: req.mode,
    text,
    stage: "queued",
    queuedAt: isoMs(now),
    ...(to.task && to.task.state !== "running" ? { held: true } : {}),
  };
  const ins = steers.insert(hub.db, { steer: draft, ...(to.task ? { taskId: to.task.taskId } : {}), by: stored(by), queuedMs: now, request: crid });
  let steer = ins.steer;
  if (!ins.created) return steer;
  // A lead's or a person's words answer a question the task asked, even mid-run: from then on another agent's message
  // is held for it like any other.
  if (by.kind !== "agent" && to.task) steerTasks(hub).answered(to.task.taskId);
  emit(hub, steer, "steer.queued");
  if (by.kind === "human" && to.task) tellLead(hub, steer, to.task);
  const body = message(hub, steer, to, by, req);
  steers.keepMessage(hub.db, steer.id, body);
  // An agent never starts another's run: one that has ended keeps the message for a run something else starts (a
  // Monitor or wait_ci of its own, its lead), unless it waits for an answer, which this may be.
  const seam = steerTasks(hub);
  if (by.kind === "agent" && to.task && ["done", "failed", "idle"].includes(to.task.state) && seam.askedAt(to.task.taskId) === undefined) {
    const id = to.task.taskId;
    steer = {
      ...steer,
      detail: seam.hasCiWait(id)
        ? `${id} has finished and waits on wait_ci: it gets this when that wakes it`
        : `${id} has finished and isn't waiting on ${by.from.taskId}: it gets this only if a Monitor or wait_ci of its own wakes it, or its lead continues it`,
    };
    steers.put(hub.db, steer);
    steers.hold(hub.db, steer.id, body);
    await seam.holdMessage(id, body);
    return steers.get(hub.db, steer.id)?.steer ?? steer;
  }
  // A task that is not running gets it with its next run: held until then, and sent tagged with that run.
  if (to.task && to.task.state !== "running") {
    steer = { ...steer, detail: `queued until ${to.task.taskId} starts; it gets this with its next run` };
    steers.put(hub.db, steer);
    steers.hold(hub.db, steer.id, body);
    try {
      await steerTasks(hub).message({ projectRef: to.task.projectRef, by: stored(by) }, to.task.taskId, body);
      return steers.get(hub.db, steer.id)?.steer ?? steer;
    } catch (error) {
      fail(hub, steer, (error as Error).message);
      throw error;
    }
  }
  try {
    const sent = await writeQueue(hub).send(to.thread, body, crid, undefined, { mode: req.mode === "now" ? "now" : "boundary", steer: steer.id, riders: [] });
    if (sent.queued) {
      steer = { ...steer, detail: `waiting for ${to.thread.machineId} (until ${sent.queuedUntil ? hhmm(sent.queuedUntil) : ""})` };
      steers.put(hub.db, steer);
    }
    return steer;
  } catch (error) {
    const why = (error as Error).message;
    fail(hub, steer, why);
    throw new ToolError("failed", why);
  }
}

/** A person steered a task directly: its lead hears it at its next wake, so its plan doesn't fork from it. */
function tellLead(hub: Hub, steer: Steer, task: Task): void {
  const line = renderEvent({ kind: "agent_steered", task: task.taskId, steerKind: task.kind, steer: steer.id, text: steer.text });
  leadWakes(hub).trigger(task.projectRef, { kind: "line", line: "human", text: line });
}

/** The lead digest's line under an order: the human's latest direct steers to its tasks, and how each landed. */
export function digestLine(hub: Hub, workstreamId: string): string | undefined {
  let list: Steer[];
  try {
    list = steers.list(hub.db, workstreamId, 20);
  } catch {
    return undefined;
  }
  const parts = list
    .filter((s) => s.by.kind === "human" && "taskId" in s.target)
    .slice(0, 3)
    .map((s) => `${s.id} → ${(s.target as { taskId: string }).taskId} ${s.stage === "unacknowledged" ? "not acknowledged" : s.stage}`);
  return parts.length > 0 ? parts.join(", ") : undefined;
}

/**
 * The tasks area is about to send a task's next run, whose message carries every held steer in the order they came.
 * All become that run's: the newest is the tag and the older ones its riders.
 */
export function takeHeld(hub: Hub, taskId: string, thread: ThreadRef, clientRequestId: string): { id: string; riders: string[] } | undefined {
  const held = steers.heldForTask(hub.db, taskId);
  const last = held.pop();
  if (!last) return undefined;
  const runId = sendRunId(thread, clientRequestId);
  const leader: Steer = { ...last, runId, thread };
  delete leader.detail;
  delete leader.held;
  steers.bind(hub.db, leader);
  const riders: string[] = [];
  for (const r of held) {
    const rider: Steer = { ...r, runId, thread, detail: `sent with ${taskId}'s next run, together with ${leader.id}` };
    delete rider.held;
    try {
      steers.ride(hub.db, rider, leader.id);
      riders.push(rider.id);
    } catch {
      // A rider not bound stays held, as the Rust hub leaves it.
    }
  }
  return { id: leader.id, riders };
}

/** A task's run was cut for steer run `runId`, which never ran: its steers claude never took in are held again. */
export function holdUnrun(hub: Hub, taskId: string, runId: string): string[] {
  const out: string[] = [];
  for (const { steer, message: m } of steers.ofRun(hub.db, taskId, runId)) {
    if (steer.deliveredAt !== undefined || (steer.stage !== "queued" && steer.stage !== "failed")) continue;
    const text = m ?? steer.text;
    const again: Steer = { ...steer, stage: "queued", held: true, detail: `its run never began; it goes again with ${taskId}'s resumed run` };
    try {
      steers.put(hub.db, again);
      steers.hold(hub.db, again.id, text);
      out.push(text);
    } catch (error) {
      console.warn(`unrun steer ${steer.id} not held again:`, error);
    }
  }
  return out;
}

/** The run it was bound to never went out (the machine was away): it and its riders are held again. */
export function rehold(hub: Hub, id: string): void {
  for (const one of [id, ...steers.riders(hub.db, id).map((r) => r.id)]) {
    const got = steers.get(hub.db, one);
    if (!got || !("taskId" in got.steer.target)) continue;
    const steer: Steer = { ...got.steer, held: true, detail: `queued until ${got.steer.target.taskId} starts; it gets this with its next run` };
    try {
      steers.put(hub.db, steer);
      steers.hold(hub.db, steer.id);
    } catch {
      // As the Rust hub: a steer not held again stays as it was.
    }
  }
}

/** The offline queue gave up on a steer's write: past its limit (`ttl`), or the node refused it. */
export function expired(hub: Hub, id: string, reason: "ttl" | "refused"): void {
  const got = steers.get(hub.db, id);
  if (!got || isFinal(got.steer.stage)) return;
  const steer: Steer = {
    ...got.steer,
    stage: reason === "ttl" ? "expired" : "failed",
    detail: reason === "ttl" ? `${got.steer.thread.machineId} stayed offline past the queue's limit` : "the node refused it",
  };
  try {
    steers.put(hub.db, steer);
    emit(hub, steer, "steer.failed");
  } catch {
    // As the Rust hub: a steer not stored stays as it was.
  }
}

function fail(hub: Hub, steer: Steer, why: string): void {
  const { detail: _, ...rest } = steer;
  const failed: Steer = { ...rest, stage: "failed", ...(why ? { detail: jsTake(why, 400) } : {}) };
  steers.put(hub.db, failed);
  emit(hub, failed, "steer.failed");
}

const rankOf = (stage: SteerStage) => (stage === "queued" ? 0 : stage === "delivered" ? 1 : 2);
const isFinal = (stage: SteerStage) => !["queued", "delivered"].includes(stage);

/** A node's receipt. Receipts replay after a link drop, so one that does not move the steer forward is ignored. */
export function onReceipt(hub: Hub, machineId: string, r: SteerReceipt): void {
  const got = steers.get(hub.db, r.steerId);
  if (!got) return void console.warn(`a receipt for an unknown steer ${r.steerId}`);
  const steer = { ...got.steer };
  if (steer.thread.machineId !== machineId || steer.runId !== r.runId) return void console.warn(`a receipt for ${r.steerId} from another thread`);
  // Held again for its task's resumed run: what its earlier run says of it is over.
  if (isFinal(steer.stage) || rankOf(r.stage) <= rankOf(steer.stage) || steers.isHeld(hub.db, steer.id)) return;
  // When the hub heard it, so the sweep's grace runs on the hub's own clock.
  const at = nowMs(hub.clock);
  let delivered: number | undefined;
  let acked: number | undefined;
  steer.stage = r.stage;
  if (steer.seenAt === undefined && r.seenAt !== undefined) steer.seenAt = r.seenAt;
  if (r.stage === "delivered") {
    steer.deliveredAt = r.at;
    if (r.how !== undefined) steer.how = r.how;
    else delete steer.how;
    if (r.stoppedTool !== undefined) steer.stoppedTool = r.stoppedTool;
    else delete steer.stoppedTool;
    delivered = at;
  } else if (r.stage === "acknowledged") {
    steer.ackedAt = r.at;
    if (r.excerpt !== undefined) steer.ackExcerpt = r.excerpt;
    else delete steer.ackExcerpt;
    acked = at;
  } else if (r.stage === "failed" || r.stage === "expired") {
    if (r.reason !== undefined) steer.detail = jsTake(r.reason, 400);
    else delete steer.detail;
  }
  // An acknowledgement that skipped `delivered` still says when.
  if (steer.deliveredAt === undefined && (r.stage === "acknowledged" || r.stage === "unacknowledged")) steer.deliveredAt = r.at;
  try {
    steers.put(hub.db, steer, delivered, acked);
  } catch (error) {
    return void console.error("steer receipt not stored:", error);
  }
  emit(hub, steer, eventType(r.stage));
}

function eventType(stage: SteerStage): HubEventType {
  switch (stage) {
    case "queued":
      return "steer.queued";
    case "delivered":
      return "steer.delivered";
    case "acknowledged":
      return "steer.acknowledged";
    case "unacknowledged":
      return "steer.unacknowledged";
    case "withdrawn":
      return "steer.withdrawn";
    default:
      return "steer.failed";
  }
}

const targetName = (s: Steer) => ("workstreamId" in s.target ? `the lead of ${s.target.workstreamId}` : s.target.taskId);

function summary(s: Steer): string {
  const to = targetName(s);
  switch (s.stage) {
    case "queued":
      return s.by.kind === "agent" ? `${s.id} from ${s.by.taskId} to ${to}: '${oneLine(s.text, 120)}'` : `${s.id} to ${to}: '${oneLine(s.text, 120)}'`;
    case "delivered":
      return s.how === "stopped" && s.stoppedTool !== undefined ? `${s.id} reached ${to}: it stopped \`${oneLine(s.stoppedTool, 80)}\`` : `${s.id} reached ${to}`;
    case "acknowledged":
      return `${to} acknowledged ${s.id}`;
    case "unacknowledged":
      return `${to} did not acknowledge ${s.id}`;
    case "withdrawn":
      return `${s.id} to ${to} withdrawn`;
    case "failed":
      return `${s.id} to ${to} failed`;
    default:
      return `${s.id} to ${to} expired undelivered`;
  }
}

function emit(hub: Hub, steer: Steer, type: HubEventType): void {
  const queued = type === "steer.queued";
  const data: Record<string, unknown> = { steerId: steer.id, workstreamId: steer.workstreamId };
  if ("taskId" in steer.target) data.taskId = steer.target.taskId;
  data.stage = steer.stage;
  if (steer.how !== undefined) data.how = steer.how;
  if (steer.ackExcerpt !== undefined) data.excerpt = steer.ackExcerpt;
  if (queued) {
    data.text = jsTake(steer.text, 120);
    data.mode = steer.mode;
    data.by = steer.by;
  }
  if (type === "steer.failed" && steer.detail !== undefined) data.reason = steer.detail;
  if (steer.held !== undefined) data.held = steer.held;
  try {
    events(hub).append({
      at: isoMs(nowMs(hub.clock)),
      type,
      machineId: steer.thread.machineId,
      threadId: steer.thread.threadId,
      summary: jsTake(summary(steer), 200),
      data,
    });
  } catch (error) {
    console.error("steer event append failed:", error);
  }
  if (steer.by.kind === "agent" && !queued) onSteer(hub, steer);
}

/** Withdraws a steer still queued: from the hub's offline queue, or from claude's own queue. Only its sender may. */
export async function withdraw(hub: Hub, caller: Caller, id: string): Promise<Steer> {
  const got = steers.get(hub.db, id);
  if (!got || !allows(caller, "read", got.steer.thread.machineId)) throw notFound(`steer ${id}`);
  let steer = got.steer;
  if (got.by !== `key:${caller.keyId}`) throw new ToolError("forbidden", `${id} was sent from another device; only its sender can withdraw it.`);
  const taken = (s: Steer) =>
    invalid(
      `${id} was already delivered${s.deliveredAt === undefined ? "" : ` at ${s.deliveredAt.slice(11, 19)}`}.`,
      "Once delivered it cannot be unsaid; send another steer saying what changed.",
    );
  if (steer.stage === "withdrawn") return steer;
  if (steer.stage === "failed" || steer.stage === "expired") throw invalid(`${id} never reached the agent; there is nothing to withdraw.`);
  if (steer.stage !== "queued") throw taken(steer);
  // Held for a task's next run: take its text back out of the task's pending message.
  const held = steers.heldMessage(hub.db, id);
  if (held !== undefined && "taskId" in steer.target) {
    if (!(await steerTasks(hub).takeBack(steer.target.taskId, held))) throw taken(steer);
    steers.unhold(hub.db, id);
    steer = { ...steer, stage: "withdrawn" };
    delete steer.detail;
    delete steer.held;
    steers.put(hub.db, steer);
    emit(hub, steer, "steer.withdrawn");
    return steer;
  }
  let dropped = writeQueue(hub).withdrawSteer(id);
  if (!dropped) {
    try {
      dropped = await withdrawRun(hub, steer.thread, steer.runId);
    } catch (error) {
      throw new ToolError("failed", (error as Error).message);
    }
  }
  if (!dropped) throw taken(steers.get(hub.db, id)?.steer ?? steer);
  const now = steers.get(hub.db, id)?.steer;
  if (now?.stage === "withdrawn") return now;
  steer = { ...steer, stage: "withdrawn" };
  steers.put(hub.db, steer);
  emit(hub, steer, "steer.withdrawn");
  return steer;
}

/**
 * Closes steers whose receipt can no longer come: their thread stopped running at least RECEIPT_GRACE ago without
 * one. A steer still in the hub's offline queue is left to the queue's own expiry. Returns how many it closed.
 */
export function sweep(hub: Hub): number {
  const now = nowMs(hub.clock);
  let closed = 0;
  let list: { steer: Steer; at: number }[];
  try {
    list = steers.open(hub.db);
  } catch {
    return 0;
  }
  for (const { steer, at } of list) {
    if (now - at < RECEIPT_GRACE_MS || writeQueue(hub).hasSteer(steer.id)) continue;
    const status = store(hub).threadGet(steer.thread)?.thread.status;
    if (status === "running" || status === "waiting") continue;
    const m = steer.thread.machineId;
    const [stage, why]: [SteerStage, string] =
      steer.stage === "delivered"
        ? ["unacknowledged", `no reply came back from ${m}: its node restarted, or is older than this hub`]
        : ["failed", `${m}'s node lost it before the agent took it in: it restarted, or is older than this hub`];
    const done: Steer = { ...steer, stage, detail: why };
    try {
      steers.put(hub.db, done);
      emit(hub, done, eventType(stage));
      closed += 1;
    } catch {
      // Tried again on the next sweep.
    }
  }
  return closed;
}

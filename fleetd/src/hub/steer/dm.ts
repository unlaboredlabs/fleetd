// Agent messages: one agent's words to one to five others of its project
// (`agent_message`). Each recipient's delivery is a steer by the sender, with its receipts; the message and where it
// stands for each recipient are kept here whole, for the person to read and audit (`agent_messages`), and every change
// is an `agent.messaged` or `agent.message_updated` event on the project.
import type { AgentMessage, AgentMessageOutcome, AgentMessageRecipient, HubEventType, ProjectRef, Steer, Task } from "../../shared/contracts.ts";
import { ToolError } from "../../shared/errors.ts";
import type { Hub } from "../api/hub.ts";
import { jsTake } from "../chat/index.ts";
import { renderEvent } from "../leads/events.ts";
import { leadWakes } from "../leads/seams.ts";
import type { HubDb } from "../store/db.ts";
import { events } from "../store/events.ts";
import { isoMs, nowMs, parseMs } from "../store/time.ts";
import { TaskRecords } from "../tasks/records.ts";

/** The most recipients one agent's messages reach in a minute: room for any real exchange, a stop for a loop. */
export const PER_MINUTE = 20;

type Send = (from: Task, message: string, taskId: string, text: string, crid: string) => Promise<Steer>;
type AskedAt = (taskId: string) => number | undefined;

const messageN = (id: string) => (/^M[0-9]+$/.test(id) ? Number(id.slice(1)) : undefined);
const hhmm = (ms: number) => isoMs(ms).slice(11, 16);
const sameRef = (a: ProjectRef, b: ProjectRef) => a.machineId === b.machineId && a.projectId === b.projectId;

function oneLine(text: string, max: number): string {
  const flat = text.split(/\s+/u).filter(Boolean).join(" ");
  return [...flat].length > max ? `${jsTake(flat, max - 1)}…` : flat;
}

/** Sends `text` from `from` to each of `to` (repeats dropped), and keeps it. A recipient that can't take it is
 * `refused` in the answer, not an error: the others still get it. */
export async function sendMessage(hub: Hub, deliver: Send, askedAt: AskedAt, from: Task, to: string[], text: string) {
  const ids = [...new Set(to)];
  const now = nowMs(hub.clock);
  const c = hub.db.conn;
  const sent =
    c
      .query<{ n: number }, [string, number]>(
        `SELECT COUNT(*) AS n FROM agent_message_to t JOIN agent_messages m ON m.n = t.message_n
         WHERE m.from_task = ? AND m.sent_ms > ?`,
      )
      .get(from.taskId, now - 60_000)?.n ?? 0;
  if (sent + ids.length > PER_MINUTE) {
    throw new ToolError(
      "forbidden",
      `${from.taskId}'s messages reached ${sent} agents in the last minute; ${PER_MINUTE} is the most.`,
      "Put what is left in one message a minute from now. If agents are going back and forth, ask your lead with ask_lead instead.",
    );
  }
  const r = from.projectRef;
  const n = Number(
    c
      .query(`INSERT INTO agent_messages (machine_id, project_id, from_task, from_title, text, sent_ms) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(r.machineId, r.projectId, from.taskId, from.title, text, now).lastInsertRowid,
  );
  const id = `M${n}`;
  const recipients: AgentMessageRecipient[] = [];
  for (const [pos, taskId] of ids.entries()) {
    const found = TaskRecords.get(c, taskId)?.task;
    const before = found && sameRef(found.projectRef, r) ? found : undefined;
    const asked = askedAt(taskId);
    let outcome: AgentMessageOutcome;
    let steerN: number | undefined;
    let detail: string | undefined;
    let at: number | undefined = now;
    try {
      const steer = await deliver(from, id, taskId, text, `${id}:${taskId}`);
      steerN = Number(steer.id.slice(1));
      if (steer.held === true) {
        outcome = before?.state === "queued" ? "held" : "not_woken";
        detail = steer.detail;
      } else if (before !== undefined && before.state !== "running") {
        outcome = "woke";
        detail = asked === undefined ? `it answers what ${taskId} asked` : `it answers what ${taskId} asked at ${hhmm(asked)}`;
      } else {
        outcome = "delivered";
        at = undefined;
      }
    } catch (error) {
      outcome = "refused";
      detail = (error as Error).message;
    }
    c.query(
      `INSERT INTO agent_message_to (message_n, pos, task_id, title, steer_n, outcome, at_ms, detail) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(n, pos, taskId, before?.title ?? null, steerN ?? null, outcome, at ?? null, detail ?? null);
    recipients.push({
      taskId,
      ...(before !== undefined ? { title: before.title } : {}),
      outcome,
      ...(at !== undefined ? { at: isoMs(at) } : {}),
      ...(detail !== undefined ? { detail } : {}),
    });
  }
  emit(hub, "agent.messaged", r, id, from.taskId, recipients, text);
  tellLead(hub, r, id, from.taskId, recipients, text);
  return { messageId: id, to: recipients, next: next(id, recipients) };
}

/** What the sender is told: where it stands for each recipient, and what to do when that isn't enough. */
function next(id: string, to: AgentMessageRecipient[]): string {
  const lines = to.map((r) => {
    const t = r.taskId;
    switch (r.outcome) {
      case "delivered":
        return `${t} takes it at its next tool boundary.`;
      case "held":
        return `${t} hasn't started yet, and gets it when it does.`;
      case "woke":
        return `${t} was waiting for an answer, and this continues it.`;
      case "not_woken":
        return `${t} has finished, and an agent can't restart a finished agent: it gets this only if a Monitor or wait_ci of its own wakes it, or its lead continues it. If you need ${t} now, ask your lead with ask_lead.`;
      default:
        return `${t} didn't get it: ${r.detail ?? "refused"}`;
    }
  });
  return `${id} sent. ${lines.join(" ")} Replies, if any, arrive as messages: carry on.`;
}

/** The lead's quiet copy, with its next wake. */
function tellLead(hub: Hub, r: ProjectRef, id: string, from: string, to: AgentMessageRecipient[], text: string): void {
  const names = to.map((t) => (t.outcome === "delivered" || t.outcome === "woke" ? t.taskId : `${t.taskId} (${t.outcome.replace("_", " ")})`));
  const line = renderEvent({ kind: "agent_messaged", from, to: names.join(", "), message: id, text });
  leadWakes(hub).trigger(r, { kind: "line", line: "quiet", text: line });
}

function emit(hub: Hub, type: HubEventType, r: ProjectRef, id: string, from: string, to: AgentMessageRecipient[], text: string): void {
  const data = {
    messageId: id,
    from,
    to: to.map((t) => ({ taskId: t.taskId, outcome: t.outcome, ...(t.detail !== undefined ? { detail: t.detail } : {}) })),
    text: jsTake(text, 120),
  };
  const summary = `${id} from ${from} to ${to.map((t) => t.taskId).join(", ")}: '${oneLine(text, 120)}'`;
  try {
    events(hub).append({ at: isoMs(nowMs(hub.clock)), type, machineId: r.machineId, projectId: r.projectId, summary: jsTake(summary, 200), data });
  } catch (error) {
    console.error("agent message event append failed:", error);
  }
}

/** A recipient's steer moved: taken in, it is delivered (a woken one stays woke); one that failed or expired was never
 * sent. A change is an `agent.message_updated` with every recipient as it stands. */
export function onSteer(hub: Hub, steer: Steer): void {
  const steerN = Number(steer.id.slice(1));
  const c = hub.db.conn;
  const row = c
    .query<{ message_n: number; pos: number; outcome: string; at_ms: number | null }, [number]>(
      "SELECT message_n, pos, outcome, at_ms FROM agent_message_to WHERE steer_n = ?",
    )
    .get(steerN);
  if (!row) return;
  const now = nowMs(hub.clock);
  let outcome: AgentMessageOutcome;
  let detail: string | null = null;
  let at: number;
  switch (steer.stage) {
    case "delivered":
    case "acknowledged":
    case "unacknowledged":
      if (row.outcome === "woke" || (row.outcome === "delivered" && row.at_ms !== null)) return;
      outcome = "delivered";
      at = (steer.deliveredAt !== undefined ? parseMs(steer.deliveredAt) : undefined) ?? now;
      break;
    case "failed":
    case "expired":
    case "withdrawn":
      if (row.outcome === "refused") return;
      outcome = "refused";
      detail = steer.detail ?? steer.stage;
      at = now;
      break;
    default:
      return;
  }
  try {
    c.query("UPDATE agent_message_to SET outcome = ?, at_ms = ?, detail = ? WHERE message_n = ? AND pos = ?").run(outcome, at, detail, row.message_n, row.pos);
  } catch (error) {
    return void console.error("agent message outcome not stored:", error);
  }
  const got = get(hub.db, row.message_n);
  if (got) emit(hub, "agent.message_updated", got.projectRef, got.message.id, got.message.from.taskId, got.message.to, got.message.text);
}

/** The project's agent messages (only those `taskId` sent or got, with one) older than `before`, newest first. */
export function list(db: HubDb, r: ProjectRef, taskId: string | undefined, before: string | undefined, limit: number) {
  const c = db.conn;
  const filter = `machine_id = ?1 AND project_id = ?2 AND (?3 IS NULL OR from_task = ?3
    OR n IN (SELECT message_n FROM agent_message_to WHERE task_id = ?3))`;
  const total = c.query<{ n: number }, [string, string, string | null]>(`SELECT COUNT(*) AS n FROM agent_messages WHERE ${filter}`).get(r.machineId, r.projectId, taskId ?? null)?.n ?? 0;
  const ns = c
    .query<{ n: number }, [string, string, string | null, number | null, number]>(
      `SELECT n FROM agent_messages WHERE ${filter} AND (?4 IS NULL OR n < ?4) ORDER BY n DESC LIMIT ?5`,
    )
    .all(r.machineId, r.projectId, taskId ?? null, before === undefined ? null : (messageN(before) ?? null), limit + 1)
    .map((row) => row.n);
  const more = ns.length > limit;
  const messages = ns.slice(0, limit).flatMap((n) => {
    const got = get(db, n);
    return got ? [got.message] : [];
  });
  return { messages, more, total };
}

/** One agent message, with its project. */
export function get(db: HubDb, n: number): { projectRef: ProjectRef; message: AgentMessage } | undefined {
  const c = db.conn;
  const head = c
    .query<{ machine_id: string; project_id: string; from_task: string; from_title: string; text: string; sent_ms: number }, [number]>(
      "SELECT machine_id, project_id, from_task, from_title, text, sent_ms FROM agent_messages WHERE n = ?",
    )
    .get(n);
  if (!head) return undefined;
  const to = c
    .query<{ task_id: string; title: string | null; outcome: string; at_ms: number | null; detail: string | null }, [number]>(
      "SELECT task_id, title, outcome, at_ms, detail FROM agent_message_to WHERE message_n = ? ORDER BY pos",
    )
    .all(n)
    .map(
      (row): AgentMessageRecipient => ({
        taskId: row.task_id,
        ...(row.title !== null ? { title: row.title } : {}),
        outcome: row.outcome as AgentMessageOutcome,
        ...(row.at_ms !== null ? { at: isoMs(row.at_ms) } : {}),
        ...(row.detail !== null ? { detail: row.detail } : {}),
      }),
    );
  return {
    projectRef: { machineId: head.machine_id, projectId: head.project_id },
    message: { id: `M${n}`, from: { taskId: head.from_task, title: head.from_title }, text: head.text, sentAt: isoMs(head.sent_ms), to },
  };
}

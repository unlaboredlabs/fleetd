// A project's factory bridge: a project's lead texts another project's lead (`project_message`), reads the factory in
// one call (`factory_status`), and is woken when what it asked for changes. Each message is an ask `N<n>`. The other
// lead may answer it with the same call (`reply: "N<n>"`), which wakes the first; both chats show each text as a quiet
// line, and a pair of leads trades at most PAIR_PER_HOUR texts an hour. The lead that opens an order for one passes
// `asked: "N<n>"` to `brief`, and from then on `step` follows the order in the event log and wakes the asking lead
// with one line.
//
// The checklist and the chat's `sendAsAgent` come from their modules. The status rows (`statusRows`) are set on `found`
// by their area; a call that needs them not set yet says so.
import type { Database } from "bun:sqlite";
import type { HubEvent, LeadText, ProjectRef, ProjectSummary, TodoItem } from "../../shared/contracts.ts";
import { NotImplemented, ToolError } from "../../shared/errors.ts";
import type { Hub } from "../api/hub.ts";
import { leadWakes } from "../api/leads.ts";
import { noteSent, sendAsAgent } from "../chat/index.ts";
import { read as readChecklist } from "../checklist/index.ts";
import { workstreamGet, workstreamsList } from "../orders/workstreams.ts";
import { events } from "../store/events.ts";
import { store } from "../store/hub_store.ts";
import { isoMs } from "../store/time.ts";
import { HOUR_MS, PAIR_PER_HOUR, RETRY_MS } from "./asks.ts";

export { leadFooter, PAIR_PER_HOUR, RETRY_MS } from "./asks.ts";

export const OPS = ["project_message", "factory_status"] as const;
/** `project_message` as a project's session asks for it. */
export const TOOL = "mcp__fleetd__project_message";
/** The event log cursor `run` keeps in `time_cursors`. */
const CURSOR = "project.bridge";
/** Asks per project `factory_status` lists, newest first. */
const ASKS_SHOWN = 5;
const TYPES = ["workstream.created", "workstream.done", "workstream.state", "change.state"];

export type ProjectMessageCall = { project: string; text: string; reply?: string };
export type ProjectMessageResult = {
  handle: string;
  projectRef: ProjectRef;
  title: string;
  leadWaiting?: string;
  next?: string;
};
export type FactoryStatusCall = { project?: string };
export type FactoryOrder = { workstreamId: string; title: string; headline?: string; asked?: string };
export type FactoryAsk = { handle: string; text: string; at: string; orders: string[] };
export type FactoryProject = {
  projectRef: ProjectRef;
  title: string;
  state: string;
  blockedReason?: string;
  warning?: string;
  agentsRunning: number;
  openOrders: FactoryOrder[];
  checklist: TodoItem[];
  lastMerged?: unknown;
  merged7d?: number;
  asks: FactoryAsk[];
};
export type FactoryStatusResult = { projects: FactoryProject[]; next?: string };

/** One status row (status/rows.rs), as `statusRows` gives it. */
type StatusRow = {
  projectRef: ProjectRef;
  title: string;
  state: string;
  blockedReason?: string;
  warning?: string;
  agentsRunning: number;
  lastMerged?: unknown;
  merged7d?: number;
};

type Found = {
  sendAsAgent?: (hub: Hub, to: ProjectRef, by: string, body: string, requestId: string, lead?: LeadText) => Promise<{ leadWaiting?: string | boolean }>;
  noteSent?: (hub: Hub, r: ProjectRef, by: string, text: string, request: string, lead: LeadText) => Promise<unknown>;
  statusRows?: (hub: Hub, nowMs: number) => StatusRow[];
};
/**
 * The other areas' parts the bridge calls, set by those areas (the status `statusRows`). One not set yet makes the call
 * that needs it say so. A test may set `sendAsAgent` and `noteSent` in place of the chat's.
 */
export const found: Found = {};

const refOf = (p: { machineId: string; projectId: string }): ProjectRef => ({ machineId: p.machineId, projectId: p.projectId });
const same = (a: ProjectRef, b: ProjectRef) => a.machineId === b.machineId && a.projectId === b.projectId;

/** `status::rows::clip`: one line, cut to `max` UTF-16 units with "…". */
export function clip(s: string, max: number): string {
  const line = s.replace(/[\r\n]/g, " ");
  if (line.length <= max) return line;
  let out = "";
  for (const c of line) {
    if (out.length + c.length + 1 > max) break;
    out += c;
  }
  return `${out}…`;
}

/** Whether the hub has project `r`; an archived one only with `archived`. */
export function isProject(db: Database, r: ProjectRef, archived: boolean): boolean {
  return (
    db
      .query(
        `SELECT 1 FROM projects p WHERE p.machine_id = ?1 AND p.project_id = ?2 AND (?3 OR NOT EXISTS (
               SELECT 1 FROM project_settings s WHERE s.machine_id = ?1 AND s.project_id = ?2
                 AND s.archived_ms IS NOT NULL))`,
      )
      .get(r.machineId, r.projectId, archived ? 1 : 0) !== null
  );
}

/** Every project's lead works with other projects (D310), but an archived one's. */
export function mayUse(db: Database, r: ProjectRef): void {
  if (isProject(db, r, false)) return;
  throw new ToolError(
    "forbidden",
    "This bot is archived, or the hub doesn't have it: its lead works with no other bot.",
    "Bring it back from the app first.",
  );
}

/** The project `name` names, by project id or title, other than the caller's own. */
function target(hub: Hub, from: ProjectRef, name: string): ProjectSummary {
  const all = store(hub).projectsShown();
  const byId = all.filter((p) => p.projectId === name);
  const found = byId.length > 0 ? byId : all.filter((p) => p.title.trim().toLowerCase() === name.trim().toLowerCase());
  if (found.length === 0) {
    throw new ToolError("not_found", `No bot ${name} on this hub.`, "Call factory_status to see the bots, and name one by its title.");
  }
  if (found.length > 1) throw new ToolError("invalid", `${found.length} bots are called ${name}.`, "Name it by its bot id, from factory_status.");
  const p = found[0] as ProjectSummary;
  if (same(from, refOf(p))) {
    throw new ToolError("invalid", "That is this lead's own bot.", "project_message writes to another bot's lead; say it in your own reply.");
  }
  return p;
}

/** The agent name a lead writes under in another project's chat: its project's title. */
export const author = (hub: Hub, r: ProjectRef) => store(hub).projectGet(r)?.title ?? r.projectId;

/** One ask, as the bridge keeps it. */
export type Ask = {
  handle: string;
  from: ProjectRef;
  to: ProjectRef;
  text: string;
  atMs: number;
  orders: string[];
};

const ASK_COLUMNS = "n, from_machine_id, from_project_id, to_machine_id, to_project_id, text, at_ms";
type AskRow = {
  n: number;
  from_machine_id: string;
  from_project_id: string;
  to_machine_id: string;
  to_project_id: string;
  text: string;
  at_ms: number;
};

function askRow(c: Database, row: AskRow): Ask {
  const orders = c
    .query<{ workstream_id: string }, [number]>("SELECT workstream_id FROM project_ask_orders WHERE n = ? ORDER BY rowid")
    .all(row.n)
    .map((r) => r.workstream_id);
  return {
    handle: `N${row.n}`,
    from: { machineId: row.from_machine_id, projectId: row.from_project_id },
    to: { machineId: row.to_machine_id, projectId: row.to_project_id },
    text: row.text,
    atMs: row.at_ms,
    orders,
  };
}

/** A project's asks of other projects, newest first. */
export function asksFrom(c: Database, from: ProjectRef): Ask[] {
  return c
    .query<AskRow, [string, string]>(
      `SELECT ${ASK_COLUMNS} FROM project_asks WHERE from_machine_id = ? AND from_project_id = ? ORDER BY n DESC LIMIT 200`,
    )
    .all(from.machineId, from.projectId)
    .map((row) => askRow(c, row));
}

function askByHandle(c: Database, handle: string): Ask | undefined {
  const m = /^N(\d+)$/.exec(handle);
  if (!m) return undefined;
  const row = c.query<AskRow, [number]>(`SELECT ${ASK_COLUMNS} FROM project_asks WHERE n = ?`).get(Number(m[1]));
  return row ? askRow(c, row) : undefined;
}

/** The ask an order was opened for: its first, when its lead folded others in later. */
function askOf(c: Database, workstreamId: string): Ask | undefined {
  const n = c.query<{ n: number }, [string]>("SELECT n FROM project_ask_orders WHERE workstream_id = ? ORDER BY rowid LIMIT 1").get(workstreamId)?.n;
  return n === undefined ? undefined : askByHandle(c, `N${n}`);
}

export const projectTitle = (hub: Hub, r: ProjectRef) => store(hub).projectGet(r)?.title ?? r.projectId;

/** The text `reply` answers: one `to`'s lead sent this lead's project on this hub. Its handle. */
function answering(hub: Hub, from: ProjectRef, to: ProjectSummary, reply: string): string {
  const fix = "reply takes the handle at the end of the text it answers; without reply, the message starts a new exchange.";
  const a = askByHandle(hub.db.conn, reply);
  if (!a || !same(a.to, from)) {
    throw new ToolError("not_found", `${reply} is not a text this bot's lead got from another bot here.`, fix);
  }
  if (!same(a.from, refOf(to))) {
    const from = projectTitle(hub, a.from);
    throw new ToolError("invalid", `${reply} came from ${from}, not ${to.title}.`, `Answer it with project "${from}".`);
  }
  return a.handle;
}

/** Refuses a new text once two bots' leads traded PAIR_PER_HOUR in the last hour, both ways together. */
function capped(hub: Hub, a: ProjectRef, b: ProjectRef, title: string, now: number): void {
  const at = hub.db.conn
    .query<{ at_ms: number }, [string, string, string, string, number, number]>(
      `SELECT at_ms FROM project_asks WHERE at_ms > ?5
         AND ((from_machine_id = ?1 AND from_project_id = ?2 AND to_machine_id = ?3 AND to_project_id = ?4)
           OR (from_machine_id = ?3 AND from_project_id = ?4 AND to_machine_id = ?1 AND to_project_id = ?2))
         ORDER BY at_ms LIMIT ?6`,
    )
    .all(a.machineId, a.projectId, b.machineId, b.projectId, now - HOUR_MS, PAIR_PER_HOUR)
    .map((r) => r.at_ms);
  if (at.length < PAIR_PER_HOUR) return;
  const again = isoMs((at[0] as number) + HOUR_MS).slice(11, 16);
  throw new ToolError(
    "invalid",
    `This bot's lead and ${title}'s have texted each other ${PAIR_PER_HOUR} times in the last hour, the most fleetd allows.`,
    `Write again after ${again} UTC, all in one message, or end your turn. What needs the person goes in your own chat.`,
  );
}

/**
 * The text a lead's call repeats, if it is a retry: the newest text between the two bots either way, from this lead,
 * within RETRY_MS, with the same words and answering the same text (`reply`'s n, or none).
 */
function retried(c: Database, from: ProjectRef, to: ProjectRef, text: string, reply: number | null, now: number): number | undefined {
  const last = c
    .query<{ n: number; from_machine_id: string; from_project_id: string; text: string; at_ms: number; reply: number | null }, [string, string, string, string]>(
      `SELECT n, from_machine_id, from_project_id, text, at_ms, reply FROM project_asks
         WHERE (from_machine_id = ?1 AND from_project_id = ?2 AND to_machine_id = ?3 AND to_project_id = ?4)
            OR (from_machine_id = ?3 AND from_project_id = ?4 AND to_machine_id = ?1 AND to_project_id = ?2)
         ORDER BY n DESC LIMIT 1`,
    )
    .get(from.machineId, from.projectId, to.machineId, to.projectId);
  const sentBy = last !== null && last.from_machine_id === from.machineId && last.from_project_id === from.projectId;
  return sentBy && last.text === text && last.at_ms >= now - RETRY_MS && last.reply === reply ? last.n : undefined;
}

export async function projectMessage(hub: Hub, from: ProjectRef, call: ProjectMessageCall): Promise<ProjectMessageResult> {
  const to = target(hub, from, call.project);
  const toRef = refOf(to);
  const replied = call.reply !== undefined ? answering(hub, from, to, call.reply) : undefined;
  const text = call.text;
  const now = hub.clock.now();
  const c = hub.db.conn;
  const answers = replied === undefined ? null : Number(replied.slice(1));
  // A retry, the same words to the same project within RETRY_MS, is the first ask: its message isn't posted again. A
  // lead's text is one only while nothing went between the two bots since, and answering the same text.
  const first = retried(c, from, toRef, text, answers, now);
  if (first === undefined) capped(hub, from, toRef, to.title, now);
  const n =
    first ??
    (c
      .query<{ n: number }, [string, string, string, string, string, number, number | null]>(
        `INSERT INTO project_asks (from_machine_id, from_project_id, to_machine_id, to_project_id, text, at_ms, reply)
           VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING n`,
      )
      .get(from.machineId, from.projectId, toRef.machineId, toRef.projectId, text, now, answers)?.n as number);
  const handle = `N${n}`;
  // One lead's text to another: the other lead reads its handle and how to answer it; the person reads the words in
  // both chats, as quiet lines, and the sender's copy goes to no lead.
  const by = author(hub, from);
  const lead: LeadText = { handle, ...(replied !== undefined ? { reply: replied } : {}) };
  const sent = await (found.sendAsAgent ?? sendAsAgent)(hub, toRef, by, text, `ask:${handle}`, lead);
  await (found.noteSent ?? noteSent)(hub, from, by, text, `sent:${handle}`, { ...lead, to: to.title });
  const waiting = typeof sent.leadWaiting === "string" ? sent.leadWaiting : undefined;
  return {
    handle,
    projectRef: toRef,
    title: to.title,
    ...(waiting !== undefined ? { leadWaiting: waiting } : {}),
    next: `Sent to ${to.title}'s lead, and shown in both chats. It reads it as input, never as the person's word. Its reply, if the work needs one, wakes you with its own handle; an order it opens for ${handle} wakes you as it opens, closes, merges or fails. End your turn instead of waiting.`,
  };
}

export function factoryStatus(hub: Hub, from: ProjectRef, call: FactoryStatusCall): FactoryStatusResult {
  const only = call.project !== undefined ? refOf(target(hub, from, call.project)) : undefined;
  if (!found.statusRows) throw new NotImplemented("src/hub/status (statusRows, for factory_status)");
  const rows = found.statusRows(hub, hub.clock.now());
  const asks = asksFrom(hub.db.conn, from);
  const projects: FactoryProject[] = [];
  for (const row of rows) {
    const r = row.projectRef;
    if (same(from, r) || (only && !same(only, r))) continue;
    const orders = workstreamsList(hub.db.conn, { projectRef: r, state: "open", limit: 20 });
    const checklist = readChecklist(hub.db, r).items;
    const toIt = asks.filter((a) => same(a.to, r));
    const askedFor = (w: string) => toIt.find((a) => a.orders.includes(w))?.handle;
    projects.push({
      projectRef: r,
      title: row.title,
      state: row.state,
      ...(row.blockedReason !== undefined ? { blockedReason: row.blockedReason } : {}),
      ...(row.warning !== undefined ? { warning: row.warning } : {}),
      agentsRunning: row.agentsRunning,
      openOrders: orders.map((w) => {
        const asked = askedFor(w.workstreamId);
        return {
          workstreamId: w.workstreamId,
          title: w.title,
          ...(w.headline ? { headline: w.headline } : {}),
          ...(asked !== undefined ? { asked } : {}),
        };
      }),
      checklist: checklist.filter((i) => i.state !== "done"),
      ...(row.lastMerged !== undefined ? { lastMerged: row.lastMerged } : {}),
      ...(row.merged7d !== undefined ? { merged7d: row.merged7d } : {}),
      asks: toIt.slice(0, ASKS_SHOWN).map((a) => ({
        handle: a.handle,
        text: clip(a.text.split(/\r?\n/)[0] ?? "", 120),
        at: new Date(a.atMs).toISOString(),
        orders: a.orders,
      })),
    });
  }
  const next =
    projects.length === 0
      ? "No other bot on this hub yet."
      : only
        ? "Write to its lead with project_message; what it needs the person for is in its own chat."
        : "factory_status with project reads one. Write to a bot's lead with project_message.";
  return { projects, next };
}

/** The ask an event is about, and what happened to it, for an event about an order one asked for. */
function news(hub: Hub, e: HubEvent): [Ask, string] | undefined {
  const data = (e.data ?? {}) as Record<string, unknown>;
  const w = typeof data.workstreamId === "string" ? data.workstreamId : undefined;
  if (w === undefined) return undefined;
  const c = hub.db.conn;
  const title = () => {
    const ws = workstreamGet(c, w);
    return ws ? ` "${clip(ws.title, 80)}"` : "";
  };
  const reason = () => (typeof data.reason === "string" ? `: ${clip(data.reason, 160)}` : "");
  // An order opened for an ask, or one its lead folded the ask into later.
  const folded = e.type === "workstream.state" && typeof data.asked === "string";
  if (e.type === "workstream.created" || folded) {
    if (typeof data.asked !== "string") return undefined;
    // Only the project asked can open an order for the ask, and only for one asked here.
    const asked = askByHandle(c, data.asked);
    if (!asked || asked.to.machineId !== e.machineId || asked.to.projectId !== e.projectId) return undefined;
    c.query("INSERT OR IGNORE INTO project_ask_orders (workstream_id, n) VALUES (?, ?)").run(w, asked.handle.slice(1));
    return [asked, folded ? `its lead folded it into order ${w}${title()}` : `its lead opened order ${w}${title()}`];
  }
  const asked = askOf(c, w);
  if (!asked) return undefined;
  if (e.type === "workstream.done") return [asked, `order ${w}${title()} is done${reason()}`];
  if (e.type === "workstream.state" && data.state === "stopped") return [asked, `order ${w}${title()} was stopped${reason()}`];
  if (e.type === "change.state") {
    if (typeof data.prNumber !== "number" || typeof data.repo !== "string") return undefined;
    const how = { merged: "merged", ci_failed: "failed CI", refused: "was refused by the train", abandoned: "was given up by the train" }[
      String(data.to)
    ];
    if (how === undefined) return undefined;
    return [asked, `PR #${data.prNumber} (${data.repo}) of order ${w}${title()} ${how}`];
  }
  return undefined;
}

const cursorGet = (c: Database) =>
  c.query<{ value: number }, [string]>("SELECT value FROM time_cursors WHERE source = ?1").get(CURSOR)?.value;
const cursorSet = (c: Database, value: number) =>
  c
    .query(
      `INSERT INTO time_cursors (source, value) VALUES (?1, ?2)
         ON CONFLICT(source) DO UPDATE SET value = MAX(value, excluded.value)`,
    )
    .run(CURSOR, value);

/** Follows one page after `cursor`: the cursor to resume from, whether more pages are ready, the wakes it sent. */
export function step(hub: Hub, cursor: number): { cursor: number; more: boolean; woken: [ProjectRef, string][] } {
  const page = events(hub).page(cursor, TYPES);
  const woken: [ProjectRef, string][] = [];
  for (const e of page.events) {
    const found = news(hub, e);
    if (!found) continue;
    const [asked, what] = found;
    const line = `- ${asked.handle} to ${projectTitle(hub, asked.to)}: ${what}`;
    leadWakes(hub).trigger(asked.from, { kind: "line", line: "factory", text: line });
    woken.push([asked.from, line]);
  }
  if (page.cursor !== cursor) cursorSet(hub.db.conn, page.cursor);
  return { cursor: page.cursor, more: page.more, woken };
}

/** Follows the event log for what projects asked for, from where it left off, until the hub stops. */
export async function run(hub: Hub): Promise<void> {
  // A first start begins at the head: nothing was asked before the bridge existed.
  let cursor = cursorGet(hub.db.conn) ?? events(hub).head();
  const signal = hub.shutdown.signal;
  while (!signal.aborted) {
    try {
      const page = step(hub, cursor);
      cursor = page.cursor;
      if (page.more) continue;
      await events(hub).wait({ cursor, types: TYPES, timeoutSec: 3600 }, signal);
    } catch (error) {
      console.error("ask bridge: events not followed:", error);
      await new Promise<void>((resolve) => {
        const timer = setTimeout(done, 5000);
        function done() {
          clearTimeout(timer);
          signal.removeEventListener("abort", done);
          resolve();
        }
        signal.addEventListener("abort", done, { once: true });
      });
    }
  }
}

/** The lead-side calls: a project's lead's `project_message` and `factory_status`. */
export async function answer(hub: Hub, project: ProjectRef, call: { op: string } & Record<string, unknown>): Promise<unknown> {
  mayUse(hub.db.conn, project);
  if (call.op === "project_message") return projectMessage(hub, project, call as unknown as ProjectMessageCall);
  if (call.op === "factory_status") return factoryStatus(hub, project, call as unknown as FactoryStatusCall);
  throw new ToolError("invalid", `${call.op} is not a factory bridge call.`);
}

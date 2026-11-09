// A Navi's factory bridge: a project's lead writes to another project's lead
// (`project_message`), reads the factory in one call (`factory_status`), and is woken when what it asked for changes.
// Each message is an ask `N<n>`; the lead that opens an order for it passes `asked: "N<n>"` to `brief`, and from then
// on `step` follows the order in the event log and wakes the asking lead with one line.
//
// A hub link is the bridge's other asker: a Navi on another hub, acting as the person who minted the link here. Its
// asks go into chats as "<person> via <label>", reach only the link's projects, and what happens to them goes out on
// the link's feed (`feed`) instead of a wake. A call that names a linked hub goes there (hub_links/client.ts).
//
// The checklist and the chat's `sendAsAgent` come from their modules. The status rows (`statusRows`) and the hub-link
// client's `ask`, `status` and `linked` are set on `found` by their areas once they are ported; a call that needs one
// not set yet says so.
import type { Database } from "bun:sqlite";
import type { Grant, HubEvent, PersonRef, ProjectRef, ProjectSummary, Role, TodoItem } from "../../shared/contracts.ts";
import { NotImplemented, ToolError } from "../../shared/errors.ts";
import type { Hub } from "../api/hub.ts";
import { leadWakes } from "../api/leads.ts";
import { sendAsAgent } from "../chat/index.ts";
import { read as readChecklist } from "../checklist/index.ts";
import { workstreamGet, workstreamsList } from "../orders/workstreams.ts";
import { events } from "../store/events.ts";
import { store } from "../store/hub_store.ts";
import * as navis from "./store.ts";
import { othersOf, type Refs } from "./owner.ts";

export const OPS = ["project_message", "factory_status"] as const;
/** `project_message` as a Navi's session asks for it. */
export const TOOL = "mcp__fleetd__project_message";
/** The event log cursor `run` keeps in `time_cursors`. */
const CURSOR = "navi.bridge";
/** How long the same words to the same project count as a retry of the first ask, not a new one. */
const RETRY_MS = 10 * 60 * 1000;
/** Asks per project `factory_status` lists, newest first. */
const ASKS_SHOWN = 5;
const TYPES = ["workstream.created", "workstream.done", "workstream.state", "change.state"];

/** A link minted here, as the hub-links area hands it over: Rust's `Issued`, as data. */
export type Issued = { linkId: string; label: string; projects?: ProjectRef[]; person?: PersonRef; grants: Grant[]; who: string };

/** Who asks: a project's lead on this hub, or a link minted here, for a Navi on another hub. */
export type Asker = { kind: "navi"; navi: ProjectRef } | { kind: "link"; link: Issued };

const RANK: Record<Role, number> = { read: 0, operate: 1, admin: 2 };
/** The link holds `role` on the machine. */
export const linkAllows = (link: Issued, role: Role, machineId: string) =>
  link.grants.some((g) => RANK[g.role] >= RANK[role] && (g.machines === "*" || g.machines.includes(machineId)));
/** The project is within the link's limits. */
export const linkLimits = (link: Issued, p: ProjectRef) =>
  link.projects === undefined || link.projects.some((o) => o.machineId === p.machineId && o.projectId === p.projectId);
/** Who a link's asks are from, in the chats here. */
export const linkAuthor = (link: Issued) => `${link.who} via ${link.label}`;

export type ProjectMessageCall = { project: string; text: string; hub?: string };
export type ProjectMessageResult = {
  handle: string;
  projectRef: ProjectRef;
  title: string;
  leadWaiting?: string;
  hub?: string;
  next?: string;
};
export type FactoryStatusCall = { project?: string; hub?: string };
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
export type FactoryStatusResult = { projects: FactoryProject[]; hubs?: unknown[]; next?: string };
export type LinkFeedItem = { handle: string; title: string; what: string };

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
  sendAsAgent?: (hub: Hub, to: ProjectRef, by: string, body: string, requestId: string) => Promise<{ leadWaiting?: string | boolean }>;
  statusRows?: (hub: Hub, nowMs: number) => StatusRow[];
  ask?: (hub: Hub, navi: ProjectRef, label: string, call: ProjectMessageCall) => Promise<ProjectMessageResult>;
  status?: (hub: Hub, navi: ProjectRef, label: string, call: FactoryStatusCall) => Promise<FactoryStatusResult>;
  linked?: (hub: Hub, navi: ProjectRef) => unknown[];
};
/**
 * The other areas' parts the bridge calls that have no module on main yet, set by those areas with
 * `Object.assign(found, …)` when they land (the status `statusRows`, the hub links `ask`, `status` and `linked`). One
 * not set yet makes the call that needs it say so. A test may set `sendAsAgent` in place of the chat's.
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

/** What a project's lead is told at the end of an ask. */
export const askFooter = (handle: string) =>
  `(Ask ${handle}. If you open an order for it, pass asked: "${handle}" to brief, so the asker hears when it lands. If you fold it into an order already open, call brief with that workstreamId and asked: "${handle}".)`;

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
    "This project is archived, or the hub doesn't have it: its lead works with no other project.",
    "Bring it back from the app first.",
  );
}

/** The asker sees the project at all: a Navi every project here, a link those its device reads. */
const sees = (asker: Asker, p: ProjectRef) => asker.kind === "navi" || linkAllows(asker.link, "read", p.machineId);

/** The Navis that aren't the asker's person's (D215): it neither sees nor reaches them. */
function othersOfAsker(hub: Hub, asker: Asker): Refs {
  if (asker.kind === "navi") return othersOf(hub.db, navis.of(hub.db.conn, asker.navi)?.owner, false);
  return othersOf(hub.db, asker.link.person?.personId, true);
}

/** The asker reaches the project: not a Navi's own, and one of a link's projects. */
const reaches = (asker: Asker, p: ProjectRef) =>
  asker.kind === "navi" ? !same(asker.navi, p) : sees(asker, p) && linkLimits(asker.link, p);

/** The project `name` names, by project id or title, other than the caller's own. */
function target(hub: Hub, asker: Asker, name: string): ProjectSummary {
  const hidden = othersOfAsker(hub, asker);
  const all = store(hub)
    .projectsShown()
    .filter((p) => sees(asker, refOf(p)) && !hidden.has(refOf(p)));
  const byId = all.filter((p) => p.projectId === name);
  const found = byId.length > 0 ? byId : all.filter((p) => p.title.trim().toLowerCase() === name.trim().toLowerCase());
  if (found.length === 0) {
    throw new ToolError("not_found", `No project ${name} on this hub.`, "Call factory_status to see the projects, and name one by its title.");
  }
  if (found.length > 1) throw new ToolError("invalid", `${found.length} projects are called ${name}.`, "Name it by its project id, from factory_status.");
  const p = found[0] as ProjectSummary;
  if (!reaches(asker, refOf(p))) {
    throw asker.kind === "navi"
      ? new ToolError("invalid", "That is this lead's own project.", "project_message writes to another project's lead; say it in your own reply.")
      : new ToolError(
          "forbidden",
          `${p.title} is not one of this link's projects.`,
          "factory_status lists the projects the link reaches; the person can widen it where it was made.",
        );
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
  /** It came in through this link minted here. */
  viaLink?: string;
  /** It went out through this link kept here, as the ask `remote` there. */
  toHub?: string;
};

const ASK_COLUMNS = "n, from_machine_id, from_project_id, to_machine_id, to_project_id, text, at_ms, via_link, to_hub";
type AskRow = {
  n: number;
  from_machine_id: string;
  from_project_id: string;
  to_machine_id: string;
  to_project_id: string;
  text: string;
  at_ms: number;
  via_link: string | null;
  to_hub: string | null;
};

function askRow(c: Database, row: AskRow): Ask {
  const orders = c
    .query<{ workstream_id: string }, [number]>("SELECT workstream_id FROM navi_ask_orders WHERE n = ? ORDER BY rowid")
    .all(row.n)
    .map((r) => r.workstream_id);
  return {
    handle: `N${row.n}`,
    from: { machineId: row.from_machine_id, projectId: row.from_project_id },
    to: { machineId: row.to_machine_id, projectId: row.to_project_id },
    text: row.text,
    atMs: row.at_ms,
    orders,
    ...(row.via_link !== null ? { viaLink: row.via_link } : {}),
    ...(row.to_hub !== null ? { toHub: row.to_hub } : {}),
  };
}

/** An asker's asks, newest first. */
export function asksOf(c: Database, asker: Asker): Ask[] {
  const rows =
    asker.kind === "navi"
      ? c
          .query<AskRow, [string, string]>(
            `SELECT ${ASK_COLUMNS} FROM navi_asks WHERE from_machine_id = ? AND from_project_id = ? ORDER BY n DESC LIMIT 200`,
          )
          .all(asker.navi.machineId, asker.navi.projectId)
      : c.query<AskRow, [string]>(`SELECT ${ASK_COLUMNS} FROM navi_asks WHERE via_link = ? ORDER BY n DESC LIMIT 200`).all(asker.link.linkId);
  return rows.map((row) => askRow(c, row));
}

/** A Navi's asks to projects on this hub, newest first. Its asks through a hub link name projects there. */
export const asksFrom = (c: Database, from: ProjectRef) => asksOf(c, { kind: "navi", navi: from }).filter((a) => a.toHub === undefined);

/** The ask a Navi here sent through a kept link, by its handle there. */
export function askSent(c: Database, linkId: string, remote: string): Ask | undefined {
  const row = c.query<AskRow, [string, string]>(`SELECT ${ASK_COLUMNS} FROM navi_asks WHERE to_hub = ? AND remote = ?`).get(linkId, remote);
  return row ? askRow(c, row) : undefined;
}

/** Records an ask a Navi here sent through a kept link (once per handle there): its handle here. */
export function recordSent(
  c: Database,
  from: ProjectRef,
  linkId: string,
  sent: { handle: string; projectRef: ProjectRef },
  text: string,
  nowMs: number,
): string {
  const kept = askSent(c, linkId, sent.handle);
  if (kept) return kept.handle;
  const row = c
    .query<{ n: number }, [string, string, string, string, string, number, string, string]>(
      `INSERT INTO navi_asks (from_machine_id, from_project_id, to_machine_id, to_project_id, text, at_ms,
             to_hub, remote) VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING n`,
    )
    .get(from.machineId, from.projectId, sent.projectRef.machineId, sent.projectRef.projectId, text, nowMs, linkId, sent.handle);
  return `N${row?.n}`;
}

function askByHandle(c: Database, handle: string): Ask | undefined {
  const m = /^N(\d+)$/.exec(handle);
  if (!m) return undefined;
  const row = c.query<AskRow, [number]>(`SELECT ${ASK_COLUMNS} FROM navi_asks WHERE n = ?`).get(Number(m[1]));
  return row ? askRow(c, row) : undefined;
}

/** The ask an order was opened for: its first, when its lead folded others in later. */
function askOf(c: Database, workstreamId: string): Ask | undefined {
  const n = c.query<{ n: number }, [string]>("SELECT n FROM navi_ask_orders WHERE workstream_id = ? ORDER BY rowid LIMIT 1").get(workstreamId)?.n;
  return n === undefined ? undefined : askByHandle(c, `N${n}`);
}

export const projectTitle = (hub: Hub, r: ProjectRef) => store(hub).projectGet(r)?.title ?? r.projectId;

export async function projectMessage(hub: Hub, asker: Asker, call: ProjectMessageCall): Promise<ProjectMessageResult> {
  const to = target(hub, asker, call.project);
  const toRef = refOf(to);
  if (asker.kind === "link" && !linkAllows(asker.link, "operate", toRef.machineId)) {
    throw new ToolError(
      "forbidden",
      `The link's person can't open orders in ${to.title}: they only read it.`,
      "Ask an admin of that hub for operate on its machine.",
    );
  }
  const from = asker.kind === "navi" ? asker.navi : { machineId: "", projectId: "" };
  const via = asker.kind === "link" ? asker.link.linkId : null;
  const text = call.text;
  const now = hub.clock.now();
  const c = hub.db.conn;
  // A retry, the same words to the same project within RETRY_MS, is the first ask: its message isn't posted again.
  const first = c
    .query<{ n: number }, [string, string, string, string, string, number, string | null]>(
      `SELECT n FROM navi_asks WHERE from_machine_id = ? AND from_project_id = ? AND to_machine_id = ?
                     AND to_project_id = ? AND text = ? AND at_ms >= ? AND via_link IS ? AND to_hub IS NULL
                     ORDER BY n DESC LIMIT 1`,
    )
    .get(from.machineId, from.projectId, toRef.machineId, toRef.projectId, text, now - RETRY_MS, via)?.n;
  const n =
    first ??
    (c
      .query<{ n: number }, [string, string, string, string, string, number, string | null]>(
        `INSERT INTO navi_asks (from_machine_id, from_project_id, to_machine_id, to_project_id, text, at_ms,
                 via_link) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING n`,
      )
      .get(from.machineId, from.projectId, toRef.machineId, toRef.projectId, text, now, via)?.n as number);
  const handle = `N${n}`;
  const by = asker.kind === "navi" ? author(hub, asker.navi) : linkAuthor(asker.link);
  const sent = await (found.sendAsAgent ?? sendAsAgent)(hub, toRef, by, `${text}\n\n${askFooter(handle)}`, `navi:${handle}`);
  const waiting = typeof sent.leadWaiting === "string" ? sent.leadWaiting : undefined;
  return {
    handle,
    projectRef: toRef,
    title: to.title,
    ...(waiting !== undefined ? { leadWaiting: waiting } : {}),
    next: `In ${to.title}'s chat as ${by}. Its lead reads it as input, never as the person's approval: anything it needs the person for, it asks in its own chat. A wake tells you when an order opened for ${handle} opens, closes, merges or fails; end your turn instead of waiting.`,
  };
}

export function factoryStatus(hub: Hub, asker: Asker, call: FactoryStatusCall): FactoryStatusResult {
  const only = call.project !== undefined ? refOf(target(hub, asker, call.project)) : undefined;
  if (!found.statusRows) throw new NotImplemented("src/hub/status (statusRows, for factory_status)");
  const rows = found.statusRows(hub, hub.clock.now());
  const asks = asksOf(hub.db.conn, asker);
  const hidden = othersOfAsker(hub, asker);
  const projects: FactoryProject[] = [];
  for (const row of rows) {
    const r = row.projectRef;
    if (!reaches(asker, r) || hidden.has(r) || (only && !same(only, r))) continue;
    const orders = workstreamsList(hub.db.conn, { projectRef: r, state: "open", limit: 20 });
    const checklist = readChecklist(hub.db, r).items;
    const toIt = asks.filter((a) => same(a.to, r) && a.toHub === undefined);
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
      ? asker.kind === "link"
        ? "The link reaches no project on this hub."
        : "No other project on this hub yet."
      : only
        ? "Write to its lead with project_message; what it needs the person for is in its own chat."
        : "factory_status with project reads one. Write to a project's lead with project_message.";
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
    if (!asked || asked.toHub !== undefined || asked.to.machineId !== e.machineId || asked.to.projectId !== e.projectId) return undefined;
    c.query("INSERT OR IGNORE INTO navi_ask_orders (workstream_id, n) VALUES (?, ?)").run(w, asked.handle.slice(1));
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
    // An ask that came in through a link is followed on its feed, not woken here.
    if (!found || found[0].viaLink !== undefined) continue;
    const [asked, what] = found;
    const line = `- ${asked.handle} to ${projectTitle(hub, asked.to)}: ${what}`;
    leadWakes(hub).trigger(asked.from, { kind: "line", line: "factory", text: line });
    woken.push([asked.from, line]);
  }
  if (page.cursor !== cursor) cursorSet(hub.db.conn, page.cursor);
  return { cursor: page.cursor, more: page.more, woken };
}

/** One page of what happened to a link's asks after `cursor`. */
export function feed(hub: Hub, linkId: string, cursor: number): { cursor: number; more: boolean; items: LinkFeedItem[] } {
  const page = events(hub).page(cursor, TYPES);
  const items: LinkFeedItem[] = [];
  for (const e of page.events) {
    const found = news(hub, e);
    if (found && found[0].viaLink === linkId) items.push({ title: projectTitle(hub, found[0].to), handle: found[0].handle, what: found[1] });
  }
  return { cursor: page.cursor, more: page.more, items };
}

/** Follows the event log for what Navis asked for, from where it left off, until the hub stops. */
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
      console.error("navi bridge: events not followed:", error);
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

/** The bridge as other areas reach it, `hub.area("navi_bridge")`: the hub-links area answers its links with it. */
export type NaviBridge = {
  factoryStatus(asker: Asker, call: FactoryStatusCall): FactoryStatusResult;
  projectMessage(asker: Asker, call: ProjectMessageCall): Promise<ProjectMessageResult>;
  feed(linkId: string, after: number): { cursor: number; more: boolean; items: LinkFeedItem[] };
  mayUse(navi: ProjectRef): void;
  askSent(linkId: string, remote: string): { handle: string; from: ProjectRef } | undefined;
  recordSent(from: ProjectRef, linkId: string, sent: { handle: string; projectRef: ProjectRef; title: string; leadWaiting?: string }, text: string, nowMs: number): string;
};

export function bridgeOf(hub: Hub): NaviBridge {
  return {
    factoryStatus: (asker, call) => factoryStatus(hub, asker, call),
    projectMessage: (asker, call) => projectMessage(hub, asker, call),
    feed: (linkId, after) => feed(hub, linkId, after),
    mayUse: (navi) => mayUse(hub.db.conn, navi),
    askSent: (linkId, remote) => {
      const a = askSent(hub.db.conn, linkId, remote);
      return a ? { handle: a.handle, from: a.from } : undefined;
    },
    recordSent: (from, linkId, sent, text, nowMs) => recordSent(hub.db.conn, from, linkId, sent, text, nowMs),
  };
}

/** The lead-side calls: a project's lead's `project_message` and `factory_status`, here or through a linked hub. */
export async function answer(hub: Hub, navi: ProjectRef, call: { op: string } & Record<string, unknown>): Promise<unknown> {
  mayUse(hub.db.conn, navi);
  const asker: Asker = { kind: "navi", navi };
  if (call.op === "project_message") {
    const c = call as unknown as ProjectMessageCall;
    if (c.hub !== undefined) {
      if (!found.ask) throw new NotImplemented("src/hub/hub_links (client ask)");
      return found.ask(hub, navi, c.hub, c);
    }
    return projectMessage(hub, asker, c);
  }
  if (call.op === "factory_status") {
    const c = call as unknown as FactoryStatusCall;
    if (c.hub !== undefined) {
      if (!found.status) throw new NotImplemented("src/hub/hub_links (client status)");
      return found.status(hub, navi, c.hub, c);
    }
    const out = factoryStatus(hub, asker, c);
    const hubs = found.linked ? found.linked(hub, navi) : [];
    return hubs.length > 0 ? { ...out, hubs } : out;
  }
  throw new ToolError("invalid", `${call.op} is not a factory bridge call.`);
}

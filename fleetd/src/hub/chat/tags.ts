// The chat's tags, a trial a person turns on per project (`chatTags`, off by default; artifact threads-design): the
// hub tags each message with the order it is about (`about`), from what the lead already does, never from a judgement
// of the lead per message. First match wins: a lead message whose bubbles open with `[W12]` is about those orders (the
// marker is stripped); an inline card is about its request's order; any other lead message is about the one order its
// turn touched; a person's message sent from a lens or replying to a tagged bubble takes that tag, and else the order
// its turn opened or touched. A closed order's messages fold into the last one about it (`fold`). A person moves a
// message to another order with `chat_about_set`, and the lead hears it with its next wake. With the switch off,
// nothing here runs.
import type { ChatAbout, ChatFold, ChatMessage, ChatPart, PersonRef, ProjectRef, WorkstreamId } from "../../shared/contracts.ts";
import { ToolError } from "../../shared/errors.ts";
import type { Hub } from "../api/hub.ts";
import { Requests } from "../approvals/store.ts";
import { renderEvent } from "../leads/events.ts";
import { readWorkstream } from "../leads/records.ts";
import { runWindow } from "../leads/requested.ts";
import { leadWakes } from "../leads/seams.ts";
import { shortTitle } from "../orders/cards.ts";
import { chatTagsOn } from "../project_lead/store.ts";
import { isoMs, nowMs, parseMs } from "../store/time.ts";
import { requestOrder, turnOrder } from "./about.ts";
import { chat } from "./index.ts";

/** Whether the project's chat tags trial is on. */
export const tagsOn = (hub: Hub, r: ProjectRef) => chatTagsOn(hub.db.conn, r);

const sameRef = (a: ProjectRef, b: ProjectRef) => a.machineId === b.machineId && a.projectId === b.projectId;

/** Order `workstreamId` of project `r` as a tag; undefined when `r` has no such order. */
export function aboutOf(hub: Hub, r: ProjectRef, workstreamId: string): ChatAbout | undefined {
  const w = readWorkstream(hub.db.conn, workstreamId);
  if (!w || !sameRef(w.projectRef, r)) return undefined;
  return { workstreamId: w.workstreamId, title: shortTitle(w) };
}

/** An order id opening a bubble, as the lead marks one of a message about several orders. */
const MARKER = /^\[(W[1-9][0-9]*)\][ \t]*/;

/**
 * A final lead message's tag, set in place before it is stored. A message whose bubbles open with `[W12]` loses the
 * markers: one order for all of them tags the message, else each marked bubble carries its own.
 */
export function tagLead(hub: Hub, m: ChatMessage): void {
  if (m.author !== "lead" || m.state !== "final" || m.history !== undefined || !tagsOn(hub, m.projectRef)) return;
  delete m.about;
  if (m.item !== undefined) {
    const request = new Requests(hub.db).get((m.item as { requestId: string }).requestId);
    const order = request ? requestOrder(hub, request) : undefined;
    const about = order === undefined ? undefined : aboutOf(hub, m.projectRef, order);
    if (about) m.about = about;
    return;
  }
  if (unmark(hub, m)) return;
  const order = turnOrder(hub, m.projectRef, parseMs(m.createdAt) ?? 0);
  const about = order === undefined ? undefined : aboutOf(hub, m.projectRef, order);
  if (about) m.about = about;
}

/** Strips the `[W12]` markers of `m`'s bubbles and tags them; false when none opens with one. */
function unmark(hub: Hub, m: ChatMessage): boolean {
  const bubbles: ChatPart[] = m.parts ?? [{ start: 0, end: m.text.length }];
  const found = bubbles.map((p) => {
    if (p.block !== undefined) return undefined;
    const hit = MARKER.exec(m.text.slice(p.start, p.end));
    const about = hit ? aboutOf(hub, m.projectRef, hit[1] as string) : undefined;
    return hit && about ? { cut: hit[0].length, about } : undefined;
  });
  if (found.every((f) => f === undefined)) return false;
  let text = "";
  let at = 0;
  let shift = 0;
  const parts: ChatPart[] = bubbles.map((p, i) => {
    const cut = found[i]?.cut ?? 0;
    text += m.text.slice(at, p.start) + m.text.slice(p.start + cut, p.end);
    at = p.end;
    const out: ChatPart = { ...p, start: p.start - shift };
    shift += cut;
    out.end = p.end - shift;
    return out;
  });
  text += m.text.slice(at);
  m.text = text;
  const orders = new Set(found.map((f) => f?.about.workstreamId));
  const only = found[0]?.about;
  if (orders.size === 1 && only) {
    // One order for every bubble: the message's tag.
    m.about = only;
    for (const p of parts) delete p.about;
  } else {
    for (const [i, p] of parts.entries()) {
      const about = found[i]?.about;
      if (about) p.about = about;
      else delete p.about;
    }
  }
  if (m.parts) m.parts = parts;
  return true;
}

/**
 * A person's new message's tag: the order of the lens it was sent from, else the tag of the bubble it answers, either
 * only while that order is open (a closed one's fold would swallow the new message). Undefined with the switch off.
 */
export function humanAbout(hub: Hub, r: ProjectRef, lens: WorkstreamId | undefined, replied: ChatMessage | undefined, part: number | undefined): ChatAbout | undefined {
  if (!tagsOn(hub, r)) return undefined;
  const open = (id: string | undefined) => {
    const w = id === undefined ? undefined : readWorkstream(hub.db.conn, id);
    return w && sameRef(w.projectRef, r) && w.state === "open" ? aboutOf(hub, r, w.workstreamId) : undefined;
  };
  return open(lens) ?? open((replied?.parts?.[part ?? 0]?.about ?? replied?.about)?.workstreamId);
}

/** Sets `about` on stored message `id` when it has none, announced. The message as written, else undefined. */
function tagIfUntagged(hub: Hub, id: string, about: ChatAbout): ChatMessage | undefined {
  const out = chat(hub).update(id, (m) => {
    if (m.about !== undefined || (m.parts ?? []).some((p) => p.about !== undefined)) return false;
    m.about = about;
    return true;
  });
  if (out) chat(hub).announce(out);
  return out;
}

/**
 * The lead opened order `workstreamId` from a person's message (the one `runHuman` found, written at `atMs`): that
 * message is about it, unless it already is about another.
 */
export function tagAsked(hub: Hub, r: ProjectRef, workstreamId: WorkstreamId, atMs: number, person: PersonRef | undefined): void {
  if (!tagsOn(hub, r)) return;
  const about = aboutOf(hub, r, workstreamId);
  if (!about) return;
  const row = hub.db.all<{ n: number }>(
    `SELECT n FROM chat_messages WHERE machine_id = ?1 AND project_id = ?2 AND created_ms = ?3
       AND json_extract(data, '$.author') = 'human' AND json_extract(data, '$.history') IS NULL
       AND (?4 IS NULL OR json_extract(data, '$.person.personId') = ?4)
     ORDER BY seq LIMIT 1`,
    [r.machineId, r.projectId, atMs, person?.personId ?? null],
  )[0];
  if (row) tagIfUntagged(hub, `m${row.n}`, about);
}

/**
 * The lead's run of thread `thread` just ended: the people's messages it took in that have no tag yet are about the
 * one order it touched, and so are its own replies still untagged; the closed orders it tagged fold again.
 */
export function settleRun(hub: Hub, r: ProjectRef, thread: string, nowMs: number): void {
  if (!tagsOn(hub, r)) return;
  const { floor, since } = runWindow(hub.db, r, thread, nowMs);
  // The run that just ended holds the moment before its end.
  const order = turnOrder(hub, r, since - 1);
  if (order === undefined) return;
  const about = aboutOf(hub, r, order);
  if (!about) return;
  const rows = hub.db.all<{ n: number }>(
    `SELECT n FROM chat_messages WHERE machine_id = ?1 AND project_id = ?2 AND created_ms > ?3 AND created_ms <= ?4
       AND json_extract(data, '$.author') IN ('human', 'lead') AND json_extract(data, '$.history') IS NULL
       AND json_extract(data, '$.item') IS NULL AND json_extract(data, '$.state') = 'final'
     ORDER BY seq`,
    [r.machineId, r.projectId, floor, since],
  );
  let tagged = false;
  for (const row of rows) if (tagIfUntagged(hub, `m${row.n}`, about)) tagged = true;
  if (tagged) refold(hub, r, order);
}

/** Every message of `r`'s chat about `workstreamId`, or folding it, oldest first. */
function aboutRows(hub: Hub, r: ProjectRef, workstreamId: WorkstreamId): ChatMessage[] {
  return hub.db
    .all<{ data: string }>(
      `SELECT data FROM chat_messages WHERE machine_id = ?1 AND project_id = ?2 AND (
         json_extract(data, '$.about.workstreamId') = ?3 OR json_extract(data, '$.fold.workstreamId') = ?3
         OR EXISTS (SELECT 1 FROM json_each(data, '$.parts') WHERE json_extract(value, '$.about.workstreamId') = ?3))
       ORDER BY seq`,
      [r.machineId, r.projectId, workstreamId],
    )
    .map((row) => JSON.parse(row.data) as ChatMessage);
}

const isAbout = (m: ChatMessage, id: string) => m.about?.workstreamId === id || (m.parts ?? []).some((p) => p.about?.workstreamId === id);

/**
 * Puts order `workstreamId`'s fold where it belongs: on the last message about it once it is closed, nowhere while it
 * is open. Each message whose fold changed is announced.
 */
export function refold(hub: Hub, r: ProjectRef, workstreamId: WorkstreamId): void {
  if (!tagsOn(hub, r)) return;
  const w = readWorkstream(hub.db.conn, workstreamId);
  if (!w || !sameRef(w.projectRef, r)) return;
  const rows = aboutRows(hub, r, workstreamId);
  const about = rows.filter((m) => isAbout(m, workstreamId));
  const last = about[about.length - 1];
  const fold: ChatFold | undefined =
    w.state !== "open" && last ? { workstreamId, title: shortTitle(w), state: w.state, count: about.length } : undefined;
  const c = chat(hub);
  for (const m of rows) {
    const want = m.messageId === last?.messageId ? fold : undefined;
    if (JSON.stringify(m.fold) === JSON.stringify(want)) continue;
    const out = c.update(m.messageId, (s) => {
      if (want) s.fold = want;
      else delete s.fold;
      return true;
    });
    if (out) c.announce(out);
  }
}

/**
 * `chat_about_set`: a person moves message `messageId` of `r`'s chat to open order `workstreamId`, or to none. The lead
 * hears it with its next wake. Refused with the switch off.
 */
export function retag(hub: Hub, r: ProjectRef, messageId: string, workstreamId: WorkstreamId | undefined, who: string): ChatMessage {
  if (!tagsOn(hub, r)) {
    throw new ToolError("invalid", "This project's chat tags are off.", "Turn them on with project_settings_set chatTags: true.");
  }
  const c = chat(hub);
  const message = c.byId(messageId);
  if (!message || !sameRef(message.projectRef, r)) throw new ToolError("not_found", `No message ${messageId} in this chat.`);
  let about: ChatAbout | undefined;
  if (workstreamId !== undefined) {
    const w = readWorkstream(hub.db.conn, workstreamId);
    if (!w || !sameRef(w.projectRef, r) || w.state !== "open") {
      throw new ToolError("invalid", `${workstreamId} is not an open order of this project.`, "Pick one of its open orders, or leave workstreamId out for none.");
    }
    about = aboutOf(hub, r, workstreamId);
  }
  const before = new Set([message.about, ...(message.parts ?? []).map((p) => p.about)].filter((a): a is ChatAbout => a !== undefined).map((a) => a.workstreamId));
  const was = message.about ?? message.parts?.find((p) => p.about !== undefined)?.about;
  if (before.size <= 1 && was?.workstreamId === about?.workstreamId) return message;
  const out =
    c.update(messageId, (m) => {
      if (about) m.about = about;
      else delete m.about;
      for (const p of m.parts ?? []) delete p.about;
      m.updatedAt = isoMs(nowMs(hub.clock));
      return true;
    }) ?? message;
  c.announce(out);
  for (const id of new Set([...before, ...(about ? [about.workstreamId] : [])])) refold(hub, r, id);
  const named = (a: ChatAbout | undefined) => (a ? `${a.title} (${a.workstreamId})` : "no order");
  const from = before.size > 1 ? [...before].join(", ") : named(was);
  leadWakes(hub).trigger(r, {
    kind: "line",
    line: "retag",
    text: renderEvent({ kind: "retagged", who, message: messageId, from, to: named(about), text: message.text }),
  });
  return out;
}

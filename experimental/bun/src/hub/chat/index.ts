// The lead chat (crates/fleetd/src/hub/chat/mod.rs, nudges.rs): one conversation per project, the main surface. This
// keeps the messages (in order, deduped, announced as `chat.message`), the needs-you state (`chat.waiting`), the
// nudges and the streamed text of the lead's replies. `flow` delivers a human's message to the lead and mirrors the
// lead's replies back; `history` reads what came before the chat into it once per project; `tools` serves the tools.
import type { Database } from "bun:sqlite";
import type {
  ArtifactPublished,
  AttachmentRef,
  ChatAuthor,
  ChatClient,
  ChatDelivery,
  ChatDelta,
  ChatHistorySource,
  ChatItem,
  ChatMessage,
  ChatNudge,
  ChatNudgeCleared,
  ChatOpenItem,
  ChatOpenNudge,
  ChatReplyTo,
  MemoryRefreshed,
  PersonRef,
  ProjectChatState,
  ProjectRef,
  RememberedItem,
  SkillSaved,
  WorktreesKept,
} from "../../shared/contracts.ts";
import type { Hub } from "../api/hub.ts";
import type { HubDb } from "../store/db.ts";
import { events } from "../store/events.ts";
import { isoMs, parseMs } from "../store/time.ts";
import { show } from "../intake/attachments.ts";
import { parts as partsOf } from "./parts.ts";

export const CHAT_TEXT_MAX = 100_000;
export const CHAT_PAGE_MAX = 100;
export const CHAT_OPEN_ITEMS_MAX = 20;
export const CHAT_NUDGES_MAX = 3;
export const CHAT_OPEN_NUDGES_MAX = CHAT_NUDGES_MAX;
export const CHAT_NUDGE_MS = 24 * 60 * 60_000;
const ATTACHMENTS_MAX = 20;
/** Event data stays under the log's 2 KB; a larger message is read with chat_history. */
const EVENT_MESSAGE_MAX = 1800;
/** How long a nudge for a reply not yet in the chat waits for it to land. */
const PENDING_MS = 10 * 60_000;
/** Agent keys' messages a minute (flow.rs `AGENT_PER_MINUTE`). */
export const AGENT_PER_MINUTE = 10;

/**
 * A message to add. `source` names the record it was read from, so reading it again adds nothing; `request` is a
 * human's clientRequestId, so a resend returns the same message.
 */
export type NewMessage = {
  author?: ChatAuthor;
  text?: string;
  attachments?: AttachmentRef[];
  streaming?: boolean;
  request?: string;
  source?: string;
  item?: ChatItem;
  history?: ChatHistorySource;
  remembered?: RememberedItem;
  memoryRefreshed?: MemoryRefreshed;
  worktreesKept?: WorktreesKept;
  skillSaved?: SkillSaved;
  artifact?: ArtifactPublished;
  skills?: string[];
  by?: string;
  person?: PersonRef;
  client?: ChatClient;
  replyTo?: ChatReplyTo;
  delivery?: ChatDelivery;
  /** A human message not yet in the lead's session. */
  held?: boolean;
  /** Defaults to now. */
  createdMs?: number;
  /** Flagged for the person's look as it is added. */
  nudge?: string;
};

const key = (r: ProjectRef) => `${r.machineId}/${r.projectId}`;
const numberOf = (id: string) => Number.parseInt(id.slice(1), 10) || 0;

/** `s` cut to `max` UTF-16 units, never splitting a surrogate pair (executor/shell_mapper.rs `js_take`). */
export function jsTake(s: string, max: number): string {
  if (s.length <= max) return s;
  let end = max;
  const code = s.charCodeAt(end - 1);
  if (code >= 0xd800 && code <= 0xdbff) end -= 1;
  return s.slice(0, end);
}

const textOf = (s: string) => jsTake(s, CHAT_TEXT_MAX);

/** The message in the Rust struct's field order, absent fields left out, so rows read the same. */
export function serialize(m: ChatMessage): string {
  const o: Record<string, unknown> = {
    messageId: m.messageId,
    projectRef: m.projectRef,
    seq: m.seq,
    author: m.author,
    text: m.text,
    attachments: m.attachments ?? [],
    createdAt: m.createdAt,
  };
  const rest: (keyof ChatMessage)[] = [
    "updatedAt",
    "state",
    "clientRequestId",
    "delivery",
    "by",
    "person",
    "client",
    "replyTo",
    "item",
    "history",
    "parts",
    "remembered",
    "memoryRefreshed",
    "worktreesKept",
    "skills",
    "skillSaved",
    "artifact",
    "nudge",
  ];
  for (const k of rest) if (m[k] !== undefined && m[k] !== null) o[k] = m[k];
  return JSON.stringify(o);
}

const parse = (data: string) => JSON.parse(data) as ChatMessage;

/**
 * Whether a lead message asks the human something: a line that ends with a question mark (past any closing
 * markdown), or a numbered item with one.
 */
export function asksQuestion(text: string): boolean {
  return text.split(/\r?\n/).some((raw) => {
    const l = raw.trim();
    const m = /^([^.)]*)[.)]/.exec(l);
    const numbered = !!m && m[1] !== undefined && m[1].length > 0 && m[1].length <= 2 && /^[0-9]+$/.test(m[1]);
    return (numbered && l.includes("?")) || l.replace(/[\s*_`)"]+$/u, "").endsWith("?");
  });
}

const asksInABlock = (m: ChatMessage) => (m.parts ?? []).some((p) => p.block?.kind === "ask");

const itemOpen = (item: ChatItem) => (item as { state?: string }).state === "open";

/**
 * The needs-you rule: an inline item waits for an answer, or any lead message since the human last wrote asks
 * something. History and a reply still streaming don't count.
 */
export function needsYou(messages: ChatMessage[]): boolean {
  if (messages.some((m) => m.item !== undefined && itemOpen(m.item))) return true;
  let since = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i] as ChatMessage;
    if (m.author === "human" && m.history === undefined) {
      since = i + 1;
      break;
    }
  }
  return messages
    .slice(since)
    .some((m) => m.author === "lead" && m.history === undefined && m.state === "final" && (asksQuestion(m.text) || asksInABlock(m)));
}

/** Whether a nudge still waits at `now`: not cleared, and less than a day old. */
export function nudgeWaiting(nudge: ChatNudge, now: number): boolean {
  const at = parseMs(nudge.at);
  return nudge.cleared === undefined && at !== undefined && now - at < CHAT_NUDGE_MS;
}

/** The project's messages whose nudge waits, by the partial index `chat_nudges_waiting`'s condition. */
const WAITING = `SELECT data FROM chat_messages WHERE machine_id = ?1 AND project_id = ?2
     AND json_extract(data, '$.nudge') IS NOT NULL
     AND json_extract(data, '$.nudge.cleared') IS NULL ORDER BY seq`;

/** The hub's chat, `chat(hub)`. */
export const chat = (hub: Hub) => hub.area("chat", (h) => new Chat(h));

export class Chat {
  private readonly db: HubDb;
  private readonly deltas = new Set<(delta: ChatDelta) => void>();
  /** What `chat.waiting` last said per project, so it fires only on a change. */
  private readonly said = new Map<string, string>();
  /** One history read per project at a time. */
  private reading: Promise<void> = Promise.resolve();
  private readonly agentSends = new Map<string, number[]>();
  /** Nudges for lead replies not in the chat yet, by their source: the reason, and when. */
  private readonly pendingNudges = new Map<string, [string, number]>();
  /** One held message on its way to the lead at a time, per project (`flow`). */
  private readonly sendingLocks = new Map<string, Promise<void>>();

  constructor(private readonly hub: Hub) {
    this.db = hub.db;
  }

  private now(): number {
    return this.hub.clock.now();
  }

  private nowTs(): string {
    return isoMs(this.now());
  }

  /** Counts a new message from agent key `keyId` and says whether it is within the minute's allowance. */
  allowAgent(keyId: string): boolean {
    const now = this.now();
    for (const [k, at] of this.agentSends) {
      const kept = at.filter((t) => now - t < 60_000);
      if (kept.length === 0) this.agentSends.delete(k);
      else this.agentSends.set(k, kept);
    }
    const at = this.agentSends.get(keyId) ?? [];
    if (at.length >= AGENT_PER_MINUTE) return false;
    at.push(now);
    this.agentSends.set(keyId, at);
    return true;
  }

  /** Every streamed append, for the app connections subscribed to a chat; returns the unsubscribe. */
  subscribe(fn: (delta: ChatDelta) => void): () => void {
    this.deltas.add(fn);
    return () => this.deltas.delete(fn);
  }

  historyRead(r: ProjectRef): boolean {
    return !!this.db.conn
      .query("SELECT 1 FROM chat_projects WHERE machine_id = ?1 AND project_id = ?2")
      .get(r.machineId, r.projectId);
  }

  /** Reads the project's past into the chat once: `entries` in time order, then the mark. */
  async readHistory(r: ProjectRef, entries: () => Promise<NewMessage[]> | NewMessage[]): Promise<void> {
    if (this.historyRead(r)) return;
    const before = this.reading;
    let done!: () => void;
    this.reading = new Promise((resolve) => (done = resolve));
    try {
      await before;
      if (this.historyRead(r)) return;
      const list = [...(await entries())].sort((a, b) => (a.createdMs ?? 0) - (b.createdMs ?? 0));
      for (const e of list) this.insertQuiet(r, e);
      this.db.conn
        .query("INSERT OR IGNORE INTO chat_projects (machine_id, project_id, history_ms) VALUES (?1, ?2, ?3)")
        .run(r.machineId, r.projectId, this.now());
    } finally {
      done();
    }
  }

  /** When the project's history was read: messages of records older than this are history. */
  historyMs(r: ProjectRef): number | undefined {
    return (
      this.db.conn
        .query<{ history_ms: number }, [string, string]>("SELECT history_ms FROM chat_projects WHERE machine_id = ?1 AND project_id = ?2")
        .get(r.machineId, r.projectId)?.history_ms ?? undefined
    );
  }

  /** Adds a message without announcing it; the same request or source returns the stored one. */
  private insertQuiet(r: ProjectRef, n: NewMessage): { message: ChatMessage; created: boolean } {
    const createdMs = n.createdMs ?? this.now();
    return this.db.transaction((c) => {
      const existing = c
        .query<{ data: string }, [string, string, string | null, string | null]>(
          `SELECT data FROM chat_messages WHERE machine_id = ?1 AND project_id = ?2
           AND ((request IS NOT NULL AND request = ?3) OR (source IS NOT NULL AND source = ?4))`,
        )
        .get(r.machineId, r.projectId, n.request ?? null, n.source ?? null);
      if (existing) return { message: parse(existing.data), created: false };
      const { seq } = c
        .query<{ seq: number }, [string, string]>(
          "SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM chat_messages WHERE machine_id = ?1 AND project_id = ?2",
        )
        .get(r.machineId, r.projectId) as { seq: number };
      const inserted = c
        .query(
          `INSERT INTO chat_messages (machine_id, project_id, seq, created_ms, request, source, held, data)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, '{}')`,
        )
        .run(r.machineId, r.projectId, seq, createdMs, n.request ?? null, n.source ?? null, n.held ? 1 : 0);
      const rowid = Number(inserted.lastInsertRowid);
      const author = n.author ?? "system";
      const text = textOf(n.text ?? "");
      const message: ChatMessage = {
        messageId: `m${rowid}`,
        projectRef: r,
        seq,
        author,
        text,
        attachments: (n.attachments ?? []).slice(0, ATTACHMENTS_MAX),
        createdAt: isoMs(createdMs),
        state: n.streaming ? "streaming" : "final",
      };
      if (n.request) message.clientRequestId = n.request;
      if (n.delivery !== undefined) message.delivery = n.delivery;
      if (n.by !== undefined) {
        const by = [...n.by].slice(0, 120).join("");
        if (by.length > 0 && !/[\r\n]/.test(by)) message.by = by;
      }
      if (n.person !== undefined) message.person = n.person;
      if (n.client !== undefined) message.client = n.client;
      if (n.replyTo !== undefined) message.replyTo = n.replyTo;
      if (n.item !== undefined) message.item = n.item;
      if (n.history !== undefined) message.history = n.history;
      if (n.remembered !== undefined) message.remembered = n.remembered;
      if (n.memoryRefreshed !== undefined) message.memoryRefreshed = n.memoryRefreshed;
      if (n.worktreesKept !== undefined) message.worktreesKept = n.worktreesKept;
      if (n.skillSaved !== undefined) message.skillSaved = n.skillSaved;
      if (n.artifact !== undefined) message.artifact = n.artifact;
      if (n.skills && n.skills.length > 0) message.skills = n.skills;
      const parts = show(c, r, author === "lead" && !n.streaming ? partsOf(text) : undefined);
      if (parts) message.parts = parts;
      c.query("UPDATE chat_messages SET data = ?1 WHERE n = ?2").run(serialize(message), rowid);
      return { message, created: true };
    });
  }

  /** Adds a message and announces it. The same request or source returns the stored message, announced once. */
  add(r: ProjectRef, n: NewMessage): { message: ChatMessage; created: boolean } {
    const { message, created } = this.insertQuiet(r, n);
    if (created) {
      this.landed(n.source, n.nudge, message);
      this.announce(message);
    }
    return { message, created };
  }

  /** One author=system line, for fleetd's own events in a project's chat. */
  systemLine(r: ProjectRef, text: string): ChatMessage {
    return this.add(r, { author: "system", text }).message;
  }

  /** An inline item (a secret to enter, a command to approve) as a lead message. */
  item(r: ProjectRef, item: ChatItem): ChatMessage {
    return this.add(r, { author: "lead", item, source: `item:${(item as { requestId: string }).requestId}` }).message;
  }

  /** An item's new state, in place. */
  updateItem(requestId: string, item: ChatItem): ChatMessage | undefined {
    const message = this.bySourceAnywhere(`item:${requestId}`);
    if (!message) return undefined;
    if (JSON.stringify(message.item) === JSON.stringify(item)) return message;
    message.item = item;
    message.updatedAt = this.nowTs();
    this.put(message);
    this.announce(message);
    return message;
  }

  /** A remembered line's new state, in place. */
  setRemembered(message: ChatMessage, remembered: RememberedItem): ChatMessage {
    message.remembered = remembered;
    message.updatedAt = this.nowTs();
    this.put(message);
    this.announce(message);
    return message;
  }

  /** A "Memory refreshed" line's changes, in place, as Undo marks them. */
  setMemoryRefreshed(message: ChatMessage, refreshed: MemoryRefreshed): ChatMessage {
    message.memoryRefreshed = refreshed;
    message.updatedAt = this.nowTs();
    this.put(message);
    this.announce(message);
    return message;
  }

  private one(sql: string, ...params: (string | number | null)[]): ChatMessage | undefined {
    const row = this.db.conn.query<{ data: string }, (string | number | null)[]>(sql).get(...params);
    return row ? parse(row.data) : undefined;
  }

  private many(sql: string, ...params: (string | number | null)[]): ChatMessage[] {
    return this.db.conn
      .query<{ data: string }, (string | number | null)[]>(sql)
      .all(...params)
      .flatMap((row) => {
        try {
          return [parse(row.data)];
        } catch {
          return [];
        }
      });
  }

  /** The message a human's request stored, if any. */
  byRequest(r: ProjectRef, request: string): ChatMessage | undefined {
    return this.one(
      "SELECT data FROM chat_messages WHERE machine_id = ?1 AND project_id = ?2 AND request = ?3",
      r.machineId,
      r.projectId,
      request,
    );
  }

  /** A human message waits for the project's lead to start. */
  hold(message: ChatMessage): void {
    this.setHeld(message, true);
  }

  /** The held message went to the lead. */
  release(message: ChatMessage): void {
    this.setHeld(message, false);
  }

  private setHeld(message: ChatMessage, held: boolean): void {
    this.db.conn.query("UPDATE chat_messages SET held = ?1 WHERE n = ?2").run(held ? 1 : 0, numberOf(message.messageId));
  }

  /** The project's turn to send a held message: resolves with the release once the one before is done. */
  async sending(r: ProjectRef): Promise<() => void> {
    const k = key(r);
    const before = this.sendingLocks.get(k) ?? Promise.resolve();
    let release!: () => void;
    const mine = new Promise<void>((resolve) => (release = resolve));
    const chained = before.then(() => mine);
    this.sendingLocks.set(k, chained);
    await before;
    return () => {
      release();
      if (this.sendingLocks.get(k) === chained) this.sendingLocks.delete(k);
    };
  }

  isHeld(message: ChatMessage): boolean {
    const row = this.db.conn
      .query<{ held: number }, [number]>("SELECT held FROM chat_messages WHERE n = ?1")
      .get(numberOf(message.messageId));
    return !!row?.held;
  }

  /** A message by its id ("m<n>"). */
  byId(id: string): ChatMessage | undefined {
    const n = id.startsWith("m") ? Number.parseInt(id.slice(1), 10) || 0 : 0;
    return this.one("SELECT data FROM chat_messages WHERE n = ?1", n);
  }

  /** The requests whose inline item still reads open or approved: the ones a missed event could leave stale. */
  unsettledRequests(): string[] {
    return this.db.conn
      .query<{ id: string | null }, []>(
        `SELECT DISTINCT json_extract(data, '$.item.requestId') AS id FROM chat_messages
         WHERE json_extract(data, '$.item.state') IN ('open', 'approved')`,
      )
      .all()
      .flatMap((r) => (r.id ? [r.id] : []));
  }

  /** The projects with a held message. */
  heldProjects(): ProjectRef[] {
    return this.db.conn
      .query<{ machine_id: string; project_id: string }, []>("SELECT DISTINCT machine_id, project_id FROM chat_messages WHERE held = 1")
      .all()
      .map((r) => ({ machineId: r.machine_id, projectId: r.project_id }));
  }

  /** The project's held messages, oldest first. */
  held(r: ProjectRef): ChatMessage[] {
    return this.many(
      "SELECT data FROM chat_messages WHERE machine_id = ?1 AND project_id = ?2 AND held = 1 ORDER BY seq",
      r.machineId,
      r.projectId,
    );
  }

  /** The project's messages still streaming whose source starts with `prefix`. */
  streamingFrom(r: ProjectRef, prefix: string): ChatMessage[] {
    return this.many(
      `SELECT data FROM chat_messages WHERE machine_id = ?1 AND project_id = ?2
       AND substr(source, 1, length(?3)) = ?3 AND json_extract(data, '$.state') = 'streaming'
       ORDER BY seq`,
      r.machineId,
      r.projectId,
      prefix,
    );
  }

  /**
   * Changes the stored message `id` where it is, read and written in one transaction, so what another writer put
   * there meanwhile isn't overwritten by an older copy. `f` says whether it changed anything; the message as written
   * when it did, else undefined.
   */
  update(id: string, f: (m: ChatMessage) => boolean): ChatMessage | undefined {
    const n = numberOf(id);
    return this.db.transaction((c: Database) => {
      const row = c.query<{ data: string }, [number]>("SELECT data FROM chat_messages WHERE n = ?1").get(n);
      if (!row) return undefined;
      const message = parse(row.data);
      if (!f(message)) return undefined;
      c.query("UPDATE chat_messages SET data = ?1 WHERE n = ?2").run(serialize(message), n);
      return message;
    });
  }

  put(message: ChatMessage): void {
    this.db.conn.query("UPDATE chat_messages SET data = ?1 WHERE n = ?2").run(serialize(message), numberOf(message.messageId));
  }

  private bySourceAnywhere(source: string): ChatMessage | undefined {
    return this.one("SELECT data FROM chat_messages WHERE source = ?1 ORDER BY n DESC LIMIT 1", source);
  }

  bySource(r: ProjectRef, source: string): ChatMessage | undefined {
    return this.one(
      "SELECT data FROM chat_messages WHERE machine_id = ?1 AND project_id = ?2 AND source = ?3",
      r.machineId,
      r.projectId,
      source,
    );
  }

  /** Appends streamed text to a streaming message and sends it to subscribers, with the length it had before. */
  append(message: ChatMessage, append: string): ChatMessage {
    if (!append) return message;
    const now = this.nowTs();
    let offset = 0;
    const appended = this.update(message.messageId, (m) => {
      if (m.state !== "streaming") return false;
      offset = m.text.length;
      m.text = textOf(m.text + append);
      m.updatedAt = now;
      return true;
    });
    if (!appended) return message;
    let rest = append;
    let at = offset;
    // Frames carry at most 4000 UTF-16 units.
    while (rest.length > 0) {
      const part = jsTake(rest, 4000) || rest.slice(0, 2);
      const delta: ChatDelta = {
        projectRef: appended.projectRef,
        messageId: appended.messageId,
        seq: appended.seq,
        offset: at,
        append: part,
      };
      for (const fn of this.deltas) fn(delta);
      at += part.length;
      rest = rest.slice(part.length);
    }
    return appended;
  }

  /** A streamed message is complete: its final text, announced, written onto the stored message. */
  finish(message: ChatMessage, text: string): ChatMessage {
    const final = textOf(text);
    const now = this.nowTs();
    const leadParts = message.author === "lead" ? show(this.db.conn, message.projectRef, partsOf(final)) : undefined;
    const done = (m: ChatMessage) => {
      if (m.author === "lead") {
        if (leadParts) m.parts = leadParts;
        else delete m.parts;
      }
      m.text = final;
      m.state = "final";
      m.updatedAt = now;
      return true;
    };
    let out = this.update(message.messageId, done);
    if (!out) {
      done(message);
      this.put(message);
      out = message;
    }
    this.announce(out);
    return out;
  }

  /** The project's title, as everything a person reads names it; never its id. */
  private title(r: ProjectRef): string | undefined {
    const row = this.db.conn
      .query<{ title: string | null }, [string, string]>(
        "SELECT json_extract(data, '$.title') AS title FROM projects WHERE machine_id = ?1 AND project_id = ?2",
      )
      .get(r.machineId, r.projectId);
    const title = row?.title ?? undefined;
    return title && title.trim() ? title : undefined;
  }

  announce(message: ChatMessage): void {
    const r = message.projectRef;
    const full = serialize(message);
    const who = { human: "You", lead: "The lead", agent: "An agent" }[message.author as string] ?? "fleetd";
    const title = this.title(r);
    events(this.hub).append({
      at: this.nowTs(),
      type: "chat.message",
      machineId: r.machineId,
      projectId: r.projectId,
      summary: title === undefined ? `${who} in a project's chat` : `${who} in the chat of ${[...title].slice(0, 60).join("")}`,
      data: {
        projectRef: r,
        messageId: message.messageId,
        seq: message.seq,
        author: message.author,
        state: message.state,
        ...(Buffer.byteLength(full) <= EVENT_MESSAGE_MAX ? { message: JSON.parse(full) } : {}),
      },
    });
  }

  /** A page of the chat, oldest first, and whether more lies before and after it. */
  page(r: ProjectRef, before: number | undefined, after: number | undefined, limit: number) {
    const lim = Math.min(Math.max(limit, 1), CHAT_PAGE_MAX);
    const c = this.db.conn;
    const big = Number.MAX_SAFE_INTEGER;
    let rows: { seq: number; data: string }[];
    if (after !== undefined) {
      rows = c
        .query<{ seq: number; data: string }, [string, string, number, number, number]>(
          `SELECT seq, data FROM chat_messages WHERE machine_id = ?1 AND project_id = ?2 AND seq > ?3
           AND seq < ?4 ORDER BY seq ASC LIMIT ?5`,
        )
        .all(r.machineId, r.projectId, after, before ?? big, lim);
    } else {
      rows = c
        .query<{ seq: number; data: string }, [string, string, number, number]>(
          `SELECT seq, data FROM chat_messages WHERE machine_id = ?1 AND project_id = ?2 AND seq < ?3
           ORDER BY seq DESC LIMIT ?4`,
        )
        .all(r.machineId, r.projectId, before ?? big, lim)
        .reverse();
    }
    const last = (
      c
        .query<{ last: number }, [string, string]>(
          "SELECT COALESCE(MAX(seq), 0) AS last FROM chat_messages WHERE machine_id = ?1 AND project_id = ?2",
        )
        .get(r.machineId, r.projectId) as { last: number }
    ).last;
    const first = rows[0]?.seq;
    const lastSeq = rows[rows.length - 1]?.seq;
    const moreBefore = first !== undefined ? first > 1 : after !== undefined && after > 0 && last > 0;
    const moreAfter = lastSeq !== undefined ? lastSeq < last : before !== undefined && before <= last;
    return { messages: rows.map((row) => parse(row.data)), moreBefore, moreAfter };
  }

  /**
   * The messages of `r`'s chat whose text holds every one of `words` (SQLite's LIKE), newest first: before seq
   * `before`, created from `fromMs` up to `toMs`, at most `limit`, and whether more match past them.
   */
  search(r: ProjectRef, words: string[], fromMs?: number, toMs?: number, before?: number, limit = 20) {
    let sql = `SELECT data FROM chat_messages WHERE machine_id = ? AND project_id = ? AND seq < ?
               AND created_ms >= ? AND created_ms <= ?`;
    const args: (string | number | bigint)[] = [
      r.machineId,
      r.projectId,
      before ?? 9223372036854775807n,
      fromMs ?? -9223372036854775808n,
      toMs ?? 9223372036854775807n,
    ];
    for (const word of words) {
      sql += " AND json_extract(data, '$.text') LIKE ? ESCAPE '\\'";
      args.push(`%${word.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_")}%`);
    }
    sql += " ORDER BY seq DESC LIMIT ?";
    args.push(limit + 1);
    const rows = this.db.conn
      .query<{ data: string }, (string | number | bigint)[]>(sql)
      .all(...args)
      .map((row) => parse(row.data));
    const more = rows.length > limit;
    return { messages: rows.slice(0, limit), more };
  }

  /** The seq of message `id` ("m<n>") when it is one of `r`'s chat. */
  seqIn(r: ProjectRef, id: string): number | undefined {
    if (!/^m[0-9]+$/.test(id)) return undefined;
    return (
      this.db.conn
        .query<{ seq: number }, [number, string, string]>(
          "SELECT seq FROM chat_messages WHERE n = ?1 AND machine_id = ?2 AND project_id = ?3",
        )
        .get(Number(id.slice(1)), r.machineId, r.projectId)?.seq ?? undefined
    );
  }

  /** The message at `seq` with up to `before` messages before it and `after` after it, oldest first. */
  around(r: ProjectRef, seq: number, before: number, after: number) {
    const c = this.db.conn;
    const read = (sql: string, limit: number) =>
      c.query<{ seq: number; data: string }, [string, string, number, number]>(sql).all(r.machineId, r.projectId, seq, limit);
    const rows = read(
      `SELECT seq, data FROM chat_messages WHERE machine_id = ?1 AND project_id = ?2 AND seq <= ?3
       ORDER BY seq DESC LIMIT ?4`,
      before + 1,
    ).reverse();
    rows.push(
      ...read(
        `SELECT seq, data FROM chat_messages WHERE machine_id = ?1 AND project_id = ?2 AND seq > ?3
         ORDER BY seq ASC LIMIT ?4`,
        after,
      ),
    );
    const beyond = (sql: string, at: number) =>
      !!(c.query<{ e: number }, [string, string, number]>(sql).get(r.machineId, r.projectId, at) as { e: number }).e;
    const moreBefore = beyond(
      "SELECT EXISTS (SELECT 1 FROM chat_messages WHERE machine_id = ?1 AND project_id = ?2 AND seq < ?3) AS e",
      rows[0]?.seq ?? seq,
    );
    const moreAfter = beyond(
      "SELECT EXISTS (SELECT 1 FROM chat_messages WHERE machine_id = ?1 AND project_id = ?2 AND seq > ?3) AS e",
      rows[rows.length - 1]?.seq ?? seq,
    );
    return { messages: rows.map((row) => parse(row.data)), moreBefore, moreAfter };
  }

  /** The project's chat state; `leadWorking` is the lead's own (the flow reads it off its thread). */
  state(r: ProjectRef, leadWorking: boolean): ProjectChatState {
    const { messages: recent } = this.page(r, undefined, undefined, 1);
    const open = this.openItems(r);
    const openItems: ChatOpenItem[] = open
      .flatMap((m): ChatOpenItem[] => {
        if (!m.item || !itemOpen(m.item)) return [];
        const kind = (m.item as { kind?: string }).kind === "command_approval" ? "command_approval" : "secret_request";
        return [{ messageId: m.messageId, kind } as ChatOpenItem];
      })
      .slice(0, CHAT_OPEN_ITEMS_MAX);
    const considered = [...this.sinceHuman(r), ...open];
    const last = recent[recent.length - 1];
    const nudges = this.nudgesListed(r);
    return {
      projectRef: r,
      needsYou: needsYou(considered),
      leadWorking,
      lastSeq: last?.seq ?? 0,
      ...(last ? { lastMessageAt: last.createdAt } : {}),
      ...(openItems.length > 0 ? { openItems } : {}),
      ...(nudges.length > 0 ? { nudges } : {}),
    } as ProjectChatState;
  }

  /** The lead's messages after the human's last one written in the chat, oldest first; history left out. */
  sinceHuman(r: ProjectRef): ChatMessage[] {
    const after = (
      this.db.conn
        .query<{ after: number }, [string, string]>(
          `SELECT COALESCE(MAX(seq), 0) AS after FROM chat_messages WHERE machine_id = ?1 AND project_id = ?2
           AND json_extract(data, '$.author') = 'human' AND json_extract(data, '$.history') IS NULL`,
        )
        .get(r.machineId, r.projectId) as { after: number }
    ).after;
    return this.many(
      `SELECT data FROM chat_messages WHERE machine_id = ?1 AND project_id = ?2 AND seq > ?3
       AND json_extract(data, '$.author') = 'lead' AND json_extract(data, '$.history') IS NULL
       ORDER BY seq`,
      r.machineId,
      r.projectId,
      after,
    );
  }

  private openItems(r: ProjectRef): ChatMessage[] {
    return this.many(
      `SELECT data FROM chat_messages WHERE machine_id = ?1 AND project_id = ?2
       AND json_extract(data, '$.item.state') = 'open' ORDER BY seq LIMIT 20`,
      r.machineId,
      r.projectId,
    );
  }

  /** Announces `chat.waiting` when the needs-you or working state, open items or waiting nudges changed. */
  tellState(state: ProjectChatState): void {
    const now = JSON.stringify([
      state.needsYou,
      state.leadWorking,
      (state.openItems ?? []).map((i) => i.messageId),
      (state.nudges ?? []).map((n) => n.messageId),
    ]);
    const k = key(state.projectRef);
    const before = this.said.get(k);
    this.said.set(k, now);
    if (before === now) return;
    const r = state.projectRef;
    events(this.hub).append({
      at: this.nowTs(),
      type: "chat.waiting",
      machineId: r.machineId,
      projectId: r.projectId,
      summary: state.needsYou ? "The lead waits on you" : state.leadWorking ? "The lead is working" : "The lead is idle",
      data: state,
    });
  }

  // Nudges (nudges.rs).

  /** The project's nudges still waiting, oldest first; those a day old are marked expired as they are found. */
  openNudges(r: ProjectRef): ChatMessage[] {
    const now = this.now();
    const all = this.many(WAITING, r.machineId, r.projectId);
    const open = all.filter((m) => m.nudge && nudgeWaiting(m.nudge, now));
    for (const m of all.filter((m) => !(m.nudge && nudgeWaiting(m.nudge, now)))) {
      this.update(m.messageId, (s) => {
        if (!s.nudge || s.nudge.cleared !== undefined) return false;
        s.nudge.cleared = "expired";
        return true;
      });
    }
    const at = (m: ChatMessage) => parseMs(m.nudge?.at ?? "") ?? -Infinity;
    return open.sort((a, b) => at(a) - at(b) || a.seq - b.seq);
  }

  /** The waiting nudges as a chat state lists them. */
  nudgesListed(r: ProjectRef): ChatOpenNudge[] {
    return this.openNudges(r)
      .flatMap((m) => (m.nudge ? [{ messageId: m.messageId, reason: m.nudge.reason, at: m.nudge.at }] : []))
      .slice(0, CHAT_OPEN_NUDGES_MAX);
  }

  /** Flags `message` for the person's look, announced; past the cap, the oldest waiting one is replaced. */
  nudge(message: ChatMessage, reason: string): ChatMessage {
    const nudge = this.makeRoom(message, reason);
    const now = this.nowTs();
    const flagged = this.update(message.messageId, (m) => {
      m.nudge = nudge;
      m.updatedAt = now;
      return true;
    });
    if (!flagged) return message;
    this.announce(flagged);
    return flagged;
  }

  private makeRoom(message: ChatMessage, reason: string): ChatNudge {
    const others = this.openNudges(message.projectRef).filter((m) => m.messageId !== message.messageId);
    const over = Math.max(others.length + 1 - CHAT_NUDGES_MAX, 0);
    for (const old of others.slice(0, over)) this.clearNudge(old, "replaced");
    return { reason, at: this.nowTs() };
  }

  /** The nudge no longer waits: seen, dismissed or replaced. False when it wasn't waiting. */
  clearNudge(message: ChatMessage, how: ChatNudgeCleared): boolean {
    const now = this.nowTs();
    const cleared = this.update(message.messageId, (m) => {
      if (!m.nudge || m.nudge.cleared !== undefined) return false;
      m.nudge.cleared = how;
      m.updatedAt = now;
      return true;
    });
    if (!cleared) return false;
    this.announce(cleared);
    return true;
  }

  /** Flags the message `source` names once it lands, for a reply the lead nudged before the chat had it. */
  nudgeOnLanding(source: string, reason: string): void {
    const now = this.now();
    for (const [k, [, at]] of this.pendingNudges) if (now - at >= PENDING_MS) this.pendingNudges.delete(k);
    this.pendingNudges.set(source, [reason, now]);
  }

  /** A new message's nudge, its own or one that waited for its source: set on it before it is announced. */
  private landed(source: string | undefined, nudge: string | undefined, message: ChatMessage): void {
    const now = this.now();
    let waited: string | undefined;
    if (source !== undefined) {
      const pending = this.pendingNudges.get(source);
      this.pendingNudges.delete(source);
      if (pending && now - pending[1] < PENDING_MS) waited = pending[0];
    }
    const reason = nudge ?? waited;
    if (reason === undefined) return;
    message.nudge = this.makeRoom(message, reason);
    message.updatedAt = this.nowTs();
    this.put(message);
  }
}

/** The chat's needs-you, for areas that badge or notify on it (push): `hub.area("chat_state")`. */
export type ChatState = { needsYou(r: ProjectRef): boolean };

export const chatState = (hub: Hub) =>
  hub.area<ChatState>("chat_state", (h) => ({ needsYou: (r) => chat(h).state(r, false).needsYou }));

export { sendAsAgent } from "./flow.ts";

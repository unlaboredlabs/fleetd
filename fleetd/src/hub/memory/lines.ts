// Who taught each line of a bot's memory (`memory_lines`), and the lines held for an admin's OK (hold_rules.ts).
// A line's author is kept by its words: the lead's `remember` records the person its turn is for (none: the lead's
// own), a person's edit in the app records them for each line it adds, and an admin's Keep records whoever taught the
// held line. A row outlives its line, so a line put back (an Undo, an edit) shows who taught it first; the memory list
// shows only the rows of the lines a file still has. A held line lives in its chat line (`remembered.hold`), the one
// thing the admin's needs-you and Keep read, and is written to memory only once kept.
import type { ChatMessage, MemoryAuthor, MemoryHeld, PersonId, PersonRef, ProjectRef } from "../../shared/contracts.ts";
import type { Hub } from "../api/hub.ts";
import { administers, refOf } from "../people/roles.ts";
import { getOn } from "../people/store.ts";
import type { HubDb } from "../store/db.ts";
import { isoMs } from "../store/time.ts";
import { activePeople, linesOf } from "./index.ts";

const topicKey = (topic: string | undefined) => topic ?? "";

/** Records `person` (undefined: the lead) as who taught `text` in the project's file `topic`. */
export function taught(db: HubDb, r: ProjectRef, topic: string | undefined, text: string, person: PersonId | undefined, atMs: number): void {
  db.conn
    .query(
      `INSERT INTO memory_lines (machine_id, project_id, topic, text, person_id, at_ms) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
       ON CONFLICT (machine_id, project_id, topic, text) DO UPDATE SET person_id = excluded.person_id, at_ms = excluded.at_ms`,
    )
    .run(r.machineId, r.projectId, topicKey(topic), text, person ?? null, atMs);
}

/** A person by id as others see them, removed ones too (their lines keep their name). */
export function personRef(db: HubDb, person: PersonId): PersonRef | undefined {
  const p = getOn(db.conn, person);
  return p ? refOf(p) : undefined;
}

/** Who taught each line of the project's file `topic` that `text` (the file) still has, in the file's order. */
export function authors(db: HubDb, r: ProjectRef, topic: string | undefined, text: string): MemoryAuthor[] {
  const rows = db.all<{ text: string; person_id: string | null; at_ms: number }>(
    "SELECT text, person_id, at_ms FROM memory_lines WHERE machine_id = ?1 AND project_id = ?2 AND topic = ?3",
    [r.machineId, r.projectId, topicKey(topic)],
  );
  if (rows.length === 0) return [];
  const byText = new Map(rows.map((row) => [row.text, row]));
  const out: MemoryAuthor[] = [];
  for (const line of linesOf(text)) {
    const entry = line.trimEnd().replace(/^(- )+/, "");
    const row = byText.get(entry);
    if (!row) continue;
    byText.delete(entry);
    const by = row.person_id === null ? undefined : personRef(db, row.person_id);
    out.push({ text: entry, at: isoMs(row.at_ms), ...(by ? { by } : {}) });
  }
  return out;
}

/** Whether the workspace has an owner or admin to keep a held line. */
export const anyAdmin = (db: HubDb): boolean => activePeople(db).some((p) => p.role === "owner" || p.role === "admin");

/** The workspace's owners and admins still on it: whom a held line waits on. */
export const admins = (db: HubDb): PersonId[] => activePeople(db).flatMap((p) => (p.role === "owner" || p.role === "admin" ? [p.personId] : []));

/** Whether `person` is an owner or admin still on the workspace. */
export function isAdmin(db: HubDb, person: PersonId | undefined): boolean {
  if (person === undefined) return false;
  const p = getOn(db.conn, person);
  return p !== undefined && p.removedAt === undefined && administers(p.role);
}

/** The project's chat lines of lines held for an admin, oldest first. */
export function heldLines(db: HubDb, r: ProjectRef): ChatMessage[] {
  return db
    .all<{ data: string }>(
      `SELECT data FROM chat_messages WHERE machine_id = ?1 AND project_id = ?2
       AND json_extract(data, '$.remembered.hold') = 'waiting' ORDER BY seq LIMIT 100`,
      [r.machineId, r.projectId],
    )
    .flatMap((row) => {
      try {
        return [JSON.parse(row.data) as ChatMessage];
      } catch {
        return [];
      }
    });
}

/** A held chat line as the memory list shows it. */
export function heldOf(m: ChatMessage): MemoryHeld | undefined {
  const item = m.remembered;
  if (!item || item.hold !== "waiting") return undefined;
  return {
    messageId: m.messageId,
    text: item.text,
    at: m.createdAt,
    ...(item.topic === undefined ? {} : { topic: item.topic }),
    ...(item.replaced === undefined ? {} : { replaced: item.replaced }),
    ...(item.by === undefined ? {} : { by: item.by }),
  };
}

/** The held lines of `r` for `memory_get`. */
export const held = (hub: Hub, r: ProjectRef): MemoryHeld[] => heldLines(hub.db, r).flatMap((m) => heldOf(m) ?? []);

// The messages pinned in a bot's chat (`chat_message_pins`, `chat_message_pin`): the same for everyone in it, kept
// with who pinned each and when. A pin or an unpin announces `chat.message_pins`, which every app reading the bot's
// machine sees and answers by reading the list again. A pinned message that is gone (erased, or dropped by a migration)
// is left out of the list, and its row goes with the chat's next pin write. Nothing of it reaches the lead.
import type { ChatMessage, ChatMessagePin, PersonRef, ProjectRef } from "../../shared/contracts.ts";
import { ToolError } from "../../shared/errors.ts";
import { requireRole } from "../api/grants.ts";
import type { Hub } from "../api/hub.ts";
import type { Registry } from "../api/registry.ts";
import { events, type NewEvent } from "../store/events.ts";
import { isoMs } from "../store/time.ts";
import { firstLine } from "./find_rules.ts";
import { parse } from "./rules.ts";

/** The most pins a chat holds. */
export const CHAT_PINS_MAX = 50;

type Row = { data: string; pinned_ms: number; person_id: string; name: string };

/** The pins of `r`'s chat whose message is still there, newest pinned first. */
export function pinsOf(hub: Hub, r: ProjectRef): ChatMessagePin[] {
  return hub.db.conn
    .query<Row, [string, string]>(
      `SELECT m.data, p.pinned_ms, p.person_id, COALESCE(pp.name, p.person_name) AS name FROM chat_message_pins p
       JOIN chat_messages m ON m.n = p.message_n AND m.machine_id = p.machine_id AND m.project_id = p.project_id
       LEFT JOIN people pp ON pp.person_id = p.person_id
       WHERE p.machine_id = ?1 AND p.project_id = ?2 ORDER BY p.pinned_ms DESC, p.message_n DESC`,
    )
    .all(r.machineId, r.projectId)
    .map((row) => pinOf(parse(row.data), row.pinned_ms, { personId: row.person_id, name: row.name }));
}

function pinOf(m: ChatMessage, pinnedMs: number, by: PersonRef): ChatMessagePin {
  return {
    messageId: m.messageId,
    seq: m.seq,
    pinnedAt: isoMs(pinnedMs),
    pinnedBy: by,
    author: m.author,
    ...(m.by !== undefined ? { by: m.by } : {}),
    ...(m.person !== undefined ? { person: m.person } : {}),
    createdAt: m.createdAt,
    text: firstLine(m),
  };
}

/** Pins or unpins message `messageId` of `r`'s chat for `by`, and says whether anything changed. */
export function setPin(hub: Hub, r: ProjectRef, messageId: string, pinned: boolean, by: PersonRef): boolean {
  const c = hub.db.conn;
  if (!/^m[0-9]+$/.test(messageId)) throw notInChat(messageId);
  const n = Number(messageId.slice(1));
  const there = c
    .query<{ n: number }, [number, string, string]>("SELECT n FROM chat_messages WHERE n = ?1 AND machine_id = ?2 AND project_id = ?3")
    .get(n, r.machineId, r.projectId);
  return c.transaction(() => {
    // The rows of messages that are gone go first, so they never count against the cap.
    c.query(
      `DELETE FROM chat_message_pins WHERE machine_id = ?1 AND project_id = ?2 AND NOT EXISTS (SELECT 1 FROM chat_messages m
       WHERE m.n = chat_message_pins.message_n AND m.machine_id = ?1 AND m.project_id = ?2)`,
    ).run(r.machineId, r.projectId);
    if (!pinned) {
      return c.query("DELETE FROM chat_message_pins WHERE machine_id = ?1 AND project_id = ?2 AND message_n = ?3").run(r.machineId, r.projectId, n).changes > 0;
    }
    if (!there) throw notInChat(messageId);
    const held = c
      .query<{ k: number; has: number }, [string, string, number]>(
        "SELECT COUNT(*) AS k, COALESCE(SUM(message_n = ?3), 0) AS has FROM chat_message_pins WHERE machine_id = ?1 AND project_id = ?2",
      )
      .get(r.machineId, r.projectId, n) as { k: number; has: number };
    if (held.has > 0) return false;
    if (held.k >= CHAT_PINS_MAX) {
      throw new ToolError("invalid", `This chat already has ${CHAT_PINS_MAX} pinned messages.`, "Unpin one first.");
    }
    c.query(
      `INSERT INTO chat_message_pins (machine_id, project_id, message_n, pinned_ms, person_id, person_name)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
    ).run(r.machineId, r.projectId, n, hub.clock.now(), by.personId, by.name);
    return true;
  })();
}

const notInChat = (id: string) => new ToolError("not_found", `${id} is not a message of this chat.`);

export function register(tools: Registry): void {
  tools.add("chat_message_pins", (hub, caller, input) => {
    requireRole(caller, "read", input.projectRef.machineId);
    return { pins: pinsOf(hub, input.projectRef) };
  });

  tools.add("chat_message_pin", (hub, caller, input) => {
    const r = input.projectRef;
    requireRole(caller, "operate", r.machineId);
    const person = caller.kind === "human" ? caller.person : undefined;
    const row = person
      ? hub.db.conn.query<{ name: string; removed_ms: number | null }, [string]>("SELECT name, removed_ms FROM people WHERE person_id = ?").get(person.personId)
      : undefined;
    if (!person || !row || row.removed_ms !== null) {
      throw new ToolError("forbidden", "Only a person pins a chat's messages, from one of their own devices.", "Pin it in the fleetd app.");
    }
    const by = { personId: person.personId, name: row.name };
    if (setPin(hub, r, input.messageId, input.pinned, by)) {
      try {
        events(hub).append({
          at: isoMs(hub.clock.now()),
          type: "chat.message_pins",
          machineId: r.machineId,
          projectId: r.projectId,
          summary: input.pinned ? `${by.name} pinned a message` : `${by.name} unpinned a message`,
          data: { projectRef: r, messageId: input.messageId, pinned: input.pinned, by },
        } as NewEvent);
      } catch (error) {
        console.warn(`chat.message_pins event not recorded for ${r.machineId}/${r.projectId}:`, error);
      }
    }
    return { pins: pinsOf(hub, r) };
  });
}

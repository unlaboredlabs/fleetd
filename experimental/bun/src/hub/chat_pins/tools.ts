// `chat_pins_get` and `chat_pins_set` (crates/fleetd/src/hub/chat_pins/mod.rs): the chats a person pinned, the same on
// each of their devices. A set announces `chat.pins`, which only that person's devices see.
import type { ChatPinsSetInput } from "../../shared/contracts.ts";
import { ToolError } from "../../shared/errors.ts";
import type { Registry } from "../api/registry.ts";
import { isoMs } from "../auth/index.ts";
import { me, putRefs, refsOf } from "../sidebar_order/store.ts";
import { events, type NewEvent } from "../store/events.ts";

export function register(tools: Registry): void {
  tools.add("chat_pins_get", (hub, caller) => {
    const person = me(hub, caller);
    const kept = person === undefined ? undefined : refsOf(hub.db.conn, "chat_pins", person);
    return { set: kept !== undefined, pins: kept ?? [] };
  });

  tools.add("chat_pins_set", (hub, caller, input: ChatPinsSetInput) => {
    const person = me(hub, caller);
    if (person === undefined) {
      throw new ToolError(
        "forbidden",
        "Only a person pins chats, from one of their own devices.",
        "Pair the app as yourself, then pin a chat in its list.",
      );
    }
    putRefs(hub.db.conn, "chat_pins", person, input.pins);
    try {
      events(hub).append({
        at: isoMs(hub.clock.now()),
        type: "chat.pins",
        summary: "Pinned chats changed",
        data: { personId: person },
      } as NewEvent);
    } catch (error) {
      console.warn(`chat.pins event not recorded for ${person}:`, error);
    }
    return { pins: input.pins };
  });
}

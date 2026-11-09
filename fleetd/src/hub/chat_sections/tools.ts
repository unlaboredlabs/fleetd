// `chat_sections_get` and `chat_sections_set`: a person's own named sections of chats, the same on each of their
// devices. A set announces `chat.sections`, which only that person's devices see.
import type { ChatSection, ChatSectionsSetInput, ProjectRef } from "../../shared/contracts.ts";
import { ToolError } from "../../shared/errors.ts";
import type { Hub } from "../api/hub.ts";
import type { Caller, Registry } from "../api/registry.ts";
import { allows, isoMs } from "../auth/index.ts";
import { others, Refs } from "../navi/owner.ts";
import { me } from "../sidebar_order/store.ts";
import { events, type NewEvent } from "../store/events.ts";
import { kept, putSections, sectionsOf } from "./store.ts";

export const MAX_SECTIONS = 50;
/** A name's longest, in characters, after trimming. */
export const MAX_NAME = 40;

/** The chats `caller` has: every project still there on a machine the key reads, but another person's Only me ones. */
function theirs(hub: Hub, caller: Caller): (r: ProjectRef) => boolean {
  const navis = others(hub.db, caller);
  const there = new Refs(
    hub.db.conn
      .query<{ machine_id: string; project_id: string }, []>("SELECT machine_id, project_id FROM projects")
      .all()
      .map((p) => ({ machineId: p.machine_id, projectId: p.project_id })),
  );
  return (r) => allows(caller, "read", r.machineId) && there.has(r) && !navis.has(r);
}

/** The list as sent with its names trimmed, or the refusal for one a person can't keep. */
function named(sections: ChatSection[]): ChatSection[] {
  const refuse = (message: string, fix: string) => new ToolError("invalid", message, fix);
  if (sections.length > MAX_SECTIONS) {
    throw refuse(`At most ${MAX_SECTIONS} sections: this list has ${sections.length}.`, "Remove a section you no longer use, then try again.");
  }
  const ids = new Set<string>();
  const names = new Set<string>();
  return sections.map((s) => {
    const name = s.name.trim();
    const length = Array.from(name).length;
    if (length === 0) throw refuse("A section needs a name.", "Type a name for the section.");
    if (length > MAX_NAME) {
      throw refuse(`A section's name is at most ${MAX_NAME} characters: “${name}” has ${length}.`, "Pick a shorter name.");
    }
    if (names.has(name)) throw refuse(`Two sections are named “${name}”.`, "Pick another name, or move the chat into the section that has it.");
    if (ids.has(s.id)) throw refuse(`Two sections have the id ${s.id}.`, "Give each section an id of its own.");
    names.add(name);
    ids.add(s.id);
    return { id: s.id, name, chats: s.chats };
  });
}

export function register(tools: Registry): void {
  tools.add("chat_sections_get", (hub, caller) => {
    const person = me(hub, caller);
    // A deleted project, or one no longer theirs to see, is left out as it is read: nothing is written here.
    return { sections: person === undefined ? [] : kept(sectionsOf(hub.db.conn, person), theirs(hub, caller)) };
  });

  tools.add("chat_sections_set", (hub, caller, input: ChatSectionsSetInput) => {
    const person = me(hub, caller);
    if (person === undefined) {
      throw new ToolError(
        "forbidden",
        "Only a person keeps chat sections, from one of their own devices.",
        "Pair the app as yourself, then move a chat to a section in its list.",
      );
    }
    const sent = named(input.sections);
    const sections = hub.db.transaction((conn) => {
      const list = kept(sent, theirs(hub, caller));
      putSections(conn, person, list);
      return list;
    });
    try {
      events(hub).append({
        at: isoMs(hub.clock.now()),
        type: "chat.sections",
        summary: "Chat sections changed",
        data: { personId: person },
      } as NewEvent);
    } catch (error) {
      console.warn(`chat.sections event not recorded for ${person}:`, error);
    }
    return { sections };
  });
}

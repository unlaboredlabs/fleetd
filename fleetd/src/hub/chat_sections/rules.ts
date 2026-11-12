// A person's sections of chats as they keep them, without the database (store.ts and tools.ts read and write them):
// the limits, a list's names checked, and the sections a person still has.
import type { ChatSection, ProjectRef } from "../../shared/contracts.ts";
import { ToolError } from "../../shared/errors.ts";

export const MAX_SECTIONS = 50;
/** A name's longest, in characters, after trimming. */
export const MAX_NAME = 40;

/** The list as sent with its names trimmed, or the refusal for one a person can't keep. */
export function named(sections: ChatSection[]): ChatSection[] {
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

/**
 * `sections` as a person has them: a chat in the first section that names it only, none that `has` doesn't know, and
 * no section left without a chat.
 */
export function kept(sections: ChatSection[], has: (r: ProjectRef) => boolean): ChatSection[] {
  const seen = new Set<string>();
  const out: ChatSection[] = [];
  for (const s of sections) {
    const chats: ProjectRef[] = [];
    for (const r of s.chats) {
      const key = `${r.machineId}\u0000${r.projectId}`;
      if (seen.has(key) || !has(r)) continue;
      seen.add(key);
      chats.push({ machineId: r.machineId, projectId: r.projectId });
    }
    if (chats.length > 0) out.push({ id: s.id, name: s.name, chats });
  }
  return out;
}

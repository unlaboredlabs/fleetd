// Each person's own sections of chats: one row per person, the whole list in their order.
import type { Database } from "bun:sqlite";
import type { ChatSection, ProjectRef } from "../../shared/contracts.ts";

/** A person's sections as saved; empty until they make one. */
export function sectionsOf(db: Database, person: string): ChatSection[] {
  const row = db.query<{ sections: string }, [string]>("SELECT sections FROM chat_sections WHERE person_id = ?").get(person);
  if (!row) return [];
  try {
    const list = JSON.parse(row.sections) as ChatSection[];
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

export function putSections(db: Database, person: string, sections: ChatSection[]): void {
  const rows = sections.map((s) => ({
    id: s.id,
    name: s.name,
    chats: s.chats.map((r) => ({ machineId: r.machineId, projectId: r.projectId })),
  }));
  db.query(
    "INSERT INTO chat_sections (person_id, sections) VALUES (?, ?) ON CONFLICT (person_id) DO UPDATE SET sections = excluded.sections",
  ).run(person, JSON.stringify(rows));
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

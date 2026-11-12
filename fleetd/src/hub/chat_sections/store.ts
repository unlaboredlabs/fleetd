// Each person's own sections of chats: one row per person, the whole list in their order.
import type { Database } from "bun:sqlite";
import type { ChatSection } from "../../shared/contracts.ts";

export { kept } from "./rules.ts";

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


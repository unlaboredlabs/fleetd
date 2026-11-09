// Each person's own order of the projects and Navis in their sidebar,
// and the person a human key stands for.
import type { Database } from "bun:sqlite";
import type { ProjectRef } from "../../shared/contracts.ts";
import type { Hub } from "../api/hub.ts";
import type { Caller } from "../api/registry.ts";

/** The live person behind a human key; undefined for an agent's key or a removed person's. */
export function me(hub: Hub, caller: Caller): string | undefined {
  if (caller.kind !== "human" || !caller.person) return undefined;
  const row = hub.db.conn
    .query<{ removed_ms: number | null }, [string]>("SELECT removed_ms FROM people WHERE person_id = ?")
    .get(caller.person.personId);
  return row && row.removed_ms === null ? caller.person.personId : undefined;
}

/** A person's list of refs in `table` (`sidebar_orders` or `chat_pins`); undefined until they set one. */
export function refsOf(db: Database, table: "sidebar_orders" | "chat_pins", person: string): ProjectRef[] | undefined {
  const row = db.query<{ refs: string }, [string]>(`SELECT refs FROM ${table} WHERE person_id = ?`).get(person);
  if (!row) return undefined;
  try {
    return JSON.parse(row.refs) as ProjectRef[];
  } catch {
    return [];
  }
}

export function putRefs(db: Database, table: "sidebar_orders" | "chat_pins", person: string, refs: ProjectRef[]): void {
  db.query(
    `INSERT INTO ${table} (person_id, refs) VALUES (?, ?) ON CONFLICT (person_id) DO UPDATE SET refs = excluded.refs`,
  ).run(person, JSON.stringify(refs.map((r) => ({ machineId: r.machineId, projectId: r.projectId }))));
}

// What the hub keeps of a project beyond its node's report, in its own `project_settings` columns (D310): Only me
// (`only_me`, every former Navi's), the key that made it, its owner, when it was archived and the card it pays with
// (crates/fleetd/src/hub/navi/store.rs). A Navi is an Only me project.
import type { Database } from "bun:sqlite";
import type { PersonId, ProjectCreator, ProjectRef, Timestamp } from "../../shared/contracts.ts";
import { isoMs } from "../store/time.ts";

/** What the hub keeps of any project: its owner, maker and archive, whether Only me or not. */
export type Kept = {
  onlyMe: boolean;
  createdBy?: ProjectCreator;
  owner?: PersonId;
  archivedAt?: Timestamp;
};

type KeptRow = {
  only_me: number;
  created_by_key: string | null;
  created_by_name: string | null;
  owner_person: string | null;
  archived_ms: number | null;
};

/** Undefined for a project with no row of its own. */
export function kept(db: Database, r: ProjectRef): Kept | undefined {
  const row = db
    .query<KeptRow, [string, string]>(
      `SELECT only_me, created_by_key, created_by_name, owner_person, archived_ms FROM project_settings
         WHERE machine_id = ? AND project_id = ?`,
    )
    .get(r.machineId, r.projectId);
  if (!row) return undefined;
  const out: Kept = { onlyMe: Boolean(row.only_me) };
  if (row.created_by_key !== null) out.createdBy = { keyId: row.created_by_key, name: row.created_by_name ?? "" };
  if (row.owner_person !== null) out.owner = row.owner_person;
  if (row.archived_ms !== null) out.archivedAt = isoMs(row.archived_ms);
  return out;
}

/** The Only me projects with an owner other than `person` (every one with an owner, for undefined). */
export function others(db: Database, person: PersonId | undefined): ProjectRef[] {
  return db
    .query<{ machine_id: string; project_id: string }, [string | null]>(
      `SELECT machine_id, project_id FROM project_settings
         WHERE only_me = 1 AND owner_person IS NOT NULL AND (?1 IS NULL OR owner_person != ?1)`,
    )
    .all(person ?? null)
    .map((r) => ({ machineId: r.machine_id, projectId: r.project_id }));
}

/**
 * Turns Only me on or off. On, the project becomes `owner`'s when it has no owner yet; off, it is everyone's on the
 * hub, and keeps its owner for when it is turned on again.
 */
export function setOnlyMe(db: Database, r: ProjectRef, on: boolean, owner: PersonId | undefined): void {
  db.query(
    `INSERT INTO project_settings (machine_id, project_id, only_me, owner_person) VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT (machine_id, project_id) DO UPDATE SET only_me = excluded.only_me,
           owner_person = COALESCE(project_settings.owner_person, excluded.owner_person)`,
  ).run(r.machineId, r.projectId, on ? 1 : 0, on ? (owner ?? null) : null);
}

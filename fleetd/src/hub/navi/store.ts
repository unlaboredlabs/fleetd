// What the hub keeps of a project beyond its node's report, in its own `project_settings` columns (D310): Only me
// (`only_me`, every former Navi's), the key that made it, its owner, when it was archived and the card it pays with.
// A Navi is an Only me project.
import type { Database } from "bun:sqlite";
import type { NaviSite, PersonId, ProjectCreator, ProjectRef, Timestamp } from "../../shared/contracts.ts";
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

/** A Navi: an Only me project, with who made it and when. */
export type Navi = { createdBy: ProjectCreator; createdMs: number; archivedAt?: Timestamp; owner?: PersonId };

export function of(db: Database, r: ProjectRef): Navi | undefined {
  const row = db
    .query<
      { created_by_key: string | null; created_by_name: string | null; created_ms: number | null; archived_ms: number | null; owner_person: string | null },
      [string, string]
    >(
      `SELECT created_by_key, created_by_name, created_ms, archived_ms, owner_person FROM project_settings
         WHERE machine_id = ? AND project_id = ? AND only_me = 1`,
    )
    .get(r.machineId, r.projectId);
  if (!row) return undefined;
  return {
    createdBy: { keyId: row.created_by_key ?? "", name: row.created_by_name ?? "" },
    createdMs: row.created_ms ?? 0,
    ...(row.archived_ms !== null ? { archivedAt: isoMs(row.archived_ms) } : {}),
    ...(row.owner_person !== null ? { owner: row.owner_person } : {}),
  };
}

export function put(db: Database, r: ProjectRef, by: ProjectCreator, owner: PersonId | undefined, atMs: number): void {
  db.query(
    `INSERT INTO project_settings (machine_id, project_id, only_me, created_ms, created_by_key, created_by_name,
           owner_person) VALUES (?, ?, 1, ?, ?, ?, ?)
         ON CONFLICT (machine_id, project_id) DO UPDATE SET only_me = 1, created_ms = excluded.created_ms,
           created_by_key = excluded.created_by_key, created_by_name = excluded.created_by_name,
           owner_person = excluded.owner_person WHERE only_me = 0`,
  ).run(r.machineId, r.projectId, atMs, by.keyId, by.name, owner ?? null);
}

/** Unmarks a Navi whose folder couldn't be made: its project has nothing else yet. */
export function remove(db: Database, r: ProjectRef): void {
  db.query("DELETE FROM project_settings WHERE machine_id = ? AND project_id = ?").run(r.machineId, r.projectId);
}

/** Archives any project; undefined brings it back. */
export function setArchived(db: Database, r: ProjectRef, atMs: number | undefined): void {
  db.query(
    `INSERT INTO project_settings (machine_id, project_id, archived_ms) VALUES (?2, ?3, ?1)
         ON CONFLICT (machine_id, project_id) DO UPDATE SET archived_ms = excluded.archived_ms`,
  ).run(atMs ?? null, r.machineId, r.projectId);
}

/** Whether `r` is archived. */
export function archived(db: Database, r: ProjectRef): boolean {
  return (
    db
      .query("SELECT 1 FROM project_settings WHERE machine_id = ? AND project_id = ? AND archived_ms IS NOT NULL")
      .get(r.machineId, r.projectId) !== null
  );
}

type RefRow = { machine_id: string; project_id: string };

/** Every Navi, oldest first. */
export function all(db: Database): ProjectRef[] {
  return db
    .query<RefRow, []>("SELECT machine_id, project_id FROM project_settings WHERE only_me = 1 ORDER BY created_ms, rowid")
    .all()
    .map((r) => ({ machineId: r.machine_id, projectId: r.project_id }));
}

/** Archives `person`'s Only-me projects not archived yet, as they are removed from the hub. The ones it archived. */
export function archiveOf(db: Database, person: PersonId, atMs: number): ProjectRef[] {
  return db
    .query<RefRow, [string, number]>(
      `UPDATE project_settings SET archived_ms = ?2
         WHERE only_me = 1 AND owner_person = ?1 AND archived_ms IS NULL RETURNING machine_id, project_id`,
    )
    .all(person, atMs)
    .map((r) => ({ machineId: r.machine_id, projectId: r.project_id }));
}

/** The Only-me projects of people removed from the hub, each with its owner, oldest first. */
export function left(db: Database): [ProjectRef, PersonId][] {
  return db
    .query<RefRow & { owner_person: string }, []>(
      `SELECT s.machine_id, s.project_id, s.owner_person FROM project_settings s
         JOIN people p ON p.person_id = s.owner_person
         WHERE s.only_me = 1 AND p.removed_ms IS NOT NULL ORDER BY s.created_ms, s.rowid`,
    )
    .all()
    .map((r) => [{ machineId: r.machine_id, projectId: r.project_id }, r.owner_person]);
}

/** Gives every Navi with no owner to `person`: a hub's first owner takes the Navis from before people. */
export function adopt(db: Database, person: PersonId): void {
  db.query("UPDATE project_settings SET owner_person = ? WHERE only_me = 1 AND owner_person IS NULL").run(person);
}

/** Whether the Navi may fetch and open `site` without asking. */
export function siteAllowed(db: Database, r: ProjectRef, site: string): boolean {
  return db.query("SELECT 1 FROM navi_sites WHERE machine_id = ? AND project_id = ? AND site = ?").get(r.machineId, r.projectId, site) !== null;
}

export function allowSite(db: Database, r: ProjectRef, site: string, by: string, atMs: number): void {
  db.query(
    `INSERT INTO navi_sites (machine_id, project_id, site, allowed_ms, allowed_by) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (machine_id, project_id, site) DO NOTHING`,
  ).run(r.machineId, r.projectId, site, atMs, by);
}

export function revokeSite(db: Database, r: ProjectRef, site: string): void {
  db.query("DELETE FROM navi_sites WHERE machine_id = ? AND project_id = ? AND site = ?").run(r.machineId, r.projectId, site);
}

/** The Navi's allowed sites, by site. */
export function sites(db: Database, r: ProjectRef): NaviSite[] {
  return db
    .query<{ site: string; allowed_ms: number; allowed_by: string }, [string, string]>(
      "SELECT site, allowed_ms, allowed_by FROM navi_sites WHERE machine_id = ? AND project_id = ? ORDER BY site",
    )
    .all(r.machineId, r.projectId)
    .map((row) => ({ site: row.site, allowedAt: isoMs(row.allowed_ms), allowedBy: row.allowed_by }));
}

/** The card the Navi pays with, as its `op://vault/item` reference. */
export function card(db: Database, r: ProjectRef): string | undefined {
  return (
    db.query<{ card_ref: string | null }, [string, string]>("SELECT card_ref FROM project_settings WHERE machine_id = ? AND project_id = ?").get(r.machineId, r.projectId)
      ?.card_ref ?? undefined
  );
}

/** undefined: the Navi has no card. */
export function setCard(db: Database, r: ProjectRef, cardRef: string | undefined): void {
  db.query("UPDATE project_settings SET card_ref = ? WHERE machine_id = ? AND project_id = ?").run(cardRef ?? null, r.machineId, r.projectId);
}

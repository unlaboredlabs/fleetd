// What the hub keeps of a project beyond its node's report, in its own `project_settings` columns (D310): the key that
// made it, when it was archived, its bot's color and the card it pays with. Every project is everyone's on its hub
// (D491): `only_me` and `owner_person` are no longer read.
import type { Database } from "bun:sqlite";
import type { BotColor, ProjectSite, ProjectCreator, ProjectRef, Timestamp } from "../../shared/contracts.ts";
import { isoMs } from "../store/time.ts";

/** What the hub keeps of any project: its maker and archive. */
export type Kept = {
  createdBy?: ProjectCreator;
  archivedAt?: Timestamp;
  /** Absent: slate, the default. */
  avatarColor?: BotColor;
};

type KeptRow = {
  created_by_key: string | null;
  created_by_name: string | null;
  archived_ms: number | null;
  avatar_color: string | null;
};

/** Undefined for a project with no row of its own. */
export function kept(db: Database, r: ProjectRef): Kept | undefined {
  const row = db
    .query<KeptRow, [string, string]>(
      `SELECT created_by_key, created_by_name, archived_ms, avatar_color FROM project_settings
         WHERE machine_id = ? AND project_id = ?`,
    )
    .get(r.machineId, r.projectId);
  if (!row) return undefined;
  const out: Kept = {};
  if (row.created_by_key !== null) out.createdBy = { keyId: row.created_by_key, name: row.created_by_name ?? "" };
  if (row.archived_ms !== null) out.archivedAt = isoMs(row.archived_ms);
  if (row.avatar_color !== null) out.avatarColor = row.avatar_color;
  return out;
}

/** Gives the project's bot `color`; slate, the default, is kept as none. */
export function setAvatarColor(db: Database, r: ProjectRef, color: BotColor): void {
  db.query(
    `INSERT INTO project_settings (machine_id, project_id, avatar_color) VALUES (?1, ?2, ?3)
         ON CONFLICT (machine_id, project_id) DO UPDATE SET avatar_color = excluded.avatar_color`,
  ).run(r.machineId, r.projectId, color === "slate" ? null : color);
}

/** Records who made a new project and when. */
export function put(db: Database, r: ProjectRef, by: ProjectCreator, atMs: number): void {
  db.query(
    `INSERT INTO project_settings (machine_id, project_id, created_ms, created_by_key, created_by_name) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (machine_id, project_id) DO UPDATE SET created_ms = excluded.created_ms,
           created_by_key = excluded.created_by_key, created_by_name = excluded.created_by_name`,
  ).run(r.machineId, r.projectId, atMs, by.keyId, by.name);
}

/** Forgets a new project whose folder couldn't be made: it has nothing else yet. */
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

/** Whether the project may fetch and open `site` without asking. */
export function siteAllowed(db: Database, r: ProjectRef, site: string): boolean {
  return db.query("SELECT 1 FROM project_sites WHERE machine_id = ? AND project_id = ? AND site = ?").get(r.machineId, r.projectId, site) !== null;
}

export function allowSite(db: Database, r: ProjectRef, site: string, by: string, atMs: number): void {
  db.query(
    `INSERT INTO project_sites (machine_id, project_id, site, allowed_ms, allowed_by) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (machine_id, project_id, site) DO NOTHING`,
  ).run(r.machineId, r.projectId, site, atMs, by);
}

export function revokeSite(db: Database, r: ProjectRef, site: string): void {
  db.query("DELETE FROM project_sites WHERE machine_id = ? AND project_id = ? AND site = ?").run(r.machineId, r.projectId, site);
}

/** The project's allowed sites, by site. */
export function sites(db: Database, r: ProjectRef): ProjectSite[] {
  return db
    .query<{ site: string; allowed_ms: number; allowed_by: string }, [string, string]>(
      "SELECT site, allowed_ms, allowed_by FROM project_sites WHERE machine_id = ? AND project_id = ? ORDER BY site",
    )
    .all(r.machineId, r.projectId)
    .map((row) => ({ site: row.site, allowedAt: isoMs(row.allowed_ms), allowedBy: row.allowed_by }));
}

/** The card the project pays with, as its `op://vault/item` reference. */
export function card(db: Database, r: ProjectRef): string | undefined {
  return (
    db.query<{ card_ref: string | null }, [string, string]>("SELECT card_ref FROM project_settings WHERE machine_id = ? AND project_id = ?").get(r.machineId, r.projectId)
      ?.card_ref ?? undefined
  );
}

/** undefined: the project has no card. A project with no row of its own yet gets one. */
export function setCard(db: Database, r: ProjectRef, cardRef: string | undefined): void {
  db.query(
    `INSERT INTO project_settings (machine_id, project_id, card_ref) VALUES (?1, ?2, ?3)
         ON CONFLICT (machine_id, project_id) DO UPDATE SET card_ref = excluded.card_ref`,
  ).run(r.machineId, r.projectId, cardRef ?? null);
}

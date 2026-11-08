// A hub-kept skill's history and its use (crates/fleetd/src/hub/skills/versions.rs, W238). Every write of its SKILL.md
// keeps a version in `skill_versions` (the newest SKILL_VERSIONS_KEPT); `skill_uses` holds a skill as one project's
// sessions get it: turned off there, and when one of them last ran it.
import type { Database } from "bun:sqlite";
import type { ProjectRef, SkillAuthor, SkillScope, SkillVersion } from "../../shared/contracts.ts";
import type { HubDb } from "../store/db.ts";
import { isoMs } from "../store/time.ts";
import { isSkillName, SKILL_VERSIONS_KEPT, WHY_CAP } from "./frontmatter.ts";

/** Who writes a version, and why. */
export type Who = { author: SkillAuthor; by: string; why?: string; atMs: number };

export const person = (by: string, why: string | undefined, atMs: number): Who => ({ author: "person", by, ...(why === undefined ? {} : { why }), atMs });
export const agent = (by: string, why: string, atMs: number): Who => ({ author: "agent", by, why, atMs });

/** A scope's key in both tables: a project's machine and id, or two empty strings for the global scope. */
const key = (scope: SkillScope, r?: ProjectRef): [string, string] => (scope === "project" && r ? [r.machineId, r.projectId] : ["", ""]);

const clip = (s: string, cap: number) => [...s.split(/\s+/u).filter(Boolean).join(" ")].slice(0, cap).join("");

const COLUMNS = "version, author, by_name, why, at_ms";
type VersionRow = { version: number; author: string; by_name: string; why: string | null; at_ms: number };

const versionOf = (r: VersionRow): SkillVersion => ({
  version: r.version,
  author: r.author === "agent" ? "agent" : "person",
  by: r.by_name || "someone",
  at: isoMs(r.at_ms),
  ...(r.why ? { why: r.why } : {}),
});

/** Keeps `text` as the skill's next version; returns its number. */
export function keep(c: Database, scope: SkillScope, r: ProjectRef | undefined, name: string, text: string, who: Who): number {
  const [m, p] = key(scope, r);
  const last = c
    .query<{ v: number | null }, [string, string, string]>("SELECT MAX(version) AS v FROM skill_versions WHERE machine_id = ? AND project_id = ? AND name = ?")
    .get(m, p, name)?.v;
  const version = (last ?? 0) + 1;
  const why = who.why === undefined ? null : clip(who.why, WHY_CAP) || null;
  c.query(
    `INSERT INTO skill_versions (machine_id, project_id, name, version, author, by_name, why, text, at_ms)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(m, p, name, version, who.author, clip(who.by, 200), why, text, who.atMs);
  c.query("DELETE FROM skill_versions WHERE machine_id = ? AND project_id = ? AND name = ? AND version <= ?").run(m, p, name, version - SKILL_VERSIONS_KEPT);
  return version;
}

/** Drops a deleted skill's versions, and in a project its off switch and last use there. */
export function forget(c: Database, scope: SkillScope, r: ProjectRef | undefined, name: string): void {
  const [m, p] = key(scope, r);
  for (const table of ["skill_versions", "skill_uses"]) c.query(`DELETE FROM ${table} WHERE machine_id = ? AND project_id = ? AND name = ?`).run(m, p, name);
}

/** The projects with a row in `skill_uses` for `name`. */
export const usesOf = (c: Database, name: string): ProjectRef[] =>
  c
    .query<{ machine_id: string; project_id: string }, [string]>("SELECT machine_id, project_id FROM skill_uses WHERE name = ? AND machine_id != ''")
    .all(name)
    .map((r) => ({ machineId: r.machine_id, projectId: r.project_id }));

/** The skill's versions, newest first, without their texts. */
export function list(db: HubDb, scope: SkillScope, r: ProjectRef | undefined, name: string): SkillVersion[] {
  const [m, p] = key(scope, r);
  return db
    .all<VersionRow>(`SELECT ${COLUMNS} FROM skill_versions WHERE machine_id = ? AND project_id = ? AND name = ? ORDER BY version DESC`, [m, p, name])
    .map(versionOf);
}

export function newest(db: HubDb, scope: SkillScope, r: ProjectRef | undefined, name: string): SkillVersion | undefined {
  const [m, p] = key(scope, r);
  const row = db.all<VersionRow>(`SELECT ${COLUMNS} FROM skill_versions WHERE machine_id = ? AND project_id = ? AND name = ? ORDER BY version DESC LIMIT 1`, [m, p, name])[0];
  return row ? versionOf(row) : undefined;
}

/** One version with its text. */
export function get(db: HubDb, scope: SkillScope, r: ProjectRef | undefined, name: string, version: number): { version: SkillVersion; text: string } | undefined {
  const [m, p] = key(scope, r);
  const row = db.all<VersionRow & { text: string }>(
    `SELECT ${COLUMNS}, text FROM skill_versions WHERE machine_id = ? AND project_id = ? AND name = ? AND version = ?`,
    [m, p, name, version],
  )[0];
  return row ? { version: versionOf(row), text: row.text } : undefined;
}

/** How a project's sessions get a skill: off there, and its last use there. */
export type Use = { off: boolean; lastUsedMs?: number };

export function uses(db: HubDb, r: ProjectRef): Map<string, Use> {
  return new Map(
    db
      .all<{ name: string; off: number; last_used_ms: number | null }>("SELECT name, off, last_used_ms FROM skill_uses WHERE machine_id = ? AND project_id = ?", [
        r.machineId,
        r.projectId,
      ])
      .map((row) => [row.name, { off: row.off !== 0, ...(row.last_used_ms === null ? {} : { lastUsedMs: row.last_used_ms }) }]),
  );
}

/** The skills turned off in any of `projects`. */
export function offIn(db: HubDb, projects: ProjectRef[]): Set<string> {
  const out = new Set<string>();
  for (const r of projects) for (const [n, u] of uses(db, r)) if (u.off) out.add(n);
  return out;
}

export function setOff(db: HubDb, r: ProjectRef, name: string, off: boolean): void {
  db.conn
    .query(
      `INSERT INTO skill_uses (machine_id, project_id, name, off) VALUES (?, ?, ?, ?)
       ON CONFLICT (machine_id, project_id, name) DO UPDATE SET off = excluded.off`,
    )
    .run(r.machineId, r.projectId, name, off ? 1 : 0);
}

export function used(db: HubDb, r: ProjectRef, name: string, atMs: number): void {
  db.conn
    .query(
      `INSERT INTO skill_uses (machine_id, project_id, name, last_used_ms) VALUES (?, ?, ?, ?)
       ON CONFLICT (machine_id, project_id, name) DO UPDATE SET last_used_ms = excluded.last_used_ms`,
    )
    .run(r.machineId, r.projectId, name, atMs);
}

/** A session ran `ran` (`fleetd:<name>`) with the Skill tool: its project's last use of it is now. */
export function ran(db: HubDb, thread: { machineId: string; threadId: string }, ranName: string, atMs: number): void {
  if (!ranName.startsWith("fleetd:") || !isSkillName(ranName.slice(7))) return;
  const project = db.all<{ project_id: string }>("SELECT project_id FROM threads WHERE machine_id = ? AND thread_id = ?", [thread.machineId, thread.threadId])[0];
  if (project) used(db, { machineId: thread.machineId, projectId: project.project_id }, ranName.slice(7), atMs);
}

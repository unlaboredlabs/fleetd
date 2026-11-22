// What the hub keeps of a project beyond its node's report, in its own `project_settings` columns (D310): the key that
// made it, when it was archived, its bot's color and shape, who merges its PRs, by which risk rules and how (its merge
// mode), and the card it pays with. Every project is everyone's on its hub (D491): `only_me` and `owner_person` are no longer read.
import type { Database } from "bun:sqlite";
import { botLookOf, type BotColor, type BotShape, type Merger, type MergeMode, type ProjectCreator, type RiskRules, type ProjectRef, type ProjectSite, type Timestamp } from "../../shared/contracts.ts";
import { isoMs } from "../store/time.ts";
import { DEFAULT_RISK_RULES } from "../train/merge_rules.ts";

/** What the hub keeps of any project: its maker and archive. */
export type Kept = {
  createdBy?: ProjectCreator;
  archivedAt?: Timestamp;
  /** Absent: grey, the default. */
  avatarColor?: BotColor;
  /** Absent: pebble, the default. */
  avatarShape?: BotShape;
  /** Its chat's tags trial is on; absent: off. */
  chatTags?: true;
  /** A person turned its issues-as-orders switch off; absent: on. */
  issueOrdersOff?: true;
  /** fleetd's merge train merges its PRs; absent: people do, the default. */
  merges?: "fleetd";
  /** Its PRs merge, then verify; absent: test, then merge, the default. */
  mergeMode?: "verify_after";
};

type KeptRow = {
  created_by_key: string | null;
  created_by_name: string | null;
  archived_ms: number | null;
  avatar_color: string | null;
  avatar_shape: string | null;
  chat_tags: number | null;
  issue_orders: number | null;
  merges: string | null;
  merge_mode: string | null;
};

/** Undefined for a project with no row of its own. */
export function kept(db: Database, r: ProjectRef): Kept | undefined {
  const row = db
    .query<KeptRow, [string, string]>(
      `SELECT created_by_key, created_by_name, archived_ms, avatar_color, avatar_shape, chat_tags, issue_orders, merges, merge_mode FROM project_settings
         WHERE machine_id = ? AND project_id = ?`,
    )
    .get(r.machineId, r.projectId);
  if (!row) return undefined;
  const out: Kept = {};
  if (row.created_by_key !== null) out.createdBy = { keyId: row.created_by_key, name: row.created_by_name ?? "" };
  if (row.archived_ms !== null) out.archivedAt = isoMs(row.archived_ms);
  if (row.avatar_color !== null) out.avatarColor = row.avatar_color;
  if (row.avatar_shape !== null) out.avatarShape = row.avatar_shape;
  if (row.chat_tags === 1) out.chatTags = true;
  if (row.issue_orders === 0) out.issueOrdersOff = true;
  if (mergerOf(row.merges) === "fleetd") out.merges = "fleetd";
  if (modeOf(row.merge_mode) === "verify_after") out.mergeMode = "verify_after";
  return out;
}

/** Whether a GitHub issue labelled `fleetd` in the bot's repos opens an order (hub/issues): on unless turned off. */
export function issueOrdersOn(db: Database, r: ProjectRef): boolean {
  const row = db
    .query<{ v: number | null }, [string, string]>("SELECT issue_orders AS v FROM project_settings WHERE machine_id = ? AND project_id = ?")
    .get(r.machineId, r.projectId);
  return row?.v !== 0;
}

/** Turns the bot's issues-as-orders switch on or off; on, the default, is kept as none. */
export function setIssueOrders(db: Database, r: ProjectRef, on: boolean): void {
  db.query(
    `INSERT INTO project_settings (machine_id, project_id, issue_orders) VALUES (?1, ?2, ?3)
         ON CONFLICT (machine_id, project_id) DO UPDATE SET issue_orders = excluded.issue_orders`,
  ).run(r.machineId, r.projectId, on ? null : 0);
}

/** Whether the project's chat tags trial is on. */
export function chatTagsOn(db: Database, r: ProjectRef): boolean {
  const row = db
    .query<{ v: number | null }, [string, string]>("SELECT chat_tags AS v FROM project_settings WHERE machine_id = ? AND project_id = ?")
    .get(r.machineId, r.projectId);
  return row?.v === 1;
}

/** A row's `merges`: NULL is people, the default for a bot made since who merges was a setting. */
const mergerOf = (v: string | null | undefined): Merger => (v === "fleetd" ? "fleetd" : "people");

/** Who merges the project's PRs: people for a project with no row of its own, as a new one has none. */
export function mergesOf(db: Database, r: ProjectRef): Merger {
  const row = db
    .query<{ v: string | null }, [string, string]>("SELECT merges AS v FROM project_settings WHERE machine_id = ? AND project_id = ?")
    .get(r.machineId, r.projectId);
  return mergerOf(row?.v);
}

/** A row's `merge_mode`: NULL is test, then merge, the default. */
const modeOf = (v: string | null | undefined): MergeMode => (v === "verify_after" ? "verify_after" : "test_first");

/** How the train merges the project's PRs: test, then merge for a project with no row of its own. */
export function mergeModeOf(db: Database, r: ProjectRef): MergeMode {
  const row = db
    .query<{ v: string | null }, [string, string]>("SELECT merge_mode AS v FROM project_settings WHERE machine_id = ? AND project_id = ?")
    .get(r.machineId, r.projectId);
  return modeOf(row?.v);
}

/** Sets how the train merges the project's PRs; test, then merge, the default, is kept as none. */
export function setMergeMode(db: Database, r: ProjectRef, mode: MergeMode): void {
  db.query(
    `INSERT INTO project_settings (machine_id, project_id, merge_mode) VALUES (?1, ?2, ?3)
         ON CONFLICT (machine_id, project_id) DO UPDATE SET merge_mode = excluded.merge_mode`,
  ).run(r.machineId, r.projectId, mode === "verify_after" ? "verify_after" : null);
}

/** Sets who merges the project's PRs; people, the default, is kept as none. */
export function setMerges(db: Database, r: ProjectRef, merges: Merger): void {
  db.query(
    `INSERT INTO project_settings (machine_id, project_id, merges) VALUES (?1, ?2, ?3)
         ON CONFLICT (machine_id, project_id) DO UPDATE SET merges = excluded.merges`,
  ).run(r.machineId, r.projectId, merges === "fleetd" ? "fleetd" : null);
}

/** The project's risk rules: the defaults until a person edits them (or for a row that can't be read). */
export function riskRulesOf(db: Database, r: ProjectRef): RiskRules {
  const row = db
    .query<{ v: string | null }, [string, string]>("SELECT merge_rules AS v FROM project_settings WHERE machine_id = ? AND project_id = ?")
    .get(r.machineId, r.projectId);
  if (!row?.v) return DEFAULT_RISK_RULES;
  try {
    const kept = JSON.parse(row.v) as Partial<RiskRules>;
    const list = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : undefined);
    return { itself: list(kept.itself) ?? DEFAULT_RISK_RULES.itself, person: list(kept.person) ?? DEFAULT_RISK_RULES.person };
  } catch {
    return DEFAULT_RISK_RULES;
  }
}

/** Replaces the project's risk rules; the defaults are kept as none. */
export function setRiskRules(db: Database, r: ProjectRef, rules: RiskRules): void {
  const same = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => x === b[i]);
  const isDefault = same(rules.itself, DEFAULT_RISK_RULES.itself) && same(rules.person, DEFAULT_RISK_RULES.person);
  db.query(
    `INSERT INTO project_settings (machine_id, project_id, merge_rules) VALUES (?1, ?2, ?3)
         ON CONFLICT (machine_id, project_id) DO UPDATE SET merge_rules = excluded.merge_rules`,
  ).run(r.machineId, r.projectId, isDefault ? null : JSON.stringify({ itself: rules.itself, person: rules.person }));
}

/** Turns the project's chat tags trial on or off; off is kept as none. */
export function setChatTags(db: Database, r: ProjectRef, on: boolean): void {
  db.query(
    `INSERT INTO project_settings (machine_id, project_id, chat_tags) VALUES (?1, ?2, ?3)
         ON CONFLICT (machine_id, project_id) DO UPDATE SET chat_tags = excluded.chat_tags`,
  ).run(r.machineId, r.projectId, on ? 1 : null);
}

/** Gives the project's bot `color`; the default (grey, or slate as an older app names it) is kept as none. */
export function setAvatarColor(db: Database, r: ProjectRef, color: BotColor, isDefault: boolean): void {
  db.query(
    `INSERT INTO project_settings (machine_id, project_id, avatar_color) VALUES (?1, ?2, ?3)
         ON CONFLICT (machine_id, project_id) DO UPDATE SET avatar_color = excluded.avatar_color`,
  ).run(r.machineId, r.projectId, isDefault ? null : color);
}

/** Gives the project's bot `shape`; pebble, the default, is kept as none. */
export function setAvatarShape(db: Database, r: ProjectRef, shape: BotShape): void {
  db.query(
    `INSERT INTO project_settings (machine_id, project_id, avatar_shape) VALUES (?1, ?2, ?3)
         ON CONFLICT (machine_id, project_id) DO UPDATE SET avatar_shape = excluded.avatar_shape`,
  ).run(r.machineId, r.projectId, shape === "pebble" ? null : shape);
}

/** Gives a new project's bot its look from its id (botLookOf), so a list of new bots looks varied; one made before keeps
 * Pebble in the color it had. Pebble and grey are kept as none, as a pick of them is. */
export function startLook(db: Database, r: ProjectRef): void {
  const { shape, color } = botLookOf(r.projectId);
  setAvatarShape(db, r, shape);
  setAvatarColor(db, r, color, color === "grey");
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

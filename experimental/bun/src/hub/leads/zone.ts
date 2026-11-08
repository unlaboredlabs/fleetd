// A person's time zone (crates/fleetd/src/hub/people/zone.rs, which the leads area and automations read): the one
// their app or phone last sent with a chat message (`people.tz`); else the hub's `policy.tz` decision, else the hub
// machine's zone, and which.
import type { ProjectRef } from "../../shared/contracts.ts";
import { hubZone, POLICY_TZ_KEY, zone } from "../attention/index.ts";
import { listDecisions } from "../ledger/repo.ts";
import type { HubDb } from "../store/db.ts";
import { zonedParts } from "../wakes/schedule.ts";

export type Zone = { tz: string; source: "device" | "policy" | "hub" };

/** The zone with how it was chosen when it isn't the person's own. */
export function told(z: Zone): string {
  if (z.source === "policy") return `${z.tz}, the hub's policy.tz: theirs isn't known yet`;
  if (z.source === "hub") return `${z.tz}, the hub machine's zone: theirs isn't known yet`;
  return z.tz;
}

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const pad = (n: number) => String(n).padStart(2, "0");

function parts(z: Zone, ms: number) {
  const t = zonedParts(ms, z.tz);
  const day = DAYS[new Date(Date.UTC(t.year, t.month - 1, t.day)).getUTCDay()] as string;
  return { ...t, dayName: day, monthName: MONTHS[t.month - 1] as string };
}

/** "Tue 3 Nov, 18:05": the instant on this zone's clock, for a list that names the zone once. */
export function short(z: Zone, ms: number): string {
  const t = parts(z, ms);
  return `${t.dayName} ${t.day} ${t.monthName}, ${pad(t.hour)}:${pad(t.minute)}`;
}

/** "Tue 3 Nov 2026, 18:05 Europe/Berlin": with the year and how the zone was chosen. */
export function stamp(z: Zone, ms: number): string {
  const t = parts(z, ms);
  return `${t.dayName} ${t.day} ${t.monthName} ${t.year}, ${pad(t.hour)}:${pad(t.minute)} ${told(z)}`;
}

function policyOn(db: HubDb): string | undefined {
  try {
    const d = listDecisions(db.conn, { scope: { kind: "global" }, limit: 500 }).find((x) => x.key === POLICY_TZ_KEY);
    return d ? zone(d.value.trim()) : undefined;
  } catch {
    return undefined;
  }
}

const ownerOn = (db: HubDb) =>
  db.all<{ person_id: string }>("SELECT person_id FROM people WHERE role = 'owner' AND removed_ms IS NULL ORDER BY created_ms, rowid LIMIT 1")[0]?.person_id;

/** Keeps `tz` as the zone of `person` (undefined: the hub's owner), from a chat message their device sent. */
export function setZone(db: HubDb, person: string | undefined, tz: string): void {
  const id = person ?? ownerOn(db);
  if (id !== undefined) db.conn.query("UPDATE people SET tz = ? WHERE person_id = ? AND tz IS NOT ?").run(tz, id, tz);
}

/** The zone of `person` (undefined: the hub's owner): their device's, else `policy.tz`, else the hub machine's. */
export function ofPerson(db: HubDb, person: string | undefined): Zone {
  try {
    const id = person ?? ownerOn(db);
    const own = id === undefined ? undefined : db.all<{ tz: string | null }>("SELECT tz FROM people WHERE person_id = ?", [id])[0]?.tz;
    const mine = own ? zone(own) : undefined;
    if (mine) return { tz: mine, source: "device" };
    const policy = policyOn(db);
    if (policy) return { tz: policy, source: "policy" };
  } catch {
    // The hub machine's zone, as on a store error.
  }
  return { tz: hubZone(), source: "hub" };
}

/** The zone of the person who last wrote in `r`'s chat (none yet: the hub's owner). */
export function ofChat(db: HubDb, r: ProjectRef): Zone {
  let person: string | undefined;
  try {
    const row = db.all<{ data: string }>(
      `SELECT data FROM chat_messages WHERE machine_id = ?1 AND project_id = ?2
         AND json_valid(data) AND json_extract(data, '$.author') = 'human'
       ORDER BY seq DESC LIMIT 1`,
      [r.machineId, r.projectId],
    )[0];
    person = row ? (JSON.parse(row.data) as { person?: { personId?: string } }).person?.personId : undefined;
  } catch {
    person = undefined;
  }
  return ofPerson(db, person);
}

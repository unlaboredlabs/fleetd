// The people reads and the `people.changed` announcement this area's tools need (crates/fleetd/src/hub/people/mod.rs
// `get_on`, `active`, `owner_on`; people/tools.rs `administrator`, `account_removed`), with the Rust SQL. The people
// area itself is ported elsewhere; these only read its table.
import type { Database } from "bun:sqlite";
import type { HubRole, Person, PersonRef } from "../../shared/contracts.ts";
import { ToolError } from "../../shared/errors.ts";
import type { Hub } from "../api/hub.ts";
import type { Caller } from "../api/registry.ts";
import { allows } from "../auth/index.ts";
import { events } from "../store/events.ts";
import { isoMs } from "../store/time.ts";

const COLUMNS = "person_id, name, role, created_ms, removed_ms";
type Row = { person_id: string; name: string; role: string; created_ms: number; removed_ms: number | null };

/** An unreadable role grants the least, never more. */
export const roleOf = (text: string): HubRole => (text === "owner" || text === "admin" ? text : "member");
export const administers = (role: HubRole) => role === "owner" || role === "admin";

function cleanName(name: string): string {
  const kept = [...name.trim()].filter((c) => !/\p{Cc}/u.test(c)).slice(0, 80).join("").trim();
  return kept.length > 0 ? kept : "Owner";
}

function read(row: Row): Person {
  return {
    personId: row.person_id,
    name: cleanName(row.name),
    role: roleOf(row.role),
    createdAt: isoMs(row.created_ms),
    ...(row.removed_ms !== null ? { removedAt: isoMs(row.removed_ms) } : {}),
  };
}

export function personGet(db: Database, id: string): Person | undefined {
  const row = db.query<Row, [string]>(`SELECT ${COLUMNS} FROM people WHERE person_id = ?`).get(id);
  return row ? read(row) : undefined;
}

/** Everyone still on the hub, oldest first. */
export const activePeople = (db: Database): Person[] =>
  db.query<Row, []>(`SELECT ${COLUMNS} FROM people WHERE removed_ms IS NULL ORDER BY created_ms, rowid`).all().map(read);

/** The first owner still on the hub. */
export function ownerOn(db: Database): Person | undefined {
  const row = db
    .query<Row, []>(`SELECT ${COLUMNS} FROM people WHERE role = 'owner' AND removed_ms IS NULL ORDER BY created_ms, rowid LIMIT 1`)
    .get();
  return row ? read(row) : undefined;
}

export const refOf = (p: Person): PersonRef => ({ personId: p.personId, name: p.name });

/** Some grant of the caller's gives `role` on every machine (api/grants.rs `allows_everywhere`). */
export const allowsEverywhere = (caller: Caller, role: "admin" | "operate" | "read") =>
  caller.grants.some((g) => g.machines === "*" && allows({ ...caller, grants: [g] }, role));

/** The owner or admin behind a human key with admin everywhere; undefined for anyone else. */
export function administrator(hub: Hub, caller: Caller): Person | undefined {
  if (caller.kind !== "human" || !caller.person) return undefined;
  const person = personGet(hub.db.conn, caller.person.personId);
  return person && administers(person.role) && allowsEverywhere(caller, "admin") ? person : undefined;
}

/** The person behind a human key, still on the hub: only a person keeps an account of their own. */
export function me(hub: Hub, caller: Caller, refusal: ToolError): Person {
  const person = caller.kind === "human" && caller.person ? personGet(hub.db.conn, caller.person.personId) : undefined;
  if (!person || person.removedAt !== undefined) throw refusal;
  return person;
}

/** `people.changed` for one of `person`'s accounts removed: every open app reads the Hub's people again. */
export function accountRemoved(hub: Hub, person: PersonRef, what: string): void {
  try {
    events(hub).append({
      at: isoMs(hub.clock.now()),
      type: "people.changed",
      summary: `${person.name} removed their ${what}`,
      data: { change: "account_removed", person, by: person },
    });
  } catch (e) {
    console.warn("people.changed event not recorded:", e);
  }
}

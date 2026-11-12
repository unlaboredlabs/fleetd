// The hub's people (table `people`): who is behind each human key,
// with a hub role. A hub has at least one owner, made at its first start from the machine's user; an older hub's
// human keys all bind to it, so a one-person hub reads exactly as before.
import type { Database } from "bun:sqlite";
import type { HubRole, Person, PersonId, PersonRef } from "../../shared/contracts.ts";
import type { Hub } from "../api/hub.ts";
import { base32 } from "../auth/nodes.ts";
import type { HubDb } from "../store/db.ts";
import { isoMs } from "../store/time.ts";
import { cleanName, OWNER_FALLBACK, roleOf } from "./roles.ts";

/** Read from `people`; the last, their picture's id, from `person_avatars`. */
const COLUMNS =
  "person_id, name, role, created_ms, removed_ms, (SELECT avatar FROM person_avatars a WHERE a.person_id = people.person_id) AS avatar";

type PersonRow = {
  person_id: string;
  name: string;
  role: string;
  created_ms: number;
  removed_ms: number | null;
  avatar: string | null;
};

const newId = () => `p_${base32(crypto.getRandomValues(new Uint8Array(5)))}`;

function readRow(row: PersonRow): Person {
  return {
    ...(row.avatar === null ? {} : { avatar: row.avatar }),
    createdAt: isoMs(row.created_ms),
    name: cleanName(row.name) ?? OWNER_FALLBACK,
    personId: row.person_id,
    ...(row.removed_ms === null ? {} : { removedAt: isoMs(row.removed_ms) }),
    role: roleOf(row.role),
  };
}

export const refOf = (p: Person): PersonRef => ({ name: p.name, personId: p.personId });

export function getOn(c: Database, id: string): Person | undefined {
  const row = c.query<PersonRow, [string]>(`SELECT ${COLUMNS} FROM people WHERE person_id = ?`).get(id);
  return row ? readRow(row) : undefined;
}

/** The first owner still on the hub. */
export function ownerOn(c: Database): Person | undefined {
  const row = c
    .query<PersonRow, []>(
      `SELECT ${COLUMNS} FROM people WHERE role = 'owner' AND removed_ms IS NULL ORDER BY created_ms, rowid LIMIT 1`,
    )
    .get();
  return row ? readRow(row) : undefined;
}

/** The machine user's name, for the owner a hub makes for itself. */
export function machineUser(): string {
  for (const name of ["USER", "LOGNAME", "USERNAME"]) {
    const value = process.env[name];
    if (value !== undefined && value.trim() !== "") return value;
  }
  return OWNER_FALLBACK;
}

/** `People::ensure_owner` inside a transaction. */
export function ensureOwnerOn(c: Database, name: string, now: number): Person {
  let owner = ownerOn(c);
  if (!owner) {
    const id = newId();
    c.query("INSERT INTO people (person_id, name, role, created_ms) VALUES (?, ?, 'owner', ?)").run(
      id,
      cleanName(name) ?? OWNER_FALLBACK,
      now,
    );
    owner = getOn(c, id) as Person;
  }
  c.query("UPDATE agent_keys SET person_id = ? WHERE kind = 'human' AND person_id IS NULL").run(owner.personId);
  return owner;
}

/** The `people` table: `people(hub)`. */
export class People {
  constructor(
    private readonly db: HubDb,
    private readonly now: () => number,
  ) {}

  /**
   * The hub's owner, made from the machine's user when the hub has none; every human key and Navi with no person
   * binds to it. Idempotent: the hub runs it at each start, and a human key made without a person runs it too.
   */
  ensureOwner(): Person {
    const now = this.now();
    const name = machineUser();
    return this.db.transaction((c) => ensureOwnerOn(c, name, now));
  }

  get(id: PersonId): Person | undefined {
    return getOn(this.db.conn, id);
  }

  /** Oldest first. */
  list(includeRemoved: boolean): Person[] {
    return this.db
      .all<PersonRow>(`SELECT ${COLUMNS} FROM people WHERE ? OR removed_ms IS NULL ORDER BY created_ms, rowid`, [
        includeRemoved ? 1 : 0,
      ])
      .map(readRow);
  }

  /** People on the hub, removed ones left out. */
  count(): number {
    return this.db.conn.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM people WHERE removed_ms IS NULL").get()?.n ?? 0;
  }

  /**
   * The names of people who joined after the hub's first person: not removed, with a device that still works.
   * Someone invited who hasn't paired yet hasn't joined.
   */
  joined(): string[] {
    return this.db
      .all<{ name: string }>(
        `SELECT p.name FROM people p
         WHERE p.removed_ms IS NULL
           AND p.person_id != (SELECT person_id FROM people ORDER BY created_ms, rowid LIMIT 1)
           AND EXISTS (SELECT 1 FROM agent_keys k WHERE k.person_id = p.person_id AND k.kind = 'human'
                       AND k.revoked_ms IS NULL)
         ORDER BY p.created_ms, p.rowid`,
      )
      .map((r) => r.name);
  }

  create(name: string, role: HubRole): Person {
    const now = this.now();
    const person: Person = { createdAt: isoMs(now), name, personId: newId(), role };
    this.db.conn
      .query("INSERT INTO people (person_id, name, role, created_ms) VALUES (?, ?, ?, ?)")
      .run(person.personId, name, role, now);
    return person;
  }

  /** Renames a person or changes their role; undefined when there is no such person. */
  set(id: PersonId, name: string | undefined, role: HubRole | undefined): Person | undefined {
    return this.db.transaction((c) => {
      c.query("UPDATE people SET name = COALESCE(?2, name), role = COALESCE(?3, role) WHERE person_id = ?1").run(
        id,
        name ?? null,
        role ?? null,
      );
      return getOn(c, id);
    });
  }

  /**
   * Removes a person: their devices are revoked, their open invites closed and their picture forgotten. Their projects
   * stay as they are, everyone's on the hub (D491).
   * Returns the person and how many devices it revoked; undefined when there is no such person.
   */
  remove(id: PersonId): { person: Person; revoked: number } | undefined {
    const now = this.now();
    return this.db.transaction((c) => {
      c.query("UPDATE people SET removed_ms = COALESCE(removed_ms, ?2) WHERE person_id = ?1").run(id, now);
      const revoked = c
        .query("UPDATE agent_keys SET revoked_ms = ?2 WHERE person_id = ?1 AND revoked_ms IS NULL")
        .run(id, now).changes;
      c.query(
        "UPDATE pair_codes SET revoked_ms = ?2 WHERE person_id = ?1 AND used_ms IS NULL AND revoked_ms IS NULL",
      ).run(id, now);
      c.query("DELETE FROM person_avatars WHERE person_id = ?1").run(id);
      const person = getOn(c, id);
      return person ? { person, revoked } : undefined;
    });
  }

  /** Owners still on the hub. */
  owners(): number {
    return (
      this.db.conn
        .query<{ n: number }, []>("SELECT COUNT(*) AS n FROM people WHERE role = 'owner' AND removed_ms IS NULL")
        .get()?.n ?? 0
    );
  }

  /** The person a key belongs to, as records name them. */
  personRef(id: PersonId): PersonRef | undefined {
    const p = this.get(id);
    return p ? refOf(p) : undefined;
  }
}

export const people = (hub: Hub) => hub.area("people", (h) => new People(h.db, () => h.clock.now()));

/** Everyone on the hub (not removed), oldest first. */
export const active = (db: HubDb): Person[] =>
  db.all<PersonRow>(`SELECT ${COLUMNS} FROM people WHERE removed_ms IS NULL ORDER BY created_ms, rowid`).map(readRow);

/** The hub's people when there is more than one, oldest first; empty on a one-person hub. */
export function roster(db: HubDb): Person[] {
  try {
    const all = active(db);
    return all.length > 1 ? all : [];
  } catch (error) {
    console.warn("people: roster not read:", error);
    return [];
  }
}

/** Who wrote a human message, as the lead reads it: "The human" on a one-person hub, else the writer's name. */
export const writer = (db: HubDb, person: PersonRef | undefined) =>
  person !== undefined && roster(db).length > 0 ? person.name : "The human";

/** `lead.start`'s `{{people}}`: nothing on a one-person hub; else who shares the chat, with their roles. */
export function leadPeople(db: HubDb): string {
  const all = roster(db);
  if (all.length === 0) return "";
  const names = all.map((p) => `${p.name} (${p.role})`).join(", ");
  return (
    ` Several people share this hub and its chats: ${names}. "The human" below means whoever writes to you: each ` +
    "message names its writer, so answer them by name, and take an answer to a question you asked one person " +
    "from that person."
  );
}

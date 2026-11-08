// What the CLI writes to the hub's database itself, beside a running hub (SQLite WAL makes that safe): keys
// (hub/auth), people and invites (hub/people, hub/pair), the events those changes announce (hub/store/event_log) and
// the claims a revoked key releases (hub/work). Ported from those Rust modules as the CLI calls them, row for row.
import type { Database } from "bun:sqlite";
import type { Grant, Role } from "../shared/contracts.ts";
import { HubDb } from "../hub/store/db.ts";

const BASE32 = "abcdefghijklmnopqrstuvwxyz234567";
const KEY_PREFIX = "fld_";
const ENROLL_PREFIX = "fle_";
const ENROLL_TTL_MS = 15 * 60_000;
export const ENROLL_CODE_ID_LEN = 12;
const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_SUMMARY = 200;
const MAX_DATA_BYTES = 2048;

export const randomBytes = (n: number) => crypto.getRandomValues(new Uint8Array(n));

export function base32(bytes: Uint8Array): string {
  let out = "";
  let buffer = 0;
  let bits = 0;
  for (const byte of bytes) {
    buffer = ((buffer << 8) | byte) >>> 0;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(buffer >>> (bits - 5)) & 31];
      bits -= 5;
    }
    buffer &= (1 << bits) - 1;
  }
  if (bits > 0) out += BASE32[(buffer << (5 - bits)) & 31];
  return out;
}

export const secret = (prefix: string) => `${prefix}${base32(randomBytes(32))}`;
export const sha256 = (text: string) => new Bun.CryptoHasher("sha256").update(text).digest("hex");
export const isoMs = (ms: number) => new Date(ms).toISOString();

/** The hub home's database, opened beside a running hub. */
export function openHub(home: string): HubDb {
  try {
    return HubDb.open(home);
  } catch (error) {
    throw new Error((error as Error).message);
  }
}

// ---- keys ----

export type KeyInfo = {
  keyId: string;
  name: string;
  kind?: "human";
  prefix: string;
  grants: Grant[];
  createdAt: string;
  lastUsedAt?: string;
  revokedAt?: string;
  person?: { personId: string; name: string };
};

const KEY_COLUMNS = `k.key_id, k.name, k.kind, k.prefix, k.grants, k.created_ms, k.last_used_ms, k.revoked_ms,
  p.person_id, p.name AS person_name, p.role AS person_role`;
const KEY_FROM = "agent_keys k LEFT JOIN people p ON p.person_id = k.person_id";

type KeyRow = {
  key_id: string;
  name: string;
  kind: string;
  prefix: string;
  grants: string;
  created_ms: number;
  last_used_ms: number | null;
  revoked_ms: number | null;
  person_id: string | null;
  person_name: string | null;
  person_role: string | null;
};

const RANK: Record<Role, number> = { read: 0, operate: 1, admin: 2 };

function keyInfo(row: KeyRow): KeyInfo {
  let grants = JSON.parse(row.grants) as Grant[];
  if (row.person_id !== null) {
    // A device never holds more than its person's role allows (people `capped`, `role_cap`).
    const cap: Role = row.person_role === "owner" || row.person_role === "admin" ? "admin" : "operate";
    grants = grants.map((g) => ({ role: RANK[g.role] <= RANK[cap] ? g.role : cap, machines: g.machines }));
  }
  return {
    keyId: row.key_id,
    name: row.name,
    ...(row.kind === "human" ? { kind: "human" as const } : {}),
    prefix: row.prefix,
    grants,
    createdAt: isoMs(row.created_ms),
    ...(row.last_used_ms === null ? {} : { lastUsedAt: isoMs(row.last_used_ms) }),
    ...(row.revoked_ms === null ? {} : { revokedAt: isoMs(row.revoked_ms) }),
    ...(row.person_id === null
      ? {}
      : { person: { personId: row.person_id, name: cleanName(row.person_name ?? "") ?? "Owner" } }),
  };
}

/** `grants` as serde writes them: `[{"role":"admin","machines":"*"}]`. */
const grantsJson = (grants: Grant[]) => JSON.stringify(grants.map((g) => ({ role: g.role, machines: g.machines })));

/** A key; a human key belongs to the hub's owner unless `person` names someone. */
export function createKey(
  db: HubDb,
  name: string,
  grants: Grant[],
  kind: "agent" | "human",
  person?: string,
): { info: KeyInfo; key: string } {
  const personId = kind === "agent" ? null : (person ?? ensureOwner(db).personId);
  const now = Date.now();
  const key = secret(KEY_PREFIX);
  const keyId = `key_${base32(randomBytes(5))}`;
  db.conn
    .query(
      `INSERT INTO agent_keys (key_id, hash, prefix, name, grants, created_ms, kind, person_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(keyId, sha256(key), key.slice(0, KEY_PREFIX.length + 6), name, grantsJson(grants), now, kind, personId);
  return { info: getKey(db, keyId)!, key };
}

export function getKey(db: HubDb, keyId: string): KeyInfo | undefined {
  const row = db.conn.query<KeyRow, [string]>(`SELECT ${KEY_COLUMNS} FROM ${KEY_FROM} WHERE k.key_id = ?`).get(keyId);
  return row ? keyInfo(row) : undefined;
}

export function listKeys(db: HubDb): KeyInfo[] {
  return db.conn
    .query<KeyRow, []>(`SELECT ${KEY_COLUMNS} FROM ${KEY_FROM} ORDER BY k.created_ms, k.key_id`)
    .all()
    .map(keyInfo);
}

/** Revokes a key and the hub links minted from it; how many links were still live. Throws when there is no key. */
export function revokeKey(db: HubDb, keyId: string): number {
  const now = Date.now();
  const [changed, links] = db.transaction((c) => {
    const changed = c.query("UPDATE agent_keys SET revoked_ms = COALESCE(revoked_ms, ?) WHERE key_id = ?").run(now, keyId)
      .changes;
    const links = c
      .query("UPDATE hub_links_issued SET revoked_ms = ? WHERE key_id = ? AND revoked_ms IS NULL")
      .run(now, keyId).changes;
    return [changed, links];
  });
  if (changed === 0) throw new Error(`no agent key ${keyId}; run \`fleetd hub key list\` to see key ids`);
  return links;
}

/** Whether `key` is a live key of this hub (hub/auth `verify`, without its last-used write). */
export function keyWorks(db: HubDb, key: string): boolean {
  if (!/^fld_[a-z2-7]{52}$/.test(key)) return false;
  const row = db.conn
    .query<{ revoked_ms: number | null; removed: number | null }, [string]>(
      `SELECT k.revoked_ms, p.removed_ms AS removed FROM agent_keys k LEFT JOIN people p ON p.person_id = k.person_id
       WHERE k.hash = ?`,
    )
    .get(sha256(key));
  return row !== null && row.revoked_ms === null && row.removed === null;
}

// ---- enroll codes ----

/** One-time, valid for 15 minutes; it replaces the machine's open one. */
export function createEnrollToken(db: HubDb, machineId: string): { token: string; expiresAt: string } {
  const now = Date.now();
  const expires = now + ENROLL_TTL_MS;
  const token = secret(ENROLL_PREFIX);
  db.transaction((c) => {
    c.query("DELETE FROM enroll_tokens WHERE machine_id = ? AND used_ms IS NULL AND expires_ms > ?").run(machineId, now);
    c.query("INSERT INTO enroll_tokens (hash, machine_id, expires_ms, pool) VALUES (?, ?, ?, 0)").run(
      sha256(token),
      machineId,
      expires,
    );
  });
  return { token, expiresAt: isoMs(expires) };
}

export type OpenEnrollCode = { id: string; machineId: string; createdAt: string; expiresAt: string; pool: boolean };

export function openEnrollTokens(db: HubDb): OpenEnrollCode[] {
  return db.conn
    .query<{ id: string; machine_id: string; expires_ms: number; pool: number }, [number, number]>(
      `SELECT substr(hash, 1, ?1) AS id, machine_id, expires_ms, pool FROM enroll_tokens
       WHERE used_ms IS NULL AND expires_ms > ?2 ORDER BY expires_ms, hash`,
    )
    .all(ENROLL_CODE_ID_LEN, Date.now())
    .map((r) => ({
      id: r.id,
      machineId: r.machine_id,
      createdAt: isoMs(r.expires_ms - ENROLL_TTL_MS),
      expiresAt: isoMs(r.expires_ms),
      pool: r.pool !== 0,
    }));
}

/** Takes back the open enroll code `id` names; the machine it was for, or undefined. */
export function revokeEnrollToken(db: HubDb, id: string): string | undefined {
  const row = db.conn
    .query<{ machine_id: string }, [number, string, number]>(
      `DELETE FROM enroll_tokens WHERE substr(hash, 1, ?1) = ?2 AND length(?2) = ?1
       AND used_ms IS NULL AND expires_ms > ?3 RETURNING machine_id`,
    )
    .get(ENROLL_CODE_ID_LEN, id, Date.now());
  return row?.machine_id;
}

// ---- people ----

export type HubRole = "owner" | "admin" | "member";
export type Person = { personId: string; name: string; role: HubRole; createdAt: string; removedAt?: string };

/** Trimmed, control characters dropped, at most 80 characters; undefined when nothing is left. */
export function cleanName(name: string): string | undefined {
  // Rust's char::is_control is the Cc category.
  const kept = [...name.trim()].filter((c) => !/\p{Cc}/u.test(c)).slice(0, 80).join("").trim();
  return kept === "" || /[\r\n]/.test(kept) ? undefined : kept;
}

const roleOf = (text: string): HubRole => (text === "owner" || text === "admin" ? text : "member");
const PEOPLE_COLUMNS = "person_id, name, role, created_ms, removed_ms";
type PersonRow = { person_id: string; name: string; role: string; created_ms: number; removed_ms: number | null };
const person = (r: PersonRow): Person => ({
  personId: r.person_id,
  name: cleanName(r.name) ?? "Owner",
  role: roleOf(r.role),
  createdAt: isoMs(r.created_ms),
  ...(r.removed_ms === null ? {} : { removedAt: isoMs(r.removed_ms) }),
});

const getOn = (c: Database, id: string) => {
  const row = c.query<PersonRow, [string]>(`SELECT ${PEOPLE_COLUMNS} FROM people WHERE person_id = ?`).get(id);
  return row ? person(row) : undefined;
};

/** The hub's owner, made from the machine's user when the hub has none. */
export function ensureOwner(db: HubDb): Person {
  const now = Date.now();
  const user = ["USER", "LOGNAME", "USERNAME"].map((v) => process.env[v]).find((v) => v && v.trim()) ?? "Owner";
  return db.transaction((c) => {
    let owner = c
      .query<PersonRow, []>(
        `SELECT ${PEOPLE_COLUMNS} FROM people WHERE role = 'owner' AND removed_ms IS NULL ORDER BY created_ms, rowid LIMIT 1`,
      )
      .get();
    if (!owner) {
      const id = `p_${base32(randomBytes(5))}`;
      c.query("INSERT INTO people (person_id, name, role, created_ms) VALUES (?, ?, 'owner', ?)").run(
        id,
        cleanName(user) ?? "Owner",
        now,
      );
      owner = c.query<PersonRow, [string]>(`SELECT ${PEOPLE_COLUMNS} FROM people WHERE person_id = ?`).get(id)!;
    }
    c.query("UPDATE agent_keys SET person_id = ? WHERE kind = 'human' AND person_id IS NULL").run(owner.person_id);
    c.query("UPDATE project_settings SET owner_person = ? WHERE only_me = 1 AND owner_person IS NULL").run(owner.person_id);
    return person(owner);
  });
}

export const getPerson = (db: HubDb, id: string) => getOn(db.conn, id);

export function listPeople(db: HubDb, includeRemoved: boolean): Person[] {
  return db.conn
    .query<PersonRow, [number]>(
      `SELECT ${PEOPLE_COLUMNS} FROM people WHERE ?1 OR removed_ms IS NULL ORDER BY created_ms, rowid`,
    )
    .all(includeRemoved ? 1 : 0)
    .map(person);
}

export function createPerson(db: HubDb, name: string, role: HubRole): Person {
  const now = Date.now();
  const id = `p_${base32(randomBytes(5))}`;
  db.conn.query("INSERT INTO people (person_id, name, role, created_ms) VALUES (?, ?, ?, ?)").run(id, name, role, now);
  return { personId: id, name, role, createdAt: isoMs(now) };
}

export function setPersonRole(db: HubDb, id: string, role: HubRole): Person | undefined {
  return db.transaction((c) => {
    c.query("UPDATE people SET role = COALESCE(?2, role) WHERE person_id = ?1").run(id, role);
    return getOn(c, id);
  });
}

/** Removes a person: devices revoked, open invites closed, Only-me projects archived. How many devices went. */
export function removePerson(db: HubDb, id: string): [Person, number] | undefined {
  const now = Date.now();
  return db.transaction((c) => {
    c.query("UPDATE people SET removed_ms = COALESCE(removed_ms, ?2) WHERE person_id = ?1").run(id, now);
    const revoked = c.query("UPDATE agent_keys SET revoked_ms = ?2 WHERE person_id = ?1 AND revoked_ms IS NULL").run(id, now)
      .changes;
    c.query(
      "UPDATE pair_codes SET revoked_ms = ?2 WHERE person_id = ?1 AND used_ms IS NULL AND revoked_ms IS NULL",
    ).run(id, now);
    c.query(
      "UPDATE project_settings SET archived_ms = ?2 WHERE only_me = 1 AND owner_person = ?1 AND archived_ms IS NULL",
    ).run(id, now);
    const p = getOn(c, id);
    return p ? ([p, revoked] as [Person, number]) : undefined;
  });
}

export function owners(db: HubDb): number {
  return db.conn
    .query<{ n: number }, []>("SELECT COUNT(*) AS n FROM people WHERE role = 'owner' AND removed_ms IS NULL")
    .get()!.n;
}

// ---- pairing codes and invites (hub/pair) ----

const CODE_TTL_MS = 15 * 60_000;
const INVITE_TTL_MS = 7 * 24 * 60 * 60_000;
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** A fresh code, `XXXX-XXXX`: 40 random bits. */
export function newCode(): string {
  const bits = [...randomBytes(5)].reduce((acc, b) => acc * 256n + BigInt(b), 0n);
  let chars = "";
  for (let i = 7; i >= 0; i--) chars += ALPHABET[Number((bits >> BigInt(i * 5)) & 31n)];
  return `${chars.slice(0, 4)}-${chars.slice(4)}`;
}

const canon = (code: string) => code.replace("-", "");

export type Invite = {
  inviteId: string;
  person: { personId: string; name: string };
  state: "open" | "used" | "revoked" | "expired";
  createdAt: string;
  expiresAt: string;
};

/** One-time, valid for 15 minutes: `name` names the key when the device sends none. */
export function createPairCode(db: HubDb, name: string | undefined, role: Role, personId?: string) {
  const now = Date.now();
  const expires = now + CODE_TTL_MS;
  const code = newCode();
  db.conn
    .query("INSERT INTO pair_codes (hash, name, expires_ms, role, created_ms, person_id) VALUES (?, ?, ?, ?, ?, ?)")
    .run(sha256(canon(code)), name ?? null, expires, role, now, personId ?? null);
  return { code, expiresAt: isoMs(expires) };
}

const INVITE_QUERY = `SELECT c.invite_id, c.person_id, p.name, c.created_ms, c.expires_ms, c.used_ms, c.revoked_ms
  FROM pair_codes c LEFT JOIN people p ON p.person_id = c.person_id`;
type InviteRow = {
  invite_id: string;
  person_id: string | null;
  name: string | null;
  created_ms: number | null;
  expires_ms: number;
  used_ms: number | null;
  revoked_ms: number | null;
};
const invite = (r: InviteRow, now: number): Invite => ({
  inviteId: r.invite_id,
  person: { personId: r.person_id ?? "", name: cleanName(r.name ?? "") ?? "someone" },
  state: r.used_ms !== null ? "used" : r.revoked_ms !== null ? "revoked" : r.expires_ms <= now ? "expired" : "open",
  createdAt: isoMs(r.created_ms ?? r.expires_ms - INVITE_TTL_MS),
  expiresAt: isoMs(r.expires_ms),
});

export function createInvite(db: HubDb, personId: string) {
  const now = Date.now();
  const expires = now + INVITE_TTL_MS;
  const code = newCode();
  const inviteId = `inv_${base32(randomBytes(5))}`;
  db.conn
    .query(
      `INSERT INTO pair_codes (hash, name, expires_ms, role, created_ms, person_id, invite_id, created_by)
       VALUES (?, NULL, ?, 'admin', ?, ?, ?, NULL)`,
    )
    .run(sha256(canon(code)), expires, now, personId, inviteId);
  return { minted: { code, expiresAt: isoMs(expires) }, inviteId };
}

/** Open invites, newest first. */
export function openInvites(db: HubDb): Invite[] {
  const now = Date.now();
  return db.conn
    .query<InviteRow, [number]>(
      `${INVITE_QUERY} WHERE c.invite_id IS NOT NULL AND (c.used_ms IS NULL AND c.revoked_ms IS NULL AND c.expires_ms > ?1)
       ORDER BY c.created_ms DESC, c.invite_id`,
    )
    .all(now)
    .map((r) => invite(r, now));
}

/** Takes an open invite back: the invite, and whether this call revoked it. */
export function revokeInvite(db: HubDb, id: string): [Invite, boolean] | undefined {
  const now = Date.now();
  const changed = db.conn
    .query("UPDATE pair_codes SET revoked_ms = ?2 WHERE invite_id = ?1 AND used_ms IS NULL AND revoked_ms IS NULL")
    .run(id, now).changes;
  const row = db.conn.query<InviteRow, [string]>(`${INVITE_QUERY} WHERE c.invite_id = ?`).get(id);
  return row ? [invite(row, now), changed > 0] : undefined;
}

// ---- events ----

/** Appends one event to the hub's log, as hub/store/event_log `append` stores it. */
export function appendEvent(
  db: HubDb,
  event: { type: string; machineId?: string; projectId?: string; summary: string; data?: unknown },
) {
  const now = Date.now();
  db.conn.query("DELETE FROM events WHERE created_ms < ?").run(now - RETENTION_MS);
  let summary = event.summary;
  if (summary.length > MAX_SUMMARY) {
    let units = 0;
    let cut = "";
    for (const c of summary) {
      units += c.length;
      if (units >= MAX_SUMMARY) break;
      cut += c;
    }
    summary = `${cut}…`;
  }
  let data = event.data;
  if (data !== undefined && Buffer.byteLength(JSON.stringify(data)) > MAX_DATA_BYTES) data = { truncated: true };
  const stored = {
    at: isoMs(now),
    type: event.type,
    ...(event.machineId === undefined ? {} : { machineId: event.machineId }),
    ...(event.projectId === undefined ? {} : { projectId: event.projectId }),
    summary,
    ...(data === undefined ? {} : { data }),
  };
  db.conn
    .query("INSERT INTO events (created_ms, type, machine_id, data) VALUES (?, ?, ?, ?)")
    .run(now, event.type, event.machineId ?? null, JSON.stringify(stored));
}

/** `people.changed` (hub/people/tools `announce`). */
export function announcePeople(
  db: HubDb,
  change: string,
  who: { personId: string; name: string },
  summary: string,
  inviteId?: string,
) {
  const data = {
    change,
    person: { personId: who.personId, name: who.name },
    ...(inviteId === undefined ? {} : { inviteId }),
  };
  appendEvent(db, { type: "people.changed", summary, data });
}

// ---- work claims (hub/work `release_owner`) ----

const CLAIM_ORDER = [
  "claimId",
  "repoKey",
  "base",
  "projectRef",
  "owner",
  "title",
  "keys",
  "branch",
  "paths",
  "observed",
  "authorEmail",
  "state",
  "end",
  "createdAt",
  "renewedAt",
  "expiresAt",
];

/** Releases the active claims a key holds; their ids. */
export function releaseClaims(db: HubDb, keyId: string, reason: string): string[] {
  const now = Date.now();
  const released = db.transaction((c) => {
    const rows = c
      .query<{ data: string }, [string]>(
        "SELECT data FROM work_claims WHERE state = 'active' AND owner_key = ? ORDER BY n",
      )
      .all(keyId);
    return rows.map(({ data }) => {
      const claim = JSON.parse(data);
      claim.state = "released";
      claim.end = { at: isoMs(now), reason: [...reason].slice(0, 200).join("") };
      const ordered: Record<string, unknown> = {};
      for (const k of CLAIM_ORDER) if (claim[k] !== undefined && claim[k] !== null) ordered[k] = claim[k];
      c.query("UPDATE work_claims SET state = ?, expires_ms = ?, ended_ms = ?, data = ? WHERE n = ?").run(
        "released",
        Date.parse(claim.expiresAt) || 0,
        now,
        JSON.stringify(ordered),
        Number(String(claim.claimId).slice(1)),
      );
      return ordered as any;
    });
  });
  for (const claim of released) {
    const data = {
      claimId: claim.claimId,
      repoKey: claim.repoKey,
      base: claim.base,
      ...(claim.projectRef ? { projectRef: claim.projectRef } : {}),
      ownerKind: claim.owner?.kind,
      state: "released",
      reason: claim.end.reason,
    };
    appendEvent(db, {
      type: "work.ended",
      ...(claim.projectRef ? { machineId: claim.projectRef.machineId, projectId: claim.projectRef.projectId } : {}),
      summary: [...`${claim.claimId} was released: ${claim.title}`].slice(0, 200).join(""),
      data,
    });
  }
  return released.map((c) => c.claimId);
}

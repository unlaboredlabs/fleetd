// The `pair_codes` table (mac.rs): one-time `XXXX-XXXX` codes a
// device trades at POST /pair for a human key, invites (a code bound to a person, valid 7 days), and the agents'
// Mac's six-digit setup codes (a row with `machine_id` set).
import type { Invite, InviteState, MacCodeState, Person, PersonId, Role } from "../../shared/contracts.ts";
import { ENROLL_CODE_ID_LEN, SPENT_CODE_KEPT_MS, base32 } from "../auth/nodes.ts";
import { sha256 } from "../auth/index.ts";
import { cleanName } from "../people/roles.ts";
import type { HubDb } from "../store/db.ts";
import { isoMs } from "../store/time.ts";
import type { Database } from "bun:sqlite";

export const CODE_TTL_MS = 15 * 60_000;
/** An invite travels by chat or email, so it lives longer than a code read off the hub machine's screen. */
export const INVITE_TTL_MS = 7 * 24 * 60 * 60_000;
/** Crockford base32: no I, L, O or U, so a code read aloud or off a screen can't be misread. */
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const CODE_LEN = 8;
/** What `fleetd pair` grants without `--role`. */
export const DEFAULT_ROLE: Role = "admin";

export const MAC_CODE_TTL_MS = 10 * 60_000;
/** Wrong codes tried while a code is open, from every address together, before it closes. */
export const MAX_CODE_FAILURES = 10;
/** The machine id of a hub's first agents' Mac. */
export const FIRST_MAC = "mac";

/** A fresh code, `XXXX-XXXX`: 40 random bits. */
export function newCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(5));
  let bits = 0n;
  for (const b of bytes) bits = (bits << 8n) | BigInt(b);
  let chars = "";
  for (let i = CODE_LEN - 1; i >= 0; i--) chars += ALPHABET[Number((bits >> BigInt(i * 5)) & 31n)];
  return `${chars.slice(0, 4)}-${chars.slice(4)}`;
}

/**
 * The code's 8 canonical characters: any case, the hyphen and surrounding spaces optional, and the look-alikes
 * Crockford decodes (I and L as 1, O as 0) accepted. Undefined when it can't be a code.
 */
export function normalize(input: string): string | undefined {
  const trimmed = input.trim();
  const dash = trimmed.indexOf("-");
  let body: string;
  if (dash >= 0) {
    // Rust's `len()` counts bytes.
    if (Buffer.byteLength(trimmed.slice(0, dash)) !== 4) return undefined;
    body = trimmed.slice(0, dash) + trimmed.slice(dash + 1);
  } else body = trimmed;
  let canon = "";
  for (const c of body) {
    const up = /^[a-z]$/.test(c) ? c.toUpperCase() : c;
    canon += up === "I" || up === "L" ? "1" : up === "O" ? "0" : up;
  }
  return canon.length === CODE_LEN && [...canon].every((c) => ALPHABET.includes(c)) ? canon : undefined;
}

export const hash = (canon: string) => sha256(canon);

export type MintedCode = { code: string; expiresAt: string };

/** What a burned code was minted with. */
export type Redeemed = { name?: string; role: Role; personId?: PersonId; inviteId?: string };

export class RedeemError extends Error {
  constructor(readonly kind: "invalid" | "expired") {
    super(kind === "expired" ? "pairing code expired" : "unknown or already used pairing code");
  }
}

/** `read`, `operate` or `admin`, as `fleetd pair --role` takes it. */
export const parseRole = (text: string): Role | undefined =>
  text === "read" || text === "operate" || text === "admin" ? text : undefined;

const INVITE_COLUMNS = `c.invite_id, c.person_id, p.name AS person_name, c.created_ms, c.expires_ms, c.used_ms,
  c.revoked_ms, c.created_by, b.name AS by_name`;
const INVITE_FROM =
  "pair_codes c LEFT JOIN people p ON p.person_id = c.person_id LEFT JOIN people b ON b.person_id = c.created_by";

type InviteRow = {
  invite_id: string;
  person_id: string | null;
  person_name: string | null;
  created_ms: number | null;
  expires_ms: number;
  used_ms: number | null;
  revoked_ms: number | null;
  created_by: string | null;
  by_name: string | null;
};

function inviteRow(row: InviteRow, now: number): Invite {
  const name = (n: string | null) => (n === null ? undefined : cleanName(n)) ?? "someone";
  const state: InviteState =
    row.used_ms !== null ? "used" : row.revoked_ms !== null ? "revoked" : row.expires_ms <= now ? "expired" : "open";
  return {
    createdAt: isoMs(row.created_ms ?? row.expires_ms - INVITE_TTL_MS),
    ...(row.created_by === null ? {} : { createdBy: { name: name(row.by_name), personId: row.created_by } }),
    expiresAt: isoMs(row.expires_ms),
    inviteId: row.invite_id,
    person: { name: name(row.person_name), personId: row.person_id ?? "" },
    ...(row.revoked_ms === null ? {} : { revokedAt: isoMs(row.revoked_ms) }),
    state,
    ...(row.used_ms === null ? {} : { usedAt: isoMs(row.used_ms) }),
  };
}

function inviteOn(c: Database, id: string, now: number): Invite | undefined {
  const row = c.query<InviteRow, [string]>(`SELECT ${INVITE_COLUMNS} FROM ${INVITE_FROM} WHERE c.invite_id = ?`).get(id);
  return row ? inviteRow(row, now) : undefined;
}

/** Six random digits. */
export function newMacCode(): string {
  const n = crypto.getRandomValues(new Uint32Array(1))[0] as number;
  return String(n % 1_000_000).padStart(6, "0");
}

/** The code's six digits, typed with spaces or a hyphen between them or not. Undefined when it can't be one. */
export function normalizeMac(input: string): string | undefined {
  const digits = [...input].filter((c) => !/^\s$/u.test(c) && c !== "-").join("");
  return /^[0-9]{6}$/.test(digits) ? digits : undefined;
}

/** Its own namespace: a Mac code's hash never meets a pairing code's. */
const macHash = (canon: string) => hash(`mac ${canon}`);

/** An open Mac setup code as `fleetd pair --worker-codes` lists it: never the code itself. */
export type OpenMacCode = { id: string; machineId: string; createdAt: string; expiresAt: string };

export class PairCodes {
  constructor(
    private readonly db: HubDb,
    private readonly now: () => number,
  ) {}

  /** One-time, valid for 15 minutes; `name` names the key when the device sends none, `role` is what it gets. */
  create(name: string | undefined, role: Role): MintedCode {
    return this.insert(name, role, undefined);
  }

  /** The same, for one more device of `person` (the app's Pair a phone): the key it mints is theirs. */
  createFor(person: PersonId, role: Role): MintedCode {
    return this.insert(undefined, role, person);
  }

  private insert(name: string | undefined, role: Role, person: PersonId | undefined): MintedCode {
    const now = this.now();
    const expires = now + CODE_TTL_MS;
    const code = newCode();
    this.db.conn
      .query("INSERT INTO pair_codes (hash, name, expires_ms, role, created_ms, person_id) VALUES (?, ?, ?, ?, ?, ?)")
      .run(hash(normalize(code) as string), name ?? null, expires, role, now, person ?? null);
    return { code, expiresAt: isoMs(expires) };
  }

  /**
   * An invite for `person`, valid for 7 days: the device that redeems it gets a key of theirs with admin on every
   * machine, which their role caps each time the key is verified.
   */
  createInvite(person: Person, createdBy: PersonId | undefined): { minted: MintedCode; invite: Invite } {
    const now = this.now();
    const expires = now + INVITE_TTL_MS;
    const code = newCode();
    const inviteId = `inv_${base32(crypto.getRandomValues(new Uint8Array(5)))}`;
    this.db.conn
      .query(
        `INSERT INTO pair_codes (hash, name, expires_ms, role, created_ms, person_id, invite_id, created_by)
         VALUES (?, NULL, ?, ?, ?, ?, ?, ?)`,
      )
      .run(hash(normalize(code) as string), expires, "admin", now, person.personId, inviteId, createdBy ?? null);
    return { minted: { code, expiresAt: isoMs(expires) }, invite: inviteOn(this.db.conn, inviteId, now) as Invite };
  }

  /** Invites, newest first: only open ones unless `all`. */
  invites(all: boolean): Invite[] {
    const now = this.now();
    return this.db
      .all<InviteRow>(
        `SELECT ${INVITE_COLUMNS} FROM ${INVITE_FROM} WHERE c.invite_id IS NOT NULL
         AND (?1 OR (c.used_ms IS NULL AND c.revoked_ms IS NULL AND c.expires_ms > ?2))
         ORDER BY c.created_ms DESC, c.invite_id`,
        [all ? 1 : 0, now],
      )
      .map((r) => inviteRow(r, now));
  }

  invite(id: string): Invite | undefined {
    return inviteOn(this.db.conn, id, this.now());
  }

  /** Takes an open invite back; a used or revoked one stays. The invite and whether this call revoked it. */
  revokeInvite(id: string): { invite: Invite; revoked: boolean } | undefined {
    const now = this.now();
    const changed = this.db.conn
      .query("UPDATE pair_codes SET revoked_ms = ?2 WHERE invite_id = ?1 AND used_ms IS NULL AND revoked_ms IS NULL")
      .run(id, now).changes;
    const invite = inviteOn(this.db.conn, id, now);
    return invite ? { invite, revoked: changed > 0 } : undefined;
  }

  /** Drops codes and invites used, revoked or expired more than SPENT_CODE_KEPT_MS ago. How many went. */
  prune(): number {
    return this.db.conn
      .query("DELETE FROM pair_codes WHERE coalesce(used_ms, revoked_ms, expires_ms) < ?")
      .run(this.now() - SPENT_CODE_KEPT_MS).changes;
  }

  /** Burns the code; returns what it was minted with. Throws a RedeemError. */
  redeem(code: string): Redeemed {
    const canon = normalize(code);
    if (canon === undefined) throw new RedeemError("invalid");
    const now = this.now();
    const h = hash(canon);
    // One statement, so two devices racing on one code cannot both win.
    const burned = this.db.conn
      .query<{ name: string | null; role: string; person_id: string | null; invite_id: string | null }, [{ now: number; hash: string }]>(
        `UPDATE pair_codes SET used_ms = $now WHERE hash = $hash AND used_ms IS NULL AND revoked_ms IS NULL
         AND expires_ms > $now RETURNING name, role, person_id, invite_id`,
      )
      .get({ now, hash: h });
    if (burned) {
      return {
        ...(burned.name === null ? {} : { name: burned.name }),
        // An unreadable role grants the least, never more.
        role: parseRole(burned.role) ?? "read",
        ...(burned.person_id === null ? {} : { personId: burned.person_id }),
        ...(burned.invite_id === null ? {} : { inviteId: burned.invite_id }),
      };
    }
    const row = this.db.conn
      .query<{ expires_ms: number; used_ms: number | null; revoked_ms: number | null }, [string]>(
        "SELECT expires_ms, used_ms, revoked_ms FROM pair_codes WHERE hash = ?",
      )
      .get(h);
    throw new RedeemError(row && row.used_ms === null && row.revoked_ms === null && row.expires_ms <= now ? "expired" : "invalid");
  }

  /** A new setup code for the agents' Mac `machine`: any Mac code still open is revoked first. */
  createMac(machine: string): MintedCode {
    const now = this.now();
    const expires = now + MAC_CODE_TTL_MS;
    const code = newMacCode();
    const h = macHash(code);
    this.db.transaction((c) => {
      c.query(
        `UPDATE pair_codes SET revoked_ms = ?1 WHERE machine_id IS NOT NULL AND used_ms IS NULL
         AND revoked_ms IS NULL AND expires_ms > ?1`,
      ).run(now);
      // Every other code of these digits is spent now: the old row of a code drawn again makes way.
      c.query("DELETE FROM pair_codes WHERE hash = ?").run(h);
      c.query(
        "INSERT INTO pair_codes (hash, name, expires_ms, role, created_ms, machine_id) VALUES (?, NULL, ?, 'read', ?, ?)",
      ).run(h, expires, now, machine);
    });
    return { code, expiresAt: isoMs(expires) };
  }

  /**
   * Burns the Mac code once `check` accepts the machine it is for; returns that machine, or what `check` refused
   * with (the code then stays open). Throws a RedeemError.
   */
  redeemMac<E>(code: string, check: (machine: string) => E | undefined): { machine: string } | { refused: E } {
    const canon = normalizeMac(code);
    if (canon === undefined) throw new RedeemError("invalid");
    const now = this.now();
    const h = macHash(canon);
    const row = this.db.conn
      .query<{ machine_id: string; expires_ms: number; used_ms: number | null; revoked_ms: number | null }, [string]>(
        "SELECT machine_id, expires_ms, used_ms, revoked_ms FROM pair_codes WHERE hash = ? AND machine_id IS NOT NULL",
      )
      .get(h);
    if (!row || row.used_ms !== null || row.revoked_ms !== null) throw new RedeemError("invalid");
    if (row.expires_ms <= now) throw new RedeemError("expired");
    const refused = check(row.machine_id);
    if (refused !== undefined) return { refused };
    // One statement, so two Macs racing on one code cannot both win.
    const burned = this.db.conn
      .query(
        `UPDATE pair_codes SET used_ms = $now WHERE hash = $hash AND machine_id IS NOT NULL AND used_ms IS NULL
         AND revoked_ms IS NULL AND expires_ms > $now`,
      )
      .run({ now, hash: h }).changes;
    if (burned !== 1) throw new RedeemError("invalid");
    return { machine: row.machine_id };
  }

  /** The open Mac setup code, if there is one: there is one at a time. */
  openMac(): OpenMacCode | undefined {
    const row = this.db.conn
      .query<{ id: string; machine_id: string; created_ms: number | null; expires_ms: number }, [number, number]>(
        `SELECT substr(hash, 1, ?1) AS id, machine_id, created_ms, expires_ms FROM pair_codes WHERE machine_id IS NOT NULL
         AND used_ms IS NULL AND revoked_ms IS NULL AND expires_ms > ?2 ORDER BY created_ms DESC LIMIT 1`,
      )
      .get(ENROLL_CODE_ID_LEN, this.now());
    if (!row) return undefined;
    return {
      id: row.id,
      machineId: row.machine_id,
      createdAt: isoMs(row.created_ms ?? row.expires_ms - MAC_CODE_TTL_MS),
      expiresAt: isoMs(row.expires_ms),
    };
  }

  /** Takes back the open Mac setup code `id` names; the machine it was for, or undefined. */
  revokeMac(id: string): string | undefined {
    const row = this.db.conn
      .query<{ machine_id: string }, [number, string, number]>(
        `UPDATE pair_codes SET revoked_ms = ?3 WHERE substr(hash, 1, ?1) = ?2 AND length(?2) = ?1
         AND machine_id IS NOT NULL AND used_ms IS NULL AND revoked_ms IS NULL AND expires_ms > ?3
         RETURNING machine_id`,
      )
      .get(ENROLL_CODE_ID_LEN, id, this.now());
    return row?.machine_id;
  }

  /** A wrong code was tried: it counts against the open Mac code, which closes at its MAX_CODE_FAILURES th. */
  failedMac(): void {
    this.db.conn
      .query(
        `UPDATE pair_codes SET failures = failures + 1,
         revoked_ms = CASE WHEN failures + 1 >= ?2 THEN ?1 ELSE NULL END
         WHERE machine_id IS NOT NULL AND used_ms IS NULL AND revoked_ms IS NULL AND expires_ms > ?1`,
      )
      .run(this.now(), MAX_CODE_FAILURES);
  }

  /** Where the Mac setup code `code` stands, for Add machine; undefined when the hub has no such code. */
  macState(code: string): MacCodeState | undefined {
    const canon = normalizeMac(code);
    if (canon === undefined) return undefined;
    const row = this.db.conn
      .query<{ expires_ms: number; used_ms: number | null; revoked_ms: number | null; failures: number }, [string]>(
        "SELECT expires_ms, used_ms, revoked_ms, failures FROM pair_codes WHERE hash = ? AND machine_id IS NOT NULL",
      )
      .get(macHash(canon));
    if (!row) return undefined;
    if (row.used_ms !== null) return "used";
    if (row.revoked_ms !== null) return row.failures >= MAX_CODE_FAILURES ? "closed" : "revoked";
    return row.expires_ms <= this.now() ? "expired" : "open";
  }
}

export const pairCodes = (hub: { db: HubDb; clock: { now(): number } }) => new PairCodes(hub.db, () => hub.clock.now());

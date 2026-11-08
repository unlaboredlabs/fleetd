// Node enrollment tokens and node keys (crates/fleetd/src/hub/auth/mod.rs): one-time `fle_` codes from
// `fleetd pair --worker` and `machine add`, burned by a node's first hello, which records its ed25519 key.
import type { Clock } from "../../shared/clock.ts";
import type { HubDb } from "../store/db.ts";
import { isoMs, sha256 } from "./index.ts";
import { REASON_MAX_BYTES } from "../../shared/node_link.ts";

const ENROLL_PREFIX = "fle_";
const ENROLL_TTL_MS = 15 * 60_000;
/** How long a used or expired enroll code's row stays, so a node trying it again hears why. */
export const SPENT_CODE_KEPT_MS = 24 * 60 * 60_000;
/** Hex digits of an enroll code's hash that name it in `fleetd pair --worker-codes` and `--worker-revoke`. */
export const ENROLL_CODE_ID_LEN = 12;
const BASE32 = "abcdefghijklmnopqrstuvwxyz234567";

/** RFC 4648 base32, lowercase, unpadded. */
export function base32(bytes: Uint8Array): string {
  let out = "";
  let buffer = 0;
  let bits = 0;
  for (const byte of bytes) {
    buffer = ((buffer << 8) | byte) & 0xffff;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(buffer >> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32[(buffer << (5 - bits)) & 31];
  return out;
}

/** `prefix` and 32 random bytes in base32. */
export const secret = (prefix: string) => `${prefix}${base32(crypto.getRandomValues(new Uint8Array(32)))}`;

/** A node's refusal, in the shape the MCP error has: the link's close reason is `reason()`. */
export class Unauthorized extends Error {
  readonly code = "forbidden";
  constructor(
    message: string,
    readonly fix?: string,
  ) {
    super(message);
    this.name = "Unauthorized";
  }

  /** "<message>. Fix: <fix>", as a node reads it in the link's close reason. */
  reason(): string {
    return this.fix === undefined ? this.message : `${this.message}. Fix: ${this.fix}`;
  }
}

/** From `forms` of (message, fix), fullest first: the first that fits a close reason; else the last. */
function refusal(forms: [string, string][]): Unauthorized {
  const all = forms.map(([m, f]) => new Unauthorized(m, f));
  return all.find((r) => Buffer.byteLength(r.reason()) <= REASON_MAX_BYTES) ?? (all[all.length - 1] as Unauthorized);
}

/** A node already enrolled as `theirs` asked to enroll under another id. */
function enrolledAs(theirs: string): Unauthorized {
  const message = `enrolled as ${theirs}`;
  return refusal([
    [message, `fleetd pair --worker ${theirs} and run its line, or fleetd machine remove ${theirs} first`],
    [message, `fleetd pair --worker ${theirs}, or fleetd machine remove ${theirs}`],
    [message, `fleetd pair --worker ${theirs}, or remove it`],
  ]);
}

export type EnrollToken = { token: string; expiresAt: string };
export type OpenEnrollCode = { id: string; machineId: string; createdAt: string; expiresAt: string; pool: boolean };

export class NodeKeys {
  constructor(
    private readonly db: HubDb,
    private readonly clock: Clock,
  ) {}

  /** One-time, valid for 15 minutes; replaces the machine's open one. `by` names the caller in the hub log. */
  createEnrollToken(machineId: string, by: string): EnrollToken {
    return this.mint(machineId, false, by);
  }

  /** A pool enroll token, minted by the hub itself for one of its cloud machine slots (hub/pool). */
  createPoolEnrollToken(machineId: string): EnrollToken {
    return this.mint(machineId, true, "a cloud machine slot");
  }

  private mint(machineId: string, pool: boolean, by: string): EnrollToken {
    const now = this.clock.now();
    const expires = now + ENROLL_TTL_MS;
    const token = secret(ENROLL_PREFIX);
    const replaced = this.db.transaction((conn) => {
      const { changes } = conn
        .query("DELETE FROM enroll_tokens WHERE machine_id = ? AND used_ms IS NULL AND expires_ms > ?")
        .run(machineId, now);
      conn
        .query("INSERT INTO enroll_tokens (hash, machine_id, expires_ms, pool) VALUES (?, ?, ?, ?)")
        .run(sha256(token), machineId, expires, pool ? 1 : 0);
      return changes;
    });
    // Never the code: its id is what `fleetd pair --worker-codes` lists.
    console.info(`enroll code minted machine_id=${machineId} by=${by} id=${sha256(token).slice(0, ENROLL_CODE_ID_LEN)} replaced=${replaced}`);
    return { token, expiresAt: isoMs(expires) };
  }

  /** Every enroll code that can still be used, oldest first. */
  openEnrollTokens(): OpenEnrollCode[] {
    const rows = this.db.all<{ id: string; machine_id: string; expires_ms: number; pool: number }>(
      `SELECT substr(hash, 1, ?) AS id, machine_id, expires_ms, pool FROM enroll_tokens
       WHERE used_ms IS NULL AND expires_ms > ? ORDER BY expires_ms, hash`,
      [ENROLL_CODE_ID_LEN, this.clock.now()],
    );
    return rows.map((r) => ({
      id: r.id,
      machineId: r.machine_id,
      createdAt: isoMs(r.expires_ms - ENROLL_TTL_MS),
      expiresAt: isoMs(r.expires_ms),
      pool: r.pool !== 0,
    }));
  }

  /** Takes back the open enroll code `id` names; the machine it was for, or undefined. */
  revokeEnrollToken(id: string): string | undefined {
    const row = this.db.conn
      .query<{ machine_id: string }, [number, string, number]>(
        `DELETE FROM enroll_tokens WHERE substr(hash, 1, ?1) = ?2 AND length(?2) = ?1
         AND used_ms IS NULL AND expires_ms > ?3 RETURNING machine_id`,
      )
      .get(ENROLL_CODE_ID_LEN, id, this.clock.now());
    return row?.machine_id;
  }

  revokeEnrollSecret(token: string): boolean {
    return this.revokeEnrollToken(sha256(token).slice(0, ENROLL_CODE_ID_LEN)) !== undefined;
  }

  /** Drops enroll codes used or expired more than SPENT_CODE_KEPT_MS ago; how many went. */
  pruneEnrollTokens(): number {
    return this.db.conn
      .query("DELETE FROM enroll_tokens WHERE coalesce(used_ms, expires_ms) < ?")
      .run(this.clock.now() - SPENT_CODE_KEPT_MS).changes;
  }

  private poolTokenOpen(token: string, machineId: string): boolean {
    return (
      this.db.conn
        .query(
          "SELECT 1 FROM enroll_tokens WHERE hash = ? AND machine_id = ? AND pool = 1 AND used_ms IS NULL AND expires_ms > ?",
        )
        .get(sha256(token), machineId, this.clock.now()) !== null
    );
  }

  /** Whether the machine's node enrolled with a pool enroll token: one of the hub's cloud machines. */
  isPool(machineId: string): boolean {
    const row = this.db.conn.query<{ pool: number }, [string]>("SELECT pool FROM node_keys WHERE machine_id = ?").get(machineId);
    return (row?.pool ?? 0) !== 0;
  }

  /** Burns the token and records `pubKey` as the machine's node key; throws Unauthorized with why it can't. */
  consumeEnrollToken(token: string, machineId: string, pubKey: string): void {
    const now = this.clock.now();
    const hash = sha256(token);
    const burned = this.db.transaction((conn) => {
      // One statement, so two nodes racing on one token cannot both win.
      const row = conn
        .query<{ pool: number }, Record<string, string | number>>(
          "UPDATE enroll_tokens SET used_ms = $now WHERE hash = $hash AND machine_id = $machine AND used_ms IS NULL AND expires_ms > $now RETURNING pool",
        )
        .get({ now, hash, machine: machineId });
      if (!row) return false;
      conn
        .query(
          "INSERT INTO node_keys (machine_id, pub_key, pool) VALUES (?, ?, ?) ON CONFLICT (machine_id) DO UPDATE SET pub_key = excluded.pub_key, pool = excluded.pool",
        )
        .run(machineId, pubKey, row.pool);
      return true;
    });
    if (burned) return;
    const row = this.db.conn
      .query<{ machine_id: string; expires_ms: number; used_ms: number | null }, [string]>(
        "SELECT machine_id, expires_ms, used_ms FROM enroll_tokens WHERE hash = ?",
      )
      .get(hash);
    const m = machineId;
    let why: string;
    if (!row) why = "unknown, replaced or revoked enrollment token";
    else if (row.used_ms !== null) why = "enrollment token was already used";
    else if (row.expires_ms <= now) why = "enrollment token expired";
    else {
      // A name typed in by hand for a code made for another: the code still works.
      const machine = row.machine_id;
      const why = `enrollment token is for machine ${machine}, not ${m}`;
      throw refusal([
        [why, `join as ${machine} (--machine-id ${machine}), or on the hub run fleetd pair --worker ${m} for a code for ${m}`],
        [why, `join as ${machine} (--machine-id ${machine})`],
        [`the code is for ${machine}`, `--machine-id ${machine}`],
      ]);
    }
    throw refusal([
      [why, `on the hub, run fleetd pair --worker ${m} for a new code`],
      [why, `fleetd pair --worker ${m} on the hub`],
    ]);
  }

  nodePubKey(machineId: string): string | undefined {
    return this.db.conn.query<{ pub_key: string }, [string]>("SELECT pub_key FROM node_keys WHERE machine_id = ?").get(machineId)
      ?.pub_key;
  }

  /**
   * Enrolls the machine's node from the computer `fingerprint` names: refused when that id is already another
   * computer's (unless it is a pool machine with an open pool token), or the key is enrolled under another id.
   */
  enrollNode(token: string, machineId: string, pubKey: string, fingerprint?: string): void {
    const theirs = this.db.conn
      .query<{ machine_id: string }, [string, string]>(
        "SELECT machine_id FROM node_keys WHERE pub_key = ? AND machine_id != ? LIMIT 1",
      )
      .get(pubKey, machineId);
    if (theirs) throw enrolledAs(theirs.machine_id);
    const ours = this.nodeFingerprint(machineId);
    if (
      fingerprint !== undefined &&
      ours !== undefined &&
      fingerprint !== ours &&
      !(this.isPool(machineId) && this.poolTokenOpen(token, machineId))
    ) {
      throw refusal([
        [`${machineId} is another computer's machine id`, `use an id of its own, or fleetd machine remove ${machineId} first`],
        ["this id is another computer's", `use another id, or fleetd machine remove ${machineId} first`],
      ]);
    }
    this.consumeEnrollToken(token, machineId, pubKey);
    if (fingerprint !== undefined) this.setNodeFingerprint(machineId, fingerprint);
  }

  nodeFingerprint(machineId: string): string | undefined {
    return (
      this.db.conn
        .query<{ fingerprint: string | null }, [string]>("SELECT fingerprint FROM node_keys WHERE machine_id = ?")
        .get(machineId)?.fingerprint ?? undefined
    );
  }

  setNodeFingerprint(machineId: string, fingerprint: string): void {
    this.db.conn.query("UPDATE node_keys SET fingerprint = ? WHERE machine_id = ?").run(fingerprint, machineId);
  }

  /** Forgets the machine's node key, so its node is refused from its next link on; false if it had none. */
  revokeNode(machineId: string): boolean {
    return this.db.conn.query("DELETE FROM node_keys WHERE machine_id = ?").run(machineId).changes > 0;
  }
}

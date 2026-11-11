// Node enrollment tokens and node keys: one-time `fle_` codes from
// `fleetd pair --worker` and `machine add`, burned by a node's first hello, which records its ed25519 key. A code
// minted with no machine (the app's Connect a computer) takes the name the node asks for, made unique.
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
/** An enroll code's machine_id when it names no machine: never a valid machine id. */
export const NAMELESS = "";
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
export type OpenEnrollCode = { id: string; machineId: string; createdAt: string; expiresAt: string };

export class NodeKeys {
  constructor(
    private readonly db: HubDb,
    private readonly clock: Clock,
  ) {}

  /** One-time, valid for 15 minutes; replaces the machine's open one. With no machine, it enrolls a node under the
   * name it asks for, made unique (freeId), and replaces none. `by` names the caller in the hub log. */
  createEnrollToken(machineId: string | undefined, by: string): EnrollToken {
    const now = this.clock.now();
    const expires = now + ENROLL_TTL_MS;
    const token = secret(ENROLL_PREFIX);
    const replaced = this.db.transaction((conn) => {
      const { changes } =
        machineId === undefined
          ? { changes: 0 }
          : conn.query("DELETE FROM enroll_tokens WHERE machine_id = ? AND used_ms IS NULL AND expires_ms > ?").run(machineId, now);
      conn
        .query("INSERT INTO enroll_tokens (hash, machine_id, expires_ms) VALUES (?, ?, ?)")
        .run(sha256(token), machineId ?? NAMELESS, expires);
      return changes;
    });
    // Never the code: its id is what `fleetd pair --worker-codes` lists.
    console.info(`enroll code minted machine_id=${machineId ?? "(any)"} by=${by} id=${sha256(token).slice(0, ENROLL_CODE_ID_LEN)} replaced=${replaced}`);
    return { token, expiresAt: isoMs(expires) };
  }

  /** Every enroll code that can still be used, oldest first. */
  openEnrollTokens(): OpenEnrollCode[] {
    const rows = this.db.all<{ id: string; machine_id: string; expires_ms: number }>(
      `SELECT substr(hash, 1, ?) AS id, machine_id, expires_ms FROM enroll_tokens
       WHERE used_ms IS NULL AND expires_ms > ? ORDER BY expires_ms, hash`,
      [ENROLL_CODE_ID_LEN, this.clock.now()],
    );
    return rows.map((r) => ({
      id: r.id,
      machineId: r.machine_id,
      createdAt: isoMs(r.expires_ms - ENROLL_TTL_MS),
      expiresAt: isoMs(r.expires_ms),
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

  /** Burns the token and records `pubKey` as the machine's node key; throws Unauthorized with why it can't. A nameless
   * token takes any id: enrollNode settles which. */
  consumeEnrollToken(token: string, machineId: string, pubKey: string): void {
    const now = this.clock.now();
    const hash = sha256(token);
    const burned = this.db.transaction((conn) => {
      // One statement, so two nodes racing on one token cannot both win.
      const row = conn
        .query<{ hash: string }, Record<string, string | number>>(
          `UPDATE enroll_tokens SET used_ms = $now WHERE hash = $hash AND machine_id IN ($machine, $nameless)
           AND used_ms IS NULL AND expires_ms > $now RETURNING hash`,
        )
        .get({ now, hash, machine: machineId, nameless: NAMELESS });
      if (!row) return false;
      conn
        .query(
          "INSERT INTO node_keys (machine_id, pub_key) VALUES (?, ?) ON CONFLICT (machine_id) DO UPDATE SET pub_key = excluded.pub_key",
        )
        .run(machineId, pubKey);
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
    if (row?.machine_id === NAMELESS) throw refusal([[why, "ask the hub for a new join line"]]);
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
   * computer's, or the key is enrolled under another id. The id it enrolled under: `machineId`, or for a nameless
   * token the one freeId settles.
   */
  enrollNode(token: string, machineId: string, pubKey: string, fingerprint?: string): string {
    if (this.nameless(token)) machineId = this.freeId(machineId, pubKey, fingerprint);
    const theirs = this.db.conn
      .query<{ machine_id: string }, [string, string]>(
        "SELECT machine_id FROM node_keys WHERE pub_key = ? AND machine_id != ? LIMIT 1",
      )
      .get(pubKey, machineId);
    if (theirs) throw enrolledAs(theirs.machine_id);
    const ours = this.nodeFingerprint(machineId);
    if (fingerprint !== undefined && ours !== undefined && fingerprint !== ours) {
      throw refusal([
        [`${machineId} is another computer's machine id`, `use an id of its own, or fleetd machine remove ${machineId} first`],
        ["this id is another computer's", `use another id, or fleetd machine remove ${machineId} first`],
      ]);
    }
    this.consumeEnrollToken(token, machineId, pubKey);
    if (fingerprint !== undefined) this.setNodeFingerprint(machineId, fingerprint);
    return machineId;
  }

  /** Whether `token` was minted with no machine: a spent one too, so its refusal says it was used. */
  private nameless(token: string): boolean {
    return this.db.conn.query("SELECT 1 FROM enroll_tokens WHERE hash = ? AND machine_id = ?").get(sha256(token), NAMELESS) !== null;
  }

  /**
   * The id a nameless code enrolls `pubKey` under: the one that key holds already (the computer joins again), else
   * `wish`, or `wish-2`, `wish-3`… when another computer's machine or an open code for one has it.
   */
  private freeId(wish: string, pubKey: string, fingerprint: string | undefined): string {
    const held = this.db.conn
      .query<{ machine_id: string }, [string]>("SELECT machine_id FROM node_keys WHERE pub_key = ? LIMIT 1")
      .get(pubKey);
    if (held) return held.machine_id;
    const taken = (id: string) => {
      const key = this.db.conn
        .query<{ fingerprint: string | null }, [string]>("SELECT fingerprint FROM node_keys WHERE machine_id = ?")
        .get(id);
      if (key) return fingerprint === undefined || key.fingerprint !== fingerprint;
      return (
        this.db.conn.query("SELECT 1 FROM machines WHERE machine_id = ?").get(id) !== null ||
        this.db.conn
          .query("SELECT 1 FROM enroll_tokens WHERE machine_id = ? AND used_ms IS NULL AND expires_ms > ?")
          .get(id, this.clock.now()) !== null
      );
    };
    let id = wish;
    for (let k = 2; taken(id); k++) {
      const suffix = `-${k}`;
      id = `${wish.slice(0, 32 - suffix.length).replace(/-+$/, "")}${suffix}`;
    }
    return id;
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

import crypto from "node:crypto";
import { ErrorCode, Grant, type AgentKeyInfo, type KeyKind, type MachineId, type Role } from "@fleetd/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as HubDb from "../store/HubDb.ts";

const CREATE_KEY_FIX = "create a key with `fleetd hub key create --name <name> --role <role> --machines '*'`";

/** Shaped like the MCP error result so transports can pass it through. */
export class Unauthorized extends Schema.TaggedError<Unauthorized>()("Unauthorized", {
  code: ErrorCode,
  message: Schema.String,
  fix: Schema.optionalKey(Schema.String),
}) {}

export class KeyNotFound extends Schema.TaggedError<KeyNotFound>()("KeyNotFound", { keyId: Schema.String }) {
  override get message(): string {
    return `no agent key ${this.keyId}; run \`fleetd hub key list\` to see key ids`;
  }
}

export class Auth extends Context.Service<
  Auth,
  {
    /** `key` is shown once and never stored; the hub keeps its sha256. */
    readonly createKey: (
      name: string,
      grants: ReadonlyArray<Grant>,
      kind?: KeyKind,
    ) => Effect.Effect<{ readonly key: string; readonly info: AgentKeyInfo }>;
    /** Accepts `fld_…` or `Bearer fld_…`. Revocation is seen on the next call. */
    readonly verify: (bearer: string) => Effect.Effect<AgentKeyInfo, Unauthorized>;
    /** Idempotent: revoking a revoked key keeps its first `revokedAt`. */
    readonly revoke: (keyId: string) => Effect.Effect<void, KeyNotFound>;
    readonly list: () => Effect.Effect<ReadonlyArray<AgentKeyInfo>>;
    /**
     * Whether some grant gives at least `role` on `machineId`. Without a machine (fleet-wide reads), any grant of
     * that role is enough; the caller then filters results per machine.
     */
    readonly allows: (info: AgentKeyInfo, role: Role, machineId?: MachineId) => boolean;
    /** One-time, valid for 15 minutes. */
    readonly createEnrollToken: (
      machineId: MachineId,
    ) => Effect.Effect<{ readonly token: string; readonly expiresAt: string }>;
    /** Burns the token and records `pubKey` as the machine's node key. */
    readonly consumeEnrollToken: (token: string, machineId: MachineId, pubKey: string) => Effect.Effect<void, Unauthorized>;
    readonly nodePubKey: (machineId: MachineId) => Effect.Effect<string | undefined>;
  }
>()("fleetd/auth/Auth") {}

const KEY_PREFIX = "fld_";
const ENROLL_PREFIX = "fle_";
const KEY_PATTERN = /^fld_[a-z2-7]{52}$/u;
const LAST_USED_EVERY_MS = 60_000;
const ENROLL_TTL_MS = 15 * 60_000;
const RANK: Record<Role, number> = { read: 0, operate: 1, admin: 2 };

const BASE32 = "abcdefghijklmnopqrstuvwxyz234567";

/** RFC 4648 base32, lowercase, unpadded. */
const base32 = (bytes: Uint8Array) => {
  let out = "";
  let buffer = 0;
  let bits = 0;
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(buffer >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  return bits > 0 ? out + BASE32[(buffer << (5 - bits)) & 31] : out;
};

const secret = (prefix: string) => prefix + base32(crypto.randomBytes(32));
const sha256 = (s: string) => crypto.createHash("sha256").update(s).digest("hex");
const iso = (ms: number) => new Date(ms).toISOString();

const decodeGrants = Schema.decodeSync(Schema.fromJsonString(Schema.Array(Grant)));
const encodeGrants = Schema.encodeSync(Schema.fromJsonString(Schema.Array(Grant)));

const toInfo = (row: Record<string, unknown>): AgentKeyInfo => ({
  keyId: String(row.key_id),
  name: String(row.name),
  ...(row.kind === "human" ? { kind: "human" as const } : {}),
  prefix: String(row.prefix),
  grants: decodeGrants(String(row.grants)),
  createdAt: iso(Number(row.created_ms)),
  ...(row.last_used_ms === null ? {} : { lastUsedAt: iso(Number(row.last_used_ms)) }),
  ...(row.revoked_ms === null ? {} : { revokedAt: iso(Number(row.revoked_ms)) }),
});

const allows = (info: AgentKeyInfo, role: Role, machineId?: MachineId) =>
  info.revokedAt === undefined &&
  info.grants.some(
    (grant) =>
      RANK[grant.role] >= RANK[role] &&
      (machineId === undefined || grant.machines === "*" || grant.machines.includes(machineId)),
  );

const make = Effect.gen(function* () {
  const { db } = yield* HubDb.HubDb;

  const sql = {
    keyInsert: db.prepare(
      "INSERT INTO agent_keys (key_id, hash, prefix, name, grants, created_ms, kind) VALUES ($key_id, $hash, $prefix, $name, $grants, $created_ms, $kind)",
    ),
    keyByHash: db.prepare("SELECT * FROM agent_keys WHERE hash = ?"),
    keyTouch: db.prepare("UPDATE agent_keys SET last_used_ms = ? WHERE key_id = ?"),
    keyRevoke: db.prepare("UPDATE agent_keys SET revoked_ms = COALESCE(revoked_ms, ?) WHERE key_id = ?"),
    keyList: db.prepare("SELECT * FROM agent_keys ORDER BY created_ms, key_id"),
    tokenInsert: db.prepare("INSERT INTO enroll_tokens (hash, machine_id, expires_ms) VALUES (?, ?, ?)"),
    tokenGet: db.prepare("SELECT * FROM enroll_tokens WHERE hash = ?"),
    // One statement, so two nodes racing on one token cannot both win.
    tokenBurn: db.prepare(
      "UPDATE enroll_tokens SET used_ms = $now WHERE hash = $hash AND machine_id = $machine AND used_ms IS NULL AND expires_ms > $now",
    ),
    nodeKeyUpsert: db.prepare(
      "INSERT INTO node_keys (machine_id, pub_key) VALUES (?, ?) ON CONFLICT (machine_id) DO UPDATE SET pub_key = excluded.pub_key",
    ),
    nodeKeyGet: db.prepare("SELECT pub_key FROM node_keys WHERE machine_id = ?"),
  };

  const createKey = (name: string, grants: ReadonlyArray<Grant>, kind: KeyKind = "agent") =>
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      const key = secret(KEY_PREFIX);
      const row = {
        key_id: `key_${base32(crypto.randomBytes(5))}`,
        hash: sha256(key),
        prefix: key.slice(0, KEY_PREFIX.length + 6),
        name,
        grants: encodeGrants(grants),
        kind,
        created_ms: now,
      };
      sql.keyInsert.run(row);
      return { key, info: toInfo({ ...row, last_used_ms: null, revoked_ms: null }) };
    });

  const verify = (bearer: string) =>
    Effect.gen(function* () {
      const key = bearer.replace(/^Bearer\s+/iu, "").trim();
      if (!KEY_PATTERN.test(key)) {
        return yield* new Unauthorized({
          code: "invalid",
          message: "expected an agent key: `Authorization: Bearer fld_…`",
          fix: CREATE_KEY_FIX,
        });
      }
      const row = sql.keyByHash.get(sha256(key));
      if (!row) return yield* new Unauthorized({ code: "forbidden", message: "unknown agent key", fix: CREATE_KEY_FIX });
      if (row.revoked_ms !== null) {
        return yield* new Unauthorized({
          code: "forbidden",
          message: `agent key ${String(row.prefix)} was revoked`,
          fix: CREATE_KEY_FIX,
        });
      }
      const now = yield* Clock.currentTimeMillis;
      if (row.last_used_ms === null || now - Number(row.last_used_ms) >= LAST_USED_EVERY_MS) {
        sql.keyTouch.run(now, String(row.key_id));
        return toInfo({ ...row, last_used_ms: now });
      }
      return toInfo(row);
    });

  const revoke = (keyId: string) =>
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      if (sql.keyRevoke.run(now, keyId).changes === 0) return yield* new KeyNotFound({ keyId });
    });

  const createEnrollToken = (machineId: MachineId) =>
    Effect.gen(function* () {
      const expires = (yield* Clock.currentTimeMillis) + ENROLL_TTL_MS;
      const token = secret(ENROLL_PREFIX);
      sql.tokenInsert.run(sha256(token), machineId, expires);
      return { token, expiresAt: iso(expires) };
    });

  const consumeEnrollToken = (token: string, machineId: MachineId, pubKey: string) =>
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      const hash = sha256(token);
      const burned = HubDb.transaction(db, () => {
        if (sql.tokenBurn.run({ now, hash, machine: machineId }).changes === 0) return false;
        sql.nodeKeyUpsert.run(machineId, pubKey);
        return true;
      });
      if (burned) return;
      const row = sql.tokenGet.get(hash);
      const why = !row
        ? "unknown enrollment token"
        : row.used_ms !== null
          ? "enrollment token was already used"
          : Number(row.expires_ms) <= now
            ? "enrollment token expired"
            : `enrollment token is for machine ${String(row.machine_id)}, not ${machineId}`;
      return yield* new Unauthorized({
        code: "forbidden",
        message: why,
        fix: `on the hub, run \`fleetd hub token create --machine ${machineId}\` and join again within 15 minutes`,
      });
    });

  return Auth.of({
    createKey,
    verify,
    revoke,
    list: () => Effect.sync(() => sql.keyList.all().map(toInfo)),
    allows,
    createEnrollToken,
    consumeEnrollToken,
    nodePubKey: (machineId) =>
      Effect.sync(() => {
        const row = sql.nodeKeyGet.get(machineId);
        return row ? String(row.pub_key) : undefined;
      }),
  });
});

export const layer = Layer.effect(Auth, make);

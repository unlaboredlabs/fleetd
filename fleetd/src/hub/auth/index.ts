// Key checking, as crates/fleetd/src/hub/auth/mod.rs does it: a key is `fld_` and 52 base32 characters, stored as its
// SHA-256; a revoked key, or one whose person was removed, is refused on its next call. Creating, listing and revoking
// keys, enroll tokens and node keys are hub-core's to port here (PORT_MAP.md).
import type { AgentKeyInfo, Grant } from "../../shared/contracts.ts";
import type { Clock } from "../../shared/clock.ts";
import { ToolError } from "../../shared/errors.ts";
import type { HubDb } from "../store/db.ts";
import { capped, cleanName, OWNER_FALLBACK, roleCap, roleOf } from "../people/roles.ts";
import { isAgentKey, isoMs, sha256, stripBearer } from "./allows.ts";
import { Keys } from "./keys.ts";
import { NodeKeys } from "./nodes.ts";

export { allows, isAgentKey, isoMs, sha256, stripBearer } from "./allows.ts";

const CREATE_KEY_FIX = "create a key with `fleetd hub key create --name <name> --role <role> --machines '*'`";
const KEY_PREFIX = "fld_";
const LAST_USED_EVERY_MS = 60_000;

export type KeyRow = {
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
  person_removed: number | null;
};

const KEY_QUERY = `SELECT k.key_id, k.name, k.kind, k.prefix, k.grants, k.created_ms, k.last_used_ms, k.revoked_ms,
  p.person_id, p.name AS person_name, p.role AS person_role, p.removed_ms IS NOT NULL AS person_removed
  FROM agent_keys k LEFT JOIN people p ON p.person_id = k.person_id WHERE k.hash = ?`;

export class Auth {
  /** Node enroll tokens and node keys. */
  readonly nodes: NodeKeys;
  /** Creating, listing and revoking agent and human keys. */
  readonly keys: Keys;
  private readonly revokeListeners = new Set<() => void>();

  constructor(
    private readonly db: HubDb,
    private readonly clock: Clock,
  ) {
    this.nodes = new NodeKeys(db, clock);
    this.keys = new Keys(db, clock, () => this.revokedSome());
  }

  /** Calls `fn` on each key this hub revokes (an open app connection checks its key again); returns the unsubscribe. */
  onRevoke(fn: () => void): () => void {
    this.revokeListeners.add(fn);
    return () => this.revokeListeners.delete(fn);
  }

  /** Tells open connections that keys were revoked, so each checks its own again. */
  revokedSome(): void {
    for (const fn of this.revokeListeners) fn();
  }

  /** Accepts `fld_…` or `Bearer fld_…`; throws a ToolError for any key it refuses. */
  verify(bearer: string): AgentKeyInfo {
    const key = stripBearer(bearer);
    if (!isAgentKey(key)) {
      throw new ToolError("invalid", "expected an agent key: `Authorization: Bearer fld_…`", CREATE_KEY_FIX);
    }
    const row = this.db.conn.query<KeyRow, [string]>(KEY_QUERY).get(sha256(key));
    const forbidden = (message: string) => new ToolError("forbidden", message, CREATE_KEY_FIX);
    if (!row) throw forbidden("unknown agent key");
    if (row.revoked_ms !== null) throw forbidden(`agent key ${row.prefix} was revoked`);
    if (row.person_removed) throw forbidden(`the person key ${row.prefix} belongs to was removed from the hub`);
    const now = this.clock.now();
    if (row.last_used_ms === null || now - row.last_used_ms >= LAST_USED_EVERY_MS) {
      this.db.conn.query("UPDATE agent_keys SET last_used_ms = ? WHERE key_id = ?").run(now, row.key_id);
      row.last_used_ms = now;
    }
    return info(row);
  }
}

/**
 * The key as the hub applies it: a device never holds more than its person's role allows, so a member's device reads
 * (and acts) as operate even where its own grant says admin.
 */
export function info(row: KeyRow): AgentKeyInfo {
  const stored = JSON.parse(row.grants) as Grant[];
  const grants = row.person_id === null ? stored : capped(stored, roleCap(roleOf(row.person_role ?? "")));
  return {
    keyId: row.key_id,
    name: row.name,
    ...(row.kind === "human" ? { kind: "human" as const } : {}),
    prefix: row.prefix,
    grants,
    createdAt: isoMs(row.created_ms),
    ...(row.last_used_ms === null ? {} : { lastUsedAt: isoMs(row.last_used_ms) }),
    ...(row.revoked_ms === null ? {} : { revokedAt: isoMs(row.revoked_ms) }),
    ...(row.person_id === null ? {} : { person: { personId: row.person_id, name: cleanName(row.person_name ?? "") ?? OWNER_FALLBACK } }),
  };
}

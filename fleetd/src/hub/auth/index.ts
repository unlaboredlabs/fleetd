// Key checking, as crates/fleetd/src/hub/auth/mod.rs does it: a key is `fld_` and 52 base32 characters, stored as its
// SHA-256; a revoked key, or one whose person was removed, is refused on its next call. Creating, listing and revoking
// keys, enroll tokens and node keys are hub-core's to port here (PORT_MAP.md).
import type { AgentKeyInfo } from "../../shared/contracts.ts";
import type { Clock } from "../../shared/clock.ts";
import type { HubDb } from "../store/db.ts";
import { isAgentKey, sha256, stripBearer } from "./allows.ts";
import { Keys } from "./keys.ts";
import { NodeKeys } from "./nodes.ts";
import { info, keyRefusal, type KeyRow, LAST_USED_EVERY_MS, notAgentKey } from "./key_rules.ts";

export { allows, isAgentKey, isoMs, sha256, stripBearer } from "./allows.ts";
export { info, type KeyRow } from "./key_rules.ts";

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
    if (!isAgentKey(key)) throw notAgentKey();
    const row = this.db.conn.query<KeyRow, [string]>(KEY_QUERY).get(sha256(key));
    const refused = keyRefusal(row ?? undefined);
    if (refused || !row) throw refused;
    const now = this.clock.now();
    if (row.last_used_ms === null || now - row.last_used_ms >= LAST_USED_EVERY_MS) {
      this.db.conn.query("UPDATE agent_keys SET last_used_ms = ? WHERE key_id = ?").run(now, row.key_id);
      row.last_used_ms = now;
    }
    return info(row);
  }
}

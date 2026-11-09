// Creating, listing and revoking agent and human keys (`list`,
// `get`, `revoke`), with the same SQL: `hub.auth.keys`.
import type { AgentKeyInfo, Grant, PersonId } from "../../shared/contracts.ts";
import type { Clock } from "../../shared/clock.ts";
import { ToolError } from "../../shared/errors.ts";
import { ensureOwnerOn, getOn, machineUser } from "../people/store.ts";
import type { HubDb } from "../store/db.ts";
import { info, type KeyRow, sha256 } from "./index.ts";
import { base32, secret } from "./nodes.ts";

const KEY_PREFIX = "fld_";

const KEY_COLUMNS = `k.key_id, k.name, k.kind, k.prefix, k.grants, k.created_ms, k.last_used_ms, k.revoked_ms,
  p.person_id, p.name AS person_name, p.role AS person_role, p.removed_ms IS NOT NULL AS person_removed`;
const KEY_FROM = "agent_keys k LEFT JOIN people p ON p.person_id = k.person_id";

/** `key` is shown once and never stored; the hub keeps its sha256. */
export type CreatedKey = { key: string; info: AgentKeyInfo };

/** `AuthError::KeyNotFound`. */
export const keyNotFound = (keyId: string) =>
  new ToolError("not_found", `no agent key ${keyId}; run \`fleetd hub key list\` to see key ids`);

export class Keys {
  constructor(
    private readonly db: HubDb,
    private readonly clock: Clock,
    /** Tells open connections that keys were revoked (`Auth.revokedSome`). */
    private readonly revoked: () => void,
  ) {}

  /** A human key belongs to the hub's owner; `createKeyFor` names another person. */
  createKey(name: string, grants: Grant[], kind: "agent" | "human"): CreatedKey {
    return this.createKeyFor(name, grants, kind, undefined);
  }

  /** A human key for `person` (the owner when undefined); an agent key belongs to no one. */
  createKeyFor(name: string, grants: Grant[], kind: "agent" | "human", person: PersonId | undefined): CreatedKey {
    const now = this.clock.now();
    const key = secret(KEY_PREFIX);
    const keyId = `key_${base32(crypto.getRandomValues(new Uint8Array(5)))}`;
    return this.db.transaction((c) => {
      const personId = kind === "agent" ? undefined : (person ?? ensureOwnerOn(c, machineUser(), now).personId);
      c.query(
        `INSERT INTO agent_keys (key_id, hash, prefix, name, grants, created_ms, kind, person_id)
         VALUES ($key_id, $hash, $prefix, $name, $grants, $created_ms, $kind, $person)`,
      ).run({
        key_id: keyId,
        hash: sha256(key),
        prefix: key.slice(0, KEY_PREFIX.length + 6),
        name,
        grants: JSON.stringify(grants),
        created_ms: now,
        kind,
        person: personId ?? null,
      });
      const p = personId === undefined ? undefined : getOn(c, personId);
      const row: KeyRow = {
        key_id: keyId,
        name,
        kind,
        prefix: key.slice(0, KEY_PREFIX.length + 6),
        grants: JSON.stringify(grants),
        created_ms: now,
        last_used_ms: null,
        revoked_ms: null,
        person_id: p?.personId ?? null,
        person_name: p?.name ?? null,
        person_role: p?.role ?? null,
        person_removed: p === undefined ? null : p.removedAt === undefined ? 0 : 1,
      };
      return { key, info: info(row) };
    });
  }

  /** Every key, oldest first. */
  list(): AgentKeyInfo[] {
    return this.db.all<KeyRow>(`SELECT ${KEY_COLUMNS} FROM ${KEY_FROM} ORDER BY k.created_ms, k.key_id`).map(info);
  }

  /** One key by its id, revoked or not. */
  get(keyId: string): AgentKeyInfo | undefined {
    const row = this.db.conn.query<KeyRow, [string]>(`SELECT ${KEY_COLUMNS} FROM ${KEY_FROM} WHERE k.key_id = ?`).get(keyId);
    return row ? info(row) : undefined;
  }

  /**
   * Idempotent: revoking a revoked key keeps its first `revokedAt`. The hub links minted from it go with it, in the
   * same transaction (D337); returns how many of those were still live. Throws `keyNotFound` for an unknown key.
   */
  revoke(keyId: string): number {
    const now = this.clock.now();
    const [changed, links] = this.db.transaction((c) => [
      c.query("UPDATE agent_keys SET revoked_ms = COALESCE(revoked_ms, ?) WHERE key_id = ?").run(now, keyId).changes,
      c.query("UPDATE hub_links_issued SET revoked_ms = ? WHERE key_id = ? AND revoked_ms IS NULL").run(now, keyId)
        .changes,
    ]);
    if (changed === 0) throw keyNotFound(keyId);
    this.revoked();
    return links;
  }
}

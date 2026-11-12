// Agent and human keys' rules and words, with no database behind them (index.ts checks a key, keys.ts makes and
// revokes them): the key's form, how often its last use is written, what a refused key is told, and the key as the
// hub applies it.
import type { AgentKeyInfo, Grant } from "../../shared/contracts.ts";
import { ToolError } from "../../shared/errors.ts";
import { capped, cleanName, OWNER_FALLBACK, roleCap, roleOf } from "../people/roles.ts";
import { isoMs } from "./allows.ts";

export const CREATE_KEY_FIX = "create a key with `fleetd hub key create --name <name> --role <role> --machines '*'`";
export const KEY_PREFIX = "fld_";
/** A key's last-used time is written again only when it is older than this. */
export const LAST_USED_EVERY_MS = 60_000;

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

/** The start of a key its lists show: its prefix and 6 characters. */
export const shownPrefix = (key: string) => key.slice(0, KEY_PREFIX.length + 6);

/** `AuthError::KeyNotFound`. */
export const keyNotFound = (keyId: string) =>
  new ToolError("not_found", `no agent key ${keyId}; run \`fleetd hub key list\` to see key ids`);

/** A bearer that isn't an agent key at all. */
export const notAgentKey = () => new ToolError("invalid", "expected an agent key: `Authorization: Bearer fld_…`", CREATE_KEY_FIX);

/** Why the key of `row` (its row by its hash; undefined for none) is refused, if it is: unknown, revoked, or its person removed. */
export function keyRefusal(row: { prefix: string; revoked_ms: unknown; person_removed: unknown } | undefined): ToolError | undefined {
  const forbidden = (message: string) => new ToolError("forbidden", message, CREATE_KEY_FIX);
  if (!row) return forbidden("unknown agent key");
  if (row.revoked_ms !== null) return forbidden(`agent key ${row.prefix} was revoked`);
  if (row.person_removed) return forbidden(`the person key ${row.prefix} belongs to was removed from the hub`);
  return undefined;
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

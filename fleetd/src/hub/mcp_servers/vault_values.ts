// An MCP server's values that come from the vault (`kind: "vault"`), without the database, so fleetd cloud's own
// src/mcp_servers keeps the same rules: which items a server may use, the value an item gives, what the server's row
// keeps of it, and the audit row each sealing writes. The hub opens the item and seals the value to each machine that
// runs the server through the node's `mcp_secrets`, as it seals an app's typed secret (./vault_sync.ts); the node
// holds it as a secret by name, so the session config and the node are as before.
import type { McpScope, McpSealedOn, McpValue, McpValueSet, McpVaultField } from "../../shared/contracts.ts";
import type { NewAudit } from "../vault/audit_entry.ts";
import type { ItemRow } from "../vault/item.ts";

export const VAULT_PREFIX_MAX = 64;

type VaultSet = Extract<McpValueSet, { kind: "vault" }>;

/** The value an item gives by default: a login's password, a variable's value. */
export const defaultField = (kind: string): McpVaultField => (kind === "env" ? "value" : "password");

/** Why a server of `scope` can't take `item`'s value, in plain words; undefined when it can. */
export function vaultProblem(scope: McpScope, item: ItemRow | undefined, field?: McpVaultField): string | undefined {
  if (item === undefined || item.deletedMs !== undefined) return "Its vault item was deleted: pick another.";
  if (item.kind !== "login" && item.kind !== "env") return `${item.label} is a ${item.kind}: pick a login or a variable.`;
  if ((field ?? defaultField(item.kind)) !== defaultField(item.kind)) {
    return item.kind === "login" ? `${item.label} is a login: it gives its password.` : `${item.label} is a variable: it gives its value.`;
  }
  if (item.kind === "login") return item.scope === "hub" ? undefined : `${item.label} isn't in the workspace vault: move it there first.`;
  if (item.meta.sink !== undefined) return `${item.label} is kept for one request only: pick a login or a bot's variable.`;
  const own = scope.kind === "project" && item.scope === "project" && item.machineId === scope.machineId && item.projectId === scope.projectId;
  if (own) return undefined;
  return scope.kind === "global"
    ? `${item.label} is one bot's variable, and this server is for every bot: pick a team login.`
    : `${item.label} is another bot's variable: pick a team login or this bot's own variable.`;
}

/** The text a server gets from an opened item: its field's value after `prefix`; undefined when the field is empty. */
export function vaultValue(kind: string, secret: Record<string, string>, field?: McpVaultField, prefix?: string): string | undefined {
  const raw = (field ?? defaultField(kind)) === "value" ? secret.value : secret.password;
  if (raw === undefined || raw === "") return undefined;
  return `${prefix ?? ""}${raw}`;
}

/** What a server's row keeps of a vault value: the item, its label, the field and prefix, where it is sealed, and
 * why agents go without it when they do. */
export function keptVaultValue(set: VaultSet, item: ItemRow | undefined, sealedOn: McpSealedOn[], problem: string | undefined): McpValue {
  return {
    name: set.name,
    kind: "vault",
    itemId: set.itemId,
    ...(set.field !== undefined ? { field: set.field } : {}),
    ...(set.prefix !== undefined && set.prefix !== "" ? { prefix: set.prefix } : {}),
    ...(item !== undefined ? { label: item.label } : {}),
    ...(sealedOn.length > 0 ? { sealedOn } : {}),
    ...(problem !== undefined ? { problem } : {}),
  };
}

/** A kept vault value as a save sends it again unchanged (an app that edits the rest of the server). */
export const vaultSetOf = (v: McpValue): VaultSet => ({
  kind: "vault",
  name: v.name,
  itemId: v.itemId ?? "",
  ...(v.field !== undefined ? { field: v.field } : {}),
  ...(v.prefix !== undefined ? { prefix: v.prefix } : {}),
});

/** The audit row of one sealing of `item` to machine `m` for server `server`: a `deliver` via `mcp`. */
export function vaultAudit(item: ItemRow, m: string, scope: McpScope, server: string, atMs: number, error?: string): NewAudit {
  return {
    atMs,
    itemId: item.itemId,
    action: "deliver",
    outcome: error === undefined ? "ok" : "failed",
    machineId: m,
    ...(scope.kind === "project" ? { projectId: scope.projectId } : {}),
    data: { label: item.label, kind: item.kind, names: [server], host: m, via: "mcp", ...(error !== undefined ? { message: error } : {}) },
  };
}

// The vault's tools, from a person's own device (the contracts' vault_* rows). Agents never call these: they fill and
// get variables through their nodes (calls.ts, deliver.ts). No value crosses in the clear: vault_save takes the fields
// sealed to the hub's box key, vault_reveal answers sealed to the one-time key the app sends.
import type { ProjectRef } from "../../shared/contracts.ts";
import { ToolError } from "../../shared/errors.ts";
import { publicKeyOf, seal } from "../../shared/sealed_box.ts";
import { isHuman, requireRole } from "../api/grants.ts";
import type { Hub } from "../api/hub.ts";
import { unknownProject } from "../api/refusals.ts";
import type { Caller, Registry } from "../api/registry.ts";
import { allows } from "../auth/index.ts";
import { boxKey } from "../hub_links/store.ts";
import { store as hubStore } from "../store/hub_store.ts";
import { deliveries } from "./deliver.ts";
import { FIELDS, hostOf, type VaultKind, type VaultScope } from "./fields.ts";
import { importItems, search } from "./import.ts";
import { type ItemRow, vault, type Viewer } from "./index.ts";
import { deleteItem, moveItem, openToHub, restoreItem, saveItem, summary } from "./items.ts";
import { copyTeamVars, migrationStatus } from "./migrate.ts";

/** Reveals one person may make in an hour. */
export const REVEALS_PER_HOUR = 30;

const b64 = (b: Uint8Array) => Buffer.from(b).toString("base64");

function person(hub: Hub, caller: Caller): Viewer {
  if (!isHuman(caller)) {
    throw new ToolError("forbidden", "The vault is a person's: only their own devices list and change it.", "Agents fill and get variables through their nodes.");
  }
  return vault(hub).viewer(caller);
}

/** vault_status: the key's mode and state, the hub's box key to seal to, and the migration's progress. */
export function status(hub: Hub): Record<string, unknown> {
  const v = vault(hub);
  let keyId: string | undefined;
  try {
    keyId = v.keys.locked ? undefined : v.keys.active().id;
  } catch {}
  return {
    hubBoxKey: b64(publicKeyOf(boxKey(hub))),
    keyMode: v.keys.mode ?? "file",
    ...(keyId !== undefined ? { keyId } : {}),
    locked: v.keys.mode === "passphrase" && v.keys.locked,
    keyMissing: v.problem?.reason === "vault_key_missing" || (v.keys.mode !== "passphrase" && v.keys.locked),
    recoverySaved: v.store.setting("recovery_saved_ms") !== undefined,
    migration: migrationStatus(hub),
  };
}

/**
 * The items `v` sees that `input` picks: with a project, its variables and its orders' (with `usable`, the team
 * vault's items too); without, the team vault and `v`'s own items set aside. An older app's `scope` filter still works.
 */
export function listFor(
  hub: Hub,
  v: Viewer,
  input: { scope?: VaultScope; machineId?: string; projectId?: string; kind?: VaultKind; query?: string; trash?: boolean; usable?: boolean },
): ItemRow[] {
  const vt = vault(hub);
  let rows: ItemRow[];
  if (input.machineId !== undefined && input.projectId !== undefined) {
    const r: ProjectRef = { machineId: input.machineId, projectId: input.projectId };
    if (!hubStore(hub).projectGet(r)) throw unknownProject(r);
    requireRole(v.caller, "read", r.machineId);
    rows = vt.store.select(
      `(machine_id = ? AND project_id = ? AND scope IN ('project', 'order'))${input.usable === true ? " OR scope = 'hub'" : ""}`,
      [r.machineId, r.projectId],
      input.trash === true,
    );
  } else {
    rows = vt.store.select("scope = 'hub' OR (scope = 'person' AND person_id = ?)", [v.person ?? null], input.trash === true);
  }
  const q = input.query?.trim().toLowerCase();
  return rows.filter(
    (row) =>
      vt.canSee(v, row) &&
      (input.scope === undefined || row.scope === input.scope) &&
      (input.kind === undefined || row.kind === input.kind) &&
      (!q || row.label.toLowerCase().includes(q) || (row.envName ?? "").toLowerCase().includes(q) || (row.meta.sites ?? []).some((s) => s.includes(q))),
  );
}

export function register(tools: Registry): void {
  tools.add("vault_status", async (hub, caller) => {
    person(hub, caller);
    await vault(hub).load();
    return status(hub) as never;
  });

  tools.add("vault_list", async (hub, caller, input) => {
    const v = person(hub, caller);
    await vault(hub).load();
    return { items: listFor(hub, v, input as never).map((row) => summary(hub, v, row)) } as never;
  });

  tools.add("vault_get", async (hub, caller, input) => {
    const v = person(hub, caller);
    const vt = vault(hub);
    await vt.load();
    let row: ItemRow;
    try {
      row = vt.visible(v, input.itemId);
    } catch {
      row = vt.visible(v, input.itemId, true);
    }
    const activity = vt.audit.list("item_id = ?", [row.itemId], undefined, 20);
    return { item: summary(hub, v, row), activity } as never;
  });

  tools.add("vault_save", async (hub, caller, input) => {
    const v = person(hub, caller);
    await vault(hub).load();
    const i = input as Record<string, unknown> & { sealed?: string };
    const row = saveItem(hub, v, {
      ...(i.itemId !== undefined ? { itemId: String(i.itemId) } : {}),
      ...(i.kind !== undefined ? { kind: i.kind as VaultKind } : {}),
      ...(i.scope !== undefined ? { scope: i.scope as VaultScope } : {}),
      ...(i.machineId !== undefined ? { machineId: String(i.machineId) } : {}),
      ...(i.projectId !== undefined ? { projectId: String(i.projectId) } : {}),
      ...(i.workstreamId !== undefined ? { workstreamId: String(i.workstreamId) } : {}),
      ...(i.label !== undefined ? { label: String(i.label) } : {}),
      ...(i.sites !== undefined ? { sites: i.sites as string[] } : {}),
      ...(i.envName !== undefined ? { envName: String(i.envName) } : {}),
      ...(i.secret !== undefined ? { secret: i.secret === true } : {}),
      ...(i.billingAddress !== undefined ? { billingAddress: String(i.billingAddress) } : {}),
      ...(i.sealed !== undefined ? { fields: openToHub(hub, i.sealed) } : {}),
    });
    return { item: summary(hub, v, row) } as never;
  });

  tools.add("vault_delete", async (hub, caller, input) => {
    const v = person(hub, caller);
    await vault(hub).load();
    const deletedMs = deleteItem(hub, v, input.itemId, input.purge === true);
    return { itemId: input.itemId, ...(deletedMs !== undefined ? { deletedMs } : {}) } as never;
  });

  tools.add("vault_restore", async (hub, caller, input) => {
    const v = person(hub, caller);
    await vault(hub).load();
    return { item: summary(hub, v, restoreItem(hub, v, input.itemId)) } as never;
  });

  tools.add("vault_move", async (hub, caller, input) => {
    const v = person(hub, caller);
    await vault(hub).load();
    const row = moveItem(hub, v, input.itemId, {
      ...(input.machineId !== undefined ? { machineId: input.machineId } : {}),
      ...(input.projectId !== undefined ? { projectId: input.projectId } : {}),
    });
    return { item: summary(hub, v, row) } as never;
  });

  tools.add("vault_reveal", async (hub, caller, input) => {
    const v = person(hub, caller);
    const vt = vault(hub);
    await vt.load();
    vt.requireOpen();
    const row = vt.visible(v, input.itemId);
    if (!vt.canReveal(v, row)) throw new ToolError("forbidden", `You can't reveal ${row.label}.`, "Its creator or an admin can.");
    const fields = [...new Set(input.fields as string[])];
    const bad = fields.find((f) => !FIELDS[row.kind].includes(f));
    if (bad) throw new ToolError("invalid", `A ${row.kind} has no field ${bad}.`);
    const now = hub.clock.now();
    const recent = hub.db.conn
      .query<{ n: number }, [string, number]>("SELECT count(*) AS n FROM vault_audit WHERE action = 'reveal' AND person_id = ? AND at_ms > ?")
      .get(v.person ?? "", now - 3600_000)?.n ?? 0;
    if (recent >= REVEALS_PER_HOUR) {
      throw new ToolError("failed", `You revealed ${REVEALS_PER_HOUR} values this hour.`, "Wait a little, then try again.", "vault_rate_limited");
    }
    const replyKey = new Uint8Array(Buffer.from(String(input.replyKey), "base64"));
    if (replyKey.length !== 32) throw new ToolError("invalid", "replyKey: expected a 32-byte X25519 public key");
    const secret = vt.store.open(row);
    const out: Record<string, string> = {};
    for (const f of fields) if (secret[f] !== undefined) out[f] = secret[f]!;
    const bytes = Buffer.from(JSON.stringify(out), "utf8");
    let sealed: string;
    try {
      sealed = b64(seal(replyKey, bytes));
    } finally {
      bytes.fill(0);
    }
    vt.used({
      atMs: now,
      itemId: row.itemId,
      action: "reveal",
      outcome: "ok",
      ...(v.person !== undefined ? { personId: v.person } : {}),
      deviceId: caller.keyId,
      ...(row.machineId !== undefined ? { machineId: row.machineId } : {}),
      ...(row.projectId !== undefined ? { projectId: row.projectId } : {}),
      data: { label: row.label, kind: row.kind, fields },
    });
    return { sealed } as never;
  });

  tools.add("vault_audit", async (hub, caller, input) => {
    const v = person(hub, caller);
    const vt = vault(hub);
    const limit = input.limit ?? 100;
    let where: string;
    let params: (string | number)[];
    if (input.itemId !== undefined) {
      let row: ItemRow;
      try {
        row = vt.visible(v, input.itemId);
      } catch {
        row = vt.visible(v, input.itemId, true);
      }
      where = "item_id = ?";
      params = [row.itemId];
    } else if (input.machineId !== undefined && input.projectId !== undefined) {
      const r = { machineId: input.machineId, projectId: input.projectId };
      requireRole(caller, "read", r.machineId);
      if (!hubStore(hub).projectGet(r)) throw unknownProject(r);
      // The project's rows, but never another person's items set aside (an admin doesn't see those either).
      where = `machine_id = ? AND project_id = ? AND (item_id = '' OR item_id NOT IN (SELECT item_id FROM vault_items WHERE scope = 'person' AND person_id <> ?))`;
      params = [r.machineId, r.projectId, v.person ?? ""];
    } else {
      where = "item_id IN (SELECT item_id FROM vault_items WHERE scope = 'hub' OR (scope = 'person' AND person_id = ?))";
      params = [v.person ?? ""];
    }
    const entries = vt.audit.list(where, params, input.before, limit + 1);
    return { entries: entries.slice(0, limit), more: entries.length > limit } as never;
  });

  tools.add("vault_unlock", async (hub, caller, input) => {
    const v = person(hub, caller);
    if (!v.admin) throw new ToolError("forbidden", "Only an owner or admin unlocks the vault.");
    const vt = vault(hub);
    await vt.load();
    const pass = openToHub(hub, input.sealed);
    if (typeof pass !== "object" || pass === null || typeof (pass as { passphrase?: unknown }).passphrase !== "string") {
      throw new ToolError("invalid", "The sealed value holds no passphrase.", "Seal {\"passphrase\": …} to hubBoxKey.");
    }
    const ok = vt.keys.unlock((pass as { passphrase: string }).passphrase);
    vt.used({
      atMs: hub.clock.now(),
      itemId: "",
      action: "unlock",
      outcome: ok ? "ok" : "refused",
      ...(v.person !== undefined ? { personId: v.person } : {}),
      deviceId: caller.keyId,
      data: {},
    });
    if (!ok) throw new ToolError("forbidden", "That passphrase doesn't open the vault.", "Type it again.");
    vt.store.recordKeys(hub.clock.now());
    copyTeamVars(hub);
    void deliveries(hub).reconcileAll();
    return status(hub) as never;
  });

  tools.add("vault_rotate", async (hub, caller) => {
    const v = person(hub, caller);
    if (!v.admin) throw new ToolError("forbidden", "Only an owner or admin rotates the vault key.");
    const vt = vault(hub);
    await vt.load();
    vt.requireOpen();
    const { keyId, rewrapped } = await rotate(hub);
    vt.used({
      atMs: hub.clock.now(),
      itemId: "",
      action: "rotate",
      outcome: "ok",
      ...(v.person !== undefined ? { personId: v.person } : {}),
      deviceId: caller.keyId,
      data: { count: rewrapped },
    });
    return { keyId, rewrapped } as never;
  });

  tools.add("vault_import_search", async (hub, caller, input) => {
    const v = person(hub, caller);
    if (v.person === undefined) throw new ToolError("forbidden", "Only a person searches their own 1Password.");
    return (await search(hub, v.person, input.query, input.kinds as VaultKind[] | undefined, input.machineId)) as never;
  });

  tools.add("vault_import", async (hub, caller, input) => {
    const v = person(hub, caller);
    await vault(hub).load();
    return (await importItems(hub, v, input as never)) as never;
  });
}

/** Makes a fresh root key, rewraps every item under it in one transaction, then drops the old ones. */
export async function rotate(hub: Hub): Promise<{ keyId: string; rewrapped: number }> {
  const vt = vault(hub);
  const fresh = await vt.keys.add();
  vt.store.recordKeys(hub.clock.now());
  const rewrapped = vt.store.rewrapAll(fresh, hub.clock.now());
  await vt.keys.dropAllBut(fresh.id);
  // The saved recovery code was the old key's: the new one needs saving again.
  vt.store.setSetting("recovery_saved_ms", undefined);
  return { keyId: fresh.id, rewrapped };
}


// Writing items (vault_save, vault_delete, vault_restore, vault_move) and reading them as the apps list them.
// The tools and the old APIs' aliases (env vars, secret sinks, imports) all write through here, so every write checks
// the same scope rules and limits, keeps the Rust mirror, delivers variables and leaves its audit row.
import type { ProjectRef } from "../../shared/contracts.ts";
import { ToolError } from "../../shared/errors.ts";
import { openSealed } from "../../shared/sealed_box.ts";
import type { Hub } from "../api/hub.ts";
import { unknownProject } from "../api/refusals.ts";
import { allows } from "../auth/index.ts";
import { boxKey } from "../hub_links/store.ts";
import { workstreamGet } from "../orders/workstreams.ts";
import { ENV_TOTAL_MAX_BYTES, envTotalOver, PROJECT_ENV_MAX } from "../projects/settings.ts";
import { store as hubStore } from "../store/hub_store.ts";
import { deliveries, mirrorProjectRow } from "./deliver.ts";
import { checkEnvName, cleanSecret, cleanSites, LABEL_MAX, merge, type Meta, metaOf, type Secret, type VaultKind } from "./fields.ts";
import { type ItemRow, type Viewer, vault } from "./index.ts";
import { type SaveSpec, sinkEnvName, updateApp } from "./item.ts";
import { type ItemDraft, ITEMS_MAX } from "./store.ts";

export { type SaveSpec, sinkEnvName } from "./item.ts";

/** What a save says, as vault_save takes it (its `sealed` already opened) or an alias builds it. */
/** `sealed` opened with the hub's box key: its bytes. */
export function openRawToHub(hub: Hub, sealed: string): Uint8Array {
  const bytes = openSealed(boxKey(hub), new Uint8Array(Buffer.from(sealed, "base64")));
  if (!bytes) throw new ToolError("invalid", "The value wasn't sealed to this hub's key.", "Seal it to hubBoxKey from vault_status and try again.");
  return bytes;
}

/** `sealed` opened with the hub's box key: the JSON it holds. */
export function openToHub(hub: Hub, sealed: string): unknown {
  const bytes = openRawToHub(hub, sealed);
  try {
    return JSON.parse(Buffer.from(bytes).toString("utf8"));
  } catch {
    throw new ToolError("invalid", "The sealed value isn't JSON.");
  } finally {
    bytes.fill(0);
  }
}

const by = (v: Viewer) => v.person ?? `key:${v.caller.keyId}`;


/** The vault item a `request_secret` env:/file: sink keeps its value in: the same file and the same secret key. */
export function sinkItem(hub: Hub, sink: { kind: "env" | "file"; machineId: string; path: string; secretKey: string }): ItemRow | undefined {
  return vault(hub)
    .store.select("kind = 'env' AND json_extract(meta, '$.sink.machineId') = ? AND json_extract(meta, '$.sink.path') = ?", [sink.machineId, sink.path])
    .find((x) => x.meta.sink?.kind === sink.kind && x.meta.sink.secretKey === sink.secretKey);
}

function checkLabel(label: string | undefined): string {
  const l = (label ?? "").trim();
  if (l === "" || l.length > LABEL_MAX || /[\r\n]/.test(l)) throw new ToolError("invalid", `A label is 1 to ${LABEL_MAX} characters on one line.`);
  return l;
}

/** A project `v` may put a variable in. */
function projectFor(hub: Hub, v: Viewer, machineId: string | undefined, projectId: string | undefined): ProjectRef {
  if (machineId === undefined || projectId === undefined) throw new ToolError("invalid", "A variable names its machineId and projectId.");
  const r = { machineId, projectId };
  if (v.system) return r;
  if (!hubStore(hub).projectGet(r)) throw unknownProject(r);
  if (!allows(v.caller, "operate", r.machineId)) {
    throw new ToolError("forbidden", `You can't change ${r.projectId}'s variables.`, "Ask someone who operates the project.");
  }
  return r;
}

/**
 * The scope fields of a new item, checked against who asks. A login, card or address names no scope: it goes in the
 * team vault. One that names a person's, the hub's or a project's level comes from an app older than the hub.
 */
function scopeOf(hub: Hub, v: Viewer, s: SaveSpec, kind: VaultKind): Pick<ItemDraft, "scope" | "personId" | "machineId" | "projectId" | "workstreamId"> {
  if (kind !== "env") {
    if (s.scope !== undefined) throw updateApp();
    return { scope: "hub", ...(v.person !== undefined ? { personId: v.person } : {}) };
  }
  switch (s.scope) {
    case undefined:
      throw new ToolError("invalid", "A variable names its project: scope project, machineId and projectId.");
    case "person":
      throw updateApp();
    case "hub":
      throw new ToolError("invalid", "Variables belong to a project or an order, not the team vault.");
    case "project":
      return { scope: "project", ...projectFor(hub, v, s.machineId, s.projectId) };
    case "order": {
      const r = projectFor(hub, v, s.machineId, s.projectId);
      const w = s.workstreamId;
      const order = w !== undefined && /^W[1-9][0-9]{0,9}$/.test(w) ? workstreamGet(hub.db.conn, w) : undefined;
      if (!v.system && (!order || order.projectRef.machineId !== r.machineId || order.projectRef.projectId !== r.projectId || order.state !== "open")) {
        throw new ToolError("invalid", `${w ?? "That"} is no open order of ${r.projectId}.`, "Name an open order of the project.");
      }
      return { scope: "order", ...r, workstreamId: w! };
    }
  }
}

/** A project's variables, after `row` is saved, stay within today's limits (100, and 512 KiB together). */
function checkEnvLimits(hub: Hub, row: Pick<ItemDraft, "scope" | "machineId" | "projectId" | "workstreamId" | "envName" | "meta">, bytes: number, replacing?: string): void {
  if ((row.scope !== "project" && row.scope !== "order") || row.meta.sink) return;
  const others = vault(hub)
    .store.select("kind = 'env' AND scope = ? AND machine_id = ? AND project_id = ? AND ifnull(workstream_id, '') = ?", [
      row.scope,
      row.machineId!,
      row.projectId!,
      row.workstreamId ?? "",
    ])
    .filter((x) => x.itemId !== replacing && !x.meta.sink);
  if (others.length + 1 > PROJECT_ENV_MAX) {
    throw new ToolError("invalid", `A ${row.scope} takes at most ${PROJECT_ENV_MAX} variables.`, "Remove some first.");
  }
  const total = others.reduce((n, x) => n + (x.meta.bytes ?? 0), bytes);
  if (total > ENV_TOTAL_MAX_BYTES) throw new ToolError("invalid", envTotalOver(total), "Remove or shorten some, or put large values in files on the machine.");
}

function checkBilling(hub: Hub, v: Viewer, id: string | undefined): void {
  if (id === undefined) return;
  const a = vault(hub).store.get(id);
  if (!a || a.kind !== "address" || a.scope !== "hub" || a.deletedMs !== undefined) {
    throw new ToolError("invalid", `${id} isn't an address in the team vault.`, "Pick one of the team vault's addresses.");
  }
}

/** Saves a new item or a change to one; returns its row. Never logs or returns a value. */
export function saveItem(hub: Hub, v: Viewer, s: SaveSpec, action: "create" | "update" | "import" | "adopt" = s.itemId ? "update" : "create"): ItemRow {
  const vt = vault(hub);
  vt.requireOpen();
  const now = hub.clock.now();
  if (s.sites !== undefined) s.sites = cleanSites(s.sites);
  if (s.itemId !== undefined) {
    const row = vt.visible(v, s.itemId);
    if (!vt.canEdit(v, row)) throw new ToolError("forbidden", `You can't change ${row.label}.`, "Ask its creator or an admin.");
    // Making a secret variable plain shows its value in every list: only who may reveal it does.
    const newValue = typeof s.fields === "object" && s.fields !== null && "value" in s.fields;
    if (row.meta.secret === true && s.secret === false && !newValue && !vt.canShow(v, row)) {
      throw new ToolError("forbidden", `You can't make ${row.label} plain: its value would show.`, "Its creator or an admin can; or give it a new value.");
    }
    const secret: Secret = s.fields === undefined ? vt.store.open(row) : merge(row.kind, vt.store.open(row), s.fields);
    let envName = row.envName;
    if (row.kind === "env" && !row.meta.sink && s.envName !== undefined && s.envName !== row.envName) {
      checkEnvName(s.envName);
      envName = s.envName;
    }
    checkBilling(hub, v, s.billingAddress);
    const meta = metaOf(row.kind, secret, {
      sites: s.sites ?? row.meta.sites,
      secret: s.secret ?? row.meta.secret,
      billingAddress: s.billingAddress ?? row.meta.billingAddress,
      source: row.meta.source,
      ...(row.meta.sink ? { sink: row.meta.sink } : {}),
    } as Partial<Meta>);
    const draft: ItemDraft = {
      kind: row.kind,
      scope: row.scope,
      ...(row.personId !== undefined ? { personId: row.personId } : {}),
      ...(row.machineId !== undefined ? { machineId: row.machineId } : {}),
      ...(row.projectId !== undefined ? { projectId: row.projectId } : {}),
      ...(row.workstreamId !== undefined ? { workstreamId: row.workstreamId } : {}),
      ...(envName !== undefined ? { envName } : {}),
      label: row.kind === "env" && !row.meta.sink ? envName! : checkLabel(s.label ?? row.label),
      meta,
    };
    if (row.kind === "env") checkEnvLimits(hub, draft, meta.bytes ?? 0, row.itemId);
    const saved = vt.store.update(row, draft, secret, by(v), now);
    if (envName !== row.envName && row.kind === "env") mirrorProjectRow(hub, row, undefined, true);
    after(hub, v, saved, secret, action, s.held);
    return saved;
  }
  const kind = s.kind;
  if (kind === undefined) throw new ToolError("invalid", "A new item names its kind.");
  const scope = scopeOf(hub, v, s, kind);
  const secret = cleanSecret(kind, s.fields);
  if (kind === "env") {
    if (s.sink) s.envName = sinkEnvName(s.sink);
    else {
      if (s.envName === undefined) throw new ToolError("invalid", "A variable names its envName.");
      checkEnvName(s.envName);
    }
    if (secret.value === undefined) secret.value = "";
  }
  checkBilling(hub, v, s.billingAddress);
  const meta = metaOf(kind, secret, {
    ...(s.sites !== undefined ? { sites: s.sites } : {}),
    ...(s.secret !== undefined ? { secret: s.secret } : {}),
    ...(s.billingAddress !== undefined ? { billingAddress: s.billingAddress } : {}),
    ...(s.source !== undefined ? { source: s.source } : {}),
    ...(s.sink !== undefined ? { sink: s.sink } : {}),
  });
  const label = s.sink ? checkLabel(s.sink.envName ?? s.sink.secretKey ?? s.sink.path) : kind === "env" ? s.envName! : checkLabel(s.label);
  const draft: ItemDraft = { kind, ...scope, ...(kind === "env" ? { envName: s.envName! } : {}), label, meta };
  if (kind === "env") checkEnvLimits(hub, draft, meta.bytes ?? 0);
  const cap = scope.machineId ? vt.store.count({ machineId: scope.machineId, projectId: scope.projectId! }) : vt.store.count("team");
  if (cap >= ITEMS_MAX) throw new ToolError("invalid", `At most ${ITEMS_MAX} items fit here.`, "Delete some first.");
  const saved = vt.store.insert(draft, secret, by(v), now);
  after(hub, v, saved, secret, action, s.held);
  return saved;
}

/** What every write does after it: the audit row, the event, the Rust mirror and the variables' delivery. */
function after(hub: Hub, v: Viewer, row: ItemRow, secret: Secret | undefined, action: "create" | "update" | "import" | "adopt" | "delete" | "restore" | "move", held = false): void {
  const vt = vault(hub);
  vt.used({
    atMs: hub.clock.now(),
    itemId: row.itemId,
    action,
    outcome: "ok",
    ...(v.person !== undefined ? { personId: v.person } : {}),
    ...(v.human ? { deviceId: v.caller.keyId } : {}),
    ...(row.machineId !== undefined ? { machineId: row.machineId } : {}),
    ...(row.projectId !== undefined ? { projectId: row.projectId } : {}),
    ...(row.workstreamId !== undefined ? { workstreamId: row.workstreamId } : {}),
    data: { label: row.label, kind: row.kind, ...(row.envName !== undefined ? { names: [row.envName] } : {}) },
  });
  vt.changed(row);
  if (row.kind !== "env") return;
  mirrorProjectRow(hub, row, row.meta.secret ? undefined : secret?.value, action === "delete");
  if (!held) redeliver(hub, row);
}

/** Sends the variable's machines what changed, in the background: an offline one catches up when it links. */
export function redeliver(hub: Hub, row: Pick<ItemRow, "machineId" | "meta">): void {
  const d = deliveries(hub);
  const run = Promise.all([row.machineId, row.meta.sink?.machineId].filter((m): m is string => m !== undefined).map((m) => d.reconcile(m)));
  void run.catch((e) => console.warn("vault: a delivery failed:", (e as Error).message));
}

export function deleteItem(hub: Hub, v: Viewer, itemId: string, purge: boolean): number | undefined {
  const vt = vault(hub);
  const now = hub.clock.now();
  if (purge) {
    const row = vt.visible(v, itemId, true);
    if (!vt.canEdit(v, row)) throw new ToolError("forbidden", `You can't delete ${row.label}.`, "Ask its creator or an admin.");
    vt.store.purge(itemId);
    vt.changed(row);
    return undefined;
  }
  const row = vt.visible(v, itemId);
  if (!vt.canEdit(v, row)) throw new ToolError("forbidden", `You can't delete ${row.label}.`, "Ask its creator or an admin.");
  vt.store.setDeleted(itemId, now, by(v), now);
  after(hub, v, { ...row, deletedMs: now }, undefined, "delete");
  if (hub.db.conn.query("SELECT 1 FROM project_settings WHERE card_ref = ?").get(`vault:${itemId}`)) {
    hub.db.conn.query("UPDATE project_settings SET card_ref = NULL WHERE card_ref = ?").run(`vault:${itemId}`);
  }
  return now;
}

export function restoreItem(hub: Hub, v: Viewer, itemId: string): ItemRow {
  const vt = vault(hub);
  const row = vt.visible(v, itemId, true);
  if (!vt.canEdit(v, row)) throw new ToolError("forbidden", `You can't restore ${row.label}.`, "Ask its creator or an admin.");
  const now = hub.clock.now();
  try {
    vt.store.setDeleted(itemId, null, by(v), now);
  } catch (e) {
    if (String(e).includes("UNIQUE")) throw new ToolError("invalid", `There is a variable ${row.envName} here already.`, "Delete or rename that one first.");
    throw e;
  }
  const restored = vt.store.get(itemId)!;
  after(hub, v, restored, row.kind === "env" && !row.meta.secret ? vt.store.open(restored) : undefined, "restore");
  return restored;
}

/**
 * `vault_move`: an item set aside by the one-team-vault migration, by its owner, into the team vault (a login, card or
 * address) or into a project as its variable. Sealed again under its new scope.
 */
export function moveItem(hub: Hub, v: Viewer, itemId: string, to: { machineId?: string; projectId?: string }): ItemRow {
  const vt = vault(hub);
  vt.requireOpen();
  const row = vt.visible(v, itemId);
  if (row.scope !== "person" || row.personId !== v.person) {
    throw new ToolError("invalid", `${row.label} isn't set aside.`, "Only an item set aside at the upgrade moves.");
  }
  let scope: Pick<ItemDraft, "scope" | "personId" | "machineId" | "projectId">;
  if (row.kind === "env") {
    scope = { scope: "project", ...projectFor(hub, v, to.machineId, to.projectId) };
  } else {
    if (to.machineId !== undefined || to.projectId !== undefined) throw new ToolError("invalid", "A login, card or address moves to the team vault, not to a project.");
    scope = { scope: "hub", personId: v.person! };
  }
  const draft: ItemDraft = { kind: row.kind, ...scope, ...(row.envName !== undefined ? { envName: row.envName } : {}), label: row.label, meta: row.meta };
  if (row.kind === "env") checkEnvLimits(hub, draft, row.meta.bytes ?? 0, row.itemId);
  const cap = scope.machineId ? vt.store.count({ machineId: scope.machineId, projectId: scope.projectId! }) : vt.store.count("team");
  if (cap >= ITEMS_MAX) throw new ToolError("invalid", `At most ${ITEMS_MAX} items fit here.`, "Delete some first.");
  const secret = vt.store.open(row);
  const moved = vt.store.update(row, draft, secret, by(v), hub.clock.now());
  after(hub, v, moved, secret, "move");
  return moved;
}

/** An item as the apps list it: metadata only, a plain variable's value, and what the caller may do with it. */
export function summary(hub: Hub, v: Viewer, row: ItemRow): Record<string, unknown> {
  const vt = vault(hub);
  let value: string | undefined;
  if (row.kind === "env" && row.meta.secret === false && !vt.keys.locked) {
    try {
      value = vt.store.open(row).value;
    } catch {}
  }
  return {
    itemId: row.itemId,
    kind: row.kind,
    scope: row.scope,
    label: row.label,
    meta: row.meta,
    ...(row.envName !== undefined ? { envName: row.envName } : {}),
    ...(row.personId !== undefined ? { personId: row.personId } : {}),
    ...(row.machineId !== undefined ? { machineId: row.machineId } : {}),
    ...(row.projectId !== undefined ? { projectId: row.projectId } : {}),
    ...(row.workstreamId !== undefined ? { workstreamId: row.workstreamId } : {}),
    ...(value !== undefined ? { value } : {}),
    version: row.version,
    createdMs: row.createdMs,
    updatedMs: row.updatedMs,
    updatedBy: row.updatedBy,
    ...(row.deletedMs !== undefined ? { deletedMs: row.deletedMs } : {}),
    canEdit: vt.canEdit(v, row),
    canReveal: vt.canReveal(v, row),
  };
}

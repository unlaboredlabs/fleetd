// The old variable, secret-sink and card APIs as thin aliases of the vault, for one release (vault-design §7.4):
// - `project_env_set`: plain values and secrets sealed to the hub become the project's vault variables; a secret an
//   older app sealed to the node's key goes to the node as before and moves into the vault from there;
// - `request_secret` (env:, file:, order: sinks): the request names the hub's key (`sealTo`); a value sealed to it
//   becomes an order or project variable and is delivered from the vault; one sealed to the node goes as before;
// - a project's card may be a vault card (`vault:V…`); a purchase claim then carries it sealed to the hosting node.
import type { EnvVarName, EnvVarSet, HumanRequest, PersonRef, ProjectRef } from "../../shared/contracts.ts";
import { ToolError } from "../../shared/errors.ts";
import { CAP_VAULT_FILL } from "../../shared/node_link.ts";
import { openSealed, publicKeyOf, seal } from "../../shared/sealed_box.ts";
import type { Hub } from "../api/hub.ts";
import type { Caller } from "../api/registry.ts";
import { parseContractSink, secretEnvName } from "../approvals/sink.ts";
import { nodeCan } from "../link/node_port.ts";
import { boxKey } from "../hub_links/store.ts";
import { store as hubStore } from "../store/hub_store.ts";
import { deliveries } from "./deliver.ts";
import { BRAND_NAMES } from "./fields.ts";
import { type ItemRow, vault, type Viewer } from "./index.ts";
import { deleteItem, saveItem, sinkItem } from "./items.ts";
import { adopt } from "./migrate.ts";

const b64 = (b: Uint8Array) => Buffer.from(b).toString("base64");

/** The hub's box key, as a request's `sealTo` names it. */
export const hubSealTo = (hub: Hub) => b64(publicKeyOf(boxKey(hub)));

/** A value sealed to the hub's own key, as text; undefined when it was sealed to another (a node's). */
function openedByHub(hub: Hub, sealed: string): string | undefined {
  let bytes: Uint8Array | null;
  try {
    bytes = openSealed(boxKey(hub), new Uint8Array(Buffer.from(sealed, "base64")));
  } catch {
    return undefined;
  }
  if (!bytes) return undefined;
  const text = Buffer.from(bytes).toString("utf8");
  bytes.fill(0);
  return text;
}

const projectVar = (hub: Hub, r: ProjectRef, name: string): ItemRow | undefined =>
  vault(hub).store.select("kind = 'env' AND scope = 'project' AND machine_id = ? AND project_id = ? AND env_name = ? AND json_extract(meta, '$.sink') IS NULL", [
    r.machineId,
    r.projectId,
    name,
  ])[0];

/** Writes a project variable as an item: a new one, or the named one's next version. */
function upsertVar(hub: Hub, v: Viewer, r: ProjectRef, name: string, value: string, secret: boolean): void {
  const have = projectVar(hub, r, name);
  if (have) saveItem(hub, v, { itemId: have.itemId, fields: { value }, secret });
  else saveItem(hub, v, { kind: "env", scope: "project", ...r, envName: name, secret, fields: { value } });
}

/**
 * `project_env_set`'s changes into the vault. Returns what still goes to the node the old way (secrets sealed to
 * its key, removals of variables the vault doesn't hold) and what failed.
 */
export async function envIntoVault(
  hub: Hub,
  caller: Caller,
  r: ProjectRef,
  set: EnvVarSet[],
  remove: EnvVarName[],
): Promise<{ forNode: { set: EnvVarSet[]; remove: EnvVarName[] }; missed: string[] }> {
  const vt = vault(hub);
  await vt.load();
  const forNode = { set: [] as EnvVarSet[], remove: [] as EnvVarName[] };
  const missed: string[] = [];
  try {
    vt.requireOpen();
  } catch {
    // A locked vault: the old way, all of it; it moves in once the vault opens.
    return { forNode: { set, remove }, missed };
  }
  const v = vt.viewer(caller);
  for (const change of set) {
    try {
      if (change.kind === "plain") upsertVar(hub, v, r, change.name, change.value, false);
      else {
        const value = openedByHub(hub, change.sealed);
        if (value === undefined) forNode.set.push(change);
        else upsertVar(hub, v, r, change.name, value, true);
      }
    } catch (e) {
      missed.push(`${change.name} (${(e as Error).message})`);
    }
  }
  for (const name of remove) {
    const have = projectVar(hub, r, name);
    if (!have) {
      forNode.remove.push(name);
      continue;
    }
    try {
      deleteItem(hub, v, have.itemId, false);
    } catch (e) {
      missed.push(`${name} (${(e as Error).message})`);
    }
  }
  return { forNode, missed };
}

/** Takes in what the node holds now, in the background (after the old path wrote to it). */
export function adoptSoon(hub: Hub, m: string): void {
  void adopt(hub, m).catch((e) => console.warn(`vault: ${m}'s variables not moved in yet: ${(e as Error).message}`));
}

/**
 * A `request_secret` value sealed to the hub's key: kept as an order variable (`order:` sink) or a project variable
 * delivered to its env:/file: sink, then delivered now. Returns the fingerprint the node reported, or undefined for a
 * value sealed to the node (the old way).
 */
export async function takeSecret(
  hub: Hub,
  r: HumanRequest,
  sealed: string,
  by: { name: string; person?: PersonRef; machines: string[] },
): Promise<{ fingerprint: string; bytes: number } | undefined> {
  // The person's device already holds operate on both machines (secret_submit checked): act as it, there only.
  const caller = {
    keyId: "secret-submit",
    name: by.name,
    prefix: "",
    kind: "human",
    grants: [{ role: "operate", machines: by.machines }],
    createdAt: new Date(0).toISOString(),
    ...(by.person ? { person: by.person } : {}),
  } as unknown as Caller;
  const secret = r.secret;
  if (!secret) return undefined;
  const sink = parseContractSink(secret.sink);
  if (!sink || sink.kind === "fill") return undefined;
  const value = openedByHub(hub, sealed);
  if (value === undefined) return undefined;
  const vt = vault(hub);
  await vt.load();
  vt.requireOpen();
  const v = vt.viewer(caller);
  const project = { machineId: r.projectRef.machineId, projectId: r.projectRef.projectId };
  const name = secret.envName ?? secretEnvName(secret.key) ?? "SECRET";
  let row: ItemRow;
  if (sink.kind === "order") {
    const have = vt.store.select("kind = 'env' AND scope = 'order' AND machine_id = ? AND project_id = ? AND workstream_id = ? AND env_name = ?", [
      project.machineId,
      project.projectId,
      sink.path,
      name,
    ])[0];
    row = have
      ? saveItem(hub, v, { itemId: have.itemId, fields: { value }, secret: true })
      : saveItem(hub, v, { kind: "env", scope: "order", ...project, workstreamId: sink.path, envName: name, secret: true, fields: { value } });
  } else {
    const have = sinkItem(hub, { kind: sink.kind, machineId: sink.machineId, path: sink.path, secretKey: secret.key });
    row = have
      ? saveItem(hub, v, { itemId: have.itemId, fields: { value }, secret: true })
      : saveItem(hub, v, {
          kind: "env",
          scope: "project",
          ...project,
          envName: name,
          secret: true,
          fields: { value },
          sink: { kind: sink.kind, machineId: sink.machineId, path: sink.path, ...(secret.envName !== undefined ? { envName: secret.envName } : {}), secretKey: secret.key },
        });
  }
  const m = sink.machineId;
  await deliveries(hub).reconcile(m);
  const held = hub.db.conn
    .query<{ fingerprint: string | null; error: string | null }, [string, string]>(
      "SELECT fingerprint, error FROM vault_deliveries WHERE item_id = ? AND machine_id = ? ORDER BY at_ms DESC LIMIT 1",
    )
    .get(row.itemId, m);
  if (!held?.fingerprint) {
    // Kept in the vault: the node gets it once it is back, so the person needn't enter it again.
    return { fingerprint: row.meta.fingerprint ?? "", bytes: row.meta.bytes ?? 0 };
  }
  return { fingerprint: held.fingerprint, bytes: row.meta.bytes ?? 0 };
}

// --- cards ---

/** A `vault:V…` card reference's item id; undefined for an `op://` one. */
export const vaultCardId = (ref: string | undefined) => (ref !== undefined && /^vault:V[0-9a-f]{32}$/.test(ref) ? ref.slice(6) : undefined);

/** The vault card's label as the chat and the apps show it: "Visa (Personal) ••4242". */
export function cardLabelOf(hub: Hub, ref: string): { label: string; brand?: string; last4?: string } | undefined {
  const id = vaultCardId(ref);
  if (id === undefined) return undefined;
  const row = vault(hub).store.get(id);
  if (!row || row.kind !== "card") return undefined;
  return {
    label: `${row.label} ••${row.meta.last4 ?? ""}`,
    ...(row.meta.brand !== undefined ? { brand: row.meta.brand } : {}),
    ...(row.meta.last4 !== undefined ? { last4: row.meta.last4 } : {}),
  };
}

/** Checks a card a person picks for a project: a live card of the team vault. */
export function checkCardPick(hub: Hub, ref: string): void {
  const id = vaultCardId(ref);
  if (id === undefined) return;
  const row = vault(hub).usable().find((x) => x.itemId === id);
  if (!row || row.kind !== "card") {
    throw new ToolError("invalid", "That card isn't in the team vault.", "Pick one of the team vault's cards, or add one in Settings › Vault.");
  }
}

/**
 * The card for a claimed purchase, sealed to the node hosting the checkout, once; and its `purchase` audit row,
 * which `purchase_filled` closes.
 */
export function sealedCardFor(hub: Hub, r: ProjectRef, ref: string, requestId: string, host: string, sessionId: string): string | undefined {
  const id = vaultCardId(ref);
  if (id === undefined) return undefined;
  const vt = vault(hub);
  vt.requireOpen();
  if (!nodeCan(hub, host, CAP_VAULT_FILL)) {
    throw new ToolError("failed", `Update fleetd on ${host}: its node can't fill a vault card yet.`, "Tell the person; the purchase can be asked again after.");
  }
  const { personId, workstreamId } = vt.personFor(r, undefined);
  const row = vt.usable().find((x) => x.itemId === id);
  if (!row || row.kind !== "card") throw new ToolError("forbidden", "The project's card is gone from the team vault.", "Ask the person to pick a card again in Settings › Payments.");
  const box = hubStore(hub).machineGet(host)?.boxPubKey;
  if (!box) throw new ToolError("failed", `${host}'s node takes no sealed values.`, `Update fleetd on ${host}.`);
  const secret = vt.store.open(row);
  const card = { number: secret.number, month: secret.month, year: secret.year, cvc: secret.cvc, name: secret.name };
  const bytes = Buffer.from(JSON.stringify(card), "utf8");
  let sealed: string;
  try {
    sealed = b64(seal(new Uint8Array(Buffer.from(box, "base64")), bytes));
  } finally {
    bytes.fill(0);
  }
  vt.used({
    atMs: hub.clock.now(),
    itemId: row.itemId,
    action: "purchase",
    outcome: "pending",
    ...(personId !== undefined ? { personId } : {}),
    machineId: r.machineId,
    projectId: r.projectId,
    ...(workstreamId !== undefined ? { workstreamId } : {}),
    data: { label: row.label, kind: "card", host, sessionId, purchaseId: requestId },
  });
  return sealed;
}

/** Closes a purchase's audit row once its fill is reported. */
export function purchaseSettled(hub: Hub, requestId: string, ok: boolean, typed: boolean): void {
  const vt = vault(hub);
  const row = hub.db.conn
    .query<{ n: number }, [string]>("SELECT n FROM vault_audit WHERE action = 'purchase' AND outcome = 'pending' AND json_extract(data, '$.purchaseId') = ? ORDER BY n DESC LIMIT 1")
    .get(requestId);
  if (!row) return;
  if (vt.audit.settle(row.n, ok ? "ok" : "failed", { typed })) {
    const e = vt.audit.get(row.n);
    if (e) vt.usedEvent(row.n, e);
  }
}

/** "Visa ••4242" for a card the vault holds. */
export const brandLine = (row: ItemRow) => `${BRAND_NAMES[row.meta.brand ?? "other"]} ••${row.meta.last4 ?? ""}`;

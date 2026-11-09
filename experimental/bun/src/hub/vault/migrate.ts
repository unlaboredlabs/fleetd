// Moving today's variables, sinks and card into the vault (vault-design §7), losing nothing. The hub never held a
// secret value, so the values come from the nodes, sealed to the hub:
// - plain project variables straight from the hub's `project_env` rows;
// - on each Bun node's link, `vault_adopt`: the node's project and order variables and its env:/file: sinks, each
//   sealed to the hub's box key. A Rust node can't adopt: its secrets stay on its files and keep working ("waiting");
// - fleetd's own order variables (an order's `GH_TOKEN`) stay on their own path;
// - a picked `op://` card is imported from a node holding its person's token, then the project pays with the vault
//   card.
// Each step is idempotent and its progress is in `vault_settings` (`migration`). The node's files and the hub's rows
// stay: they are the delivery and the Rust mirror. After a rollback and a roll-forward the same steps run again and
// take in what changed under Rust.
import type { ProjectRef } from "../../shared/contracts.ts";
import { CAP_VAULT } from "../../shared/node_link.ts";
import { publicKeyOf } from "../../shared/sealed_box.ts";
import type { Hub } from "../api/hub.ts";
import { secretEnvName } from "../approvals/sink.ts";
import { chat } from "../chat/index.ts";
import { linked, nodeCan, sessionCall } from "../cloud/node.ts";
import { boxKey } from "../hub_links/store.ts";
import { forLead, token } from "../onepassword/index.ts";
import { parseMs } from "../store/time.ts";
import { fingerprintOf } from "./fields.ts";
import { type ItemRow, vault, type Viewer } from "./index.ts";
import { openRawToHub, openToHub, saveItem } from "./items.ts";

/** Order variables the hub delivers itself, under their request id: never adopted. */
export const SYSTEM_ORDER_VARS: Record<string, string> = { GH_TOKEN: "github" };

type MachineProgress = { adopted: number; waiting: number; mismatched: number; skippedSystem: number; waitingFor?: string; updatedMs: number };
type Progress = { plainDone?: boolean; machines: Record<string, MachineProgress> };

const b64 = (b: Uint8Array) => Buffer.from(b).toString("base64");

function progress(hub: Hub): Progress {
  try {
    return JSON.parse(vault(hub).store.setting("migration") ?? "") as Progress;
  } catch {
    return { machines: {} };
  }
}
const saveProgress = (hub: Hub, p: Progress) => vault(hub).store.setSetting("migration", JSON.stringify(p));

/** vault_status's `migration`: per machine, what moved in, what waits, what differed. */
export function migrationStatus(hub: Hub): Record<string, unknown> {
  const p = progress(hub);
  const machines = Object.entries(p.machines)
    .map(([machineId, m]) => ({ machineId, ...m }))
    .sort((a, b) => (a.machineId < b.machineId ? -1 : 1));
  return { done: p.plainDone === true && machines.every((m) => m.waiting === 0), machines };
}

/** The hub's own key for the migration's writes: it acts for no person, as the hub's owner. */
function hubViewer(hub: Hub, person?: string): Viewer {
  const owner =
    person ??
    hub.db.conn.query<{ person_id: string }, []>("SELECT person_id FROM people WHERE role = 'owner' AND removed_ms IS NULL ORDER BY created_ms LIMIT 1").get()
      ?.person_id ??
    undefined;
  return {
    caller: { keyId: "vault-migration", name: "vault migration", prefix: "", grants: [{ role: "admin", machines: "*" }], createdAt: new Date(0).toISOString() } as never,
    ...(owner !== undefined ? { person: owner } : {}),
    admin: true,
    human: false,
    system: true,
  };
}

const projectVar = (hub: Hub, r: ProjectRef, name: string): ItemRow | undefined =>
  vault(hub).store.select("kind = 'env' AND scope = 'project' AND machine_id = ? AND project_id = ? AND env_name = ?", [r.machineId, r.projectId, name])[0];

/** Plain `project_env` rows into vault items. A row changed after its item (under a Rust hub) updates it. */
export function migratePlain(hub: Hub): number {
  const v = hubViewer(hub);
  const rows = hub.db.conn
    .query<{ machine_id: string; project_id: string; name: string; value: string; updated_at: string }, []>(
      "SELECT machine_id, project_id, name, value, updated_at FROM project_env WHERE kind = 'plain' AND value IS NOT NULL",
    )
    .all();
  let n = 0;
  for (const row of rows) {
    const r = { machineId: row.machine_id, projectId: row.project_id };
    const have = projectVar(hub, r, row.name);
    try {
      if (!have) {
        saveItem(hub, v, { kind: "env", scope: "project", ...r, envName: row.name, secret: false, fields: { value: row.value }, source: { kind: "adopted", from: "project_env" } }, "adopt");
        n++;
      } else if ((parseMs(row.updated_at) ?? 0) > have.updatedMs && have.meta.fingerprint !== fingerprintOf(row.value)) {
        saveItem(hub, v, { itemId: have.itemId, fields: { value: row.value }, secret: false }, "adopt");
        n++;
      }
    } catch (e) {
      console.warn(`vault: ${r.machineId}/${r.projectId}'s variable ${row.name} not moved in: ${(e as Error).message}`);
    }
  }
  const p = progress(hub);
  p.plainDone = true;
  saveProgress(hub, p);
  return n;
}

type AdoptVar = { scope: "project" | "order"; projectId: string; orderId?: string; name: string; secret: boolean; sealed: string; fingerprint: string; bytes: number };
type AdoptSink = { secretKey: string; kind: "env" | "file"; path: string; envName?: string; sealed: string; fingerprint: string };

/** The project whose `request_secret` the sink answered, from the stored request. */
function sinkProject(hub: Hub, m: string, s: AdoptSink): ProjectRef | undefined {
  const sink = `${s.kind}:${m}:${s.path}`;
  const row = hub.db.conn
    .query<{ project_key: string }, [string, string]>(
      "SELECT project_key FROM requests WHERE kind = 'secret' AND json_extract(data, '$.secret.sink') = ? AND json_extract(data, '$.secret.key') = ? ORDER BY n DESC LIMIT 1",
    )
    .get(sink, s.secretKey);
  const key = row?.project_key;
  const at = key?.indexOf("/") ?? -1;
  return key && at > 0 ? { machineId: key.slice(0, at), projectId: key.slice(at + 1) } : undefined;
}

/** Records a delivery the node already holds, so the first reconcile doesn't send it again. */
function held(hub: Hub, row: ItemRow, m: string, target: string, fingerprint: string): void {
  hub.db.conn
    .query(
      `INSERT INTO vault_deliveries (item_id, machine_id, target, version, fingerprint, at_ms, error) VALUES (?, ?, ?, ?, ?, ?, NULL)
       ON CONFLICT (item_id, machine_id, target) DO UPDATE SET version = excluded.version, fingerprint = excluded.fingerprint, at_ms = excluded.at_ms, error = NULL`,
    )
    .run(row.itemId, m, target, row.version, fingerprint, hub.clock.now());
}

/**
 * Takes in what machine `m`'s node holds. A Rust or older node counts as waiting. Returns its progress.
 */
export async function adopt(hub: Hub, m: string): Promise<MachineProgress> {
  const vt = vault(hub);
  const p = progress(hub);
  const now = hub.clock.now();
  const was = p.machines[m];
  if (!linked(hub, m)) return was ?? { adopted: 0, waiting: 0, mismatched: 0, skippedSystem: 0, updatedMs: now };
  if (!nodeCan(hub, m, CAP_VAULT)) {
    const waiting = hub.db.conn
      .query<{ n: number }, [string]>("SELECT count(*) AS n FROM project_env WHERE machine_id = ? AND kind = 'secret'")
      .get(m)?.n ?? 0;
    const out = { adopted: was?.adopted ?? 0, waiting, mismatched: was?.mismatched ?? 0, skippedSystem: was?.skippedSystem ?? 0, waitingFor: `${m} runs an older or Rust node: its secrets move into the vault when it updates.`, updatedMs: now };
    p.machines[m] = out;
    saveProgress(hub, p);
    return out;
  }
  vt.requireOpen();
  const answer = await sessionCall(hub, m, { op: "vault_adopt", to: b64(publicKeyOf(boxKey(hub))) });
  const vars = Array.isArray(answer.vars) ? (answer.vars as AdoptVar[]) : [];
  const sinks = Array.isArray(answer.sinks) ? (answer.sinks as AdoptSink[]) : [];
  const v = hubViewer(hub);
  let adopted = 0;
  let mismatched = 0;
  let skippedSystem = 0;
  const conflict = (row: ItemRow | undefined, what: string) => {
    mismatched++;
    vt.used({ atMs: hub.clock.now(), itemId: row?.itemId ?? "", action: "adopt", outcome: "failed", machineId: m, data: { ...(row ? { label: row.label } : {}), message: what } });
  };
  for (const x of vars) {
    const r = { machineId: m, projectId: x.projectId };
    try {
      if (x.scope === "order") {
        const order = x.orderId ?? "";
        const kept = hub.db.conn
          .query<{ request_id: string; fingerprint: string }, [string, string, string, string]>(
            "SELECT request_id, fingerprint FROM order_env WHERE machine_id = ? AND project_id = ? AND workstream_id = ? AND name = ?",
          )
          .get(m, x.projectId, order, x.name);
        // fleetd's own (an order's GitHub token), or one the vault delivered itself.
        if ((SYSTEM_ORDER_VARS[x.name] !== undefined && kept?.request_id === SYSTEM_ORDER_VARS[x.name]) || kept?.request_id?.startsWith("V")) {
          if (kept?.request_id !== undefined && !kept.request_id.startsWith("V")) skippedSystem++;
          continue;
        }
        // A closed order's variables go with it (order_env.ts): nothing to move in.
        const open = /^W[1-9][0-9]{0,9}$/.test(order) && hub.db.conn.query("SELECT 1 FROM workstreams WHERE n = ? AND state = 'open'").get(Number(order.slice(1)));
        if (!open) continue;
        const have = vt.store.select("kind = 'env' AND scope = 'order' AND machine_id = ? AND project_id = ? AND workstream_id = ? AND env_name = ?", [m, x.projectId, order, x.name])[0];
        if (have) {
          if (have.meta.fingerprint === x.fingerprint) held(hub, have, m, `order:${x.projectId}/${order}`, x.fingerprint);
          continue;
        }
        const value = valueOf(hub, x.sealed, x.fingerprint);
        const row = saveItem(hub, v, { kind: "env", scope: "order", ...r, workstreamId: order, envName: x.name, secret: true, fields: { value }, source: { kind: "adopted", from: "order_env" }, held: true }, "adopt");
        held(hub, row, m, `order:${x.projectId}/${order}`, x.fingerprint);
        if (kept && kept.fingerprint !== x.fingerprint) conflict(row, `${x.name}: the node held a newer value than the hub recorded`);
        adopted++;
        continue;
      }
      const have = projectVar(hub, r, x.name);
      const hubRow = hub.db.conn
        .query<{ fingerprint: string | null; updated_at: string }, [string, string, string]>(
          "SELECT fingerprint, updated_at FROM project_env WHERE machine_id = ? AND project_id = ? AND name = ?",
        )
        .get(m, x.projectId, x.name);
      if (have) {
        if (have.meta.fingerprint === x.fingerprint || (!have.meta.secret && fingerprintOf(vt.store.open(have).value ?? "") === x.fingerprint)) {
          held(hub, have, m, `project:${x.projectId}`, x.fingerprint);
        } else if (hubRow?.fingerprint === x.fingerprint && (parseMs(hubRow.updated_at) ?? 0) > have.updatedMs) {
          // Changed under a Rust hub after the vault took it: the node's newer value wins.
          const row = saveItem(hub, v, { itemId: have.itemId, fields: { value: valueOf(hub, x.sealed, x.fingerprint) }, secret: x.secret, held: true }, "adopt");
          held(hub, row, m, `project:${x.projectId}`, x.fingerprint);
          adopted++;
        }
        continue;
      }
      if (!x.secret) continue; // plain ones come from the hub's rows (migratePlain)
      const row = saveItem(hub, v, { kind: "env", scope: "project", ...r, envName: x.name, secret: true, fields: { value: valueOf(hub, x.sealed, x.fingerprint) }, source: { kind: "adopted", from: "project_env" }, held: true }, "adopt");
      held(hub, row, m, `project:${x.projectId}`, x.fingerprint);
      if (hubRow?.fingerprint !== x.fingerprint) conflict(row, `${x.name}: the node held a value the hub didn't record`);
      adopted++;
    } catch (e) {
      conflict(undefined, `${x.name} on ${m}/${x.projectId}: ${(e as Error).message}`.slice(0, 300));
    }
  }
  for (const s of sinks) {
    try {
      const r = sinkProject(hub, m, s);
      if (!r) {
        conflict(undefined, `a ${s.kind}: sink on ${m} answers no request the hub knows`);
        continue;
      }
      const name = s.envName ?? secretEnvName(s.secretKey) ?? "SECRET";
      const already = vt.store
        .select("kind = 'env' AND json_extract(meta, '$.sink.machineId') = ? AND json_extract(meta, '$.sink.path') = ?", [m, s.path])
        .find((row) => row.meta.sink?.kind === s.kind);
      if (already) {
        if (already.meta.fingerprint === s.fingerprint) held(hub, already, m, `sink:${already.itemId}`, s.fingerprint);
        continue;
      }
      const row = saveItem(
        hub,
        v,
        {
          kind: "env",
          scope: "project",
          ...r,
          envName: name,
          secret: true,
          fields: { value: valueOf(hub, s.sealed, s.fingerprint) },
          source: { kind: "adopted", from: `sink:${s.secretKey}` },
          held: true,
          sink: { kind: s.kind, machineId: m, path: s.path, ...(s.envName !== undefined ? { envName: s.envName } : {}), secretKey: s.secretKey },
        },
        "adopt",
      );
      held(hub, row, m, `sink:${row.itemId}`, s.fingerprint);
      adopted++;
    } catch (e) {
      conflict(undefined, `a ${s.kind}: sink on ${m}: ${(e as Error).message}`.slice(0, 300));
    }
  }
  const out: MachineProgress = { adopted: (was?.adopted ?? 0) + adopted, waiting: 0, mismatched: (was?.mismatched ?? 0) + mismatched, skippedSystem, updatedMs: hub.clock.now() };
  const after = progress(hub);
  after.machines[m] = out;
  saveProgress(hub, after);
  return out;
}

/** A value sealed to the hub (its raw UTF-8 bytes), checked against the fingerprint the node gave. */
function valueOf(hub: Hub, sealed: string, fingerprint: string): string {
  const bytes = openRawToHub(hub, sealed);
  const value = Buffer.from(bytes).toString("utf8");
  bytes.fill(0);
  if (fingerprintOf(value) !== fingerprint) throw new Error("the value doesn't match its fingerprint");
  return value;
}

/** Projects paying with an `op://` card: imported from a node holding its person's token, then paid with from the vault. */
export async function migrateCards(hub: Hub): Promise<number> {
  const rows = hub.db.conn
    .query<{ machine_id: string; project_id: string; card_ref: string }, []>("SELECT machine_id, project_id, card_ref FROM project_settings WHERE card_ref LIKE 'op://%'")
    .all();
  let n = 0;
  for (const row of rows) {
    const r = { machineId: row.machine_id, projectId: row.project_id };
    const person = forLead(hub.db, r) ?? hubViewer(hub).person;
    if (person === undefined) continue;
    const m = token(hub.db, person)?.sealedOn.map((s) => s.machineId).find((x) => linked(hub, x) && nodeCan(hub, x, CAP_VAULT));
    if (m === undefined) continue;
    try {
      const existing = vault(hub).store.select("kind = 'card' AND json_extract(meta, '$.source.ref') = ?", [row.card_ref])[0];
      let itemId = existing?.itemId;
      if (itemId === undefined) {
        const out = await sessionCall(hub, m, { op: "vault_import_read", personId: person, refs: [row.card_ref], to: b64(publicKeyOf(boxKey(hub))) });
        const read = (Array.isArray(out.items) ? (out.items as { ref: string; kind: string; sealed: string }[]) : []).find((x) => x.ref === row.card_ref);
        if (!read || read.kind !== "card") continue;
        const f = openToHub(hub, read.sealed) as { title?: string; card?: object };
        const saved = saveItem(
          hub,
          hubViewer(hub, person),
          { kind: "card", scope: "person", label: String(f.title ?? "Card").slice(0, 120) || "Card", fields: f.card ?? {}, source: { kind: "1password", ref: row.card_ref, importedMs: hub.clock.now() } },
          "import",
        );
        vault(hub).store.setShares(saved.itemId, [r, ...vault(hub).store.shares(saved.itemId)], person, hub.clock.now());
        itemId = saved.itemId;
      }
      hub.db.conn.query("UPDATE project_settings SET card_ref = ? WHERE machine_id = ? AND project_id = ? AND card_ref = ?").run(`vault:${itemId}`, r.machineId, r.projectId, row.card_ref);
      const label = vault(hub).store.get(itemId)?.label ?? "Your card";
      chat(hub).systemLine(r, `Your card ${label} is now in fleetd's vault.`);
      n++;
    } catch (e) {
      console.warn(`vault: ${r.projectId}'s card not moved in yet: ${(e as Error).message}`);
    }
  }
  return n;
}

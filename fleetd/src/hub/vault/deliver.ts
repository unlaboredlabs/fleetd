// Environment variables from the vault to the nodes (vault-design §4.4). The vault is the source of truth; the hub
// works out each project's and each order's variables and writes them through today's node operations, sealed to that
// machine per delivery, so the node's spawn, masking and the Rust node stay as they are:
// - a project's file (`project_env`): its project variables, then its Only me owner's person variables under other
//   names, and the variables of every project whose repo checkout it is (W79);
// - an order's file (`secret_deliver` to `order:<machine>:<W>`): its order variables, then the person variables of
//   whoever started it, under names neither the order nor the project has;
// - a `request_secret` env:/file: sink: the item's value, written where the sink says.
// `vault_deliveries` records which version each machine holds. `reconcile` sends what's missing or older and takes back
// what went, on each change and each time a node links, so setting a variable no longer needs its machine online.
//
// For one release the hub also keeps the `project_env` and `order_env` rows (plain values, secret fingerprints) as
// before, so a rolled-back Rust hub reads them.
import type { EnvVarName, EnvVarSet, ProjectRef } from "../../shared/contracts.ts";
import { seal } from "../../shared/sealed_box.ts";
import { CAP_ORDER_ENV, CAP_PROJECT_SETTINGS } from "../../shared/node_link.ts";
import type { Hub } from "../api/hub.ts";
import { approvals } from "../approvals/index.ts";
import { executors } from "../executor/index.ts";
import { orderEnvDrop, projectEnv } from "../executor/projects.ts";
import { link } from "../link/server.ts";
import { orderEnvStore } from "../projects/order_env.ts";
import { otherCheckouts, projectSettings } from "../projects/settings.ts";
import { store } from "../store/hub_store.ts";
import { isoMs } from "../store/time.ts";
import { fingerprintOf } from "./fields.ts";
import { type ItemRow, type Vault, vault } from "./index.ts";

/** The node operations a delivery uses; tests give their own. */
export type DeliveryPort = {
  ready(m: string, what: "project" | "order" | "sink"): boolean;
  boxKey(m: string): Uint8Array | undefined;
  projectEnv(m: string, projectId: string, set: EnvVarSet[], remove: EnvVarName[]): Promise<void>;
  deliverSecret(m: string, input: Record<string, unknown>): Promise<{ fingerprint?: string; error?: string }>;
  orderEnvDrop(m: string, projectId: string, orderId: string, name: [string, string]): Promise<void>;
};

export function hubPort(hub: Hub): DeliveryPort {
  return {
    ready: (m, what) => executors(hub).isConnected(m) && link(hub).can(m, what === "order" ? CAP_ORDER_ENV : CAP_PROJECT_SETTINGS),
    boxKey: (m) => {
      const k = store(hub).machineGet(m)?.boxPubKey;
      return k ? new Uint8Array(Buffer.from(k, "base64")) : undefined;
    },
    projectEnv: async (m, p, set, remove) => void (await projectEnv(hub, m, p, set, remove)),
    deliverSecret: (m, input) => approvals(hub).deps.nodes.deliverSecret(m, input),
    orderEnvDrop: (m, p, w, name) => orderEnvDrop(hub, m, p, w, name as [EnvVarName, string]),
  };
}

const port = (hub: Hub) => hub.peek<DeliveryPort>("vault.port") ?? hub.area("vault.port", hubPort);

type Delivery = { itemId: string; target: string; version: number; fingerprint: string | null; error: string | null };

const projectTarget = (projectId: string) => `project:${projectId}`;
const orderTarget = (projectId: string, order: string) => `order:${projectId}/${order}`;

/** Variables by name, the first given for a name winning. */
function layered(...layers: ItemRow[][]): Map<string, ItemRow> {
  const out = new Map<string, ItemRow>();
  for (const layer of layers) for (const row of layer) if (row.envName && !out.has(row.envName)) out.set(row.envName, row);
  return out;
}

/** The Only me owner of `r`, whose person variables its sessions get. */
function onlyMeOwner(hub: Hub, r: ProjectRef): string | undefined {
  return (
    hub.db.conn
      .query<{ owner_person: string | null }, [string, string]>(
        "SELECT owner_person FROM project_settings WHERE machine_id = ? AND project_id = ? AND only_me = 1",
      )
      .get(r.machineId, r.projectId)?.owner_person ?? undefined
  );
}

function startedBy(hub: Hub, order: string): string | undefined {
  const n = /^W([1-9][0-9]{0,9})$/.exec(order)?.[1];
  if (n === undefined) return undefined;
  const row = hub.db.conn.query<{ data: string }, [number]>("SELECT data FROM workstreams WHERE n = ?").get(Number(n));
  try {
    return (JSON.parse(row?.data ?? "{}") as { startedBy?: { personId?: string } }).startedBy?.personId;
  } catch {
    return undefined;
  }
}

const envOf = (v: Vault, where: string, params: (string | null)[]) => v.store.select(`kind = 'env' AND ${where}`, params);
const projectVars = (v: Vault, r: ProjectRef) => envOf(v, "scope = 'project' AND machine_id = ? AND project_id = ? AND json_extract(meta, '$.sink') IS NULL", [r.machineId, r.projectId]);
const personVars = (v: Vault, person: string | undefined) => (person === undefined ? [] : envOf(v, "scope = 'person' AND person_id = ?", [person]));

/** Each project's variables as its sessions get them: its own, its repo holders', then its Only me owner's. */
export function projectSet(hub: Hub, r: ProjectRef): Map<string, ItemRow> {
  const v = vault(hub);
  const holders = store(hub)
    .projectsList(r.machineId)
    .map((p) => ({ machineId: p.machineId, projectId: p.projectId }))
    .filter((h) => h.projectId !== r.projectId && otherCheckouts(hub, h).some((c) => c.projectId === r.projectId));
  return layered(projectVars(v, r), ...holders.map((h) => projectVars(v, h)), personVars(v, onlyMeOwner(hub, r)));
}

/** An order's own variables, then its starter's person variables under names the project doesn't set. */
export function orderSet(hub: Hub, r: ProjectRef, order: string): Map<string, ItemRow> {
  const v = vault(hub);
  const own = envOf(v, "scope = 'order' AND machine_id = ? AND project_id = ? AND workstream_id = ?", [r.machineId, r.projectId, order]);
  const project = projectSet(hub, r);
  // A person variable the project already gives under that name stays the project's.
  const person = personVars(v, startedBy(hub, order)).filter((row) => !project.has(row.envName ?? ""));
  // An Only me project's owner already has theirs in the project's file.
  const fromFile = onlyMeOwner(hub, r) !== undefined;
  return layered(own, fromFile ? [] : person);
}

export class Deliveries {
  private running = new Map<string, Promise<void>>();
  private again = new Set<string>();

  constructor(private readonly hub: Hub) {}

  private rows(m: string): Delivery[] {
    return this.hub.db.conn
      .query<{ item_id: string; target: string; version: number; fingerprint: string | null; error: string | null }, [string]>(
        "SELECT item_id, target, version, fingerprint, error FROM vault_deliveries WHERE machine_id = ?",
      )
      .all(m)
      .map((x) => ({ itemId: x.item_id, target: x.target, version: x.version, fingerprint: x.fingerprint, error: x.error }));
  }

  private record(itemId: string, m: string, target: string, version: number, fingerprint: string | null, error: string | null): void {
    this.hub.db.conn
      .query(
        `INSERT INTO vault_deliveries (item_id, machine_id, target, version, fingerprint, at_ms, error) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (item_id, machine_id, target) DO UPDATE SET version = excluded.version, fingerprint = excluded.fingerprint,
           at_ms = excluded.at_ms, error = excluded.error`,
      )
      .run(itemId, m, target, version, fingerprint, this.hub.clock.now(), error);
  }

  private forget(itemId: string, m: string, target: string): void {
    this.hub.db.conn.query("DELETE FROM vault_deliveries WHERE item_id = ? AND machine_id = ? AND target = ?").run(itemId, m, target);
  }

  /**
   * Brings machine `m` up to date; one pass at a time per machine. A call meanwhile makes one more pass after it and
   * waits for that too.
   */
  reconcile(m: string): Promise<void> {
    const running = this.running.get(m);
    if (running) {
      this.again.add(m);
      return running;
    }
    const run = (async () => {
      try {
        do {
          this.again.delete(m);
          await this.pass(m);
        } while (this.again.has(m) && !this.hub.shutdown.signal.aborted);
      } finally {
        this.running.delete(m);
      }
    })();
    this.running.set(m, run);
    return run;
  }

  /** Every machine that has a project with variables or holds a delivery. */
  async reconcileAll(): Promise<void> {
    const machines = new Set<string>(
      this.hub.db.conn.query<{ m: string }, []>("SELECT DISTINCT machine_id AS m FROM vault_deliveries").all().map((x) => x.m),
    );
    for (const m of store(this.hub).machinesList()) machines.add(m.machineId);
    for (const m of machines) await this.reconcile(m).catch((e) => console.warn(`vault: variables for ${m} not delivered:`, (e as Error).message));
  }

  private desired(m: string): Map<string, Map<string, ItemRow>> {
    const hub = this.hub;
    const v = vault(hub);
    const out = new Map<string, Map<string, ItemRow>>();
    for (const p of store(hub).projectsList(m)) {
      const r = { machineId: m, projectId: p.projectId };
      out.set(projectTarget(p.projectId), projectSet(hub, r));
      const open = hub.db.conn
        .query<{ n: number }, [string, string]>("SELECT n FROM workstreams WHERE machine_id = ? AND project_id = ? AND state = 'open'")
        .all(m, p.projectId);
      for (const { n } of open) {
        const set = orderSet(hub, r, `W${n}`);
        if (set.size > 0) out.set(orderTarget(p.projectId, `W${n}`), set);
      }
    }
    for (const row of envOf(v, "json_extract(meta, '$.sink.machineId') = ?", [m])) {
      out.set(`sink:${row.itemId}`, new Map([[row.envName ?? "", row]]));
    }
    return out;
  }

  private async pass(m: string): Promise<void> {
    const p = port(this.hub);
    const v = vault(this.hub);
    if (v.keys.locked) return;
    const box = p.boxKey(m);
    if (!box) return;
    const desired = this.desired(m);
    const held = this.rows(m);
    const targets = new Set([...desired.keys(), ...held.map((d) => d.target)]);
    for (const target of targets) {
      const want = desired.get(target) ?? new Map<string, ItemRow>();
      const have = held.filter((d) => d.target === target);
      const kind = target.startsWith("project:") ? "project" : target.startsWith("order:") ? "order" : "sink";
      if (!p.ready(m, kind)) continue;
      const wanted = new Set([...want.values()].map((r) => r.itemId));
      const send = [...want.values()].filter((row) => {
        const d = have.find((x) => x.itemId === row.itemId);
        return !d || d.version !== row.version || d.error !== null;
      });
      const gone = have.filter((d) => !wanted.has(d.itemId));
      if (send.length === 0 && gone.length === 0) continue;
      try {
        if (kind === "project") await this.toProject(m, target.slice("project:".length), send, gone, want);
        else if (kind === "order") await this.toOrder(m, target, send, gone, want);
        else await this.toSink(m, target, send, gone);
      } catch (e) {
        console.warn(`vault: ${target} on ${m} not delivered: ${(e as Error).message}`);
        for (const row of send) this.record(row.itemId, m, target, row.version, null, (e as Error).message.slice(0, 300));
      }
    }
  }

  private value(row: ItemRow): string {
    return vault(this.hub).store.open(row).value ?? "";
  }

  private async toProject(m: string, projectId: string, send: ItemRow[], gone: Delivery[], want: Map<string, ItemRow>): Promise<void> {
    const p = port(this.hub);
    const box = p.boxKey(m)!;
    const set: EnvVarSet[] = [];
    const prints: [ItemRow, string][] = [];
    for (const row of send) {
      const value = this.value(row);
      prints.push([row, fingerprintOf(value)]);
      set.push(
        row.meta.secret
          ? { kind: "secret", name: row.envName!, sealed: Buffer.from(seal(box, Buffer.from(value))).toString("base64") }
          : { kind: "plain", name: row.envName!, value },
      );
    }
    // A name another item now gives is overwritten by it, not removed.
    const remove = gone.map((d) => vault(this.hub).store.get(d.itemId)?.envName).filter((n): n is string => n !== undefined && !want.has(n));
    await p.projectEnv(m, projectId, set, [...new Set(remove)]);
    for (const [row, fp] of prints) this.record(row.itemId, m, projectTarget(projectId), row.version, fp, null);
    for (const d of gone) this.forget(d.itemId, m, d.target);
    if (send.length > 0 || gone.length > 0) this.used("deliver", m, projectId, undefined, send, gone.length);
  }

  private async toOrder(m: string, target: string, send: ItemRow[], gone: Delivery[], want: Map<string, ItemRow>): Promise<void> {
    const p = port(this.hub);
    const box = p.boxKey(m)!;
    const [projectId = "", order = ""] = target.slice("order:".length).split("/");
    const r = { machineId: m, projectId };
    for (const row of send) {
      const value = this.value(row);
      const sealed = Buffer.from(seal(box, Buffer.from(value))).toString("base64");
      const out = await p.deliverSecret(m, { sink: `order:${m}:${order}`, sealed, secretKey: "vault.env", envName: row.envName, projectId });
      if (out.fingerprint === undefined) throw new Error(out.error ?? "the node kept nothing");
      this.record(row.itemId, m, target, row.version, out.fingerprint, null);
      orderEnvStore.save(this.hub.db.conn, r, order, {
        name: row.envName!,
        fingerprint: out.fingerprint,
        bytes: row.meta.bytes ?? 0,
        requestId: row.itemId,
        updatedAt: isoMs(this.hub.clock.now()),
      });
    }
    for (const d of gone) {
      const name = vault(this.hub).store.get(d.itemId)?.envName;
      if (name !== undefined && !want.has(name) && d.fingerprint) {
        await p.orderEnvDrop(m, projectId, order, [name, d.fingerprint]);
        orderEnvStore.forgetOne(this.hub.db.conn, r, order, name);
      }
      this.forget(d.itemId, m, d.target);
    }
    if (send.length > 0 || gone.length > 0) this.used("deliver", m, projectId, order, send, gone.length);
  }

  private async toSink(m: string, target: string, send: ItemRow[], gone: Delivery[]): Promise<void> {
    const p = port(this.hub);
    const box = p.boxKey(m)!;
    for (const row of send) {
      const sink = row.meta.sink!;
      const sealed = Buffer.from(seal(box, Buffer.from(this.value(row)))).toString("base64");
      const out = await p.deliverSecret(m, {
        sink: `${sink.kind}:${sink.machineId}:${sink.path}`,
        sealed,
        secretKey: sink.secretKey ?? "vault.env",
        ...(sink.envName !== undefined ? { envName: sink.envName } : {}),
      });
      if (out.fingerprint === undefined) throw new Error(out.error ?? "the node kept nothing");
      this.record(row.itemId, m, target, row.version, out.fingerprint, null);
    }
    // A sink's file stays where it was written: the node has no call to remove one.
    for (const d of gone) this.forget(d.itemId, m, d.target);
  }

  /** One `deliver` audit row per target and pass: the names sent, never their values. */
  private used(action: "deliver", m: string, projectId: string, order: string | undefined, sent: ItemRow[], removed: number): void {
    const v = vault(this.hub);
    for (const row of sent) {
      v.used({
        atMs: this.hub.clock.now(),
        itemId: row.itemId,
        action,
        outcome: "ok",
        machineId: m,
        projectId,
        ...(order !== undefined ? { workstreamId: order } : {}),
        data: { label: row.label, kind: row.kind, names: [row.envName!], host: m, ...(removed > 0 ? { count: removed } : {}) },
      });
    }
  }
}

export const deliveries = (hub: Hub) => hub.area("vault.deliveries", (h) => new Deliveries(h));

/** Keeps the `project_env` row of a project variable as the Rust hub reads it (one release). */
export function mirrorProjectRow(hub: Hub, row: ItemRow, value: string | undefined, removed: boolean): void {
  if (row.scope !== "project" || row.kind !== "env" || !row.envName || row.meta.sink) return;
  const r = { machineId: row.machineId!, projectId: row.projectId! };
  const at = isoMs(hub.clock.now());
  if (removed) projectSettings(hub).envApply(r, [], [row.envName], at);
  else if (row.meta.secret) projectSettings(hub).envApply(r, [{ name: row.envName, fingerprint: row.meta.fingerprint ?? "", bytes: row.meta.bytes ?? 0 }], [], at);
  else projectSettings(hub).envApply(r, [{ name: row.envName, value: value ?? "", bytes: row.meta.bytes ?? 0 }], [], at);
}

/** The vault variables a session of `r` (order `order`) starts with, by name: the order's over the project's. */
export function envRows(hub: Hub, r: ProjectRef, order: string | undefined): ItemRow[] {
  const all = new Map(projectSet(hub, r));
  if (order !== undefined) for (const [n, row] of orderSet(hub, r, order)) all.set(n, row);
  return [...all.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([, row]) => row);
}

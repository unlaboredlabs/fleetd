// The vault's background work: load the root key at start (making it on the first start), move today's variables and
// card in, register the nodes' calls, and keep things in step: each node that links gets what it's missing and hands
// over what it held once its link is live (the sweep tries again for one it couldn't); an order's variable entered the
// old way (sealed to its node) moves in at once, so it reaches the order's agents in each of the bot's repo checkouts;
// every sweep empties a 30-day trash, drops audit rows past a year and an order's variables once it closes.
import type { ProjectRef } from "../../shared/contracts.ts";
import { CAP_VAULT } from "../../shared/node_link.ts";
import type { Hub } from "../api/hub.ts";
import { approvals } from "../approvals/index.ts";
import { found } from "../executor/sessions.ts";
import { nodePort } from "../link/node_port.ts";
import { events } from "../store/events.ts";
import { hubSealTo, takeSecret } from "./aliases.ts";
import { sweep } from "../sweep/index.ts";
import { registerLeadCalls as registerFills } from "./calls.ts";
import { deliveries, orderSet, projectSet } from "./deliver.ts";
import { registerLeadCalls as registerImports } from "./import.ts";
import { start as startSignIn } from "./sign_in.ts";
import { vault } from "./index.ts";
import { adopt, copyTeamVars, migrateCards, migratePlain, SYSTEM_ORDER_VARS } from "./migrate.ts";

/** How long a machine that came online waits for its link to go live before the sweep takes its move-in over. */
const LIVE_WAIT_MS = 60_000;

/** Machines whose move-in hasn't gone through since they came online (the sweep tries them again), and those mid-way. */
const moveIns = (hub: Hub) => hub.area("vault.move_ins", () => ({ owed: new Set<string>(), running: new Set<string>() }));

/**
 * Each machine coming online: what it holds moves in, what it's missing goes out. machine.online is logged once the
 * node's runner answers, which can be before the hub's subscription to it is live (a link first renews the orders'
 * GitHub tokens there), so both wait for that; a machine not taken in by then stays owed to the sweep.
 */
async function linked(hub: Hub, m: string): Promise<void> {
  moveIns(hub).owed.add(m);
  await nodePort(hub).live(m, AbortSignal.any([hub.shutdown.signal, AbortSignal.timeout(LIVE_WAIT_MS)]));
  if (vault(hub).keys.locked) return;
  await moveIn(hub, m);
  await deliveries(hub)
    .reconcile(m)
    .catch((e) => console.warn(`vault: ${m}'s variables not delivered: ${(e as Error).message}`));
  await migrateCards(hub).catch((e) => console.warn(`vault: cards not moved in yet: ${(e as Error).message}`));
}

/** Takes in what `m`'s node holds, one run per machine at a time; a machine taken in is no longer owed. */
async function moveIn(hub: Hub, m: string): Promise<void> {
  const s = moveIns(hub);
  if (vault(hub).keys.locked || s.running.has(m)) return;
  s.running.add(m);
  try {
    await adopt(hub, m);
    s.owed.delete(m);
  } catch (e) {
    console.warn(`vault: ${m}'s variables not moved in yet: ${(e as Error).message}`);
  } finally {
    s.running.delete(m);
  }
}

/** The machines still owed a move-in whose link is live now. */
async function moveInOwed(hub: Hub): Promise<void> {
  for (const m of [...moveIns(hub).owed]) if (nodePort(hub).linked(m)) await moveIn(hub, m);
}

/** What machine `m`'s node holds moves into the vault, then what it's missing goes out. Never throws. */
export async function takeIn(hub: Hub, m: string): Promise<void> {
  if (vault(hub).keys.locked) return;
  await moveIn(hub, m);
  await deliveries(hub)
    .reconcile(m)
    .catch((e) => console.warn(`vault: ${m}'s variables not delivered: ${(e as Error).message}`));
}

/**
 * The machines whose node holds an open order's variable a person entered the old way (sealed to the node, so kept
 * under the order's bot only) that the vault doesn't have yet, each such value once per process while its node can
 * hand it over: taking them in delivers them at each checkout of the bot's repos too.
 */
export function strays(hub: Hub, tried: Set<string>): string[] {
  const rows = hub.db.conn
    .query<{ machine_id: string; project_id: string; workstream_id: string; name: string; fingerprint: string; request_id: string }, []>(
      `SELECT o.machine_id, o.project_id, o.workstream_id, o.name, o.fingerprint, o.request_id FROM order_env o
         JOIN workstreams w ON 'W' || w.n = o.workstream_id AND w.state = 'open'
         WHERE o.request_id NOT LIKE 'V%' AND NOT EXISTS (SELECT 1 FROM vault_items i WHERE i.kind = 'env' AND i.scope = 'order'
           AND i.deleted_ms IS NULL AND i.machine_id = o.machine_id AND i.project_id = o.project_id
           AND i.workstream_id = o.workstream_id AND i.env_name = o.name)`,
    )
    .all();
  const port = nodePort(hub);
  const out = new Set<string>();
  for (const x of rows) {
    if (SYSTEM_ORDER_VARS[x.name] === x.request_id) continue;
    const key = [x.machine_id, x.project_id, x.workstream_id, x.name, x.fingerprint].join("/");
    if (tried.has(key) || !port.linked(x.machine_id) || !port.can(x.machine_id, CAP_VAULT)) continue;
    tried.add(key);
    out.add(x.machine_id);
  }
  return [...out].sort();
}

/** How long a launch waits for its machine's variables to be delivered before it goes ahead anyway. */
const LAUNCH_DELIVERY_WAIT_MS = 10_000;

/** Brings the machine's variables up to date before a launch, waiting at most LAUNCH_DELIVERY_WAIT_MS. */
export async function beforeLaunch(hub: Hub, m: string): Promise<void> {
  if (vault(hub).keys.locked) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, LAUNCH_DELIVERY_WAIT_MS);
  });
  try {
    await Promise.race([deliveries(hub).reconcile(m), late]);
  } finally {
    clearTimeout(timer);
  }
}

/** One `inject` row per session launch: the vault variables it starts with, by name. Never a value. */
export function injected(hub: Hub, r: ProjectRef, order: string | undefined, threadId: string): void {
  const v = vault(hub);
  // What the node holds at this version, not what the vault would give: a delivery still waiting isn't in the session.
  const held = (row: { itemId: string; version: number }, target: string) =>
    hub.db.conn
      .query("SELECT 1 FROM vault_deliveries WHERE item_id = ? AND machine_id = ? AND target = ? AND version = ? AND error IS NULL")
      .get(row.itemId, r.machineId, target, row.version) !== null;
  const project = [...projectSet(hub, r).values()].filter((row) => held(row, `project:${r.projectId}`));
  const fromOrder = order === undefined ? [] : [...orderSet(hub, r, order).values()].filter((row) => held(row, `order:${r.projectId}/${order}`));
  const names = [...new Set([...project, ...fromOrder].map((row) => row.envName!))].sort();
  if (names.length === 0) return;
  v.audit.write({
    atMs: hub.clock.now(),
    itemId: "",
    action: "inject",
    outcome: "ok",
    machineId: r.machineId,
    projectId: r.projectId,
    threadId,
    ...(order !== undefined ? { workstreamId: order } : {}),
    data: { names },
  });
}

/** Order variables of orders now closed go for good, as their node files do. */
export function dropClosed(hub: Hub): void {
  const v = vault(hub);
  const closed = hub.db.conn
    .query<{ item_id: string }, []>(
      `SELECT item_id FROM vault_items WHERE scope = 'order' AND NOT EXISTS
         (SELECT 1 FROM workstreams w WHERE 'W' || w.n = vault_items.workstream_id AND w.state = 'open')`,
    )
    .all();
  for (const { item_id } of closed) v.store.purge(item_id);
  hub.db.conn.query(
    `DELETE FROM vault_deliveries WHERE target LIKE 'order:%' AND NOT EXISTS
       (SELECT 1 FROM workstreams w WHERE 'W' || w.n = substr(vault_deliveries.target, instr(vault_deliveries.target, '/') + 1) AND w.state = 'open')`,
  ).run();
}

export function start(hub: Hub): void {
  registerFills(hub);
  startSignIn(hub);
  registerImports(hub);
  const hooks = approvals(hub).deps.hooks;
  hooks.vaultSealTo = () => (vault(hub).keys.locked ? undefined : hubSealTo(hub));
  hooks.vaultSecret = (r, sealed, by) => takeSecret(hub, r, sealed, by);
  hooks.vaultTakeIn = (m) => takeIn(hub, m);
  found.injected = (r, order, threadId) => injected(hub, r, order, threadId);
  found.beforeLaunch = (r) => beforeLaunch(hub, r.machineId);
  const v = vault(hub);
  void v.load().then(async () => {
    if (v.keys.locked) return;
    try {
      migratePlain(hub);
    } catch (e) {
      console.warn(`vault: plain variables not moved in yet: ${(e as Error).message}`);
    }
    copyTeamVars(hub);
    // Machines that came online while the key was still loading.
    await moveInOwed(hub);
    await deliveries(hub)
      .reconcileAll()
      .catch((e) => console.warn(`vault: variables not delivered: ${(e as Error).message}`));
  });
  const unsubscribe = events(hub).subscribe((e) => {
    if (e.type === "machine.online" && e.machineId !== undefined) void linked(hub, e.machineId);
  });
  hub.shutdown.signal.addEventListener("abort", unsubscribe, { once: true });
  const tried = new Set<string>();
  sweep(hub).register({
    name: "vault",
    run: async () => {
      const now = hub.clock.now();
      v.store.purgeTrash(now);
      v.audit.sweep(now);
      dropClosed(hub);
      if (v.keys.locked) return;
      await moveInOwed(hub);
      for (const m of strays(hub, tried)) await takeIn(hub, m);
      await deliveries(hub).reconcileAll();
    },
  });
}

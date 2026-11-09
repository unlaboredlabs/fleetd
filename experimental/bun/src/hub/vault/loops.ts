// The vault's background work: load the root key at start (making it on the first start), move today's variables and
// card in, register the nodes' calls, and keep things in step: each node that links gets what it's missing and hands
// over what it held; every sweep empties a 30-day trash, drops audit rows past a year and an order's variables once
// it closes.
import type { ProjectRef } from "../../shared/contracts.ts";
import type { Hub } from "../api/hub.ts";
import { approvals } from "../approvals/index.ts";
import { found } from "../executor/sessions.ts";
import { events } from "../store/events.ts";
import { hubSealTo, takeSecret } from "./aliases.ts";
import { sweep } from "../sweep/index.ts";
import { registerLeadCalls as registerFills } from "./calls.ts";
import { deliveries, envRows } from "./deliver.ts";
import { registerLeadCalls as registerImports } from "./import.ts";
import { vault } from "./index.ts";
import { adopt, migrateCards, migratePlain } from "./migrate.ts";

/** Each machine coming online: what it holds moves in, what it's missing goes out. */
async function linked(hub: Hub, m: string): Promise<void> {
  const v = vault(hub);
  if (v.keys.locked) return;
  try {
    await adopt(hub, m);
  } catch (e) {
    console.warn(`vault: ${m}'s variables not moved in yet: ${(e as Error).message}`);
  }
  await deliveries(hub)
    .reconcile(m)
    .catch((e) => console.warn(`vault: ${m}'s variables not delivered: ${(e as Error).message}`));
  await migrateCards(hub).catch((e) => console.warn(`vault: cards not moved in yet: ${(e as Error).message}`));
}

/** One `inject` row per session launch: the vault variables it starts with, by name. Never a value. */
export function injected(hub: Hub, r: ProjectRef, order: string | undefined, threadId: string): void {
  const v = vault(hub);
  const names = envRows(hub, r, order).map((row) => row.envName!);
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
  registerImports(hub);
  const hooks = approvals(hub).deps.hooks;
  hooks.vaultSealTo = () => (vault(hub).keys.locked ? undefined : hubSealTo(hub));
  hooks.vaultSecret = (r, sealed, by) => takeSecret(hub, r, sealed, by);
  found.injected = (r, order, threadId) => injected(hub, r, order, threadId);
  const v = vault(hub);
  void v.load().then(async () => {
    if (v.keys.locked) return;
    try {
      migratePlain(hub);
    } catch (e) {
      console.warn(`vault: plain variables not moved in yet: ${(e as Error).message}`);
    }
    await deliveries(hub)
      .reconcileAll()
      .catch((e) => console.warn(`vault: variables not delivered: ${(e as Error).message}`));
  });
  const unsubscribe = events(hub).subscribe((e) => {
    if (e.type === "machine.online" && e.machineId !== undefined) void linked(hub, e.machineId);
  });
  hub.shutdown.signal.addEventListener("abort", unsubscribe, { once: true });
  sweep(hub).register({
    name: "vault",
    run: async () => {
      const now = hub.clock.now();
      v.store.purgeTrash(now);
      v.audit.sweep(now);
      dropClosed(hub);
      if (!v.keys.locked) await deliveries(hub).reconcileAll();
    },
  });
}

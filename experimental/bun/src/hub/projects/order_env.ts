// An order's variables (`order:` secret sinks; crates/fleetd/src/hub/projects/order_env.rs): what the hub keeps of
// each one its node saved (`order_env` rows: the name, fingerprint and size, never the value), and their end. Once
// the order is closed (done or stopped) or gone, its node is told to forget them (`order_env_drop`) and the rows go;
// a node offline then hears it once it is back, from the next event or sweep.
import type { Database } from "bun:sqlite";
import type { ProjectRef } from "../../shared/contracts.ts";
import { CAP_ORDER_ENV } from "../../shared/node_link.ts";
import type { Hub } from "../api/hub.ts";
import type { OrderEnvSaved } from "../approvals/ports.ts";
import { approvals } from "../approvals/index.ts";
import { executors } from "../executor/index.ts";
import { orderEnvDrop } from "../executor/projects.ts";
import { link } from "../link/index.ts";
import { workstreamGet } from "../orders/workstreams.ts";
import { events } from "../store/events.ts";
import { sweep } from "../sweep/index.ts";

/** One variable delivered for an order. */
export type OrderEnvRow = { name: string; fingerprint: string; bytes: number; requestId: string; updatedAt: string };

type Row = { name: string; fingerprint: string; bytes: number; request_id: string; updated_at: string };

export const orderEnvStore = {
  save(db: Database, r: ProjectRef, order: string, row: OrderEnvRow): void {
    db.query(
      `INSERT INTO order_env (machine_id, project_id, workstream_id, name, fingerprint, bytes, request_id, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (machine_id, project_id, workstream_id, name) DO UPDATE SET fingerprint = excluded.fingerprint,
           bytes = excluded.bytes, request_id = excluded.request_id, updated_at = excluded.updated_at`,
    ).run(r.machineId, r.projectId, order, row.name, row.fingerprint, row.bytes, row.requestId, row.updatedAt);
  },

  /** The order's variables, by name. */
  list(db: Database, r: ProjectRef, order: string): OrderEnvRow[] {
    return db
      .query<Row, [string, string, string]>(
        `SELECT name, fingerprint, bytes, request_id, updated_at FROM order_env
           WHERE machine_id = ? AND project_id = ? AND workstream_id = ? ORDER BY name`,
      )
      .all(r.machineId, r.projectId, order)
      .map((x) => ({ name: x.name, fingerprint: x.fingerprint, bytes: x.bytes, requestId: x.request_id, updatedAt: x.updated_at }));
  },

  /** Every order that has variables, with its project. */
  held(db: Database): [ProjectRef, string][] {
    return db
      .query<{ machine_id: string; project_id: string; workstream_id: string }, []>(
        "SELECT DISTINCT machine_id, project_id, workstream_id FROM order_env ORDER BY workstream_id",
      )
      .all()
      .map((x) => [{ machineId: x.machine_id, projectId: x.project_id }, x.workstream_id]);
  },

  /** Forgets one of the order's variables, once its node has. */
  forgetOne(db: Database, r: ProjectRef, order: string, name: string): void {
    db.query("DELETE FROM order_env WHERE machine_id = ? AND project_id = ? AND workstream_id = ? AND name = ?").run(
      r.machineId,
      r.projectId,
      order,
      name,
    );
  },

  forget(db: Database, r: ProjectRef, order: string): void {
    db.query("DELETE FROM order_env WHERE machine_id = ? AND project_id = ? AND workstream_id = ?").run(r.machineId, r.projectId, order);
  },
};

const ORDER_ID = /^W[1-9][0-9]*$/;
const MACHINE_ID = /^[a-z0-9-]{1,32}$/;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;

/** An order that is open: Rust's `!is_closed(w.state)`. */
const open = (db: Database, order: string) => ORDER_ID.test(order) && workstreamGet(db, order)?.state === "open";

/** Why the project's order can't take a variable now; undefined when it can. */
export function refusal(hub: Hub, r: ProjectRef, order: string): string | undefined {
  if (!ORDER_ID.test(order)) return `${order} is no order id.`;
  let w: ReturnType<typeof workstreamGet>;
  try {
    w = workstreamGet(hub.db.conn, order);
  } catch (e) {
    return `The hub could not read ${order}: ${(e as Error).message}.`;
  }
  if (!w || w.projectRef.machineId !== r.machineId || w.projectRef.projectId !== r.projectId) return `The project has no order ${order}.`;
  if (w.state !== "open") return `${order} is closed: its agents are done.`;
  const m = r.machineId;
  if (!link(hub).can(m, CAP_ORDER_ENV)) return `${m}'s node is too old to take an order's variables: update fleetd there.`;
  return undefined;
}

/**
 * Records what the node saved; the rows go once the order closes. A variable the hub can't record would never be
 * dropped with its order, so the node is told to forget it again, and the person to enter it again. Returns why it
 * could not, or undefined.
 */
export async function saved(hub: Hub, s: OrderEnvSaved, at: string): Promise<string | undefined> {
  const r = { machineId: s.project.machineId, projectId: s.project.projectId };
  if (!MACHINE_ID.test(r.machineId) || r.projectId === "" || !ORDER_ID.test(s.orderId) || !ENV_NAME.test(s.name)) {
    return `${s.name} for ${s.orderId} is not a variable the hub can record`;
  }
  const row = { name: s.name, fingerprint: s.fingerprint, bytes: s.bytes, requestId: s.requestId, updatedAt: at };
  try {
    orderEnvStore.save(hub.db.conn, r, s.orderId, row);
    return undefined;
  } catch (e) {
    console.warn(`an order's variable not recorded (${s.orderId}): its node drops it:`, e);
    const m = r.machineId;
    try {
      await orderEnvDrop(hub, m, r.projectId, s.orderId, [s.name, s.fingerprint]);
      return `The hub could not record ${s.name} for ${s.orderId}, so ${m}'s node dropped it again: ${(e as Error).message}`;
    } catch (drop) {
      return `The hub could not record ${s.name} for ${s.orderId} (${(e as Error).message}), and ${m}'s node could not drop it: ${(drop as Error).message}`;
    }
  }
}

/**
 * Has each closed or gone order's node forget its variables, and drops their rows once it has. An order whose node is
 * offline or too old keeps its rows until a later pass. Returns how many orders were dropped.
 */
export async function dropClosed(hub: Hub): Promise<number> {
  const db = hub.db.conn;
  let dropped = 0;
  for (const [r, order] of orderEnvStore.held(db)) {
    // Held under its own project, or under the checkout of a repo its tasks work in (an order's GitHub token,
    // github_app/sessions.rs): open while the order is.
    if (open(db, order)) continue;
    const m = r.machineId;
    if (!executors(hub).isConnected(m) || !link(hub).can(m, CAP_ORDER_ENV)) continue;
    if (!ORDER_ID.test(order)) {
      orderEnvStore.forget(db, r, order);
      continue;
    }
    try {
      await orderEnvDrop(hub, m, r.projectId, order);
      orderEnvStore.forget(db, r, order);
      console.info(`the closed order's variables are gone: ${order} on ${m}`);
      dropped++;
    } catch (e) {
      console.warn(`the closed order's variables not dropped yet: ${order} on ${m}:`, e);
    }
  }
  return dropped;
}

/**
 * Drops closed orders' variables after every batch of events (an order closing, a machine coming back), and on every
 * sweep; and answers the approvals area's order checks (D348).
 */
export function start(hub: Hub): void {
  const hooks = approvals(hub).deps.hooks;
  hooks.orderRefusal = async (project, orderId) => refusal(hub, project, orderId);
  hooks.orderEnvSaved = (s, at) => saved(hub, s, at);
  sweep(hub).register({ name: "order-env", run: async () => void (await dropClosed(hub)) });
  // One pass at a time; events during a pass make one more after it, as Rust's watch channel does.
  let running = false;
  let again = false;
  const pass = async () => {
    if (running) {
      again = true;
      return;
    }
    running = true;
    try {
      do {
        again = false;
        if (orderEnvStore.held(hub.db.conn).length === 0) continue;
        try {
          await dropClosed(hub);
        } catch (e) {
          console.warn("closed orders' variables not checked:", e);
        }
      } while (again && !hub.shutdown.signal.aborted);
    } finally {
      running = false;
    }
  };
  let queued = false;
  const unsubscribe = events(hub).subscribe(() => {
    if (queued) return;
    queued = true;
    queueMicrotask(() => {
      queued = false;
      void pass();
    });
  });
  hub.shutdown.signal.addEventListener("abort", unsubscribe, { once: true });
  void pass();
}

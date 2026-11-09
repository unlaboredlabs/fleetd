// What a sleeping cloud machine missed, kept until its next hello (crates/fleetd/src/hub/cloud/outbox.rs,
// `cloud_outbox`): a secret it must forget that the hub couldn't tell it while it slept. Each item names an account or a
// person, never a value, and is kept once per machine; the catch-up replays them in order and drops each one its node
// took.
import type { ClaudeAccount } from "../../shared/contracts.ts";
import type { Hub } from "../api/hub.ts";
import type { HubDb } from "../store/db.ts";

export type Missed = { kind: "claude_forget"; account: ClaudeAccount } | { kind: "one_password_forget"; personId: string };

/** The item as the Rust hub serializes it (`kind` first), so the unique (machine, item) pair matches its rows. */
export function itemText(item: Missed): string {
  if (item.kind === "claude_forget") {
    const account = item.account.kind === "hub" ? { kind: "hub" } : { kind: "person", personId: item.account.personId };
    return JSON.stringify({ kind: item.kind, account });
  }
  return JSON.stringify({ kind: item.kind, personId: item.personId });
}

export class Outbox {
  constructor(private readonly db: HubDb) {}

  /** Keeps `item` for the machine's next hello; once only, however often it is missed. */
  add(machineId: string, item: Missed, atMs: number): void {
    this.db.conn
      .query("INSERT INTO cloud_outbox (machine_id, item, created_ms) VALUES (?, ?, ?) ON CONFLICT (machine_id, item) DO NOTHING")
      .run(machineId, itemText(item), atMs);
  }

  /** The machine's items, oldest first, each with its id. One that no longer decodes is skipped. */
  list(machineId: string): [number, Missed][] {
    const rows = this.db.conn
      .query<{ id: number; item: string }, [string]>("SELECT id, item FROM cloud_outbox WHERE machine_id = ? ORDER BY id")
      .all(machineId);
    const out: [number, Missed][] = [];
    for (const r of rows) {
      try {
        const item = JSON.parse(r.item) as Missed;
        if (item.kind === "claude_forget" || item.kind === "one_password_forget") out.push([r.id, item]);
      } catch {}
    }
    return out;
  }

  /** The item went to its machine. */
  done(id: number): void {
    this.db.conn.query("DELETE FROM cloud_outbox WHERE id = ?").run(id);
  }
}

/** Whether the machine is a cloud (pool) machine (auth `is_pool`). */
export function isPool(hub: Hub, machineId: string): boolean {
  try {
    const row = hub.db.conn.query<{ pool: number }, [string]>("SELECT pool FROM node_keys WHERE machine_id = ?").get(machineId);
    return Boolean(row?.pool);
  } catch (e) {
    console.warn(`whether ${machineId} is a cloud machine not read:`, e);
    return false;
  }
}

/**
 * `machineId` missed `item` because it was offline: kept for its next hello when it is a cloud machine, which sleeps
 * by design. Any other machine offline keeps today's rule (the hub stops recording it as holding the secret).
 */
export function missed(hub: Hub, machineId: string, item: Missed): void {
  if (!isPool(hub, machineId)) return;
  try {
    new Outbox(hub.db).add(machineId, item, hub.clock.now());
  } catch (e) {
    console.warn(`a sleeping cloud machine's missed forget not kept (${machineId}):`, e);
  }
}

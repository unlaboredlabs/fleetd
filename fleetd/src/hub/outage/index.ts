// Machines down: a machine offline for DOWN_AFTER_MS that nothing explains is
// logged as `machine.down` with `attention`, so the hub's admins get one push (hub/push: an event about no project is
// theirs) and the app one notification; once it links again, `machine.back` tells them, once. The event log is the
// only state: a machine is paged while its newest machine.down is newer than its last link (machine.online or
// machine.degraded), so a hub restart mid-outage neither pages twice nor forgets the outage.
//
// Nothing explains an outage except an update whose node part has no result yet (its node restarts) and a cloud
// machine the pool stopped or put to sleep. Both are looked at again each sweep. A removed machine has no row, so it
// never pages. The agents' Mac counts like any machine.
import type { Machine } from "../../shared/contracts.ts";
import type { Hub } from "../api/hub.ts";
import { durationText } from "../link/server.ts";
import { events } from "../store/events.ts";
import { store } from "../store/hub_store.ts";
import { isoMs, parseMs } from "../store/time.ts";
import { pool } from "../pool/tools.ts";
import { updates } from "../update/tools.ts";

/** How long a machine stays offline before its admins are paged. */
export const DOWN_AFTER_MS = 10 * 60_000;
/** How often the sweep looks. */
export const SWEEP_EVERY_MS = 30_000;

/** The newest of a machine's outage events: seqs (0 when none), and when it last linked. */
type Marks = { linked: number; down: number; back: number; linkedMs?: number };

function marks(hub: Hub, machine: string): Marks {
  const rows = new Map<string, { seq: number; at: number }>();
  for (const r of hub.db.all<{ type: string; seq: number; at: number }>(
    `SELECT type, MAX(seq) AS seq, MAX(created_ms) AS at FROM events WHERE machine_id = ?
       AND type IN ('machine.online', 'machine.degraded', 'machine.offline', 'machine.down', 'machine.back')
     GROUP BY type`,
    [machine],
  )) {
    rows.set(r.type, { seq: r.seq, at: r.at });
  }
  const seq = (k: string) => rows.get(k)?.seq ?? 0;
  const at = (k: string) => rows.get(k)?.at;
  // Rust's Option max: any time beats none.
  const online = at("machine.online");
  const degraded = at("machine.degraded");
  const linkedMs = online === undefined ? degraded : degraded === undefined ? online : Math.max(online, degraded);
  return {
    linked: Math.max(seq("machine.online"), seq("machine.degraded")),
    down: seq("machine.down"),
    back: seq("machine.back"),
    ...(linkedMs === undefined ? {} : { linkedMs }),
  };
}

/**
 * When the outage that `before` (a seq) falls in began: the machine's first machine.offline after its newest link
 * before then. Later ones (a hub restart's, say) don't move it.
 */
function outageFrom(hub: Hub, machine: string, before: number): number | undefined {
  return (
    hub.db.conn
      .query<{ at: number | null }, [string, number]>(
        `SELECT MIN(created_ms) AS at FROM events WHERE machine_id = ?1 AND type = 'machine.offline'
           AND seq > (SELECT COALESCE(MAX(seq), 0) FROM events WHERE machine_id = ?1
                        AND type IN ('machine.online', 'machine.degraded') AND seq < ?2)`,
      )
      .get(machine, before)?.at ?? undefined
  );
}

/** Whether something explains the machine being away, so it needs nobody. */
function explained(hub: Hub, m: Machine): boolean {
  if (updates(hub).updating(m.machineId)) return true;
  if (m.cloud !== true) return false;
  try {
    const state = pool(hub).ledger.slot(m.machineId)?.state;
    // No slot: the pool no longer keeps it, so it isn't meant to be up.
    return state === undefined || state === "stopping" || state === "asleep" || state === "gone";
  } catch (error) {
    console.warn("outage: pool slot not read:", error);
    return true;
  }
}

function append(hub: Hub, type: "machine.down" | "machine.back", m: Machine, now: number, summary: string, offlineMs: number): void {
  events(hub).append({ at: isoMs(now), type, machineId: m.machineId, summary, data: { offlineMs }, attention: "loud" });
}

/** One look at every machine: pages each one down past DOWN_AFTER_MS, and says each paged one is back. */
export function sweep(hub: Hub): void {
  const now = hub.clock.now();
  for (const m of store(hub).machinesList()) {
    const k = marks(hub, m.machineId);
    const paged = k.down > k.linked;
    if (m.status === "offline") {
      if (paged) continue;
      const since = outageFrom(hub, m.machineId, Number.MAX_SAFE_INTEGER) ?? parseMs(m.lastSeenAt) ?? now;
      const away = now - since;
      if (away < DOWN_AFTER_MS || explained(hub, m)) continue;
      append(hub, "machine.down", m, now, `${m.name} has been offline for ${durationText(away)}`, away);
      console.warn(`outage: machine down, admins paged machine_id=${m.machineId} away_ms=${away}`);
    } else if (k.down > k.back && k.linked > k.down) {
      const from = outageFrom(hub, m.machineId, k.down);
      const away = k.linkedMs !== undefined && from !== undefined ? Math.max(0, k.linkedMs - from) : 0;
      append(hub, "machine.back", m, now, `${m.name} is back online after ${durationText(away)}`, away);
      console.info(`outage: machine back machine_id=${m.machineId}`);
    }
  }
}

/** Looks every 30 s until the hub stops. */
export function run(hub: Hub): void {
  const signal = hub.shutdown.signal;
  const timer = setInterval(() => {
    try {
      sweep(hub);
    } catch (error) {
      console.error("outage: machines not swept:", error);
    }
  }, SWEEP_EVERY_MS);
  signal.addEventListener("abort", () => clearInterval(timer), { once: true });
}

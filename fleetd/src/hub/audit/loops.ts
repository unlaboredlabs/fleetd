// The audit log's loops: each event record.ts reads becomes its row as it is appended, and the safety-net sweep drops
// rows past a year.
import type { Hub } from "../api/hub.ts";
import { events } from "../store/events.ts";
import { sweep } from "../sweep/index.ts";
import { AUDITED_EVENTS, fromEvent } from "./record.ts";
import { auditLog } from "./store.ts";

const audited: ReadonlySet<string> = new Set(AUDITED_EVENTS);

export function start(hub: Hub): void {
  const log = auditLog(hub);
  const unsubscribe = events(hub).subscribe((e) => {
    if (!audited.has(e.type)) return;
    try {
      const row = fromEvent(hub, e);
      if (row) log.record(row);
    } catch (error) {
      console.warn(`audit row not made from ${e.type}:`, error);
    }
  });
  hub.shutdown.signal.addEventListener("abort", unsubscribe, { once: true });
  sweep(hub).register({ name: "audit", run: () => void log.sweep(hub.clock.now()) });
}

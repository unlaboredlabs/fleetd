// An event on its way into the log, before the log numbers it (events.ts appends it), and how the log trims it.
import type { HubEvent } from "../../shared/contracts.ts";

export type NewEvent = Omit<HubEvent, "seq">;

export const MAX_DATA_BYTES = 2048;
export const MAX_SUMMARY = 200;

/**
 * Trims `summary` to 200 UTF-16 units (199 plus "…", as older hubs cut it) and replaces a `data` over 2 KB of JSON
 * with `{"truncated": true}`. Keys in the Rust struct's order, so rows read the same.
 */
export function trim(event: NewEvent): NewEvent {
  let summary = event.summary;
  if (summary.length > MAX_SUMMARY) {
    let units = 0;
    let cut = "";
    for (const c of summary) {
      units += c.length;
      if (units >= MAX_SUMMARY) break;
      cut += c;
    }
    summary = `${cut}…`;
  }
  let data = event.data;
  if (data !== undefined && Buffer.byteLength(JSON.stringify(data) ?? "") > MAX_DATA_BYTES) data = { truncated: true };
  const out: Record<string, unknown> = { at: event.at, type: event.type };
  if (event.machineId !== undefined) out.machineId = event.machineId;
  if (event.projectId !== undefined) out.projectId = event.projectId;
  if (event.threadId !== undefined) out.threadId = event.threadId;
  out.summary = summary;
  if (data !== undefined && data !== null) out.data = data;
  if (event.attention !== undefined) out.attention = event.attention;
  return out as NewEvent;
}

// The store's time forms (crates/fleetd/src/hub/store/mod.rs `now_ms`, `iso_ms`, `parse_ms`).
import type { Clock } from "../../shared/clock.ts";

export const nowMs = (clock: Clock) => clock.now();

/** `2026-10-17T10:00:00.000Z`: UTC with milliseconds, the form of every timestamp the hub stores. */
export function isoMs(ms: number): string {
  const date = new Date(ms);
  return Number.isNaN(date.getTime()) ? "1970-01-01T00:00:00.000Z" : date.toISOString();
}

const RFC3339 = /^\d{4}-\d{2}-\d{2}[Tt ]\d{2}:\d{2}:\d{2}(\.\d+)?([Zz]|[+-]\d{2}:\d{2})$/;

/** Milliseconds of an RFC 3339 timestamp (finer digits dropped); undefined for anything else. */
export function parseMs(text: string): number | undefined {
  if (!RFC3339.test(text)) return undefined;
  const ms = Date.parse(text.replace(/(\.\d{3})\d+/, "$1"));
  return Number.isNaN(ms) ? undefined : ms;
}

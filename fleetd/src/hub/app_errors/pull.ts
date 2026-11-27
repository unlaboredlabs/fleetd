// fleetd's own workspace pulls a phone update whose error reports spike (D800): the first ring of the phone's staged
// rollout (.github/release/phone-rollout.ts), as it is the workspaces' (update settings' `ring: "first"` with
// `reportTo`). It counts the reports `app_error_report` takes by the update they ran, and pulls one on any fatal report,
// or on more than CAUGHT_AT_MOST caught ones at over twice the rate of the update seen before it (reports an hour since
// each was first reported; the first one it hears of has none to weigh against, so only a fatal report pulls it). A pull is `rollout.yml`'s phone-pull: every stage then serves the update everyone had.
// Only counts are kept, in `<hub home>/update/phone-errors.json`, so a restart (each new build) keeps them; never a
// message or a stack.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/** Caught (not fatal) reports an update may have before its rate is weighed. */
export const CAUGHT_AT_MOST = 3;
/** Updates whose counts are kept, newest first reported. */
const KEPT = 20;
const MINUTE = 60_000;
const HOUR = 3_600_000;

export type UpdateCounts = { id: string; firstAt: number; fatal: number; caught: number; pulledAt?: number };

/** Why `id` should be pulled now, or undefined. `counts` is newest first reported. */
export function spike(counts: readonly UpdateCounts[], id: string, now: number): string | undefined {
  const at = counts.findIndex((c) => c.id === id);
  const u = counts[at];
  if (u === undefined || u.pulledAt !== undefined) return undefined;
  if (u.fatal > 0) return `${u.fatal} fatal error report${u.fatal === 1 ? "" : "s"}`;
  if (u.caught <= CAUGHT_AT_MOST) return undefined;
  // With no update before it to weigh against, only a fatal report pulls.
  const before = counts[at + 1];
  if (before === undefined) return undefined;
  const rate = (u.caught / Math.max(MINUTE, now - u.firstAt)) * HOUR;
  const was = (before.caught / Math.max(MINUTE, u.firstAt - before.firstAt)) * HOUR;
  if (rate <= 2 * was) return undefined;
  return `${u.caught} caught errors, ${rate.toFixed(1)} an hour against ${was.toFixed(1)} an hour on the update before`;
}

/** The counts kept in `file`, newest first reported; none when it is missing or unreadable. */
export function readCounts(file: string): UpdateCounts[] {
  try {
    const v = JSON.parse(readFileSync(file, "utf8")) as { updates?: unknown };
    return Array.isArray(v.updates) ? (v.updates as UpdateCounts[]).filter((c) => typeof c?.id === "string") : [];
  } catch {
    return [];
  }
}

function writeCounts(file: string, counts: readonly UpdateCounts[]): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(`${file}.tmp`, `${JSON.stringify({ updates: counts }, null, 2)}\n`);
  renameSync(`${file}.tmp`, file);
}

/**
 * Counts one report that ran `update` (its id; "embedded" or none is a build's own bundle, which nothing pulls), and
 * says which update to pull and why, once: it is marked pulled before the pull runs, and `failed` unmarks it so the
 * next report tries again.
 */
export function count(file: string, update: string | undefined, fatal: boolean, now: number): { pull: string; why: string } | undefined {
  if (update === undefined || update === "embedded" || !/^[0-9a-f-]{36}$/u.test(update)) return undefined;
  const counts = readCounts(file);
  let u = counts.find((c) => c.id === update);
  if (u === undefined) {
    u = { id: update, firstAt: now, fatal: 0, caught: 0 };
    counts.unshift(u);
  }
  if (fatal) u.fatal++;
  else u.caught++;
  const why = spike(counts, update, now);
  if (why !== undefined) u.pulledAt = now;
  writeCounts(file, counts.slice(0, KEPT));
  return why === undefined ? undefined : { pull: update, why };
}

/** A pull that didn't start: the next report on the update tries again. */
export function failed(file: string, update: string): void {
  const counts = readCounts(file);
  const u = counts.find((c) => c.id === update);
  if (u === undefined || u.pulledAt === undefined) return;
  delete u.pulledAt;
  writeCounts(file, counts);
}

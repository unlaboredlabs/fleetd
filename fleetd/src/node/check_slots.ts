// `fleetd check-slot <node home> <command>...`: a repo's full pre-push check takes one of the machine's check slots (a
// file under `<node home>/check-slots` it holds a flock on) while `command` runs; with every slot in use it queues,
// first come first served, and says so in one line. Ten writers' checks at once loaded the devbox past 100 and failed
// each other's timing tests, and every rerun added more. An agent's own partial test commands never take one.
//
// Agents' PATH carries `fleetd-check-slot` (install, beside build_slots.ts's cargo wrapper), which a repo's check runs itself under when it is
// there (fleetd's scripts/check.sh does): `exec fleetd-check-slot "$0" "$@"`, unless FLEETD_CHECK_SLOT says it holds one.
import { closeSync } from "node:fs";
import { availableParallelism } from "node:os";
import { join } from "node:path";
import { runInherited, take, writeWrapper } from "./build_slots.ts";
import { readConfig } from "./config.ts";

export const COMMAND = "check-slot";
/** The wrapper's name on agents' PATH. */
export const WRAPPER = "fleetd-check-slot";
/** Set in the command's environment while it holds a slot: a check run inside it doesn't take a second. */
export const HELD = "FLEETD_CHECK_SLOT";
const POLL_MS = 500;

export const dir = (home: string) => join(home, "check-slots");

/** The slots `cores` CPUs get: one per 8 cores, at least 2. */
export const slotsFit = (cores: number) => Math.max(2, Math.floor(cores / 8));

/** node.json's `checkSlots`, else what the cores fit; undefined when `checkSlots` is 0: no turns. */
export function slotsHere(home: string): number | undefined {
  let set: number | undefined;
  try {
    const n = readConfig(home)?.checkSlots;
    if (typeof n === "number" && Number.isInteger(n) && n >= 0) set = n;
  } catch {}
  if (set === 0) return undefined;
  return set ?? slotsFit(availableParallelism());
}

export function waitingLine(slots: number, ahead: number): string {
  const place = ahead === 0 ? "next in line" : ahead === 1 ? "1 check ahead" : `${ahead} checks ahead`;
  return `fleetd: waiting for a check slot (${place}; ${slots === 1 ? "1 slot" : `${slots} slots`} on this machine, all in use): it starts by itself once one frees, and the wait isn't counted in its time`;
}

/** `'value'`, for a shell. */
const quoted = (v: string) => `'${v.replaceAll("'", "'\\''")}'`;

/** Writes the check wrapper beside the cargo one (on agents' PATH: build_slots.ts addToPath), which runs `exe`
 * (fleetd's command line); its path. */
export const install = (home: string, exe: string[]) =>
  writeWrapper(home, WRAPPER, `#!/bin/sh\n# fleetd's: a repo's full pre-push check waits its turn for one of the machine's check slots.\nexec ${exe.map(quoted).join(" ")} ${COMMAND} ${quoted(home)} "$@"\n`);

/** What a worker's standing rules say about check turns. */
export const briefLine = (slots: number) =>
  `- The repo's full pre-push check (\`.fleetd/pre-push.json\`) takes turns for this machine's ${slots} check slots. One that prints it is waiting for a check slot starts by itself once one frees: don't stop it or start another. Your own partial test commands never wait.\n`;

export async function main(argv: string[]): Promise<number> {
  const [home, bin, ...args] = argv;
  if (home === undefined || bin === undefined) {
    process.stderr.write(`fleetd: ${COMMAND} needs the node home, then the command to run\n`);
    return 2;
  }
  const slots = process.env[HELD] === undefined ? slotsHere(home) : undefined;
  if (slots === undefined) return runInherited(bin, args, process.env);
  let slot: number[] | undefined;
  try {
    slot = await take(dir(home), slots, 1, POLL_MS, (n) => process.stderr.write(`${waitingLine(slots, n)}\n`));
  } catch (error) {
    process.stderr.write(`fleetd: check slots unavailable (${(error as Error).message}): checking without waiting\n`);
  }
  // Held in this process only, never handed to the check's children: a server a test leaves running can't keep it.
  const code = await runInherited(bin, args, { ...process.env, [HELD]: "1" });
  for (const fd of slot ?? []) closeSync(fd);
  return code;
}

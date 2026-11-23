// `fleetd heavy-slot <node home> <command>...`: a heavy run (a repo's full pre-push check, a whole test suite, a full
// build) takes one of the machine's heavy-run slots (a file under `<node home>/heavy-slots` it holds a flock on) while
// `command` runs; with every slot in use it queues, first come first served, and says so in one line. Ten writers'
// checks at once loaded the devbox past 100 and failed each other's timing tests, and every rerun added more; on Nov 23
// another repo's checks, which took no slot, loaded it to 47 and ran it out of ports. An agent's own partial test
// commands never take one.
//
// Agents' PATH carries `fleetd-heavy` (install, beside build_slots.ts's cargo wrapper): their standing rules (briefLine)
// tell them to run any repo's full check and long suites as `fleetd-heavy <command>`, and a repo's check may run
// itself under it (fleetd's scripts/check.sh does), unless FLEETD_HEAVY_SLOT says it holds one.
import { closeSync } from "node:fs";
import { availableParallelism } from "node:os";
import { join } from "node:path";
import { runInherited, take, writeWrapper } from "./build_slots.ts";
import { readConfig } from "./config.ts";

export const COMMAND = "heavy-slot";
/** The wrapper's name on agents' PATH. */
export const WRAPPER = "fleetd-heavy";
/** Set in the command's environment while it holds a slot: a heavy run inside it doesn't take a second. */
export const HELD = "FLEETD_HEAVY_SLOT";
/** The names from before heavy runs (Nov 22): branches' scripts/check.sh from then exec `fleetd-check-slot` unless
 * FLEETD_CHECK_SLOT is set, so both stay, or such a check would wrap itself forever. */
const OLD = { command: "check-slot", wrapper: "fleetd-check-slot", held: "FLEETD_CHECK_SLOT" };
export const COMMANDS = [COMMAND, OLD.command];
const POLL_MS = 500;

export const dir = (home: string) => join(home, "heavy-slots");

/** The slots `cores` CPUs get: one per 8 cores, at least 2. */
export const slotsFit = (cores: number) => Math.max(2, Math.floor(cores / 8));

/** node.json's `heavySlots` (`checkSlots` before it), else what the cores fit; undefined when it is 0: no turns. */
export function slotsHere(home: string): number | undefined {
  let set: number | undefined;
  try {
    const config = readConfig(home);
    const n = config?.heavySlots ?? config?.checkSlots;
    if (typeof n === "number" && Number.isInteger(n) && n >= 0) set = n;
  } catch {}
  if (set === 0) return undefined;
  return set ?? slotsFit(availableParallelism());
}

export function waitingLine(slots: number, ahead: number): string {
  const place = ahead === 0 ? "next in line" : ahead === 1 ? "1 run ahead" : `${ahead} runs ahead`;
  return `fleetd: waiting for a heavy-run slot (${place}; ${slots === 1 ? "1 slot" : `${slots} slots`} on this machine, all in use, so it can't overload it): it starts by itself once one frees; don't stop it, as a run started again goes to the back of the queue`;
}

/** `'value'`, for a shell. */
const quoted = (v: string) => `'${v.replaceAll("'", "'\\''")}'`;

/** Writes the heavy-run wrapper (and its old name) beside the cargo one (on agents' PATH: build_slots.ts addToPath),
 * which runs `exe` (fleetd's command line); its path. */
export function install(home: string, exe: string[]): string {
  const script = `#!/bin/sh\n# fleetd's: a long test or build command waits its turn for one of the machine's heavy-run slots.\nexec ${exe.map(quoted).join(" ")} ${COMMAND} ${quoted(home)} "$@"\n`;
  writeWrapper(home, OLD.wrapper, script);
  return writeWrapper(home, WRAPPER, script);
}

/** What a worker's standing rules say about heavy runs. */
export const briefLine = (slots: number) =>
  `- Run the repo's full pre-push check (\`.fleetd/pre-push.json\`, or what its docs name) and any other whole test suite or full build as \`${WRAPPER} <command>\` (\`${WRAPPER} bun run check\`): it takes one of this machine's ${slots} heavy-run slots, so many agents' checks can't overload it and fail on ports or timeouts. With all in use it prints that it is waiting and starts by itself once one frees: give it Bash's longest timeout or run it in the background with the Monitor tool, and don't stop it or start another. Your own partial test commands (one file, a filter) run directly and never wait.\n`;

export async function main(argv: string[]): Promise<number> {
  const [home, bin, ...args] = argv;
  if (home === undefined || bin === undefined) {
    process.stderr.write(`fleetd: ${COMMAND} needs the node home, then the command to run\n`);
    return 2;
  }
  const held = process.env[HELD] !== undefined || process.env[OLD.held] !== undefined;
  const slots = held ? undefined : slotsHere(home);
  if (slots === undefined) return runInherited(bin, args, process.env);
  let slot: number[] | undefined;
  try {
    slot = await take(dir(home), slots, 1, POLL_MS, (n) => process.stderr.write(`${waitingLine(slots, n)}\n`));
  } catch (error) {
    process.stderr.write(`fleetd: heavy-run slots unavailable (${(error as Error).message}): running without waiting\n`);
  }
  // Held in this process only, never handed to the run's children: a server a test leaves running can't keep it.
  const code = await runInherited(bin, args, { ...process.env, [HELD]: "1", [OLD.held]: "1" });
  for (const fd of slot ?? []) closeSync(fd);
  return code;
}

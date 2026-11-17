// Where an agent's session runs: a `Place`. The node starts, adopts, stops and ends a session's host, runs its setup
// commands and reads its chat files through the session's place, never by host pids or paths of its own. Two kinds:
// - `process` (./process.ts): the session host as a detached process on this machine;
// - `microvm` (./microvm.ts): the session host in a VM of its own, the default for a task's agent wherever the machine
//   can run one. It records its box in the session's host dir (`box.json`), which `placeAt` reads back.
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { ConfinedRun, RunOutcome } from "../cmd/index.ts";
import type { Image } from "../actions/image.ts";
import { sweep as sweepHosts, type HostLink, type Launch } from "../runner/host.ts";
import { boxFile, destroyBox } from "./box_record.ts";
import type { MicroVm, PlaceFor } from "./microvm.ts";
import { processPlace } from "./process.ts";

export type { PlaceFor } from "./microvm.ts";
export type PlaceKind = "process" | "microvm";

/** Where one agent's session runs. Each session picks one at launch (`pick`); what it left is found by `placeAt`. */
export interface Place {
  readonly kind: PlaceKind;
  /** Starts `fleetd session-host` with claude's argv, env and cwd (booting the box first, for a kind with one) and
   * connects to it once it registered. Throws a LaunchError. */
  start(l: Launch): Promise<HostLink>;
  /** After a node restart: reconnects to what `start` left in `dir`; undefined when nothing there answers. */
  adopt(dir: string): Promise<HostLink | undefined>;
  /** Ends the host in `dir` and its session, then removes the dir. Idempotent. */
  stop(dir: string): Promise<void>;
  /** The session's task ended: what its turns left running (a server, a browser) goes too. Never between turns, which
   * may leave one running on purpose. How many processes it ended. */
  end(dir: string): Promise<number>;
  /** Runs argv where the agent runs (setup commands), in a process group of its own killed at the timeout. */
  run(r: ConfinedRun): Promise<RunOutcome>;
  /** A piece of the image or chat file at `path` in the session's working directory `root` (actions/image.ts). */
  read(root: string, path: string, offset: number, file: boolean): Promise<Image>;
}

/** The dir a session's host keeps its registration and socket in. */
export const hostDir = (home: string, sessionId: string) => join(home, "hosts", sessionId);

let vm: MicroVm | undefined;

/** The node's VMs (none: every session runs as a process). */
export const useVm = (m: MicroVm | undefined) => void (vm = m);
export const currentVm = () => vm;

/** The place session `s`'s next start (and its setup commands) runs in: a task's agent in a VM where the machine can
 * run one, else a process. */
export const pick = (s?: PlaceFor): Place => (s && vm?.wants(s) && vm.status().kind === "microvm" ? vm.bound(s) : processPlace);

/** A box whose node has no VMs now (turned off since it started): it can still be ended. */
const strayBox: Place = {
  ...processPlace,
  kind: "microvm",
  adopt: async () => undefined,
  end: async (dir) => (await destroyBox(dir)) + (await processPlace.end(dir)),
};

/** The place the session whose host dir is `dir` was started in. */
export const placeAt = (dir: string): Place => {
  if (!existsSync(boxFile(dir))) return processPlace;
  if (!vm) return strayBox;
  return vm.bound({ sessionId: dir.split("/").at(-1)!, dir, role: "worker" });
};

/** Stops every session's host in `hosts` but those of `keep`, and removes their dirs. How many were still running. */
export const sweep = (hosts: string, keep: Set<string>): Promise<number> => sweepHosts(hosts, keep);

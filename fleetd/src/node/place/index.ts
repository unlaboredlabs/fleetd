// Where an agent's session runs: a `Place`. The node starts, adopts, stops and ends a session's host, runs its setup
// commands and reads its chat files through the session's place, never by host pids or paths of its own. Three kinds:
// - `process` (./process.ts): the session host as a detached process on this machine;
// - `microvm` (./microvm.ts): the session host in a VM of its own, the default for a task's agent wherever the machine
//   can run one. It records its box in the session's host dir (`box.json`), which `placeAt` reads back;
// - `hosted` (./hosted.ts): the session host in a box of the team's own hosted provider, when the hub's slot board
//   placed the session there. Its record is `place.json`, which `placeAt` reads first.
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { ConfinedRun, RunOutcome } from "../cmd/index.ts";
import type { Image } from "../actions/image.ts";
import { sweep as sweepHosts, type HostLink, type Launch } from "../runner/host.ts";
import { boxFile, destroyBox } from "./box_record.ts";
import type { MicroVm, PlaceFor as MicroVmFor } from "./microvm.ts";
import type { ProviderId } from "../../sandbox/providers/index.ts";
import { hasBox, hostedBox, hostedPlace, readRecord } from "./hosted.ts";
import type { Box } from "../sandbox/box.ts";
import type { View } from "./view.ts";
import { processPlace } from "./process.ts";

export type PlaceKind = "process" | "microvm" | "hosted";

/** The session a place is picked for (./microvm.ts), and where the hub placed it: `hosted` names the provider. */
export type PlaceFor = MicroVmFor & { hosted?: ProviderId };

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

/** Whether session `session` runs in a box, hosted or this node's VM: what runs on this machine for it (a program the
 * Linux desktop launches) would run outside that box. */
export const inBox = (session: string): boolean => hasBox(session) || (vm?.holds(session) ?? false);

/** Session `session`'s box once it is up, and what of this machine's files it shows (none for a hosted box, which
 * shares none): where its browser's connections go out, and what its paths are checked against (../browser/egress.ts). */
export const boxOf = (session: string): { box: Box; view?: View } | undefined => {
  const hosted = hostedBox(session);
  return hosted ? { box: hosted } : vm?.boxOf(session);
};

/** What the Linux desktop says to a VM's agent asking it to launch a program. */
export const VM_NO_DESKTOP_LAUNCH =
  "This agent runs in a VM of its own, and the Linux desktop runs on this machine outside it, so it can't launch programs for it: one started there would run outside the VM. Say in your result that the desktop check was skipped.";

/** The place session `s`'s next start (and its setup commands) runs in: the hosted provider's box the hub placed it
 * in, else a task's agent in a VM where the machine can run one, else a process. */
export const pick = (s?: PlaceFor): Place => {
  if (s?.hosted) return hostedPlace(s.hosted, s.sessionId, s.dir);
  return s && vm?.wants(s) && vm.status().kind === "microvm" ? vm.bound(s) : processPlace;
};

/** A box whose node has no VMs now (turned off since it started): it can still be ended, its dir with it. */
const strayBox: Place = {
  ...processPlace,
  kind: "microvm",
  adopt: async () => undefined,
  async end(dir) {
    const ended = (await destroyBox(dir)) + (await processPlace.end(dir));
    rmSync(dir, { recursive: true, force: true });
    return ended;
  },
};

/** The place the session whose host dir is `dir` was started in. */
export const placeAt = (dir: string): Place => {
  const hosted = readRecord(dir);
  if (hosted) return hostedPlace(hosted.provider, hosted.session, dir);
  if (!existsSync(boxFile(dir))) return processPlace;
  if (!vm) return strayBox;
  return vm.bound({ sessionId: dir.split("/").at(-1)!, dir, role: "worker" });
};

/** Whether the session whose host dir is `dir`, with `runs`, leaves its VM now: it runs in one on a machine whose next
 * start of it wouldn't (VMs turned off, or its last VM failed), and no run of it is under way, which finishes in its
 * box. Its claude then goes before the next turn, which starts where `pick` says. */
export const leavesBox = (dir: string, runs: { status: string }[]): boolean =>
  !runs.some((r) => r.status === "running" || r.status === "waiting") &&
  placeAt(dir).kind === "microvm" &&
  pick({ sessionId: dir.split("/").at(-1)!, dir, role: "worker" }).kind !== "microvm";

/** Stops every session's host in `hosts` but those of `keep`, and removes their dirs. How many were still running. */
export const sweep = (hosts: string, keep: Set<string>): Promise<number> => sweepHosts(hosts, keep);

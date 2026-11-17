// Where an agent's session runs: a `Place`. The node starts, adopts, stops and ends a session's host, runs its setup
// commands and reads its chat files through the session's place, never by host pids or paths of its own. `process`
// (./process.ts) is the only kind so far: the session host as a detached process on this machine, today's code. A
// kind with a box of its own (a VM) plugs in here: it records itself in the session's host dir at `start`, `placeAt`
// reads it back, and the call sites don't change.
import { join } from "node:path";
import type { ConfinedRun, RunOutcome } from "../cmd/index.ts";
import type { Image } from "../actions/image.ts";
import { sweep as sweepHosts, type HostLink, type Launch } from "../runner/host.ts";
import { processPlace } from "./process.ts";

export type PlaceKind = "process";

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

/** The place a session's next start runs in. */
export const pick = (): Place => processPlace;

/** The place the session whose host dir is `dir` was started in. */
export const placeAt = (_dir: string): Place => processPlace;

/** Stops every session's host in `hosts` but those of `keep`, and removes their dirs. How many were still running. */
export const sweep = (hosts: string, keep: Set<string>): Promise<number> => sweepHosts(hosts, keep);

// Where an agent's session runs: a `Place`. The node starts, adopts, stops and ends a session's host, runs its setup
// commands and reads its chat files through the session's place, never by host pids or paths of its own. Two kinds:
// - `process` (./process.ts): the session host as a detached process on this machine;
// - `hosted` (./hosted.ts): the session host in a box of a hosted provider, when the hub's slot board placed the
//   session there, and every session on a hosted runner. Its record is `place.json`, which `placeAt` reads first.
import { join } from "node:path";
import type { ConfinedRun, RunOutcome } from "../cmd/index.ts";
import type { Image } from "../actions/image.ts";
import { LaunchError, sweep as sweepHosts, type HostLink, type Launch } from "../runner/host.ts";
import type { SessionRole } from "../../shared/sessions.ts";
import type { ProviderId, Size } from "../../sandbox/providers/index.ts";
import { hasBox, hostedBox, hostedPlace, readRecord } from "./hosted.ts";
import type { Box } from "../sandbox/box.ts";
import { processPlace } from "./process.ts";

export type PlaceKind = "process" | "hosted";

/** The session a place is picked for, and where the hub placed it: `hosted` names the provider, `size` the bot's
 * pick of its box's size. */
export type PlaceFor = { sessionId: string; dir: string; role: SessionRole; account?: boolean; size?: Size; hosted?: ProviderId };

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

/** Whether session `session` runs in a hosted box: what runs on this machine for it (a program the Linux desktop
 * launches) would run outside that box. */
export const inBox = (session: string): boolean => hasBox(session);

/** Session `session`'s box once it is up: where its browser and screens run (box_screens.ts). */
export const boxOf = (session: string): { box: Box } | undefined => {
  const hosted = hostedBox(session);
  return hosted ? { box: hosted } : undefined;
};

/** What the Linux desktop says to a hosted agent asking it to launch a program on this machine. */
export const BOX_NO_DESKTOP_LAUNCH =
  "This agent runs in a hosted sandbox, and the Linux desktop runs on this machine outside it, so it can't launch programs for it: one started there would run outside the sandbox. Say in your result that the desktop check was skipped.";

let runner: (() => ProviderId | undefined) | undefined;

/** This node is the hub's own runner (shared/sandbox.ts CAP_RUNNER): every session runs in a hosted box, in the
 * provider the hub placed it in, else the first one `provider` names; none runs on this machine. */
export const useRunner = (provider: (() => ProviderId | undefined) | undefined) => void (runner = provider);
export const isRunner = () => runner !== undefined;
/** The provider the runner puts a session in that the hub placed nowhere; undefined off the runner. */
export const runnerProvider = (): ProviderId | undefined => runner?.();

/** What the hub's runner says when no provider of the team's takes its agents. */
export const RUNNER_NO_PROVIDER =
  "no hosted sandbox provider of the team's is connected, and no computer runs this bot: an admin connects boat.dev in Settings › Hub › Machines";

/** The place the runner gives a session no provider takes: it never starts, and says why. */
const noPlace: Place = {
  ...processPlace,
  start: async () => {
    throw new LaunchError(RUNNER_NO_PROVIDER);
  },
  run: async () => ({ exitCode: null, outputTail: "", timedOut: false, notRun: RUNNER_NO_PROVIDER }),
};

/** The place session `s`'s next start (and its setup commands) runs in: the hosted provider's box the hub placed it
 * in, else this machine, as a process. On the hub's runner, always a box. */
export const pick = (s?: PlaceFor): Place => {
  const hosted = s?.hosted ?? runner?.();
  if (s && hosted) return hostedPlace(hosted, s.sessionId, s.dir, s.size);
  return runner ? noPlace : processPlace;
};

/** The place the session whose host dir is `dir` was started in. A box a local VM left there (./left_vm.ts) is ended
 * by the process place's stop. */
export const placeAt = (dir: string): Place => {
  const hosted = readRecord(dir);
  return hosted ? hostedPlace(hosted.provider, hosted.session, dir) : processPlace;
};

/** Stops every session's host in `hosts` but those of `keep`, and removes their dirs. How many were still running. */
export const sweep = (hosts: string, keep: Set<string>): Promise<number> => sweepHosts(hosts, keep);

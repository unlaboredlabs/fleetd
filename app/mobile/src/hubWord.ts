// What the chats list's bar says about the hub, the phone's quiet hub row (the desktop's sidebar footer): one word in
// the title's place, only while there is something to say. "Updating…" while the hub updates (its `hub.update` says
// so, its close said "updating to <version>", or an admin's run goes on), "Updated" for a while after it came back on a new
// build, "Not Updated" when the hub or a machine didn't take it, and today's "Connecting…" for a link that dropped by itself. A
// planned restart isn't an outage: the screens keep what they show and nothing says the hub can't be reached for
// RESTART_HOLD_MS (a restart that isn't an update says nothing at all till then), and one calm line under the bar
// says an update is taking a while only past SLOW_RESTART_MS. Members see the same words; the run (an admin's) only
// adds to them. Pure, so tested (hubWord.test.ts).
import type { HubState, HubUpdateData, UpdateRun } from "./desktop";
import type { Restart } from "./store";

/** After a planned restart, this long before the screens fall back to saying the hub can't be reached. */
export const RESTART_HOLD_MS = 10_000;
/** A restart running past this gets its one line under the bar. */
export const SLOW_RESTART_MS = 30_000;
/** Past this, a restart is said as an outage: the line turns to a warning, the bar to "Connecting…". */
export const LONG_RESTART_MS = 120_000;
/** How long "Updated" stays after the hub came back on a new build, or an admin's run ended. */
export const UPDATED_FOR_MS = 10 * 60_000;
/** How long a run that didn't go through stays said in the bar: it stays in Settings › Update till the next. */
export const FAILED_FOR_MS = 60 * 60_000;

export type WordTone = "quiet" | "danger";

export interface HubWord {
  readonly text: string;
  readonly tone: WordTone;
  /** While the link is dialled, which a screen without the avatar's dot shows with a spinner. */
  readonly busy: boolean;
  /** A planned restart's, which the avatar's dot shows as a ring. */
  readonly restart?: true;
}

export interface WordInput {
  readonly hub: HubState;
  readonly restart: Restart | null;
  /** An admin's update run (Settings › Update); null for members and when there is none. */
  readonly run: UpdateRun | null;
  /** The hub's update as it tells everyone (`hub.update`, the snapshot's `update`); undefined from a hub before it. */
  readonly update?: HubUpdateData | undefined;
  readonly now: number;
}

const going = (run: UpdateRun | null): boolean => run !== null && run.finishedAt === undefined;
/** Whether an update goes on: the hub says so, or an admin's run hasn't ended. */
const updating = ({ run, update }: WordInput): boolean => update?.state === "updating" || going(run);
/** When the hub's last update ended (epoch ms), with how it ended. */
const endedUpdate = (update: HubUpdateData | undefined): { readonly state: string; readonly at: number } | undefined =>
  update?.finishedAt === undefined ? undefined : { state: update.state, at: Date.parse(update.finishedAt) };

/** A planned restart that hasn't run long enough to be an outage, and whether it is an update. */
const restarting = (input: WordInput): { readonly update: boolean; readonly ms: number } | null => {
  const { hub, restart, now } = input;
  if (hub.phase !== "connecting" && hub.phase !== "retrying") return null;
  if (restart?.t !== "down" || (!restart.planned && !updating(input))) return null;
  const ms = now - restart.since;
  return ms < LONG_RESTART_MS ? { update: restart.update || updating(input), ms } : null;
};

/** The bar's word, or undefined while there is nothing to say. */
export const hubWord = (input: WordInput): HubWord | undefined => {
  const { hub, restart, run, update, now } = input;
  switch (hub.phase) {
    case "unpaired":
      return undefined;
    case "refused":
      return { text: "Not Connected", tone: "quiet", busy: false };
    case "connecting":
    case "retrying": {
      const planned = restarting(input);
      if (planned?.update === true) return { text: "Updating…", tone: "quiet", busy: true, restart: true };
      // A restart that isn't an update says nothing while the hub is back in a moment, then what any drop says.
      if (planned !== null && planned.ms < RESTART_HOLD_MS) return undefined;
      return { text: "Connecting…", tone: "quiet", busy: true };
    }
    case "live":
      break;
  }
  if (updating(input)) return { text: "Updating…", tone: "quiet", busy: false };
  // How the hub's last update ended, as it told everyone; an admin's run says the same where it doesn't.
  const told = endedUpdate(update);
  if (told !== undefined && now - told.at < FAILED_FOR_MS && (told.state === "put_back" || told.state === "failed")) return { text: "Not Updated", tone: "danger", busy: false };
  if (told?.state === "updated" && now - told.at < UPDATED_FOR_MS) return { text: "Updated", tone: "quiet", busy: false };
  const ended = run?.finishedAt === undefined ? undefined : Date.parse(run.finishedAt);
  if (run !== null && ended !== undefined && now - ended < FAILED_FOR_MS && run.parts.some((p) => p.state === "rolled_back" || p.state === "failed")) return { text: "Not Updated", tone: "danger", busy: false };
  if (restart?.t === "updated" && now - restart.at < UPDATED_FOR_MS) return { text: "Updated", tone: "quiet", busy: false };
  if (run !== null && ended !== undefined && now - ended < UPDATED_FOR_MS && run.parts.some((p) => p.state === "done")) return { text: "Updated", tone: "quiet", busy: false };
  return undefined;
};

/**
 * Whether the screens hold what they show rather than say the hub can't be reached: the first RESTART_HOLD_MS of a
 * planned restart, when the hub is back in a moment.
 */
export const holding = (input: WordInput): boolean => {
  const planned = restarting(input);
  return planned !== null && planned.ms < RESTART_HOLD_MS;
};

export interface SlowLine {
  readonly text: string;
  readonly tone: "quiet" | "warning";
}

/** The one line under the bar for a restart that runs long; undefined for one that doesn't, and for any other drop. */
export const slowLine = (input: WordInput & { readonly hubName: string }): SlowLine | undefined => {
  const { hub, restart, now, hubName } = input;
  if (hub.phase !== "connecting" && hub.phase !== "retrying") return undefined;
  if (restart?.t !== "down" || !(restart.update || updating(input))) return undefined;
  const ms = now - restart.since;
  if (ms < SLOW_RESTART_MS) return undefined;
  if (ms >= LONG_RESTART_MS) return { text: `${hubName} hasn't come back after ${String(Math.round(LONG_RESTART_MS / 60_000))} minutes`, tone: "warning" };
  // One line on a phone's width: the bar already says what is going on.
  return { text: "Still updating. What you send goes once it's back.", tone: "quiet" };
};

/** When the bar's word next changes by itself (epoch ms), so a screen wakes for it; undefined when nothing will. */
export const nextChange = (input: WordInput): number | undefined => {
  const { hub, restart, run, update, now } = input;
  const ended = [run?.finishedAt === undefined ? undefined : Date.parse(run.finishedAt), endedUpdate(update)?.at].filter((at) => at !== undefined);
  const times = [
    ...(restart?.t === "updated" ? [restart.at + UPDATED_FOR_MS] : []),
    ...(restart?.t === "down" && hub.phase !== "live" && (restart.planned || updating(input)) ? [RESTART_HOLD_MS, SLOW_RESTART_MS, LONG_RESTART_MS].map((ms) => restart.since + ms) : []),
    ...ended.flatMap((at) => [at + UPDATED_FOR_MS, at + FAILED_FOR_MS]),
  ].filter((at) => at > now);
  return times.length === 0 ? undefined : Math.min(...times);
};

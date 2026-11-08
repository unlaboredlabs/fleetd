// What the chats list's bar says about the hub, the phone's quiet hub row (the desktop's sidebar footer): one word in
// the title's place, only while there is something to say. "Updating…" while the hub restarts for an update or an
// admin's run goes on, "Updated" for a while after it came back on a new build, "Put back" when a machine didn't take
// it, and today's "Connecting…" for a link that dropped by itself. A planned restart isn't an outage: the screens keep
// what they show, nothing says the hub can't be reached for RESTART_HOLD_MS, and one calm line under the bar says it
// is taking a while only past SLOW_RESTART_MS. Members see the same words; the run (an admin's) only adds to them. Pure,
// so tested (hubWord.test.ts).
import type { HubState, UpdateRun } from "./desktop";
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
  readonly now: number;
}

const going = (run: UpdateRun | null): boolean => run !== null && run.finishedAt === undefined;

/** A planned restart that hasn't run long enough to be an outage, and whether it is an update. */
const restarting = ({ hub, restart, run, now }: WordInput): { readonly update: boolean; readonly ms: number } | null => {
  if (hub.phase !== "connecting" && hub.phase !== "retrying") return null;
  if (restart?.t !== "down" || (!restart.planned && !going(run))) return null;
  const ms = now - restart.since;
  return ms < LONG_RESTART_MS ? { update: restart.update || going(run), ms } : null;
};

/** The bar's word, or undefined while there is nothing to say. */
export const hubWord = (input: WordInput): HubWord | undefined => {
  const { hub, restart, run, now } = input;
  switch (hub.phase) {
    case "unpaired":
      return undefined;
    case "refused":
      return { text: "Not Connected", tone: "quiet", busy: false };
    case "connecting":
    case "retrying": {
      const planned = restarting(input);
      if (planned === null) return { text: "Connecting…", tone: "quiet", busy: true };
      return { text: planned.update ? "Updating…" : "Restarting…", tone: "quiet", busy: true, restart: true };
    }
    case "live":
      break;
  }
  if (run !== null && going(run)) return { text: "Updating…", tone: "quiet", busy: false };
  const ended = run?.finishedAt === undefined ? undefined : Date.parse(run.finishedAt);
  if (run !== null && ended !== undefined && now - ended < FAILED_FOR_MS) {
    if (run.parts.some((p) => p.state === "rolled_back")) return { text: "Put back", tone: "danger", busy: false };
    if (run.parts.some((p) => p.state === "failed")) return { text: "Not Updated", tone: "danger", busy: false };
  }
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
  const { hub, restart, run, now, hubName } = input;
  if (hub.phase !== "connecting" && hub.phase !== "retrying") return undefined;
  if (restart?.t !== "down" || (!restart.planned && !going(run))) return undefined;
  const ms = now - restart.since;
  if (ms < SLOW_RESTART_MS) return undefined;
  if (ms >= LONG_RESTART_MS) return { text: `${hubName} hasn't come back after ${String(Math.round(LONG_RESTART_MS / 60_000))} minutes`, tone: "warning" };
  const what = restart.update || going(run) ? "update" : "restart";
  return { text: `${hubName} is taking a little longer to ${what}. What you send goes once it's back.`, tone: "quiet" };
};

/** When the bar's word next changes by itself (epoch ms), so a screen wakes for it; undefined when nothing will. */
export const nextChange = ({ hub, restart, run, now }: WordInput): number | undefined => {
  if (restart?.t === "updated") return restart.at + UPDATED_FOR_MS > now ? restart.at + UPDATED_FOR_MS : undefined;
  if (restart?.t !== "down" || hub.phase === "live" || (!restart.planned && !going(run))) return undefined;
  return [RESTART_HOLD_MS, SLOW_RESTART_MS, LONG_RESTART_MS].map((ms) => restart.since + ms).find((at) => at > now);
};

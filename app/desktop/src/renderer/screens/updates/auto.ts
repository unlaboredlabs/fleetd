// What automatic updates say beside their switch, on Hub › Updates and in the updates sheet: what they do, then one
// status line each for the last one that finished, what comes next and when, and why they hold back now.
// Pure, so every state is unit-tested.
import type { HubUpdateOutput, LastAutoUpdate, UpdateSettings } from "../../../shared/contracts";
import { versionLabel } from "../../../shared/updates";
import { clockAt } from "./model";

/** The hub's update settings and what automatic updates did and will do. */
export interface AutoState {
  readonly settings: UpdateSettings;
  /** When the build that is ready installs by itself. */
  readonly at: string | null;
  /** The ready build they skip, as it was put back. */
  readonly skips: string | null;
  /** The last automatic update that finished, and how it went; it survives a manual Update. */
  readonly last: LastAutoUpdate | null;
  readonly nextCheck: string | null;
  readonly skipReason: string | null;
}

/** The auto state in an answer; undefined when it has no settings (an older hub), so the last one stays. */
export const autoOf = (out: HubUpdateOutput): AutoState | undefined =>
  out.settings === undefined
    ? undefined
    : {
        settings: out.settings,
        at: out.autoAt ?? null,
        skips: out.autoSkips ?? null,
        last: out.lastAuto ?? null,
        nextCheck: out.nextCheck ?? null,
        skipReason: out.skipReason ?? null,
      };

/** What automatic updates do, beside the switch. */
export const autoWords = (drainMinutes: number): string => {
  const wait = drainMinutes === 0 ? "without waiting for agents" : `once agents finish their step (${String(drainMinutes)} minutes at most)`;
  return `New builds install by themselves as soon as they are ready, at most one update in 10 minutes, each machine ${wait}.`;
};

export type StatusTone = "default" | "quiet" | "success" | "warning" | "danger";

/** One row under the switch: a short label, then a state word in its colour, then the rest, quiet. */
export interface StatusLine {
  readonly key: "last" | "next" | "skip" | "off";
  /** Null for the one line saying it's off. */
  readonly label: string | null;
  readonly labelTone: StatusTone;
  readonly state: { readonly text: string; readonly tone: StatusTone } | null;
  readonly text: string;
}

/** The hub's sentence, ending as a sentence does. */
const sentence = (text: string): string => (/[.!?]$/u.test(text) ? text : `${text}.`);

const dayKey = (d: Date, timeZone?: string): string => d.toLocaleDateString("en-CA", timeZone === undefined ? {} : { timeZone });

/** "today at 14:05", "yesterday at 09:30", "Nov 3 at 22:10", in `timeZone` (the person's own when absent). */
export const whenAt = (iso: string, now: number, timeZone?: string): string => {
  const at = new Date(iso);
  const clock = clockAt(iso, timeZone);
  const day = dayKey(at, timeZone);
  if (day === dayKey(new Date(now), timeZone)) return `today at ${clock}`;
  if (day === dayKey(new Date(now - 86_400_000), timeZone)) return `yesterday at ${clock}`;
  const date = at.toLocaleDateString("en", { month: "short", day: "numeric", ...(timeZone === undefined ? {} : { timeZone }) });
  return `${date} at ${clock}`;
};

/** How the last automatic update ended, in a word or two and its colour; its own sentence says what didn't. */
const RESULT: Readonly<Record<string, { readonly text: string; readonly tone: StatusTone }>> = {
  done: { text: "Updated", tone: "success" },
  partial: { text: "Partly updated", tone: "warning" },
  failed: { text: "Failed", tone: "danger" },
};

const capital = (text: string): string => text.charAt(0).toUpperCase() + text.slice(1);
const row = (key: StatusLine["key"], label: string, text: string, labelTone: StatusTone = "quiet", state: StatusLine["state"] = null): StatusLine => ({
  key,
  label,
  labelTone,
  state,
  text: state === null ? capital(text) : text,
});

/**
 * The rows under the switch: the last automatic update and how it ended, what comes next and when, and why they hold
 * back now (a build they skip among them). Off, one line on what that means.
 */
export const autoStatus = (auto: AutoState, ready: string | null, now: number, timeZone?: string): StatusLine[] => {
  if (!auto.settings.auto)
    return [{ key: "off", label: null, labelTone: "quiet", state: null, text: "Off: the hub and its machines update only when someone presses Update." }];
  const lines: StatusLine[] = [];
  const { last } = auto;
  if (last === null) lines.push(row("last", "Last update", "none yet."));
  else {
    const to = last.to === undefined ? "" : `, to ${versionLabel(last.to)}`;
    const why = last.message === undefined || last.result === "done" ? "" : ` ${sentence(last.message)}`;
    const state = RESULT[last.result] ?? { text: capital(last.result), tone: "quiet" };
    lines.push(row("last", "Last update", `${whenAt(last.at, now, timeZone)}${to}.${why}`, "quiet", state));
  }
  // Held back or skipping the ready build: what comes next is the scheduler's next look, not that build.
  const held = auto.skipReason !== null || (auto.skips !== null && auto.skips === ready);
  if (auto.at !== null && ready !== null && !held) lines.push(row("next", "Next", `${versionLabel(ready)}, ${whenAt(auto.at, now, timeZone)}.`));
  else if (auto.nextCheck !== null) lines.push(row("next", "Next check", `${whenAt(auto.nextCheck, now, timeZone)}.`));
  if (auto.skipReason !== null) lines.push(row("skip", "Holding back", sentence(auto.skipReason), "warning"));
  else if (auto.skips !== null) {
    const why = "the hub didn't come up healthy on it and put it back. A newer build installs as usual; Update installs this one.";
    lines.push(row("skip", "Skips", `${versionLabel(auto.skips)}: ${why}`, "warning"));
  }
  return lines;
};

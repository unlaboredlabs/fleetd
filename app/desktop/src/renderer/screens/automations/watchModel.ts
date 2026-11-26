// The Automations tab's Watching group, kept pure: what each watcher watches in words, how often, its model and its
// last day's cost in one line, the presets the + still offers, and the hub input a new watcher saves as.
import type { Automation, AutomationCreateInput, AutomationWatch, KnownWatchEvery, KnownWatchKind, ProjectRef, WatchKind } from "../../../shared/contracts";

/** What each kind is called where a person picks it. */
export const KIND_LABEL: Readonly<Record<KnownWatchKind, string>> = { main_ci: "Main's CI", deploys: "Deploys", other: "Something else", checkin: "Daily check-in" };

export const EVERY_OPTIONS: ReadonlyArray<{ value: KnownWatchEvery; label: string }> = [
  { value: "15m", label: "15 min" },
  { value: "hour", label: "Hourly" },
  { value: "day", label: "Daily" },
];

const EVERY_WORD: Readonly<Record<KnownWatchEvery, string>> = { "15m": "Every 15 min", hour: "Hourly", day: "Daily at 09:00" };

/** The longest sentence a "Something else" watcher takes. */
export const SENTENCE_MAX = 300;

/** The daily check-in: a watcher of its own kind, shown as the bot's one switch rather than in Watching. */
export const isCheckIn = (a: Automation): boolean => a.watch?.kind === "checkin";

export const isWatcher = (a: Automation): boolean => a.watch !== undefined && !isCheckIn(a);

export const CHECKIN_TITLE = "Daily check-in";

export const CHECKIN_ABOUT =
  "Once a day at 09:00 your time, the lead offers to pick up stalled work, approvals waiting on you and follow-ups it promised. It starts nothing until you say yes, and on a quiet day it says nothing.";

/** The check-in as the hub makes it when it is switched on: daily, in the zone of whoever switched it on. */
export function checkInInput(projectRef: ProjectRef, tz: string, clientRequestId: string): AutomationCreateInput {
  return { projectRef, name: CHECKIN_TITLE, prompt: CHECKIN_TITLE, schedule: { tz }, watch: { kind: "checkin", every: "day" }, clientRequestId };
}

/** How its last check-in went, in words; undefined before the first. */
export function checkInLast(a: Automation): string | undefined {
  const r = a.lastRun;
  if (r === undefined) return undefined;
  if (r.state === "running") return "Checking in now";
  if (r.state === "failed") return "Last check-in didn't finish";
  if (r.state === "skipped") return "Last check-in skipped";
  return r.said !== undefined ? "Last check-in offered help" : "Last check-in: nothing to offer";
}

export const kindLabel = (k: WatchKind): string => (KIND_LABEL as Record<string, string>)[k] ?? k;

export const everyWord = (e: string): string => (EVERY_WORD as Record<string, string>)[e] ?? e;

/** "$0.42", "$0.0042": a cost as small as one look's. */
export function dollars(usd: number): string {
  if (usd === 0) return "$0";
  return usd >= 0.1 ? `$${usd.toFixed(2)}` : `$${usd.toFixed(4)}`;
}

/** Its last day's cost: "$0.42 in 24 h", or that it hasn't looked yet. */
export function usageWord(a: Automation): string {
  const day = a.lastDay;
  if (day === undefined || day.runs === 0) return a.lastRun === undefined ? "Not looked yet" : "$0 in 24 h";
  return `${dollars(day.costUsd)} in 24 h`;
}

/** The row's line: how often, which profile, what its last day cost. */
export function watchLine(a: Automation, defaultProfile: string | undefined): string {
  const w = a.watch;
  if (!w) return "";
  return [everyWord(w.every), w.profile ?? defaultProfile ?? "Default profile", usageWord(a)].join(" · ");
}

/** The kinds the + offers: what the hub says the bot can watch, less the presets it already has (one of each). */
export function offered(watchable: readonly WatchKind[] | undefined, have: readonly Automation[]): KnownWatchKind[] {
  const can = (watchable ?? ["other"]) as string[];
  const taken = new Set(have.map((a) => a.watch?.kind));
  return (["main_ci", "deploys", "other"] as const).filter((k) => can.includes(k) && (k === "other" || !taken.has(k)));
}

/** A new watcher as the hub takes it: a preset by its name, Something else by its sentence. */
export function watcherInput(
  w: AutomationWatch,
  sentence: string,
  projectRef: ProjectRef,
  tz: string,
  clientRequestId: string,
): AutomationCreateInput {
  const said = sentence.split(/\s+/u).filter(Boolean).join(" ");
  const name = w.kind === "other" ? (Array.from(said).length > 80 ? `${Array.from(said).slice(0, 79).join("")}…` : said) : kindLabel(w.kind);
  return { projectRef, name, prompt: w.kind === "other" ? said : name, schedule: { tz }, watch: w, clientRequestId };
}

/** What the hub would refuse in a new watcher, said before the save. */
export function sentenceProblem(kind: WatchKind, sentence: string): string | undefined {
  if (kind !== "other") return undefined;
  const said = sentence.trim();
  if (said === "") return "Say in one sentence what to watch.";
  if (Array.from(said).length > SENTENCE_MAX) return `At most ${String(SENTENCE_MAX)} characters.`;
  return undefined;
}

// Cloud machines on boat.dev (D306), apart from React: the boat.dev group in Settings › Hub › Machines, each machine's
// line, the cost a pool can reach before it is turned on, and the cloud line. The hub's pool (cloud_get) is the only
// source; nothing here is estimated but the typical day, which says so.
import type { CloudMachine, CloudMachineState, CloudView, Machine } from "../../../shared/contracts";

/** Each state in a word, as the list shows it. */
const STATE_WORDS: Readonly<Record<string, string>> = {
  creating: "Setting up",
  waking: "Waking",
  awake: "Awake",
  stopping: "Going to sleep",
  asleep: "Asleep",
  broken: "Broken",
  failed: "Not made",
  gone: "Gone",
};

export const stateWord = (state: CloudMachineState): string => STATE_WORDS[state] ?? state;

export type CloudTone = "success" | "quiet" | "default" | "warning" | "danger";

/** Awake reads as running, asleep as calm (not "offline"), broken and failed as wanting a fix. */
export const stateTone = (state: CloudMachineState): CloudTone => {
  switch (state) {
    case "awake":
      return "success";
    case "asleep":
      return "quiet";
    case "broken":
    case "failed":
      return "danger";
    case "gone":
      return "warning";
    default:
      return "default";
  }
};

/** The states Reset is for: a machine that won't come back, or never came. Never one that is up. */
export const resettable = (state: CloudMachineState): boolean => state === "broken" || state === "failed" || state === "gone";

export const awakeCount = (cloud: CloudView): number => cloud.machines.filter((m) => m.state === "awake" || m.state === "waking").length;

/** The cloud machines' ids, which the list of the person's own machines leaves out. */
export const cloudIds = (cloud: CloudView | undefined): ReadonlySet<string> => new Set(cloud?.machines.map((m) => m.machineId) ?? []);

/** The person's own machines: every machine the hub knows but its cloud ones (marked so, or in the pool). */
export const ownMachines = <M extends Pick<Machine, "machineId" | "cloud">>(machines: ReadonlyArray<M>, cloud: CloudView | undefined): M[] => {
  const ids = cloudIds(cloud);
  return machines.filter((m) => m.cloud !== true && !ids.has(m.machineId));
};

/** Dollars, to the cent. */
export const money = (dollars: number): string => `$${(Number.isFinite(dollars) ? Math.max(0, dollars) : 0).toFixed(2)}`;

/** An hourly price, to the tenth of a cent: boat.dev's are $0.018 to $0.200. */
export const rate = (dollars: number): string => `$${(Number.isFinite(dollars) ? Math.max(0, dollars) : 0).toFixed(3)}`;

const plural = (n: number, one: string, many = `${one}s`): string => `${String(n)} ${n === 1 ? one : many}`;

/** `14:02` today, else `Nov 3`: when a machine went to sleep, began setting up, or was refused. */
const since = (ms: number, nowMs: number): string => {
  const at = new Date(ms);
  const now = new Date(nowMs);
  const sameDay = at.toDateString() === now.toDateString();
  return sameDay
    ? at.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", hour12: false })
    : at.toLocaleDateString(undefined, { month: "short", day: "numeric" });
};

/** One machine's line under its name: what runs there, or how long it has slept, then its spend today; a broken one says why. */
export const machineLine = (m: CloudMachine, nowMs: number): string => {
  const spend = `${money(m.today)} today`;
  switch (m.state) {
    case "awake": {
      const work = m.agents === 0 && m.screens === 0 ? "Idle, sleeps after 15 minutes" : [m.agents > 0 ? `${plural(m.agents, "agent")} running` : "", m.screens > 0 ? plural(m.screens, "screen") : ""].filter(Boolean).join(" · ");
      return `${work} · ${spend}`;
    }
    case "asleep":
      return m.sinceMs === undefined ? `Costs nothing asleep · ${spend}` : `Asleep since ${since(m.sinceMs, nowMs)}, costs nothing · ${spend}`;
    case "waking":
      return `Waking for work · ${spend}`;
    case "creating":
      return m.sinceMs === undefined ? "Setting up: it joins in a few minutes, then sleeps" : `Setting up since ${since(m.sinceMs, nowMs)}: it joins in a few minutes, then sleeps`;
    case "stopping":
      return `Going to sleep · ${spend}`;
    case "broken":
      return `It didn't come back from two wakes, so the hub won't wake it again. Reset deletes it and makes it anew.`;
    case "failed":
      if (m.note === undefined) return "Not made. Create cloud machines tries again.";
      return m.sinceMs === undefined ? `Not made: ${m.note}` : `Not made (${since(m.sinceMs, nowMs)}): ${m.note}`;
    case "gone":
      return "boat.dev no longer has it. Create cloud machines makes it again.";
    default:
      return spend;
  }
};

/** The cloud line: "Cloud today: $0.41 of $3.00 · 2 awake". Null while the hub has no cloud machines set up. */
export const cloudStatusLine = (cloud: CloudView | undefined): string | null => {
  if (cloud === undefined || !cloud.hasKey || (cloud.machines.length === 0 && !cloud.enabled)) return null;
  const head = `Cloud today: ${money(cloud.today)} of ${money(cloud.dayBudget)}`;
  if (!cloud.enabled) return `${head} · off`;
  return `${head} · ${String(awakeCount(cloud))} awake`;
};

/** Why bursting waits, for the cloud line's second half and the panel: the hub's own line, with its first letter up. */
export const heldLine = (cloud: CloudView): string | null => {
  const why = cloud.paused ?? (cloud.enabled ? cloud.held : undefined);
  if (why === undefined || why === "") return null;
  return why.charAt(0).toUpperCase() + why.slice(1);
};

/** A size's price an hour; an unknown size counts as the dearest the hub listed. */
export const perHour = (cloud: Pick<CloudView, "sizes">, kind: string): number =>
  cloud.sizes.find((s) => s.kind === kind)?.perHour ?? Math.max(0, ...cloud.sizes.map((s) => s.perHour));

/** The most `n` machines of `kind` cost a day: all awake around the clock. */
export const ceiling = (cloud: Pick<CloudView, "sizes">, n: number, kind: string): number => n * perHour(cloud, kind) * 24;

/**
 * Machine-hours on a typical busy day with overflow to cloud (design §5.2 and review S12): the peaks of about 40 agent
 * runs, packed, with each wake's 15-minute tail. Not measured on this hub.
 */
export const TYPICAL_HOURS: readonly [number, number] = [5.5, 10];

export interface CostPreview {
  readonly perHour: string;
  /** "At most $5.18 a day, if all 3 stayed awake around the clock." */
  readonly ceiling: string;
  /** "The day budget stops them at $3.00." or null when the ceiling is under it. */
  readonly stops: string | null;
  /** "A typical busy day: 5.5–10 machine-hours, about $0.40–$0.72." */
  readonly typical: string;
  /** "Up to $20.00 a month: your plan's included dollars." */
  readonly month: string;
}

/** What turning the pool on can cost, shown before it is turned on. */
export const costPreview = (
  cloud: Pick<CloudView, "sizes" | "planDollars">,
  p: { readonly poolSize: number; readonly machineType: string; readonly dayBudget: number; readonly monthBudget: number | undefined },
): CostPreview => {
  const price = perHour(cloud, p.machineType);
  const top = ceiling(cloud, p.poolSize, p.machineType);
  const hours = TYPICAL_HOURS.map((h) => Math.min(h, p.poolSize * 24));
  const [low = 0, high = 0] = hours.map((h) => h * price);
  const plan = cloud.planDollars ?? 20;
  return {
    perHour: `${rate(price)} an hour a machine (${p.machineType})`,
    ceiling: `At most ${money(top)} a day, if ${p.poolSize === 1 ? "it" : `all ${String(p.poolSize)}`} stayed awake around the clock.`,
    stops: top > p.dayBudget ? `The day budget stops ${p.poolSize === 1 ? "it" : "them"} at ${money(p.dayBudget)}.` : null,
    typical: `A typical busy day: ${String(hours[0])}–${String(hours[1])} machine-hours, about ${money(low)}–${money(high)}.`,
    month: p.monthBudget === undefined ? `Up to ${money(plan)} a month: your plan's included dollars.` : `Up to ${money(p.monthBudget)} a month.`,
  };
};

/** Dollars as typed ("3", "$2.50"): a number above 0, or null. */
export const parseDollars = (text: string): number | null => {
  const t = text.trim().replace(/^\$/u, "");
  if (!/^\d+(\.\d{1,2})?$/u.test(t)) return null;
  const n = Number(t);
  return n > 0 ? n : null;
};

/** The confirm before the kill switch: it names the machines awake now, or says none is. */
export const stopAllLine = (cloud: CloudView): string => {
  const up = cloud.machines.filter((m) => m.state === "awake" || m.state === "waking" || m.state === "creating").map((m) => m.machineId);
  const names = up.length === 0 ? "None is awake now." : `${up.join(", ")} ${up.length === 1 ? "is" : "are"} awake now and stop${up.length === 1 ? "s" : ""}, with any agent running there; it picks up at the next wake.`;
  return `${names} The hub also asks boat.dev for every machine with this hub's label and stops each one. No work goes to cloud machines until you turn them on again.`;
};

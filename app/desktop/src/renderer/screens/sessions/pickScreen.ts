// What the New screen picker shows, as plain view data (D239): the kinds of screen a person can open, the machines
// that can host each (from machine_roles: the sessions role, the kind ready there, and a node that hosts screens the hub
// places), and each machine's slots in words, full ones offering to wait. A project's browser runs only on the project's
// own machine, where it keeps its sign-ins. An Android screen can take an open PR's CI build, installed before the
// person gets it. Apple's kinds are the agents' Mac's (D298), the only machine that offers them: its own screen, and an
// iPhone simulator of the person's own (D652), whose model and OS come from the simulators the Mac reports and whose
// slots are the Mac's simulator budget, people's ahead of agents' (D239). A kind no machine can host says why, from what the
// machines' nodes report, and what fixes it: an admin's button to the place that does, else who to ask. There is no
// switch per kind (D574) to turn on. Pure, so it is unit-tested. The phone app runs it
// too, on Hermes, which has no Array toSorted: each list here sorts its own fresh copy instead.
import type { BrowserSession, MachineRolesEntry, PrRow, SimModel } from "../../../shared/contracts";

export type ScreenKind = "browser" | "ios" | "android" | "linux_desktop" | "mac";

/** Each kind's name and, under it, one short line: the tiles read at a glance, so it fits on one line. */
export const KINDS: readonly { readonly kind: ScreenKind; readonly label: string; readonly line: string }[] = [
  { kind: "browser", label: "Browser", line: "Saved sign-ins" },
  { kind: "ios", label: "iPhone", line: "Simulator" },
  { kind: "android", label: "Android", line: "Emulator" },
  { kind: "linux_desktop", label: "Linux desktop", line: "With a terminal" },
  { kind: "mac", label: "Agents’ Mac", line: "One at a time" },
];

/**
 * Whether the bot's kept profile, its sign-ins, is taken: its lead's browser or a person's screen (neither has a task)
 * is live on the bot's own machine. One browser at a time runs on it, so the next opens on a fresh one, signed out.
 */
export const profileBusy = (sessions: readonly BrowserSession[], home: string): boolean =>
  sessions.some((x) => x.state === "live" && x.taskId === undefined && (x.kind ?? "browser") === "browser" && (x.machineId ?? x.projectRef.machineId) === home);

/** A kind's line on its tile: the browser's says which profile it opens on. */
export const kindLine = (kind: (typeof KINDS)[number], busy: boolean): string => (kind.kind === "browser" && busy ? "Fresh profile" : kind.line);

/** A kind's word in machine_roles' host checks. */
const HOST: Readonly<Record<ScreenKind, string>> = { browser: "browser", ios: "ios", android: "android", linux_desktop: "desktop", mac: "mac" };

/** Apple's kinds: only the agents' Mac offers them. */
const APPLE: ReadonlySet<ScreenKind> = new Set(["mac", "ios"]);

/** A machine as the picker lists it. */
interface HostChoice {
  readonly machineId: string;
  readonly name: string;
  /** Screens live there now, of how many it hosts. */
  readonly live: number;
  readonly max: number;
  readonly online: boolean;
  /** Every slot is taken: opening there waits for the next. */
  readonly full: boolean;
}

/** The agents' Mac offers only Apple's kinds, whatever an older hub or node of it says it has ready; an iPhone is only its. */
const offers = (m: Pick<MachineRolesEntry, "mac">, kind: ScreenKind): boolean => (kind === "ios" ? m.mac !== undefined : kind === "mac" || m.mac === undefined);

const ready = (m: MachineRolesEntry, kind: ScreenKind): boolean =>
  offers(m, kind) && m.roles.includes("sessions") && m.hostsOthers && (m.hosts ?? []).some((h) => h.host === HOST[kind] && h.ready);

/**
 * The machines that can host a screen of `kind`, online ones first, then by name. A project's browser (`home` its
 * machine) is only its own machine's, where its sign-ins are.
 */
export const hostsFor = (machines: readonly MachineRolesEntry[], kind: ScreenKind, home?: string): HostChoice[] =>
  machines
    .filter((m) => ready(m, kind) && onHome(m, kind, home))
    .map((m) => {
      // An iPhone's slots are the Mac's simulator budget, not its screens'.
      const sims = kind === "ios" ? simsOn(m) : undefined;
      const live = sims?.live ?? m.sessionsLive;
      const max = sims?.max ?? m.maxSessions;
      return { machineId: m.machineId, name: m.name, live, max, online: m.online, full: live >= max };
    })
    .sort((a, b) => Number(b.online) - Number(a.online) || a.name.localeCompare(b.name));

/** Whether any machine can host `kind`: a kind none can is shown, and says why ([`whyOff`]). */
export const canOpen = (machines: readonly MachineRolesEntry[], kind: ScreenKind, home?: string): boolean => hostsFor(machines, kind, home).length > 0;

/** A browser keeps its project's sign-ins on the project's machine, so it opens only there; other kinds go anywhere. */
const onHome = (m: Pick<MachineRolesEntry, "machineId">, kind: ScreenKind, home: string | undefined): boolean => home === undefined || kind !== "browser" || m.machineId === home;

/** What fixes a kind no machine can host: a newer fleetd, a machine let host screens, a machine of the kind it needs,
 * or nothing anyone here can do (offline, installing). */
export type OffFix = "update" | "roles" | "add" | "none";

export interface OffReason {
  /** Why, in plain words. */
  readonly why: string;
  /** The same in a word or two, under the kind's name. */
  readonly short: string;
  readonly fix: OffFix;
  /** The machine the fix is for, when it is one machine's. */
  readonly machine?: { readonly machineId: string; readonly name: string };
}

/** A kind as the sentences say it. */
const PLURAL: Readonly<Record<ScreenKind, string>> = {
  browser: "Browser screens",
  ios: "iPhone simulators",
  android: "Android emulators",
  linux_desktop: "Linux desktops",
  mac: "Agents’ Mac screens",
};

/** The same inside a sentence. */
const LOWER: Readonly<Record<ScreenKind, string>> = { ...PLURAL, browser: "browser screens" };

/** What a kind needs, where no machine can run it at all. */
const NEEDS: Readonly<Record<ScreenKind, string>> = {
  browser: "Browser screens need a machine that hosts screens.",
  ios: "iPhone simulators need a Mac joined as the agents’ Mac.",
  android: "Android emulators need a Linux x86_64 machine with KVM, and none here hosts screens.",
  linux_desktop: "Linux desktops need a Linux machine, and none here hosts screens.",
  mac: "The agents’ Mac screen needs a Mac joined as the agents’ Mac.",
};

/** One machine's reason, ranked: the one that fixes it soonest first. */
const machineOff = (m: MachineRolesEntry, kind: ScreenKind): (OffReason & { readonly rank: number }) | null => {
  const machine = { machineId: m.machineId, name: m.name };
  const noun = PLURAL[kind];
  const old = `${m.name}’s fleetd is too old to host screens from here.`;
  if (!m.online) return { rank: 6, why: `${m.name} is offline.`, short: "Offline", fix: "none", machine };
  const check = (m.hosts ?? []).find((h) => h.host === HOST[kind]);
  if (check === undefined) return { rank: 5, why: old, short: "Needs an update", fix: "update", machine };
  if (check.ready) {
    if (m.hostsOthers) return null;
    return { rank: 4, why: m.hostsOthersNote ?? old, short: "Needs an update", fix: "update", machine };
  }
  switch (check.off) {
    case "off":
      // An older node's node.json turned them off: its update turns them on.
      return { rank: 1, why: `${noun} are off on ${m.name} until its fleetd is updated.`, short: "Needs an update", fix: "update", machine };
    case "installing":
      return { rank: 2, why: `${m.name} is installing what ${LOWER[kind]} need.`, short: "Installing", fix: "none", machine };
    case "unsupported":
      return { rank: 7, why: NEEDS[kind], short: APPLE.has(kind) ? "Needs a Mac" : "No machine for it", fix: "add" };
    default:
      // Missing, failed, or a node before reasons: its own words.
      return { rank: 3, why: `${m.name}: ${sentence(check.detail)}`, short: check.off === "failed" ? "Setup failed" : "Not set up", fix: "none", machine };
  }
};

const sentence = (s: string): string => {
  const t = s.trim();
  return /[.!?]$/u.test(t) ? t : `${t}.`;
};

/**
 * Why no machine can host `kind`, from what each machine's node reports, and what fixes it; null where one can. The
 * machine whose fix is nearest speaks: an update before an install, before an offline machine, before a
 * machine that can never run it. For a project's browser (`home` its machine), only its own machine.
 */
export const whyOff = (machines: readonly MachineRolesEntry[], kind: ScreenKind, home?: string): OffReason | null => {
  if (canOpen(machines, kind, home)) return null;
  const joined = machines.filter((m) => onHome(m, kind, home));
  if (joined.length === 0) return { why: "No machine has joined this hub yet.", short: "No machine", fix: "add" };
  const mine = joined.filter((m) => offers(m, kind));
  if (mine.length === 0) return { why: NEEDS[kind], short: APPLE.has(kind) ? "Needs a Mac" : "No machine for it", fix: "add" };
  const hosting = mine.filter((m) => m.roles.includes("sessions"));
  if (hosting.length === 0) {
    return mine.length === 1 && mine[0] !== undefined
      ? { why: `${mine[0].name} doesn’t host screens: its role is agents only.`, short: "No screens host", fix: "roles", machine: { machineId: mine[0].machineId, name: mine[0].name } }
      : { why: "No machine hosts screens: each one’s role is agents only.", short: "No screens host", fix: "roles" };
  }
  const best = hosting
    .map((m) => machineOff(m, kind))
    .filter((r): r is OffReason & { readonly rank: number } => r !== null)
    .sort((a, b) => a.rank - b.rank || (a.machine?.name ?? "").localeCompare(b.machine?.name ?? ""))[0];
  if (best === undefined) return { why: `No machine can host ${LOWER[kind]} yet.`, short: "Can’t open", fix: "none" };
  const { rank: _rank, ...reason } = best;
  return reason;
};

/** The idle timeout of `kind` on the machine, as its node reports it; undefined from a node before it. */
export const idleFor = (machines: readonly MachineRolesEntry[], machineId: string | undefined, kind: ScreenKind): number | undefined =>
  machines.find((m) => m.machineId === machineId)?.hosts?.find((h) => h.host === HOST[kind])?.idleMinutes;

/** When a person's screen ends without them, in words: the machine's own idle timeout, or no number where it's unknown. */
export const idleWords = (minutes: number | undefined): string =>
  minutes === undefined ? "once it sits idle" : `after ${String(minutes)} ${minutes === 1 ? "minute" : "minutes"} idle`;

/** The hub's admins, for a member's "who to ask": its owners' and admins' names. */
export const adminNames = (people: readonly { readonly name: string; readonly role: string; readonly removedAt?: string | undefined }[]): string[] =>
  people.filter((p) => (p.role === "owner" || p.role === "admin") && p.removedAt === undefined).map((p) => p.name);

/** Who a member asks, by name: up to two of the hub's admins, else "a hub admin". */
export const adminWho = (admins: readonly string[]): string => {
  if (admins.length === 0) return "a hub admin";
  if (admins.length === 1) return admins[0] ?? "a hub admin";
  if (admins.length === 2) return `${admins[0] ?? ""} or ${admins[1] ?? ""}`;
  return `${admins.slice(0, 2).join(", ")} or another admin`;
};

/** The machine a kind no machine here can run needs. */
const ADD: Readonly<Record<ScreenKind, string>> = {
  browser: "a machine",
  ios: "a Mac set aside for agents",
  android: "a Linux machine",
  linux_desktop: "a Linux machine",
  mac: "a Mac set aside for agents",
};

/** A member's one action: who to ask, and for what; null where asking wouldn't help (offline, installing). */
export const askLine = (reason: OffReason, kind: ScreenKind, admins: readonly string[]): string | null => {
  const ask = `Ask ${adminWho(admins)}`;
  const on = reason.machine === undefined ? "" : ` on ${reason.machine.name}`;
  switch (reason.fix) {
    case "update":
      return `${ask} to update fleetd${on}.`;
    case "roles":
      return `${ask} to let a machine host screens.`;
    case "add":
      return `${ask} to add ${ADD[kind]}.`;
    case "none":
      return null;
  }
};

/** An admin's one action's label; null where there is nothing to press. */
export const fixLabel = (fix: OffFix): string | null => {
  switch (fix) {
    case "update":
      return "Open updates";
    case "roles":
      return "Open Machines";
    case "add":
      return "Add machine";
    case "none":
      return null;
  }
};

/** Where an admin's action goes: Settings › Hub › Machines › Updates for an update, else the option it reveals
 * on Settings › Hub › Machines (a role, on the machine's own page when the reason names one). */
export const fixPlace = (fix: OffFix): { readonly tab: "hub.machines" | "hub.updates"; readonly reveal: string | null } =>
  fix === "update"
    ? { tab: "hub.updates", reveal: null }
    : { tab: "hub.machines", reveal: fix === "roles" ? "hub.roles" : fix === "add" ? "hub.add-machine" : null };

/** The machine the picker starts on: the one picked, while it still can; else the first online one with a free slot. */
export const pickHost = (hosts: readonly HostChoice[], picked: string | null): HostChoice | undefined =>
  hosts.find((h) => h.machineId === picked && h.online) ?? hosts.find((h) => h.online && !h.full) ?? hosts.find((h) => h.online);

/** A machine's slots in words, under its name: the same few words for every kind (Open says a full one waits). */
export const slotLine = (h: HostChoice): string => {
  if (!h.online) return "Offline";
  const used = `${String(h.live)} of ${String(h.max)} in use`;
  return h.full ? `Full · ${used}` : used;
};

/** What the picker's button says for the machine picked. */
export const openWord = (h: HostChoice | undefined): string => (h?.full === true ? "Wait for a slot" : "Open screen");

/** Whether a PR's build can go into a screen of `kind`: an Android emulator's. */
export const takesBuild = (kind: ScreenKind): boolean => kind === "android";

/** A PR the picker offers, its build to install. */
export interface PrChoice {
  /** `owner/name#number`: the picker's value for it. */
  readonly value: string;
  readonly label: string;
  readonly repo: string;
  readonly number: number;
}

/** The PR picked when none is. */
export const NO_PR = "none";

/** The project's open PRs, as pr_list lists them (open first, most recently updated first). */
export const prChoices = (rows: readonly PrRow[]): PrChoice[] =>
  rows
    .filter((r) => r.state === "open" || r.state === "draft")
    .map((r) => ({ value: `${r.repo}#${String(r.number)}`, label: `#${String(r.number)} ${r.title}`, repo: r.repo, number: r.number }));

/** Where an open with a PR's build is, in words, while the picker follows it. */
export const openingLine = (stage: string | undefined, pr: number, machine: string): string => {
  switch (stage) {
    case "installing":
      return `Installing #${String(pr)}’s build on ${machine}…`;
    case "failed":
      return "It didn’t open.";
    case undefined:
      return "Handing it to you…";
    default:
      return `Reading #${String(pr)}’s build and starting the screen on ${machine}…`;
  }
};

/** What the picker says while an open is slow (past its first second or so): what is starting. */
export const startingLine = (kind: ScreenKind): string => {
  switch (kind) {
    case "ios":
      return "Starting the simulator…";
    case "android":
      return "Starting the emulator…";
    case "linux_desktop":
      return "Starting the desktop…";
    case "mac":
      return "Opening the Mac’s screen…";
    default:
      return "Starting the browser…";
  }
};

/**
 * The screen an open made, when the hub answered without it: the newest live one a person opened, of `kind`, that the
 * list didn't have when they pressed Open (`known`).
 */
export const newScreenOf = (sessions: readonly BrowserSession[], kind: ScreenKind, known: ReadonlySet<string>): BrowserSession | undefined =>
  sessions.find((x) => x.state === "live" && x.openedBy !== undefined && (x.kind ?? "browser") === kind && !known.has(x.sessionId));

/** The simulators the Mac reports, with its budget; absent on any other machine, and from a node before them. */
const simsOn = (m: MachineRolesEntry) => (m.hosts ?? []).find((h) => h.host === "ios")?.sims;

/** The iPhone models the machine offers, iPhones first, then foldables, then iPads, each family in the Mac's order. */
export const simModels = (machines: readonly MachineRolesEntry[], machineId: string | undefined): SimModel[] => {
  const m = machines.find((x) => x.machineId === machineId);
  const models = m === undefined ? [] : [...(simsOn(m)?.models ?? [])];
  const rank = (x: SimModel) => FAMILY.indexOf(x.family) + 1 || FAMILY.length + 1;
  return models.map((x, i) => ({ x, i })).sort((a, b) => rank(a.x) - rank(b.x) || a.i - b.i).map(({ x }) => x);
};

const FAMILY: readonly string[] = ["iphone", "foldable", "ipad"];

/** The model the picker starts on: the one picked, while the machine still has it; else its first. */
export const pickModel = (models: readonly SimModel[], picked: string | null): SimModel | undefined => models.find((x) => x.id === picked) ?? models[0];

/** The OS the picker starts on: the one picked, while the model still runs it; else the model's newest (its first). */
export const pickRuntime = (model: SimModel | undefined, picked: string | null): SimModel["runtimes"][number] | undefined =>
  model?.runtimes.find((r) => r.id === picked) ?? model?.runtimes[0];

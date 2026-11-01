// What the New screen picker shows, as plain view data (D239): the four kinds of screen a person can open, the machines
// that can host each (from machine_roles: the sessions role, the kind ready there, and a node that hosts screens the hub
// places), and each machine's slots in words, full ones offering to wait. A Navi's browser runs only on the Navi's own
// machine, where it keeps its sign-ins. An iOS or Android screen can take an open PR's CI build, installed before the
// person gets it. A kind no machine can host says why, from what the machines' nodes report, and what fixes it: an
// admin's Turn on where it is only switched off, else who to ask. Pure, so it is unit-tested.
import type { BrowserSession, MachineRolesEntry, PrRow } from "../../../shared/contracts";

export type ScreenKind = "browser" | "ios" | "android" | "linux_desktop";

export const KINDS: readonly { readonly kind: ScreenKind; readonly label: string; readonly line: string }[] = [
  { kind: "browser", label: "Browser", line: "A fresh Chrome" },
  { kind: "ios", label: "iOS", line: "An iPhone simulator" },
  { kind: "android", label: "Android", line: "An Android emulator" },
  { kind: "linux_desktop", label: "Linux desktop", line: "A desktop with a terminal" },
];

/** A kind's word in machine_roles' host checks. */
const HOST: Readonly<Record<ScreenKind, string>> = { browser: "browser", ios: "ios", android: "android", linux_desktop: "desktop" };

/** A machine as the picker lists it. */
export interface HostChoice {
  readonly machineId: string;
  readonly name: string;
  /** Screens live there now, of how many it hosts. */
  readonly live: number;
  readonly max: number;
  readonly online: boolean;
  /** Every slot is taken: opening there waits for the next. */
  readonly full: boolean;
}

const ready = (m: MachineRolesEntry, kind: ScreenKind): boolean =>
  m.roles.includes("sessions") && m.hostsOthers && (m.hosts ?? []).some((h) => h.host === HOST[kind] && h.ready);

/**
 * The machines that can host a screen of `kind`, online ones first, then by name. For a Navi (`navi` its machine) a
 * browser is only its own machine's.
 */
export const hostsFor = (machines: readonly MachineRolesEntry[], kind: ScreenKind, navi?: string): HostChoice[] =>
  machines
    .filter((m) => ready(m, kind) && (navi === undefined || kind !== "browser" || m.machineId === navi))
    .map((m) => ({ machineId: m.machineId, name: m.name, live: m.sessionsLive, max: m.maxSessions, online: m.online, full: m.sessionsLive >= m.maxSessions }))
    .toSorted((a, b) => Number(b.online) - Number(a.online) || a.name.localeCompare(b.name));

/** Whether any machine can host `kind`: a kind none can is shown, and says why ([`whyOff`]). */
export const canOpen = (machines: readonly MachineRolesEntry[], kind: ScreenKind, navi?: string): boolean => hostsFor(machines, kind, navi).length > 0;

/** What fixes a kind no machine can host: a switch an admin turns on (`turn_on`, on `machine`), a newer fleetd, a
 * machine let host screens, a machine of the kind it needs, or nothing anyone here can do (offline, installing). */
export type OffFix = "turn_on" | "update" | "roles" | "add" | "none";

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
  ios: "iOS simulators",
  android: "Android emulators",
  linux_desktop: "Linux desktops",
};

/** The same inside a sentence. */
const LOWER: Readonly<Record<ScreenKind, string>> = { ...PLURAL, browser: "browser screens" };

/** What a kind needs, where no machine can run it at all. */
const NEEDS: Readonly<Record<ScreenKind, string>> = {
  browser: "Browser screens need a machine that hosts screens.",
  ios: "iOS simulators need a Mac with Xcode, and no Mac here hosts screens.",
  android: "Android emulators need a Linux x86_64 machine with KVM, and none here hosts screens.",
  linux_desktop: "Linux desktops need a Linux machine, and none here hosts screens.",
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
      return m.screenSettings === true
        ? { rank: 0, why: `${noun} are turned off on ${m.name}.`, short: "Turned off", fix: "turn_on", machine }
        : { rank: 1, why: `${noun} are turned off on ${m.name}, and its fleetd is too old to turn them on from here.`, short: "Turned off", fix: "update", machine };
    case "restarting":
      return { rank: 2, why: `${noun} are turned on on ${m.name}: they start once its node restarts, when the screens live there end.`, short: "Starting up", fix: "none", machine };
    case "installing":
      return { rank: 2, why: `${m.name} is installing what ${LOWER[kind]} need.`, short: "Installing", fix: "none", machine };
    case "unsupported":
      return { rank: 7, why: NEEDS[kind], short: kind === "ios" ? "Needs a Mac" : "No machine for it", fix: "add" };
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
 * machine whose fix is nearest speaks: a switch turned off before an install, before an offline machine, before a
 * machine that can never run it. For a Navi's browser (`navi` its machine), only its own machine.
 */
export const whyOff = (machines: readonly MachineRolesEntry[], kind: ScreenKind, navi?: string): OffReason | null => {
  if (canOpen(machines, kind, navi)) return null;
  const mine = machines.filter((m) => navi === undefined || kind !== "browser" || m.machineId === navi);
  if (mine.length === 0) return { why: "No machine has joined this hub yet.", short: "No machine", fix: "add" };
  const hosting = mine.filter((m) => m.roles.includes("sessions"));
  if (hosting.length === 0) {
    return mine.length === 1 && mine[0] !== undefined
      ? { why: `${mine[0].name} doesn’t host screens: its role is agents only.`, short: "No screens host", fix: "roles", machine: { machineId: mine[0].machineId, name: mine[0].name } }
      : { why: "No machine hosts screens: each one’s role is agents only.", short: "No screens host", fix: "roles" };
  }
  const best = hosting
    .map((m) => machineOff(m, kind))
    .filter((r): r is OffReason & { readonly rank: number } => r !== null)
    .toSorted((a, b) => a.rank - b.rank || (a.machine?.name ?? "").localeCompare(b.machine?.name ?? ""))[0];
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

const who = (admins: readonly string[]): string => {
  if (admins.length === 0) return "a hub admin";
  if (admins.length === 1) return admins[0] ?? "a hub admin";
  if (admins.length === 2) return `${admins[0] ?? ""} or ${admins[1] ?? ""}`;
  return `${admins.slice(0, 2).join(", ")} or another admin`;
};

/** A member's one action: who to ask, and for what; null where asking wouldn't help (offline, installing). */
export const askLine = (reason: OffReason, kind: ScreenKind, admins: readonly string[]): string | null => {
  const ask = `Ask ${who(admins)}`;
  const on = reason.machine === undefined ? "" : ` on ${reason.machine.name}`;
  switch (reason.fix) {
    case "turn_on":
      return `${ask} to turn them on in Settings › Hub › Machines › Screens.`;
    case "update":
      return `${ask} to update fleetd${on}.`;
    case "roles":
      return `${ask} to let a machine host screens.`;
    case "add":
      return `${ask} to add ${kind === "ios" ? "a Mac" : kind === "browser" ? "a machine" : "a Linux machine"}.`;
    case "none":
      return null;
  }
};

/** An admin's one action's label; null where there is nothing to press. */
export const fixLabel = (fix: OffFix): string | null => {
  switch (fix) {
    case "turn_on":
      return "Turn on";
    case "update":
      return "Open updates";
    case "roles":
      return "Open machine roles";
    case "add":
      return "Add machine";
    case "none":
      return null;
  }
};

/** Where an admin's action that isn't Turn on goes: the option it reveals on Settings › Hub › Machines. */
export const fixReveal = (fix: OffFix): string | null =>
  fix === "update" ? "hub.updates" : fix === "roles" ? "hub.roles" : fix === "add" ? "hub.add-machine" : null;

/** The machine the picker starts on: the one picked, while it still can; else the first online one with a free slot. */
export const pickHost = (hosts: readonly HostChoice[], picked: string | null): HostChoice | undefined =>
  hosts.find((h) => h.machineId === picked && h.online) ?? hosts.find((h) => h.online && !h.full) ?? hosts.find((h) => h.online);

/** A machine's slots in words, under its name. */
export const slotLine = (h: HostChoice): string => {
  if (!h.online) return "Offline";
  if (h.full) return `Full: ${String(h.live)} of ${String(h.max)} screens in use. You can wait for the next one.`;
  return `${String(h.live)} of ${String(h.max)} screens in use`;
};

/** What the picker's button says for the machine picked. */
export const openWord = (h: HostChoice | undefined): string => (h?.full === true ? "Wait for a slot" : "Open screen");

/** Whether a PR's build can go into a screen of `kind`: an iOS simulator's or an Android emulator's. */
export const takesBuild = (kind: ScreenKind): boolean => kind === "ios" || kind === "android";

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

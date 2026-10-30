// What the New screen picker shows, as plain view data (D239): the four kinds of screen a person can open, the machines
// that can host each (from machine_roles: the sessions role, the kind ready there, and a node that hosts screens the hub
// places), and each machine's slots in words, full ones offering to wait. A Navi's browser runs only on the Navi's own
// machine, where it keeps its sign-ins. Pure, so it is unit-tested.
import type { MachineRolesEntry } from "../../../shared/contracts";

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

/** Whether any machine can host `kind`: a kind none can is shown, but can't be picked. */
export const canOpen = (machines: readonly MachineRolesEntry[], kind: ScreenKind, navi?: string): boolean => hostsFor(machines, kind, navi).length > 0;

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

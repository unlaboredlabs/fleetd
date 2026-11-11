// The words and choices of Hub › Machines › Screens, pure so they are tested on their own: each kind's switch and the
// line under it from what the machine's node reports, when an idle one ends, and recording retention's choices.
import type { HostCheck, MachineRolesEntry, SessionHost } from "../../../shared/contracts";

/** The kinds, in the picker's order, with their switch's label. No iOS (D298): the agents' Mac lends its simulators with
 * `mac sim`, on unless its node.json turns them off. */
export const SCREEN_KINDS: ReadonlyArray<{ readonly host: SessionHost; readonly label: string }> = [
  { host: "browser", label: "Browser" },
  { host: "android", label: "Android" },
  { host: "desktop", label: "Linux desktop" },
  { host: "mac", label: "Agents’ Mac" },
];

/** The kinds a machine's row lists: the agents' Mac offers only its own screen, whatever an older node of it reports. */
export const kindsOf = (m: Pick<MachineRolesEntry, "mac">): typeof SCREEN_KINDS => (m.mac === undefined ? SCREEN_KINDS : SCREEN_KINDS.filter((k) => k.host === "mac"));

/** A kind's switch: on as node.json has it (a node before switches: on where it can host it). */
export const switchOn = (check: HostCheck | undefined): boolean => check?.on ?? check?.ready ?? false;

/**
 * What keeps an online machine's switches still: its node between two links, as after an update or a screen setting
 * restarts it (the hub says nothing either way then), or a linked node too old for them; null when they move.
 */
export const nodeWait = (m: MachineRolesEntry): "restarting" | "old" | null =>
  !m.online || m.screenSettings === true ? null : m.screenSettings === false ? "old" : "restarting";

/** Why a kind's switch can't move, or null where it can. */
export const lockedWhy = (m: MachineRolesEntry, check: HostCheck | undefined): string | null => {
  if (!m.online) return "Offline";
  const wait = nodeWait(m);
  if (wait === "restarting") return "Restarting…";
  if (wait === "old") return "Its fleetd is too old to change this from here";
  if (check === undefined) return "Not known yet";
  if (check.off === "unsupported") return check.detail;
  return null;
};

/**
 * A kind this machine can never host, whose switch stays off: the Mac's own screen on a machine that isn't a Mac. Why,
 * and how to get one, in place of the node's words.
 */
export const elsewhereLine = (m: Pick<MachineRolesEntry, "mac">, host: SessionHost, check: HostCheck | undefined): string | null =>
  host === "mac" && m.mac === undefined && check?.off === "unsupported" ? "Only a Mac has this screen. Add one from Machines: the plus, then A Mac for agents." : null;

/** The line under a kind's switch: ready, off, or what stands in the way, in the node's words (as a sentence starts). */
export const stateLine = (check: HostCheck | undefined): string => {
  if (check === undefined) return "Not known yet";
  if (check.ready) return "Ready";
  switch (check.off) {
    case "off":
      return "Off";
    case "restarting":
      return "Starts after the screens open now end";
    default:
      return check.detail.charAt(0).toUpperCase() + check.detail.slice(1);
  }
};

/**
 * The command that lets a kind run, for the person to run on the machine: where it is on (or wanted) and something
 * it needs is missing or failed. None while it is off, on a machine that can't host it, restarting or installing.
 */
export const fixOf = (m: MachineRolesEntry, check: HostCheck | undefined): string | null => {
  if (!m.online || check === undefined || check.ready || check.fix === undefined) return null;
  return check.off === "missing" || check.off === "failed" ? check.fix : null;
};

/** When an idle screen ends there, as its node reports it (30 minutes; an older node may say otherwise). */
export const idleLine = (m: MachineRolesEntry): string => {
  if (m.mac !== undefined) return `An idle Mac screen ends after ${String((m.hosts ?? []).find((h) => h.host === "mac")?.idleMinutes ?? 5)} minutes, so the next agent gets it.`;
  const minutes = (m.hosts ?? []).find((h) => h.idleMinutes !== undefined)?.idleMinutes ?? 30;
  return `An idle screen ends after ${minutes % 60 === 0 ? `${String(minutes / 60)} ${minutes === 60 ? "hour" : "hours"}` : `${String(minutes)} minutes`}.`;
};

/** Retention's choices, and `current` among them when it is another. */
export const daysChoices = (current: number) =>
  [...new Set([7, 14, 30, 60, 90, 180, 365, current])].sort((a, b) => a - b).map((n) => ({ value: String(n), label: `${String(n)} days` }));

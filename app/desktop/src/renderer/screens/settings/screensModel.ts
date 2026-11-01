// The words and choices of Hub › Machines › Screens, pure so they are tested on their own: each kind's switch and the
// line under it from what the machine's node reports, the idle timeout's and recording retention's choices.
import type { HostCheck, MachineRolesEntry, SessionHost } from "../../../shared/contracts";

/** The kinds, in the picker's order, with their switch's label. */
export const SCREEN_KINDS: ReadonlyArray<{ readonly host: SessionHost; readonly label: string }> = [
  { host: "browser", label: "Browser" },
  { host: "ios", label: "iOS" },
  { host: "android", label: "Android" },
  { host: "desktop", label: "Linux desktop" },
];

/** A kind's switch: on as node.json has it (a node before switches: on where it can host it). */
export const switchOn = (check: HostCheck | undefined): boolean => check?.on ?? check?.ready ?? false;

/** Why a kind's switch can't move, or null where it can. */
export const lockedWhy = (m: MachineRolesEntry, check: HostCheck | undefined): string | null => {
  if (!m.online) return "Offline";
  if (m.screenSettings !== true) return "Its fleetd is too old to change this from here";
  if (check === undefined) return "Its node hasn't said";
  if (check.off === "unsupported") return check.detail;
  return null;
};

/** The line under a kind's switch: ready, off, or what stands in the way, in the node's words. */
export const stateLine = (check: HostCheck | undefined): string => {
  if (check === undefined) return "Its node hasn't said";
  if (check.ready) return check.detail;
  switch (check.off) {
    case "off":
      return "Off";
    case "restarting":
      return "Starts when its node restarts, once the screens live there end";
    default:
      return check.detail;
  }
};

/** The machine's idle timeout, as its node reports it: every kind has one, the browser's is shown. */
export const idleOf = (m: MachineRolesEntry): number | undefined => (m.hosts ?? []).find((h) => h.idleMinutes !== undefined)?.idleMinutes;

/** A few choices, and `current` among them when it is another. */
const choices = (values: readonly number[], current: number | undefined, label: (n: number) => string) =>
  [...new Set([...values, ...(current === undefined ? [] : [current])])].toSorted((a, b) => a - b).map((n) => ({ value: String(n), label: label(n) }));

export const idleChoices = (current: number | undefined) => choices([10, 15, 30, 60, 120, 240], current, (n) => (n % 60 === 0 ? `${String(n / 60)} h` : `${String(n)} min`));
export const daysChoices = (current: number | undefined) => choices([7, 14, 30, 60, 90, 180, 365], current, (n) => `${String(n)} days`);
export const gbChoices = (current: number | undefined) => choices([5, 10, 20, 50, 100, 200], current, (n) => `${String(n)} GB`);

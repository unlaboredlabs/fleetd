// The words of Hub › Machines › Screens, pure so they are tested on their own: no switch per kind (D574), only a line
// for a kind the machine could run that needs someone now, with its fix; when an idle one ends; and recording
// retention's choices.
import type { HostCheck, MachineRolesEntry, SessionHost } from "../../../shared/contracts";

/** The kinds, in the page's order, with their names. No iOS (D298): the agents' Mac lends its simulators with `mac sim`. */
export const SCREEN_KINDS: ReadonlyArray<{ readonly host: SessionHost; readonly label: string }> = [
  { host: "browser", label: "Browser" },
  { host: "android", label: "Android" },
  { host: "desktop", label: "Linux desktop" },
  { host: "mac", label: "Agents’ Mac" },
];

/** A kind that needs someone on this machine: what stands in the way, and the command that clears it where one does. */
export type NeedsLine = { readonly host: SessionHost; readonly label: string; readonly line: string; readonly fix: string | null };

const sentence = (s: string): string => {
  const t = s.trim();
  const up = t.charAt(0).toUpperCase() + t.slice(1);
  return /[.!?]$/u.test(up) ? up : `${up}.`;
};

/**
 * The kinds of screen this machine could run that need someone now, in the page's order: one missing or failed, with
 * its fix, and one an older node turned off in its node.json, which its update turns on. Nothing for a kind that is
 * ready or installing, nor for one it can't run at all (the hub places those elsewhere), nor while it is offline. The
 * agents' Mac offers only its own screen, whatever an older node of it reports.
 */
export const needsLines = (m: Pick<MachineRolesEntry, "name" | "online" | "hosts" | "mac">): NeedsLine[] => {
  if (!m.online) return [];
  const out: NeedsLine[] = [];
  for (const { host, label } of SCREEN_KINDS) {
    if (m.mac !== undefined && host !== "mac") continue;
    const c: HostCheck | undefined = (m.hosts ?? []).find((h) => h.host === host);
    if (c === undefined || c.ready || c.off === "unsupported" || c.off === "installing") continue;
    if (c.off === "off") out.push({ host, label, line: `Off until ${m.name}’s fleetd is updated.`, fix: null });
    else out.push({ host, label, line: sentence(c.detail), fix: c.fix ?? null });
  }
  return out;
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

/** The most iOS simulators a Mac's screens settings offer (node/mac_tool SIMS_MAX). */
export const SIMS_MAX = 8;

/** "iOS simulators at once"'s choices: the default, with the number the Mac runs by it (fewer on a small Mac) while
 * no number is set, then 1 to SIMS_MAX. */
export const simChoices = (sims: { readonly max: number; readonly set?: number | undefined }) => [
  { value: "default", label: sims.set === undefined ? `Default (${String(sims.max)})` : "Default" },
  ...Array.from({ length: SIMS_MAX }, (_, i) => ({ value: String(i + 1), label: String(i + 1) })),
];

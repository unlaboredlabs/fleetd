// The account menu's lines (You.tsx, HubStatus.tsx; W607). All being well a hub is one line: a dot and its name. What
// is off is one more line each, in plain words, with the one thing to do about it: the link (can't reach it, it
// refused the key, not paired), an update to take or one that didn't go in, and for an admin a machine that is
// offline and setup steps left. A member never reads an admin's line; where the problem is theirs too, the line ends
// in who to ask instead of an action. An update's line is the update status's own title and button (updates/quiet.ts),
// the words Settings › Hub › Machines › Updates says. The hub's address, Disconnect, versions and the setup steps themselves are
// in Settings (You › Hubs & devices, Hub › Machines › Updates, Hub › Setup), never here. Pure, so every state is unit-tested.
import type { MachineStatus } from "../../../shared/contracts";
import type { HubState } from "../../../shared/hub";
import { clockAt, type Act } from "../updates/model";
import type { Quiet } from "../updates/quiet";
import { hubName, restartOf } from "./model";

/** A dot in its state's colour; `ring`: the dot opened while the hub restarts; `update`: an update to take. */
export type LineMark = "success" | "warning" | "danger" | "quiet" | "ring" | "update";

/** What a click on a line does. */
export type LineDoes =
  | { readonly to: "hubs" }
  | { readonly to: "pair" }
  | { readonly to: "retry" }
  | { readonly to: "setup" }
  | { readonly to: "machines"; readonly machineId?: string }
  | { readonly to: "updates" }
  | { readonly to: "update"; readonly act: Act };

export interface MenuLine {
  readonly key: "hub" | "update" | "machines" | "setup";
  readonly mark: LineMark;
  readonly text: string;
  /** The hub's or machine's name in `text`, the one part the row may cut short when it is long; never what is wrong. */
  readonly name?: string;
  /** What a click does; a line without it is only read. */
  readonly does?: LineDoes;
  /** The action in a word or two, at the line's end ("Retry"). The hub's own line, all being well, has none. */
  readonly action?: string;
  /** A quiet word at the line's end instead: where an update stands, or who to ask. */
  readonly aside?: string;
}

export interface MenuMachine {
  readonly machineId: string;
  readonly name: string;
  readonly status: MachineStatus;
}

export interface MenuInput {
  readonly hub: HubState;
  /** The hub's name as the person gave it, with several hubs; null with one, named by its host. */
  readonly label: string | null;
  readonly quiet: Quiet | null;
  readonly admin: boolean;
  /** Undefined until the hub's machines are known. */
  readonly machines: readonly MenuMachine[] | undefined;
  /** Required setup steps left; 0 for a member. */
  readonly setupLeft: number;
  readonly now: number;
  /** The clock's zone, for tests; the person's own otherwise. */
  readonly timeZone?: string;
}

const ASK = "Ask an admin";

const plural = (n: number, one: string, many: string): string => `${String(n)} ${n === 1 ? one : many}`;

/** The hub's own line: its name beside a dot while connected, else what is wrong with the link and what to do. */
export const hubLine = (hub: HubState, label: string | null, quiet: Quiet | null, now: number, timeZone?: string): MenuLine => {
  const line = { key: "hub" } as const;
  if (hub.phase === "unpaired") {
    const pair = { action: "Pair", does: { to: "pair" } } as const;
    return label === null ? { ...line, mark: "quiet", text: "Not paired with a hub", ...pair } : { ...line, mark: "quiet", text: `${label} isn't paired`, name: label, ...pair };
  }
  const name = label ?? (hub.hub === "" ? "the hub" : hubName(hub.hub));
  const named = { ...line, name };
  if (hub.phase === "refused") return { ...named, mark: "danger", text: `${name} refused the key`, action: "Pair again", does: { to: "pair" } };
  const hubs = { does: { to: "hubs" } } as const;
  if (hub.phase === "live") {
    // An update going on or just in is a quiet word here, never a line of its own.
    const at = quiet?.note?.at;
    const aside = quiet?.kind === "updating" ? "Updating…" : quiet?.kind === "updated" ? (at === undefined ? "Updated" : `Updated ${clockAt(at, timeZone)}`) : undefined;
    return { ...named, mark: "success", text: name, ...(aside === undefined ? {} : { aside }), ...hubs };
  }
  // A restart isn't an outage while it is short (an update's for 2 minutes): the dot opens to a ring.
  const restart = restartOf(hub, now);
  if (restart !== null && restart.phase !== "outage") {
    if (restart.phase === "long") return { ...named, mark: "ring", text: `${name} is still updating`, action: "Retry", does: { to: "retry" } };
    return { ...named, mark: "ring", text: name, aside: restart.to === null ? "Restarting…" : "Updating…", ...hubs };
  }
  // The first dial is the usual start. From the second on it is out of reach, in the same words between attempts and
  // during one, so the line doesn't flip on every redial.
  if (hub.phase === "connecting" && hub.attempt <= 1) return { ...named, mark: "quiet", text: `Connecting to ${name}…`, ...hubs };
  if (hub.phase === "connecting") return { ...named, mark: "warning", text: `Can't reach ${name}`, aside: "Trying…" };
  return { ...named, mark: "warning", text: `Can't reach ${name}`, action: "Retry", does: { to: "retry" } };
};

/**
 * An update that needs someone: one to take, or one that didn't go in, in the status's own title with its one button.
 * One going on or just in is the hub's line's.
 */
export const updateLine = (quiet: Quiet | null): MenuLine | null => {
  const note = quiet?.note;
  if (note === null || note === undefined || (quiet?.kind !== "failed" && quiet?.kind !== "available")) return null;
  const line = { key: "update", mark: quiet.kind === "failed" ? "danger" : "update", text: note.title } as const;
  if (note.action !== undefined) return { ...line, action: note.action.label, does: { to: "update", act: note.action.act } };
  // Nothing to press from here: an admin's page says which machine and what to do, and anyone else is told who to ask.
  if (note.details) return { ...line, action: "Open", does: { to: "updates" } };
  return quiet.kind === "failed" ? { ...line, aside: ASK } : null;
};

/**
 * Machines that need someone, for an admin: the one by name, opening its page, or how many. A member reads of them
 * only when none is online, since then nothing of theirs runs, in the Machines page's words: all offline, all degraded
 * (connected, but agents can't run there), or some of each.
 */
export const machinesLine = (machines: readonly MenuMachine[] | undefined, admin: boolean): MenuLine | null => {
  const line = { key: "machines", mark: "warning" } as const;
  const off = machines?.filter((m) => m.status !== "online") ?? [];
  if (machines === undefined || off.length === 0) return null;
  if (!admin) {
    if (off.length < machines.length) return null;
    const text = off.every((m) => m.status === "offline") ? "All machines offline" : off.every((m) => m.status === "degraded") ? "All machines degraded" : "No machine online";
    return { ...line, text, aside: ASK };
  }
  const offline = off.every((m) => m.status === "offline");
  const [one] = off;
  if (off.length === 1 && one !== undefined) {
    return { ...line, text: `${one.name} ${offline ? "is offline" : "needs a look"}`, name: one.name, action: "Open", does: { to: "machines", machineId: one.machineId } };
  }
  return { ...line, text: `${String(off.length)} machines ${offline ? "offline" : "need a look"}`, action: "Open", does: { to: "machines" } };
};

/** Setup steps left, an admin's to finish. */
export const setupLine = (left: number, admin: boolean): MenuLine | null =>
  admin && left > 0 ? { key: "setup", mark: "warning", text: `${plural(left, "setup step", "setup steps")} left`, action: "Finish", does: { to: "setup" } } : null;

/** One hub's lines, its own first. What the hub alone can say (updates, machines, setup) shows only while it answers. */
export const menuLines = ({ hub, label, quiet, admin, machines, setupLeft, now, timeZone }: MenuInput): readonly MenuLine[] => {
  const own = hubLine(hub, label, quiet, now, timeZone);
  if (hub.phase !== "live") return [own];
  return [own, updateLine(quiet), machinesLine(machines, admin), setupLine(setupLeft, admin)].filter((l) => l !== null);
};

/** What marks your avatar for one hub: the most pressing thing off, in a few words; null while all is well. */
export interface HubMark {
  readonly tone: "warning" | "danger";
  readonly why: string;
}

const marked = (line: MenuLine | undefined, of: string): HubMark | null =>
  line === undefined || (line.mark !== "warning" && line.mark !== "danger") ? null : { tone: line.mark, why: `${line.text}${of}` };

/**
 * The link's own mark, which anyone sees: a refused key, or a hub really out of reach (not the first dial, and not a
 * planned restart until it runs into an outage). Pure, so the frame reads it for every hub from its published state.
 */
export const linkMark = (hub: HubState, label: string | null, now = Date.now()): HubMark | null => marked(hubLine(hub, label, null, now), "");

/**
 * The mark of what else is off on a hub: machines, then setup steps. An update says itself in the word under your
 * name, so it marks nothing. With several hubs the words name the hub.
 */
export const workMark = (lines: ReadonlyArray<MenuLine | null>, label: string | null): HubMark | null =>
  marked(lines.find((l) => l?.key === "machines" || l?.key === "setup") ?? undefined, label === null ? "" : ` (${label})`);

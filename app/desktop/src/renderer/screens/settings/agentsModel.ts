// Max agents: how many agents run at once, at three levels. Each machine runs what it fits (auto, from its memory and
// CPUs) unless someone set a number; a project runs up to its machine's cap unless it has a max of its own; and a fleet
// cap, unset by default, can hold every project together below what the machines fit. The hub enforces all three (a
// spawn past one queues and starts when a slot frees); this is how the app reads and words them. Pure, so it is
// tested without a screen.
import type { CapSetting, MachineCapSource, MachineId, ProjectRef, SlotState } from "../../../shared/contracts";

/** A max someone sets, or `auto` to drop it and go back to the default. */
export type Target = CapSetting;

export interface ProjectAgents {
  /** Agents of the project running now (its lead's own turns aside). Above `max` right after a lower. */
  readonly running: number;
  /** Agents waiting for a slot, paused ones included. */
  readonly queued: number;
  /** The project's max; its machine's cap when the project has none of its own. */
  readonly max: number;
  /** Its machine's cap, the slider's top. */
  readonly top: number;
  /** Whether someone set the project a max of its own; without one it follows its machine (auto). */
  readonly own: boolean;
}

const sameRef = (a: ProjectRef, b: ProjectRef) => a.machineId === b.machineId && a.projectId === b.projectId;

/** A machine's cap; a machine the hub hasn't sized yet, or a hub from before machine caps, gives the whole cap. */
export const machineCap = (slots: SlotState, machineId: MachineId): number => slots.perMachine?.find((m) => m.machineId === machineId)?.cap ?? slots.cap;

export function projectAgents(slots: SlotState, project: ProjectRef): ProjectAgents {
  const row = slots.perProject.find((p) => sameRef(p.projectRef, project));
  const top = machineCap(slots, project.machineId);
  // No row: the hub's default, the machine's cap, with nothing running or waiting. A max above a cap lowered later
  // is held to the cap.
  const max = Math.min(row?.maxAgents ?? top, top);
  return { running: row?.running ?? 0, queued: row?.queued ?? 0, max, top, own: row?.set === true };
}

/** The header control's words: "agents 6 / 12", and "· 2 queued" when some wait their turn. */
export const agentsLabel = (a: ProjectAgents): string => `agents ${a.running} / ${a.max}${a.queued > 0 ? ` · ${a.queued} queued` : ""}`;

/** How many running agents a new max leaves over it: they finish their work, and no new one starts until under. */
export const extrasOver = (running: number, next: number): number => Math.max(0, running - next);

/** What letting go at `next` will do, in one line, while the slider moves. */
export function changeLine(a: Pick<ProjectAgents, "running" | "queued" | "max">, next: number): string {
  if (next === a.max) {
    const running = a.running === 1 ? "1 agent running now" : `${a.running} agents running now`;
    return a.queued > 0 ? `${running}, ${a.queued} queued.` : `${running}.`;
  }
  const over = extrasOver(a.running, next);
  if (over > 0) {
    const until = next === 1 ? "until none is running" : `until fewer than ${next} run`;
    return `${a.running} running now, ${over} over the new max: they finish their current work, and new agents wait ${until}.`;
  }
  if (a.queued > 0 && next > a.max) return `Up to ${next} at once. ${Math.min(a.queued, next - a.max)} of the ${a.queued} queued can start now.`;
  if (next > a.max) return `Up to ${next} at once. Queued agents start as soon as there is room.`;
  return `Up to ${next} at once. New agents wait while ${next} run.`;
}

/** A project with no max of its own: "Auto: up to devbox's cap of 6." */
export const projectAutoLine = (a: ProjectAgents, machine: string): string => `Auto: up to ${machine}'s cap of ${a.top}.`;

/** What the lead hears about its own cap at 1: it works one agent at a time. */
export const serialNote = (next: number): string | null => (next === 1 ? "One agent at a time: the lead works through its tasks in order." : null);

/** The pause button's words, for `over` agents above the new max. */
export const pauseLine = (over: number): string =>
  over === 1
    ? "Pause the extra one now"
    : `Pause the ${over} extras now`;

/** A slider value kept within 1 … cap. */
export const clampMax = (value: number, cap: number): number => Math.min(Math.max(1, Math.round(value)), Math.max(1, cap));

/**
 * A change once applied, state first: "Max agents: 3, was 6.", "Max agents: auto, was 3." `auto` is what going back
 * to the default reads as ("no limit" for the fleet).
 */
export const appliedLine = (what: string, from: Target, to: Target, auto = "auto"): string => {
  const word = (t: Target) => (t === "auto" ? auto : String(t));
  return `${what}: ${word(to)}, was ${word(from)}.`;
};

/** What the agents above a lowered max do; paused ones first, when the pause was asked for. */
export function extrasLine(over: number, paused: number): string | null {
  if (paused > 0) return paused === 1 ? "1 agent saved its work and waits for room." : `${paused} agents saved their work and wait for room.`;
  if (over <= 0) return null;
  return over === 1 ? "1 agent over it finishes its current work first." : `${over} agents over it finish their current work first.`;
}

/** A slider's top: room to raise it past auto's 64, and never below a value already set higher (by the CLI). */
export const sliderTop = (...values: number[]): number => Math.max(64, ...values);

export interface MachineAgents {
  readonly machineId: MachineId;
  /** The most that run on it at once: `auto`, or the number someone set. */
  readonly cap: number;
  /** What it fits by its memory and CPUs. */
  readonly auto: number;
  /** The term that sets `auto`: "memory 18 GB", "14 of 16 CPUs", "top of 64", "memory unknown". */
  readonly why: string;
  readonly running: number;
  /** Whether someone set the cap; Auto takes it back. */
  readonly set: boolean;
  /** New agents its free disk has room for now; absent while the node reports no disk. */
  readonly diskRoom: number | undefined;
  /** What sets the cap: someone (`set`), or the term of auto that binds. */
  readonly source: MachineCapSource;
}

/** What sets an auto cap, for a hub that doesn't say: read from its `why`. */
const autoSource = (why: string): MachineCapSource =>
  why === "memory unknown" ? "unknown" : why === "not measured yet" ? "unmeasured" : why.startsWith("top of") ? "top" : why.startsWith("memory") ? "memory" : "cpu";

/** Each machine's cap and what sets it, by name (`name` gives a machine's). Empty from a hub before machine caps. */
export function machineAgents(slots: SlotState, name: (id: MachineId) => string): MachineAgents[] {
  return (slots.perMachine ?? [])
    .map((m): MachineAgents => {
      const set = m.set === true;
      const source = m.source ?? (set ? "set" : autoSource(m.why));
      return { machineId: m.machineId, cap: m.cap, auto: m.auto, why: m.why, running: m.running, set, diskRoom: m.diskRoom, source };
    })
    .sort((a, b) => name(a.machineId).localeCompare(name(b.machineId)));
}

/**
 * What sets the machine's cap, in one line: "Auto: memory 18 GB.", or "Set to 10. Auto would be 6 (memory 18 GB)."
 */
export function machineLine(m: MachineAgents): string {
  if (m.set) return `Set to ${m.cap}. Auto would be ${m.auto} (${m.why}).`;
  return `Auto: ${m.why}.`;
}

/** Why auto reads low or odd, and what to do: an old node, one not heard from yet, auto's top. */
export function machineHint(m: MachineAgents): string | null {
  const unknown = m.source === "unknown" || (m.set && autoSource(m.why) === "unknown");
  if (unknown) return `Its node doesn't report memory, so auto counts ${m.auto}. Run fleetd update on it to size it by its memory.`;
  if (m.source === "unmeasured") return "Its node hasn't reported yet; auto sizes it once it does.";
  if (m.source === "top") return `Auto stops at ${m.auto}. Set a number to run more.`;
  return null;
}

/** Its free disk, when that leaves room for fewer new agents than the cap: "Disk: room for 2 more now." */
export function diskLine(m: MachineAgents): string | null {
  if (m.diskRoom === undefined || m.diskRoom >= m.cap - m.running) return null;
  if (m.diskRoom === 0) return "Disk: no room for more now. New agents wait until space frees.";
  return `Disk: room for ${m.diskRoom} more now.`;
}

/** A cap above what the machine fits, as the design words it: "Above the 6 this machine's 18 GB fits." */
export function aboveAutoLine(m: Pick<MachineAgents, "auto" | "why">, next: number): string | null {
  if (next <= m.auto) return null;
  const memory = /^memory (\d+ GB)$/u.exec(m.why);
  const cpus = /^\d+ of (\d+) CPUs$/u.exec(m.why);
  const fits = memory ? `this machine's ${memory[1]} fits` : cpus ? `this machine's ${cpus[1]} CPUs fit` : "auto starts";
  return `Above the ${m.auto} ${fits}.`;
}

export interface FleetAgents {
  /** The fleet cap someone set; null: no limit beyond the machines' own caps. */
  readonly cap: number | null;
  /** The machines' caps added up. */
  readonly fits: number;
  readonly used: number;
  readonly queued: number;
}

export function fleetAgents(slots: SlotState): FleetAgents {
  const { perMachine } = slots;
  // A hub from before machine caps says no machines, and its cap is always the fleet cap.
  if (perMachine === undefined) return { cap: slots.cap, fits: slots.cap, used: slots.used, queued: slots.queued };
  const fits = perMachine.length > 0 ? perMachine.reduce((n, m) => n + m.cap, 0) : slots.cap;
  return { cap: slots.fleetCap ?? null, fits, used: slots.used, queued: slots.queued };
}

/** "No limit: the machines fit 62 together.", or "Set to 40 · the machines fit 62." */
export const fleetLine = (f: FleetAgents): string =>
  f.cap === null ? `No limit: the machines fit ${f.fits} together.` : `Set to ${f.cap} · the machines fit ${f.fits}.`;

/**
 * A fleet cap below a project's own max holds that project to the fleet cap; said while the slider moves, and after.
 * `name` gives a project's title.
 */
export function fleetWarning(slots: SlotState, cap: number, name: (r: ProjectRef) => string): string | null {
  const over = slots.perProject.filter((p) => p.set === true && p.maxAgents > cap);
  const [first] = over;
  if (first === undefined) return null;
  if (over.length === 1) return `Below ${name(first.projectRef)}'s max of ${first.maxAgents}: it runs at most ${cap} until you raise this.`;
  const who = over.length === 2 ? over.map((p) => name(p.projectRef)).join(" and ") : `${over.length} projects`;
  return `Below the max of ${who}: they run at most ${cap} until you raise this.`;
}

// Max agents: how many of a project's agents may run at once, how many a machine runs, and the fleet-wide cap above
// every project. The hub enforces all three (a spawn past the cap queues and starts when a slot frees); this is how the app reads and words
// them. Pure, so it is tested without a screen.
import type { ProjectRef, SlotState, SlotStatePerMachine } from "../../../shared/contracts";

export interface ProjectAgents {
  /** Agents of the project running now (its lead's own turns aside). Above `max` right after a lower. */
  readonly running: number;
  /** Agents waiting for a slot, paused ones included. */
  readonly queued: number;
  /** The project's max: its own, or the default (`cap`) it follows. */
  readonly max: number;
  /** The default: its machine's cap, or the fleet cap when that is lower. */
  readonly cap: number;
  /** Its machine's cap, which holds a higher max back until the machine is raised. */
  readonly machineCap: number;
  /** The slider's top: the fleet cap, which a machine may be raised to. */
  readonly top: number;
  /** What it runs at most now: its max, within its machine's cap and the fleet cap. */
  readonly limit: number;
  /** Slots free now on its machine, within the fleet cap: every project's agents there count, not just its own. */
  readonly free: number;
  /** Whether a person set the project's own max, which no fleet or machine change moves; false: it follows `cap`. */
  readonly own: boolean;
}

const sameRef = (a: ProjectRef, b: ProjectRef) => a.machineId === b.machineId && a.projectId === b.projectId;

/**
 * The top of the project and machine sliders: the fleet cap when set, else room to raise past what the machines fit. A
 * hub from before machine caps sends no `perMachine`, and its cap is the fleet's.
 */
export const sliderTop = (slots: SlotState): number => (slots.perMachine === undefined ? slots.cap : (slots.fleetCap ?? fleetTop(slots.cap)));

export function projectAgents(slots: SlotState, project: ProjectRef): ProjectAgents {
  const row = slots.perProject.find((p) => sameRef(p.projectRef, project));
  // `slots.cap` is every machine's cap added up, so a project is held to its own machine's.
  const machine = slots.perMachine?.find((m) => m.machineId === project.machineId);
  const machineCap = machine?.cap ?? slots.cap;
  const cap = Math.min(machineCap, slots.cap);
  const top = Math.max(1, sliderTop(slots));
  // A hub from before `own` lists only projects set or busy, and says nothing of which: a max at the top reads as the
  // default.
  const own = row?.own ?? (row !== undefined && row.maxAgents < cap);
  // On the default (or no row: nothing running or waiting), it follows `cap` whatever the row says.
  const max = own && row !== undefined ? Math.min(row.maxAgents, top) : cap;
  // A hub from before machine caps runs its projects as one machine: what is used is what runs there.
  const free = Math.max(0, Math.min(machineCap - (machine?.running ?? slots.used), slots.cap - slots.used));
  return { running: row?.running ?? 0, queued: row?.queued ?? 0, max, cap, machineCap, top, limit: Math.min(max, cap), free, own };
}

/** Where the max comes from, beside the slider: its own setting, or the default it follows and what sets it. */
export function sourceLine(slots: SlotState, a: ProjectAgents): string {
  if (a.own) return `Set for this project. The default is ${a.cap}.`;
  const fleet = slots.fleetCap !== undefined && slots.fleetCap <= a.cap;
  return fleet ? "Follows the default: the whole fleet's cap." : "Follows the default: its machine's cap, within the whole fleet's.";
}

/**
 * Said under a project's slider moved past its machine's cap: the machine holds it there. Null within it. `machineId`
 * names the machine.
 */
export function machineHolds(a: ProjectAgents, value: number, machineId: string): string | null {
  if (value <= a.machineCap) return null;
  return `${machineId} runs at most ${a.machineCap} agents at once, so this project runs ${a.machineCap} until you raise ${machineId}.`;
}

/** One machine as Settings shows it. */
export interface MachineAgents {
  readonly machineId: string;
  /** What it runs at once: a person's setting, else auto. */
  readonly cap: number;
  /** A person set it; false: auto. */
  readonly set: boolean;
  /** What it is measured to fit, which "Use auto" goes back to. */
  readonly auto: number;
  readonly running: number;
  /** Where the number comes from, in plain words. */
  readonly source: string;
}

const sentence = (text: string): string => (text.endsWith(".") ? text : `${text}.`);

/** Where a machine's number comes from: "Auto: memory 60 GB, about 2 GB an agent.", or a person's setting. */
export function machineSource(m: SlotStatePerMachine): string {
  if (m.maxAgents === undefined) return sentence(`Auto: ${m.why}`);
  return sentence(`Set by you. Auto would be ${m.auto}: ${m.why}`);
}

/** Every machine the hub has measured or a person has set, in the hub's order. */
export const machineAgents = (slots: SlotState): MachineAgents[] =>
  (slots.perMachine ?? []).map((m) => ({ machineId: m.machineId, cap: m.cap, set: m.maxAgents !== undefined, auto: m.auto, running: m.running, source: machineSource(m) }));

/** How many running agents a new max leaves over it: they finish their work, and no new one starts until under. */
export const extrasOver = (running: number, next: number): number => Math.max(0, running - next);

/** What letting go at `next` will do, in one line, while the slider moves. */
export function changeLine(a: ProjectAgents, next: number): string {
  if (next === a.max) {
    const running = a.running === 1 ? "1 agent running now" : `${a.running} agents running now`;
    return a.queued > 0 ? `${running}, ${a.queued} queued.` : `${running}.`;
  }
  const over = extrasOver(a.running, next);
  if (over > 0) {
    const until = next === 1 ? "until none is running" : `until fewer than ${next} run`;
    return `${a.running} running now, ${over} over the new max: they finish their current work, and new agents wait ${until}.`;
  }
  if (a.queued > 0 && next > a.max) {
    // Its machine (or the fleet, when lower) still holds it: only what fits in the slots free there starts, and other
    // projects' agents on the machine hold those too.
    const start = Math.min(a.queued, Math.max(0, Math.min(next - a.running, a.free)));
    const holder = a.cap < a.machineCap ? "the whole fleet" : "its machine";
    if (start === 0) return `Up to ${next} at once, but ${holder} runs ${a.cap} at most: the ${a.queued} queued wait for it.`;
    const rest = start < a.queued && a.free < next - a.running ? `; the rest wait for ${holder}` : "";
    return `Up to ${next} at once. ${start} of the ${a.queued} queued can start now${rest}.`;
  }
  if (next > a.max) return `Up to ${next} at once. Queued agents start as soon as there is room.`;
  return `Up to ${next} at once. New agents wait while ${next} run.`;
}

/** What the lead hears about its own cap at 1: it works one agent at a time. */
export const serialNote = (next: number): string | null => (next === 1 ? "One agent at a time: the lead works through its tasks in order." : null);

/** The pause button's words, for `over` agents above the new max. */
export const pauseLine = (over: number): string =>
  over === 1
    ? "Pause the extra one now"
    : `Pause the ${over} extras now`;

/** A slider value kept within 1 … cap. */
export const clampMax = (value: number, cap: number): number => Math.min(Math.max(1, Math.round(value)), Math.max(1, cap));

/** A change once applied, state first: "Max agents: 3, was 6." */
export const appliedLine = (what: string, from: number, to: number): string => `${what}: ${to}, was ${from}.`;

/** What the agents above a lowered max do; paused ones first, when the pause was asked for. */
export function extrasLine(over: number, paused: number): string | null {
  if (paused > 0) return paused === 1 ? "1 agent saved its work and waits for room." : `${paused} agents saved their work and wait for room.`;
  if (over <= 0) return null;
  return over === 1 ? "1 agent over it finishes its current work first." : `${over} agents over it finish their current work first.`;
}

/** The fleet slider's top: room to raise it, and never below a cap already set higher (by the CLI). */
export const fleetTop = (cap: number): number => Math.max(64, cap);

/**
 * A fleet cap below a project's own max holds that project to the fleet cap; said while the slider moves, and after.
 * `name` gives a project's title.
 */
export function fleetWarning(slots: SlotState, cap: number, name: (r: ProjectRef) => string): string | null {
  // A project on the default follows the fleet cap, so only an own max is held below. A hub from before `own` sends
  // none, and its rows are maxes set, or busy projects at their machine's cap.
  const over = slots.perProject.filter((p) => p.own !== false && p.maxAgents > cap);
  const [first] = over;
  if (first === undefined) return null;
  if (over.length === 1) return `Below ${name(first.projectRef)}'s max of ${first.maxAgents}: it runs at most ${cap} until you raise this.`;
  const who = over.length === 2 ? over.map((p) => name(p.projectRef)).join(" and ") : `${over.length} projects`;
  return `Below the max of ${who}: they run at most ${cap} until you raise this.`;
}

// Max agents: how many of a project's agents may run at once, and the fleet-wide cap above every project. The hub
// enforces both (a spawn past the cap queues and starts when a slot frees); this is how the app reads and words
// them. Pure, so it is tested without a screen.
import type { ProjectRef, SlotState } from "../../../shared/contracts";

export interface ProjectAgents {
  /** Agents of the project running now (its lead's own turns aside). Above `max` right after a lower. */
  readonly running: number;
  /** Agents waiting for a slot, paused ones included. */
  readonly queued: number;
  /** The project's max; its machine's cap when the project has no limit of its own. */
  readonly max: number;
  /** The most it can run, the slider's top: its machine's cap, or the fleet cap when that is lower. */
  readonly cap: number;
  /** Whether the project has a limit of its own below that. */
  readonly own: boolean;
}

const sameRef = (a: ProjectRef, b: ProjectRef) => a.machineId === b.machineId && a.projectId === b.projectId;

export function projectAgents(slots: SlotState, project: ProjectRef): ProjectAgents {
  const row = slots.perProject.find((p) => sameRef(p.projectRef, project));
  // `slots.cap` is every machine's cap added up, so a project is held to its own machine's. A hub from before machine
  // caps sends no `perMachine`, and its cap is the fleet's.
  const machine = slots.perMachine?.find((m) => m.machineId === project.machineId)?.cap ?? slots.cap;
  const cap = Math.min(machine, slots.cap);
  // No row: the hub's default, the machine's cap, with nothing running or waiting.
  const max = Math.min(row?.maxAgents ?? cap, cap);
  return { running: row?.running ?? 0, queued: row?.queued ?? 0, max, cap, own: max < cap };
}

/** The header control's words: "agents 6 / 12", and "· 2 queued" when some wait their turn. */
export const agentsLabel = (a: ProjectAgents): string => `agents ${a.running} / ${a.max}${a.queued > 0 ? ` · ${a.queued} queued` : ""}`;

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
  if (a.queued > 0 && next > a.max) return `Up to ${next} at once. ${Math.min(a.queued, next - a.max)} of the ${a.queued} queued can start now.`;
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
  const over = slots.perProject.filter((p) => p.maxAgents > cap);
  const [first] = over;
  if (first === undefined) return null;
  if (over.length === 1) return `Below ${name(first.projectRef)}'s max of ${first.maxAgents}: it runs at most ${cap} until you raise this.`;
  const who = over.length === 2 ? over.map((p) => name(p.projectRef)).join(" and ") : `${over.length} projects`;
  return `Below the max of ${who}: they run at most ${cap} until you raise this.`;
}

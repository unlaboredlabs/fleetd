// Max agents: how many of a project's agents may run at once, and the fleet-wide cap above every project. The hub
// enforces both (a spawn past the cap queues and starts when a slot frees); this is how the app reads and words
// them. Pure, so it is tested without a screen.
import type { ProjectRef, SlotState } from "../../../shared/contracts";

export interface ProjectAgents {
  /** Agents of the project running now (its lead's own turns aside). Above `max` right after a lower. */
  readonly running: number;
  /** Agents waiting for a slot, paused ones included. */
  readonly queued: number;
  /** The project's max; the fleet cap when the project has no limit of its own. */
  readonly max: number;
  /** The fleet-wide cap, the slider's top. */
  readonly cap: number;
  /** Whether the project has a limit of its own below the fleet cap. */
  readonly own: boolean;
}

const sameRef = (a: ProjectRef, b: ProjectRef) => a.machineId === b.machineId && a.projectId === b.projectId;

export function projectAgents(slots: SlotState, project: ProjectRef): ProjectAgents {
  const row = slots.perProject.find((p) => sameRef(p.projectRef, project));
  // No row: the hub's default, the fleet cap, with nothing running or waiting.
  const max = Math.min(row?.maxAgents ?? slots.cap, slots.cap);
  return { running: row?.running ?? 0, queued: row?.queued ?? 0, max, cap: slots.cap, own: max < slots.cap };
}

/** The header control's words: "agents 6 / 12", and "· 2 waiting" when some are. */
export const agentsLabel = (a: ProjectAgents): string => `agents ${a.running} / ${a.max}${a.queued > 0 ? ` · ${a.queued} waiting` : ""}`;

/** How many running agents a new max leaves over it: they finish their work, and no new one starts until under. */
export const extrasOver = (running: number, next: number): number => Math.max(0, running - next);

/** What saving `next` will do, in one line, before it is saved. */
export function changeLine(a: ProjectAgents, next: number): string {
  if (next === a.max) {
    const running = a.running === 1 ? "1 agent running now" : `${a.running} agents running now`;
    return a.queued > 0 ? `${running}, ${a.queued} waiting for a slot.` : `${running}.`;
  }
  const over = extrasOver(a.running, next);
  if (over > 0) {
    return `${a.running} running now, ${over} over the new max: they finish their current work, and new agents wait until fewer than ${next} run.`;
  }
  if (a.queued > 0 && next > a.max) return `Up to ${next} at once. ${Math.min(a.queued, next - a.max)} of the ${a.queued} waiting can start now.`;
  if (next > a.max) return `Up to ${next} at once. Waiting agents start as soon as there is room.`;
  return `Up to ${next} at once. New agents wait while ${next} run.`;
}

/** What the lead hears about its own cap at 1: it works one agent at a time. */
export const serialNote = (next: number): string | null => (next === 1 ? "One agent at a time: the lead works through its tasks in order." : null);

/** The pause option's words, for `over` agents above the new max. */
export const pauseLine = (over: number): string =>
  over === 1
    ? "Pause the extra one now: it saves its work in progress and waits, and resumes when a slot frees."
    : `Pause the ${over} extras now: they save their work in progress and wait, and resume when a slot frees.`;

/** A slider value kept within 1 … cap. */
export const clampMax = (value: number, cap: number): number => Math.min(Math.max(1, Math.round(value)), Math.max(1, cap));

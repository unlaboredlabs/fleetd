// The lines a max agents change says: each `agents.cap` event's summary (the chat's quiet line), a paused agent's
// reason and the lead's line for a raise. Pure, from numbers and names: the hub's `cap_set` (hub/slots/cap.ts) builds
// them here, and so can a server with no hub around it.

export const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** The chat line for a project cap that paused the extras: lowered, or kept where it was. */
export function pausedLine(from: number, to: number, paused: number, running: number): string {
  const push = paused === 1 ? "pushes its work and waits" : "push their work and wait";
  const keep = running === 1 ? "keeps" : "keep";
  // The app lowers the max first and offers the pause after it, at the same max.
  const change = to < from ? `${from} → ${to}` : String(to);
  return `Max agents ${change}: ${plural(paused, "agent", "agents")} ${push}; ${running} ${keep} running.`;
}

/** The chat line for a raised project cap: what started, if anything did. */
export function raisedLine(from: number, to: number, started: number, free: number): string {
  if (started === 0) return `Max agents ${from} → ${to}.`;
  return `Max agents ${from} → ${to}: ${plural(started, "queued agent starts", "queued agents start")} now, ${plural(free, "slot", "slots")} free.`;
}

/** The chat line for a lowered project cap with nothing paused: more run than the new max, and they finish. */
export function loweredLine(from: number, to: number, running: number): string {
  const finish = running === 1 ? "finishes its work" : "finish their work";
  return `Max agents ${from} → ${to}: ${running} running ${finish}; new agents wait.`;
}

/** What a project's max agents change says, whichever way it went. */
export type ProjectChange = {
  /** Its max before and after. */
  from: number;
  to: number;
  /** Queued agents the change started. */
  started: number;
  /** Slots the project has free after it. */
  free: number;
  /** Agents the change paused. */
  paused: number;
  /** Agents running after it, the paused ones included until they end. */
  running: number;
  /** Back to the default from a max of its own. */
  back: boolean;
};

/** The chat line for a project's max agents: raised, paused, lowered, back to the default, or only changed. */
export function projectLine({ from, to, started, free, paused, running, back }: ProjectChange): string {
  let line: string;
  if (to > from) line = raisedLine(from, to, started, free);
  else if (paused > 0) line = pausedLine(from, to, paused, Math.max(running - paused, 0));
  else if (to < from && running > to) line = loweredLine(from, to, running);
  else if (back && to === from) line = `Max agents ${to}, the default now.`;
  else line = `Max agents ${from} → ${to}.`;
  if (back && to !== from) line = `${line} It follows the default now.`;
  return line;
}

/** The line for a machine's max agents set, changed, or back to auto (`set` before, `setNow` after). */
export function machineLine(machine: string, from: number, to: number, set: boolean, setNow: boolean): string {
  const change = !set
    ? `Max agents on ${machine} set to ${to} (auto was ${from})`
    : setNow
      ? `Max agents on ${machine} ${from} → ${to}`
      : `Max agents on ${machine} back to auto: ${to}, was ${from}`;
  if (to > from) return `${change}: queued agents start as slots allow.`;
  if (to < from) return `${change}: running agents finish; new ones wait.`;
  return `${change}.`;
}

/** The line for the fleet cap set (`from` undefined: none before) or changed; `fit` is what the machines fit before. */
export function fleetLine(from: number | undefined, to: number, fit: number): string {
  const what = from !== undefined ? `Fleet cap ${from} → ${to}` : `Fleet cap set to ${to} (the machines fit ${fit})`;
  return to > fit ? `${what}: queued agents start as slots allow.` : `${what}: running agents finish; new ones wait.`;
}

/** A paused agent's reason, as its task shows it while it waits. */
export const pausedReason = (maxAgents: number) =>
  `paused: max agents lowered to ${maxAgents}; resumes when a slot frees`;

/** The lead's line for a raised cap (`leads::events::Event::CapRaised`). */
export const capRaisedText = (maxAgents: number, free: number) =>
  `- cap raised to ${maxAgents}: ${free} slot${free === 1 ? "" : "s"} free; queued agents already started`;

// The line of agents waiting for one of the Mac's iOS simulators (`mac sim
// start`), first come first served. Only the agent at its head may take one, so the next simulator that is ready is
// kept for it however often the others ask. A waiting agent's `mac` asks again every ASK_EVERY; one not heard from for
// GONE (its task ended or was cancelled, or its command was cut off and not run again) leaves the line, and what would
// have been its simulator goes to the next. `mac sim end` leaves it at once. A person's own simulator (D239) joins ahead
// of every agent, behind the people already waiting.

/** How often a waiting `mac sim start` asks the Mac again. */
export const ASK_EVERY = 5_000;
/** A waiting agent not heard from for this long leaves the line: room for a command cut off by its tool's time limit to
 * be run again, keeping its place. */
export const GONE = 120_000;

/** What an agent's `mac sim start` gets now: its turn (it takes a simulator now, and leaves the line once it has one),
 * or a wait at `place` while every simulator the Mac allows is in use (`full`) or agents ahead of it get theirs first. */
export type Turn = { now: true } | { now: false; place: number; full: boolean };

/** The agents waiting, first first, each with when it last asked (ms). */
export class Queue {
  private waiting: [string, number][] = [];
  /** Who of those waiting is a person. */
  private readonly people = new Set<string>();

  /** The agent's place (1 is next) as it asks at `now`: its own again while it waits, else at the back, or with
   * `person` behind the people waiting, ahead of every agent. */
  ask(agent: string, now: number, person = false): number {
    this.prune(now);
    const i = this.waiting.findIndex(([a]) => a === agent);
    if (i >= 0) {
      this.waiting[i]![1] = now;
      return i + 1;
    }
    if (!person) {
      this.waiting.push([agent, now]);
      return this.waiting.length;
    }
    const at = this.waiting.filter(([a]) => this.people.has(a)).length;
    this.waiting.splice(at, 0, [agent, now]);
    this.people.add(agent);
    return at + 1;
  }

  /** The agent's turn as it asks at `now`, with `inUse` of the Mac's `budget` simulators held. Asking to `wait`, it
   * joins the line (or keeps its place); otherwise it only takes its place, behind everyone waiting. */
  turn(agent: string, wait: boolean, inUse: number, budget: number, now: number, person = false): Turn {
    let place: number;
    if (wait) place = this.ask(agent, now, person);
    else {
      this.prune(now);
      const i = this.waiting.findIndex(([a]) => a === agent);
      const behind = person ? this.waiting.filter(([a]) => this.people.has(a)).length : this.waiting.length;
      place = (i >= 0 ? i : behind) + 1;
    }
    if (inUse >= budget) return { now: false, place, full: true };
    if (place > 1) return { now: false, place, full: false };
    return { now: true };
  }

  /** The agent leaves the line (it got its simulator, ran `mac sim end`, or failed); whether it was in it. */
  leave(agent: string): boolean {
    const before = this.waiting.length;
    this.waiting = this.waiting.filter(([a]) => a !== agent);
    this.people.delete(agent);
    return this.waiting.length !== before;
  }

  private prune(now: number): void {
    this.waiting = this.waiting.filter(([, asked]) => now - asked < GONE);
    for (const p of this.people) if (!this.waiting.some(([a]) => a === p)) this.people.delete(p);
  }
}

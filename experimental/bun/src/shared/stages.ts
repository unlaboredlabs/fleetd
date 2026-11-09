/** A start, stage by stage (stages.rs): an agent's launch or its process's spawn. Each stage's time goes to the log at
 * debug as it ends (`FLEETD_LOG=debug`), and a start that took `SLOW_MS` or more logs every stage at info, so it
 * explains itself in the log a node keeps by default (docs: Troubleshooting, "An agent was slow to start"). */

/** A start this slow logs its stages at info (`Stages.end`). */
export const SLOW_MS = 2000;

export class Stages {
  readonly #start: number;
  #last: number;
  /** Each stage so far and its time, for `end`. */
  readonly #done: [stage: string, ms: number][] = [];

  /** `what` names the start in the log (`node launch`), `id` its session. */
  constructor(
    readonly what: string,
    readonly id: string,
    readonly now: () => number = () => performance.now(),
    readonly log: (line: string) => void = (line) => console.log(line),
  ) {
    this.#start = this.#last = now();
  }

  /** `stage` ends now: its own time, and the start's so far. */
  done(stage: string): void {
    const now = this.now();
    const ms = Math.round(now - this.#last);
    if (process.env.FLEETD_LOG?.includes("debug"))
      this.log(`${new Date().toISOString()} DEBUG start stage ${JSON.stringify({ start: this.what, id: this.id, stage, ms, totalMs: Math.round(now - this.#start) })}`);
    this.#done.push([stage, ms]);
    this.#last = now;
  }

  /** The start is over: one that took `SLOW_MS` or more logs each stage's time at info (`fetch 1200 ms, worktree 90 ms`). */
  end(): void {
    const totalMs = Math.round(this.now() - this.#start);
    if (totalMs < SLOW_MS) return;
    this.log(`${new Date().toISOString()} INFO slow start ${JSON.stringify({ start: this.what, id: this.id, totalMs, stages: this.line() })}`);
  }

  line(): string {
    return this.#done.map(([stage, ms]) => `${stage} ${ms} ms`).join(", ");
  }
}

// The machine breaker (crates/fleetd/src/hub/tasks/breaker.rs): when agents on one machine keep dying (claude exited
// or was killed, or stalled), fleetd stops resuming them there, so a machine that kills every agent can't turn the
// automatic resume into a loop. Its dead agents wait, queued; its leads are told once. It closes on its own after a
// quiet spell with no death there, or as soon as an agent there completes, and the waiting agents resume.
//
// A node going away never counts. Pure: index.ts feeds it deaths and carries out what it says. Rebuilt at start from
// the last `machine.recovery_paused` of each machine.
import type { MachineId, TaskId } from "../../shared/contracts.ts";

/** This many different agents dying on one machine within `WINDOW_MS` opens its breaker. */
export const DEATHS = 3;
export const WINDOW_MS = 10 * 60_000;
/** It closes once no agent died there for this long. */
export const QUIET_MS = 30 * 60_000;

type Machine = {
  /** Deaths that count within the window, oldest first: which task, when. */
  deaths: [TaskId, number][];
  /** The latest of them, which the quiet spell runs from. */
  lastDeath?: number;
  /** When it opened; undefined while closed. */
  openSince?: number;
  /** The agents whose deaths opened it. */
  openedBy: TaskId[];
  /** The dead agents it holds back from resuming. */
  held: Set<TaskId>;
};

/** The breaker opened: the agents whose deaths opened it, and when it closes if nothing else dies. */
export type Opened = { taskIds: TaskId[]; untilMs: number };

/** An open breaker, for the doctor. */
export type Paused = { openedBy: TaskId[]; untilMs: number; held: TaskId[] };

/** Rust's BTreeSet order: byte order of the ids. */
const sorted = (ids: Iterable<TaskId>) => [...ids].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

export class Breakers {
  private readonly machines = new Map<MachineId, Machine>();

  private entry(m: MachineId): Machine {
    let e = this.machines.get(m);
    if (!e) {
      e = { deaths: [], openedBy: [], held: new Set() };
      this.machines.set(m, e);
    }
    return e;
  }

  /**
   * A task on `machine` died in a way that counts. Opens the breaker when it is the `DEATHS`th different task to die
   * there within `WINDOW_MS`; while it is open, each death keeps it open longer.
   */
  death(machine: MachineId, task: TaskId, nowMs: number): Opened | undefined {
    const m = this.entry(machine);
    m.lastDeath = nowMs;
    if (m.openSince !== undefined) return undefined;
    m.deaths.push([task, nowMs]);
    m.deaths = m.deaths.filter(([, at]) => nowMs - at < WINDOW_MS);
    const tasks: TaskId[] = [];
    for (const [t] of m.deaths) if (!tasks.includes(t)) tasks.push(t);
    if (tasks.length < DEATHS) return undefined;
    m.openSince = nowMs;
    m.openedBy = [...tasks];
    return { taskIds: tasks, untilMs: nowMs + QUIET_MS };
  }

  /** An open breaker as the hub last recorded it (`machine.recovery_paused`), at hub start. */
  restore(machine: MachineId, opened: Opened, openedMs: number): void {
    const m = this.entry(machine);
    m.openSince = openedMs;
    m.openedBy = opened.taskIds;
    // The quiet spell runs from the last death, which `until` was counted from.
    m.lastDeath = opened.untilMs - QUIET_MS;
  }

  /** The machine's breaker while it is open. */
  paused(machine: MachineId): Paused | undefined {
    const m = this.machines.get(machine);
    if (m?.openSince === undefined || m.lastDeath === undefined) return undefined;
    return { openedBy: [...m.openedBy], untilMs: m.lastDeath + QUIET_MS, held: sorted(m.held) };
  }

  /** Holds a dead task back from resuming while the breaker of its machine is open; false when it is closed. */
  hold(machine: MachineId, task: TaskId): boolean {
    const m = this.machines.get(machine);
    if (m?.openSince === undefined) return false;
    m.held.add(task);
    return true;
  }

  /** Whether the task waits on its machine's breaker. */
  holds(machine: MachineId, task: TaskId): boolean {
    const m = this.machines.get(machine);
    return m?.openSince !== undefined && m.held.has(task);
  }

  /** The task goes on anyway: its lead continued it, or it ended. */
  release(task: TaskId): void {
    for (const m of this.machines.values()) m.held.delete(task);
  }

  /** Closes the machine's breaker, if open: the tasks it held, which resume now. */
  close(machine: MachineId): TaskId[] | undefined {
    const m = this.machines.get(machine);
    if (m?.openSince === undefined) return undefined;
    m.openSince = undefined;
    m.deaths = [];
    m.lastDeath = undefined;
    m.openedBy = [];
    const held = sorted(m.held);
    m.held = new Set();
    return held;
  }

  /** The open breakers whose quiet spell is over at `nowMs`. */
  quiet(nowMs: number): MachineId[] {
    return sorted(
      [...this.machines]
        .filter(([, m]) => m.openSince !== undefined && (m.lastDeath === undefined || nowMs - m.lastDeath >= QUIET_MS))
        .map(([id]) => id),
    );
  }
}

// The safety-net sweep (crates/fleetd/src/hub/sweep/mod.rs): every 5 min, deterministic, no LLM. Built in: re-open
// streams for running threads that lost theirs, and report each machine that is offline with running threads (once
// per offline spell). Other areas add checks with `sweep(hub).register` (overdue wakes, the doctor, spent codes); each
// check is isolated, so one failing does not stop the rest.
import type { Hub } from "../api/hub.ts";
import { events } from "../store/events.ts";
import { store } from "../store/hub_store.ts";
import { isoMs } from "../store/time.ts";
import { watchdog } from "../watchdog/index.ts";

export const SWEEP_EVERY_MS = 5 * 60_000;
/** A wake this far past its time is fired by the sweep, per its catch-up rule. */
export const WAKE_OVERDUE_MS = 2 * 60_000;

export type SweepCheck = {
  /** For logs. */
  name: string;
  /** Called once per sweep; a throw or rejection is logged by the check's name and the sweep moves on. */
  run: () => Promise<void> | void;
};

/** Runs `fn` every `ms` until the hub stops, one run at a time (the Rust loops' `sleep` then work). */
export function every(hub: Hub, ms: number, fn: () => Promise<void> | void): void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const tick = async () => {
    try {
      await fn();
    } catch (error) {
      console.warn("hub loop failed:", error);
    }
    if (!hub.shutdown.signal.aborted) timer = setTimeout(tick, ms);
  };
  if (hub.shutdown.signal.aborted) return;
  timer = setTimeout(tick, ms);
  hub.shutdown.signal.addEventListener("abort", () => clearTimeout(timer), { once: true });
}

export class Sweep {
  private readonly checks: SweepCheck[] = [];
  /** Offline machines already reported, by the lastSeenAt of their offline spell. */
  private readonly reported = new Map<string, string>();

  constructor(private readonly hub: Hub) {}

  /** Sweeps every `everyMs` from now on, until the hub stops. */
  start(everyMs: number): void {
    every(this.hub, everyMs, () => this.runOnce());
  }

  /** Adds a check to every sweep from now on. */
  register(check: SweepCheck): void {
    this.checks.push(check);
  }

  private async streams(): Promise<void> {
    const opened = await watchdog(this.hub).resubscribe();
    if (opened > 0) console.info(`sweep: re-opened ${opened} thread streams`);
  }

  private offlineMachines(): void {
    const machines = store(this.hub).machinesList();
    const running = store(this.hub).threadsRunning();
    for (const machine of machines) {
      if (machine.status !== "offline") {
        this.reported.delete(machine.machineId);
        continue;
      }
      const threads = running.filter((t) => t.machineId === machine.machineId);
      const since = machine.lastSeenAt;
      if (threads.length === 0 || this.reported.get(machine.machineId) === since) continue;
      this.reported.set(machine.machineId, since);
      const n = threads.length;
      events(this.hub).append({
        at: isoMs(this.hub.clock.now()),
        type: "machine.offline",
        machineId: machine.machineId,
        summary: `${machine.machineId} is still offline with ${n} running thread${n === 1 ? "" : "s"}; their runs are not being watched`,
        data: { since, runningThreads: threads.slice(0, 20).map((t) => t.threadId), count: n },
        attention: "loud",
      });
    }
  }

  /** One sweep now: the built-in checks, then the registered ones in order (those registered later included). */
  async runOnce(): Promise<void> {
    const report = async (name: string, run: () => Promise<void> | void) => {
      try {
        await run();
      } catch (error) {
        console.warn(`sweep: check ${name} failed:`, error);
      }
    };
    await report("streams", () => this.streams());
    await report("offline-machines", () => this.offlineMachines());
    for (const check of [...this.checks]) await report(check.name, check.run);
  }
}

/** The hub's one sweep: `sweep(hub).register({ name, run })`. */
export const sweep = (hub: Hub) => hub.area("sweep", (h) => new Sweep(h));

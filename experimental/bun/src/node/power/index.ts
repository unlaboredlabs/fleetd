// Machines that sleep (crates/fleetd/src/node/power): while any session runs the node holds a sleep inhibitor, and
// drops it when none do. When the machine wakes anyway the node notices the jump in time asleep, re-links to the hub
// at once, has the session service check its live sessions, and reports the sleep (`slept`).
//
// Time asleep is CLOCK_BOOTTIME (/proc/uptime) less CLOCK_MONOTONIC (process.hrtime), the pair the Rust node reads.
// The inhibitor is `systemd-inhibit` holding a `sleep infinity` child, logind's same `idle:sleep` block lock.
import { readFileSync } from "node:fs";

/** Shorter gaps are not reported: a dark-wake blip says nothing about agents. */
export const MIN_SLEEP_MS = 5_000;
const TICK_MS = 5_000;
const PENDING_MAX = 8;

export type Slept = { fromMs: number; toMs: number };
export type Sample = { asleepMs: number; wallMs: number };

let highest = 0;

/** Time asleep since boot (the highest reading yet: raw readings only ever run short) and the wall clock. */
export function sample(): Sample | undefined {
  if (process.platform !== "linux") return undefined;
  let boot: number;
  try {
    boot = Number(readFileSync("/proc/uptime", "utf8").split(" ")[0]) * 1000;
  } catch {
    return undefined;
  }
  const mono = Number(process.hrtime.bigint() / 1_000_000n);
  highest = Math.max(highest, boot - mono);
  return { asleepMs: Math.floor(highest), wallMs: Date.now() };
}

/** Turns successive samples into the sleeps between them, placed ending now. */
export class SleepWatch {
  #last: Sample | undefined;
  observe(now: Sample): Slept | undefined {
    const last = this.#last;
    this.#last = now;
    if (!last) return undefined;
    const asleep = now.asleepMs - last.asleepMs;
    return asleep >= MIN_SLEEP_MS ? { fromMs: now.wallMs - asleep, toMs: now.wallMs } : undefined;
  }
}

/** What the link learns of wakes: a promise per wake, and the sleeps not yet sent. */
export class Wakes {
  #pending: Slept[] = [];
  #waiters: (() => void)[] = [];
  woke(slept: Slept): void {
    this.#pending.push(slept);
    this.#pending.splice(0, Math.max(0, this.#pending.length - PENDING_MAX));
    for (const w of this.#waiters.splice(0)) w();
  }
  /** Resolves at the next wake; an aborted `signal` (its link ended) drops the wait, so none piles up. */
  next(signal?: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      this.#waiters.push(resolve);
      signal?.addEventListener("abort", () => (this.#waiters = this.#waiters.filter((w) => w !== resolve)), { once: true });
    });
  }
  /** The sleeps to report, once. */
  take(): Slept[] {
    return this.#pending.splice(0);
  }
}

export const inhibitWhy = (running: number) => (running === 1 ? "fleetd: 1 agent running" : `fleetd: ${running} agents running`);

/** One hold while any agent runs, its name updated when the count changes; where none can be had it tries again
 * only once agents start again after none ran. */
export class Inhibitor {
  #held: { running: number; proc: Bun.Subprocess } | undefined;
  #failed = false;
  set(running: number): void {
    if (running === 0) {
      this.#failed = false;
      this.#held?.proc.kill();
      this.#held = undefined;
      return;
    }
    if (this.#failed || this.#held?.running === running) return;
    let proc: Bun.Subprocess;
    try {
      proc = Bun.spawn(
        ["systemd-inhibit", "--what=idle:sleep", "--who=fleetd", `--why=${inhibitWhy(running)}`, "--mode=block", "sleep", "infinity"],
        { stdin: "ignore", stdout: "ignore", stderr: "ignore" },
      );
    } catch {
      this.#failed = true;
      return;
    }
    proc.exited.then((code) => {
      if (this.#held?.proc === proc && code !== null && code !== 0) {
        this.#held = undefined;
        this.#failed = true;
      }
    });
    // The old hold goes only after the new one is taken, so there is no gap.
    const old = this.#held;
    this.#held = { running, proc };
    old?.proc.kill();
  }
  release(): void {
    this.set(0);
  }
}

/** Runs for the node's lifetime: wakes noticed within a tick, the inhibitor kept to `running()`. */
export function runPower(opts: { running: () => number; wakes: Wakes; onWake: () => void; signal: AbortSignal }): void {
  const watch = new SleepWatch();
  const inhibitor = new Inhibitor();
  const tick = () => {
    const now = sample();
    const slept = now && watch.observe(now);
    if (slept) {
      console.log(`${new Date().toISOString()} INFO the machine woke from sleep {"sleptMs":${slept.toMs - slept.fromMs}}`);
      opts.wakes.woke(slept);
      opts.onWake();
    }
    inhibitor.set(opts.running());
  };
  tick();
  const timer = setInterval(tick, TICK_MS);
  opts.signal.addEventListener("abort", () => (clearInterval(timer), inhibitor.release()), { once: true });
}

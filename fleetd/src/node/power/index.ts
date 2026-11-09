// Machines that sleep: while any session runs the node holds a sleep inhibitor, and
// drops it when none do. When the machine wakes anyway the node notices the jump in time asleep, re-links to the hub
// at once, has the session service check its live sessions, and reports the sleep (`slept`).
//
// Time asleep is, on Linux, CLOCK_BOOTTIME (/proc/uptime) less CLOCK_MONOTONIC (process.hrtime), the pair the Rust
// node reads; on macOS mach_continuous_time less mach_absolute_time (./darwin.ts). The inhibitor is, on Linux,
// `systemd-inhibit` holding a `sleep infinity` child, logind's same `idle:sleep` block lock; on macOS an IOPMAssertion.
import { readFileSync } from "node:fs";
import { asleepNs, assertion } from "./darwin.ts";

/** Shorter gaps are not reported: a dark-wake blip says nothing about agents. */
export const MIN_SLEEP_MS = 5_000;
const TICK_MS = 5_000;
const PENDING_MAX = 8;

export type Slept = { fromMs: number; toMs: number };
export type Sample = { asleepMs: number; wallMs: number };

let highest = 0;

/** One raw reading of time asleep since boot in ms, short by the gap between its two clocks' reads. */
function asleepRaw(): number | undefined {
  if (process.platform === "darwin") {
    const ns = asleepNs();
    return ns === undefined ? undefined : ns / 1_000_000;
  }
  if (process.platform !== "linux") return undefined;
  let boot: number;
  try {
    boot = Number(readFileSync("/proc/uptime", "utf8").split(" ")[0]) * 1000;
  } catch {
    return undefined;
  }
  return boot - Number(process.hrtime.bigint() / 1_000_000n);
}

/** Time asleep since boot (the highest reading yet: raw readings only ever run short) and the wall clock. */
export function sample(): Sample | undefined {
  const raw = asleepRaw();
  if (raw === undefined) return undefined;
  highest = Math.max(highest, raw);
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

/** A sleep inhibitor taken, until `release`. */
export type Hold = { release(): void };
/** Takes the OS's inhibitor named `why`, undefined where none can be had; `lost` runs if it ends by itself. */
export type Take = (why: string, lost: () => void) => Hold | undefined;

/** logind's inhibitor on Linux, an IOPMAssertion on macOS. */
export const takeHold: Take = (why, lost) => {
  if (process.platform === "darwin") return assertion(why);
  let proc: Bun.Subprocess;
  try {
    proc = Bun.spawn(["systemd-inhibit", "--what=idle:sleep", "--who=fleetd", `--why=${why}`, "--mode=block", "sleep", "infinity"], {
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
    });
  } catch {
    return undefined;
  }
  proc.exited.then((code) => {
    if (code !== null && code !== 0) lost();
  });
  return { release: () => proc.kill() };
};

/** One hold while any agent runs, its name updated when the count changes; where none can be had it tries again
 * only once agents start again after none ran. */
export class Inhibitor {
  #held: { running: number; hold: Hold } | undefined;
  #failed = false;
  constructor(private readonly take: Take = takeHold) {}
  set(running: number): void {
    if (running === 0) {
      this.#failed = false;
      this.#held?.hold.release();
      this.#held = undefined;
      return;
    }
    if (this.#failed || this.#held?.running === running) return;
    let hold: Hold | undefined = undefined;
    hold = this.take(inhibitWhy(running), () => {
      if (hold && this.#held?.hold === hold) {
        this.#held = undefined;
        this.#failed = true;
      }
    });
    if (!hold) {
      this.#failed = true;
      return;
    }
    // The old hold goes only after the new one is taken, so there is no gap.
    const old = this.#held;
    this.#held = { running, hold };
    old?.hold.release();
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

// What the screens bench reads off a live view: each frame as it reaches the watcher (when, how big on each hop),
// the CPU of this process and of the processes the screen runs in, and the time from an input to the frame that shows
// it. Shared by every kind's bench (bench/screens/*.ts).
import { readdirSync, readFileSync } from "node:fs";

/** A frame as the watcher got it: when (ms, performance.now), its picture's bytes, and its bytes on the wire. */
export type Seen = { at: number; bytes: number; wire: number };

/** CPU time of a process in ms (utime + stime from /proc), or undefined once it's gone. */
export function cpuOf(pid: number): number | undefined {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    // utime and stime are fields 14 and 15 (1-based), 12 and 13 after the name.
    return ((Number(fields[11]) + Number(fields[12])) * 1000) / 100;
  } catch {
    return undefined;
  }
}

/** `pid` and every process under it. */
export function tree(pid: number): number[] {
  const out = [pid];
  for (let i = 0; i < out.length; i++) {
    let tasks: string[] = [];
    try {
      tasks = readdirSync(`/proc/${out[i]}/task`);
    } catch {}
    for (const t of tasks) {
      try {
        for (const c of readFileSync(`/proc/${out[i]}/task/${t}/children`, "utf8").split(" ")) if (c.trim()) out.push(Number(c));
      } catch {}
    }
  }
  return out;
}

/** This process's CPU in ms. */
export const selfCpu = () => {
  const u = process.cpuUsage();
  return (u.user + u.system) / 1000;
};

/** CPU used over a span, in % of one core: this process and `pids` together. */
export class CpuSpan {
  private readonly from: number;
  private readonly self: number;
  private readonly others: number;
  constructor(private readonly pids: () => number[]) {
    this.from = performance.now();
    this.self = selfCpu();
    this.others = this.sum();
  }
  private sum(): number {
    // Each screen process with everything it started (a browser's renderers, a terminal's shell).
    return [...new Set(this.pids().flatMap(tree))].reduce((n, p) => n + (cpuOf(p) ?? 0), 0);
  }
  /** `{ node, screen }`: % of a core for this process (the node's part) and for the screen's own processes. */
  end(): { node: number; screen: number } {
    const ms = Math.max(performance.now() - this.from, 1);
    return { node: ((selfCpu() - this.self) / ms) * 100, screen: ((this.sum() - this.others) / ms) * 100 };
  }
}

/** Frames seen in a span: fps, bytes a second (picture and wire), the gaps between frames. */
export function rate(frames: Seen[], from: number, to: number) {
  const inside = frames.filter((f) => f.at >= from && f.at < to);
  const secs = Math.max((to - from) / 1000, 0.001);
  return {
    frames: inside.length,
    fps: inside.length / secs,
    bytesPerSec: inside.reduce((n, f) => n + f.bytes, 0) / secs,
    wirePerSec: inside.reduce((n, f) => n + f.wire, 0) / secs,
    meanBytes: inside.length ? inside.reduce((n, f) => n + f.bytes, 0) / inside.length : 0,
  };
}

/** The median and 95th percentile of `xs`. */
export function spread(xs: number[]): { p50: number; p95: number; n: number } {
  const s = [...xs].filter(Number.isFinite).sort((a, b) => a - b);
  const at = (q: number) => (s.length ? s[Math.min(s.length - 1, Math.floor(q * s.length))]! : Number.NaN);
  return { p50: at(0.5), p95: at(0.95), n: s.length };
}

/** Resolves with the first frame seen after now, or undefined after `ms`. */
export function nextFrame(frames: Seen[], ms: number): Promise<Seen | undefined> {
  const n = frames.length;
  const until = performance.now() + ms;
  return new Promise((resolve) => {
    const look = () => {
      if (frames.length > n) return resolve(frames[n]);
      if (performance.now() > until) return resolve(undefined);
      setTimeout(look, 1);
    };
    look();
  });
}

/** Waits until no frame has come for `quietMs` (the screen settled), `maxMs` at most. */
export async function settle(frames: Seen[], quietMs: number, maxMs: number): Promise<void> {
  const until = performance.now() + maxMs;
  while (performance.now() < until) {
    const last = frames.at(-1)?.at ?? 0;
    if (performance.now() - last >= quietMs) return;
    await Bun.sleep(10);
  }
}

export const round = (n: number, d = 0) => (Number.isFinite(n) ? Number(n.toFixed(d)) : null);

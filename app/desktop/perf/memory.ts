// Idle memory over the app's process tree. Every Chromium process maps the same Electron framework, so summed RSS
// counts those pages once per process; the budget is deduplicated memory instead: PSS on Linux, and on macOS the
// physical footprint top reports (Activity Monitor's Memory column), which proc_pid_rusage gives for our own
// processes without any entitlement. A process that can't be read fails the measurement; it never counts as 0.

export interface Proc {
  readonly pid: number;
  readonly ppid: number;
  readonly rssKb: number;
  readonly args: string;
}

/** `ps -A -o pid=,ppid=,rss=,args=` rows. */
export const parsePs = (text: string): Array<Proc> =>
  text.split("\n").flatMap((line) => {
    const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/u.exec(line);
    return m === null ? [] : [{ pid: Number(m[1]), ppid: Number(m[2]), rssKb: Number(m[3]), args: m[4] ?? "" }];
  });

/** The pids under `root`, root included. */
export const tree = (procs: ReadonlyArray<Proc>, root: number): Array<Proc> => {
  const pids = new Set([root]);
  for (let grew = true; grew; ) {
    grew = false;
    for (const p of procs) {
      if (!pids.has(p.pid) && pids.has(p.ppid)) {
        pids.add(p.pid);
        grew = true;
      }
    }
  }
  return procs.filter((p) => pids.has(p.pid));
};

const UNITS: Record<string, number> = { B: 1 / 1024, K: 1, M: 1024, G: 1024 * 1024 };

/** `top -l 1 -stats pid,mem` (macOS): KB per pid. MEM reads like 45M, 1024K+ or 1.2G-. */
export const parseTopMem = (text: string): Map<number, number> => {
  const out = new Map<number, number>();
  for (const line of text.split("\n")) {
    const m = /^\s*(\d+)\s+([\d.]+)([BKMG])[+-]?\s*$/u.exec(line);
    if (m !== null) out.set(Number(m[1]), Number(m[2]) * (UNITS[m[3] ?? ""] ?? Number.NaN));
  }
  return out;
};

/** Chromium's process type from its command line; the root process (no --type) is the browser. */
export const kindOf = (args: string): string => /--type=(\S+)/u.exec(args)?.[1] ?? "browser";

const REQUIRED = ["browser", "renderer", "gpu-process"];

export interface Account {
  readonly uniqueKb: number;
  readonly rssKb: number;
  readonly processes: number;
  readonly kinds: ReadonlyArray<string>;
}

/**
 * Sums `read` (KB per pid) over `procs`. Throws when a process that is still alive wasn't read, or when the browser,
 * a renderer or the GPU process is missing, so a parsing or permission problem can't print a small number and pass.
 */
export const account = (procs: ReadonlyArray<Proc>, read: ReadonlyMap<number, number>, alive: (pid: number) => boolean): Account => {
  const unread = procs.filter((p) => !Number.isFinite(read.get(p.pid) ?? Number.NaN) && alive(p.pid));
  if (unread.length > 0) throw new Error(`could not read the memory of ${unread.map((p) => `${p.pid} (${kindOf(p.args)})`).join(", ")}`);
  const kinds = procs.filter((p) => read.has(p.pid)).map((p) => kindOf(p.args));
  const missing = REQUIRED.filter((k) => !kinds.includes(k));
  if (missing.length > 0) throw new Error(`the app's process tree has no ${missing.join(", ")} (it has ${kinds.join(", ")})`);
  const counted = procs.filter((p) => read.has(p.pid));
  return {
    uniqueKb: counted.reduce((sum, p) => sum + (read.get(p.pid) ?? 0), 0),
    rssKb: counted.reduce((sum, p) => sum + p.rssKb, 0),
    processes: counted.length,
    kinds,
  };
};

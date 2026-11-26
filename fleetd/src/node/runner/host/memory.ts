// What the agent hears when its session's memory cap (../scope.ts `memoryCap`) kills one of its processes. The kernel
// kills inside the session's own scope, the process that holds the most there; the scope stays (`OOMPolicy=continue`),
// so claude and the rest of the session run on, and the killed command's result says only that it was killed (exit
// 137). The host (`watchMemory`) reads its scope's `memory.events` every second; when `oom_kill` goes up it writes, beside
// its dir (`noteFile`), which process it was and why, and the session's PostToolUse hook (`memoryHook`) hands that to
// claude with the next tool result, once.
//
// The kernel logs which process it killed, but most users can't read that log, so the host names it itself: while
// the scope holds a quarter of its cap or more it notes each of its processes each second, and the one killed is the one gone
// since that the kernel would pick first (most memory, plus its OOM score's share of the cap).
import { type FSWatcher, readFileSync, renameSync, watch, writeFileSync } from "node:fs";
import { totalmem } from "node:os";
import { nowIso } from "../../util.ts";

/** Where the host in `dir` leaves the note: beside the dir, which the session's next host starts afresh. */
export const noteFile = (dir: string) => `${dir}.memory`;

const TICK_MS = 1_000;

/** This process's cgroup v2 dir, undefined outside one (macOS, cgroup v1). */
export function ownCgroup(text = read("/proc/self/cgroup")): string | undefined {
  const path = text
    ?.split("\n")
    .find((l) => l.startsWith("0::"))
    ?.slice(3);
  return path ? `/sys/fs/cgroup${path === "/" ? "" : path}` : undefined;
}

function read(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

/** `oom_kill` in a cgroup's `memory.events`. */
export const oomKills = (events: string | undefined) => Number(/^oom_kill (\d+)$/m.exec(events ?? "")?.[1] ?? 0);

/** One of the scope's processes as last seen. */
export type Seen = { pid: number; command: string; bytes: number; adj: number };

function seen(pid: number): Seen | undefined {
  const status = read(`/proc/${pid}/status`);
  if (!status) return undefined;
  const kb = (field: string) => Number(new RegExp(`^${field}:\\s+(\\d+) kB$`, "m").exec(status)?.[1] ?? 0);
  const argv = (read(`/proc/${pid}/cmdline`) ?? "").split("\0").filter((a) => a !== "");
  const name = /^Name:\s+(.*)$/m.exec(status)?.[1] ?? "?";
  const command = argv.length ? argv.join(" ") : name;
  return { pid, command, bytes: (kb("VmRSS") + kb("VmSwap")) * 1024, adj: Number(read(`/proc/${pid}/oom_score_adj`)?.trim() ?? 0) };
}

/** Of the processes seen before a kill and gone after it, the one the kernel picks first in a cgroup capped at `max`. */
export function killed(before: Seen[], alive: (pid: number) => boolean, max: number): Seen | undefined {
  const badness = (s: Seen) => s.bytes + (s.adj * max) / 1000;
  return before.filter((s) => !alive(s.pid)).sort((a, b) => badness(b) - badness(a))[0];
}

/** SIGKILL's bit in /proc/<pid>/status's pending masks, and the kernel's PF_EXITING in /proc/<pid>/stat's flags. */
const SIGKILL_BIT = 1n << 8n;
const PF_EXITING = 0x4;

/** Whether `pid` is gone, a zombie or on its way out (a SIGKILL pending, or exiting): one the kernel killed counts from
 * the kill, before it has finished exiting and before its parent reaps it, so a kill read as it happens names it. */
function exited(pid: number): boolean {
  const stat = read(`/proc/${pid}/stat`);
  if (stat === undefined) return true;
  const fields = stat.slice(stat.lastIndexOf(")") + 1).trim().split(" ");
  if (fields[0] === "Z" || fields[0] === "X" || (Number(fields[6]) & PF_EXITING) !== 0) return true;
  const status = read(`/proc/${pid}/status`) ?? "";
  return ["ShdPnd", "SigPnd"].some((k) => (BigInt(`0x${new RegExp(`^${k}:\\s+([0-9a-f]+)$`, "m").exec(status)?.[1] ?? "0"}`) & SIGKILL_BIT) !== 0n);
}

const gb = (bytes: number) => `${(bytes / 1024 ** 3).toFixed(1)} GB`;
const MAX_COMMAND = 160;

/** The words the agent reads: what was killed, why, and that nothing else was. */
export function words(victim: Seen | undefined, max: number, at: string, machine = totalmem()): string {
  const what = victim
    ? `\`${victim.command.length > MAX_COMMAND ? `${victim.command.slice(0, MAX_COMMAND)}…` : victim.command}\` (pid ${victim.pid}, ${gb(victim.bytes)})`
    : "a process of this session";
  return (
    `fleetd: at ${at.slice(11, 19)} UTC the kernel killed ${what}: this session went past its memory cap of ${gb(max)} ` +
    `(this machine's ${gb(machine)} less what it keeps for the system, fleetd and other agents). Only that process was killed; the rest of the session runs on. ` +
    `Run it again with less memory (fewer workers or a smaller input), or find what grew.`
  );
}

/** Adds `line` to the note in `file`, which holds the unread lines as one JSON string. */
function note(file: string, line: string): void {
  let text = line;
  try {
    text = `${JSON.parse(readFileSync(file, "utf8")) as string}\n${line}`;
  } catch {}
  writeFileSync(`${file}.tmp`, JSON.stringify(text));
  renameSync(`${file}.tmp`, file);
}

/** Watches this process's cgroup for kills by its memory cap and notes each in `file`. Nothing where the cgroup has no
 * cap (no scope, macOS). Returns a stop, which reads the cgroup's kills once more. `outside`: the watcher isn't in the
 * cgroup (a heavy run's scope, heavy_slots.ts), so it also reads each kill as it happens (inotify on `memory.events`,
 * which the kernel marks changed at each), not at the next tick: a run whose killed step was its last ends at once, and
 * its scope with it. Never from inside: at the kill the cgroup is still full, and a host that wakes there to read /proc
 * and write its note was often killed as well. */
export function watchMemory(file: string, cgroup = ownCgroup(), tick = TICK_MS, outside = false): () => void {
  const max = Number(cgroup ? read(`${cgroup}/memory.max`)?.trim() : NaN);
  if (!cgroup || !Number.isFinite(max) || max <= 0) return () => {};
  let kills = oomKills(read(`${cgroup}/memory.events`));
  let before: Seen[] = [];
  const check = () => {
    const now = oomKills(read(`${cgroup}/memory.events`));
    if (now > kills) {
      const victim = killed(before, (pid) => !exited(pid), max);
      try {
        note(file, words(victim, max, nowIso()));
      } catch (error) {
        process.stderr.write(`${nowIso()} WARN a memory kill was not noted: ${(error as Error).message}\n`);
      }
      process.stderr.write(`${nowIso()} WARN the session's memory cap killed ${victim ? `pid ${victim.pid}` : "a process"} {"cap":${max}}\n`);
      kills = now;
    }
  };
  const timer = setInterval(() => {
    check();
    const current = Number(read(`${cgroup}/memory.current`)?.trim() ?? 0);
    before = current * 4 >= max ? pids(cgroup).flatMap((pid) => seen(pid) ?? []) : [];
  }, tick);
  timer.unref();
  let changed: FSWatcher | undefined;
  if (outside) {
    try {
      changed = watch(`${cgroup}/memory.events`, check);
      changed.on("error", () => changed?.close());
      changed.unref?.();
    } catch {}
  }
  return () => {
    clearInterval(timer);
    changed?.close();
    check();
  };
}

const pids = (cgroup: string) =>
  (read(`${cgroup}/cgroup.procs`) ?? "")
    .split("\n")
    .map(Number)
    .filter((pid) => pid > 0 && pid !== process.pid);

/** The PostToolUse (or PostToolUseFailure, `event`) hook that hands claude the note in `file` once, as context beside
 * the tool's result: free while there is none. */
export const memoryHook = (file: string, event: "PostToolUse" | "PostToolUseFailure") => {
  const f = `'${file.replaceAll("'", "'\\''")}'`;
  return `test -e ${f} || exit 0; t=${f}.$$; mv -f ${f} "$t" 2>/dev/null || exit 0; printf '{"hookSpecificOutput":{"hookEventName":"${event}","additionalContext":%s}}' "$(cat "$t")"; rm -f "$t"`;
};

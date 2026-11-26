// The machine a node runs on, as a screen's measures report it (./perf.ts `stamp`'s `machine`): its cores, its CPU busy
// over them since the last read (the screens' stamps share one read a second), and its memory in use (Linux only).
import { cpus } from "node:os";
import { readFileSync } from "node:fs";
import { parseMeminfo, usedPct } from "../load/index.ts";
import { STAMP_EVERY_MS, type MachineNow } from "./perf.ts";

let cpuAt: { at: number; idle: number; total: number } | undefined;
let last: MachineNow | undefined;

function memPct(): number | undefined {
  if (process.platform !== "linux") return undefined;
  try {
    const m = parseMeminfo(readFileSync("/proc/meminfo", "utf8"));
    return m && usedPct(m);
  } catch {
    return undefined;
  }
}

/** This machine now, read at most once a second. */
export function machineNow(now: number): MachineNow {
  if (last !== undefined && cpuAt !== undefined && now - cpuAt.at < STAMP_EVERY_MS) return last;
  const all = cpus();
  let idle = 0;
  let total = 0;
  for (const c of all) {
    idle += c.times.idle;
    total += c.times.idle + c.times.user + c.times.nice + c.times.sys + c.times.irq;
  }
  const before = cpuAt;
  cpuAt = { at: now, idle, total };
  const cpu = before === undefined || total <= before.total ? undefined : Math.round((1 - (idle - before.idle) / (total - before.total)) * 100);
  const mem = memPct();
  last = { cores: all.length, ...(cpu === undefined ? {} : { cpuPct: cpu }), ...(mem === undefined ? {} : { memPct: mem }) };
  return last;
}

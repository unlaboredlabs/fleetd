// `node soak.ts [--impl <name>] [--bin <fleetd>] [--minutes 60]`: a fleet of the fleetd under test (hub, node,
// project, offline claude) kept busy for an hour: a writer every minute (200 tool calls, then stopped), 5 /app watchers
// on the board, a decision written every 10 s. Measured from outside, so the same for every implementation:
// - stalls: /healthz asked every 50 ms and an /app `fleetd_status` call every
//   second; an answer slower than 100 ms is a stall of the hub's serving (its event loop, for a single-threaded one);
// - memory: hub and node RSS every 10 s; growth is the least-squares slope after the first 5 minutes, in MB/h, and
//   last minus first;
// - CPU over the run.
// Writes results/<impl>/soak.json.
import path from "node:path";
import { connectApp } from "./app.ts";
import { withFleet } from "./fleet.ts";
import { arg, procStat, round, scratch, summary, target, uniqueTitle, writeResult } from "./lib.ts";

const { name, bin } = target();
const minutes = Number(arg("--minutes", undefined, "60"));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const STALL_MS = 100;

const slope = (points: Array<[number, number]>) => {
  const n = points.length;
  if (n < 2) return Number.NaN;
  const mx = points.reduce((s, p) => s + p[0], 0) / n;
  const my = points.reduce((s, p) => s + p[1], 0) / n;
  const num = points.reduce((s, p) => s + (p[0] - mx) * (p[1] - my), 0);
  const den = points.reduce((s, p) => s + (p[0] - mx) ** 2, 0);
  return den === 0 ? 0 : num / den;
};

let result: unknown;
await withFleet(path.join(scratch(`soak-${name}`), "f"), bin, async (fleet) => {
  const { f } = fleet;
  const r = await fleet.admin("cap_set", { cap: 10, machine: { machineId: f.ref.machineId, maxAgents: 10 }, project: { projectRef: f.ref, maxAgents: 10 } });
  if (r.isError) throw new Error(`cap_set: ${JSON.stringify(r.body)}`);
  const ws = f.workstream("The soak.");
  const watchers = Array.from({ length: 5 }, () => connectApp(f.hubUrl, fleet.humanKey, { deflate: true }));
  await Promise.all(watchers.map((w) => w.next((x) => x.t === "snapshot")));
  for (const w of watchers) w.send({ t: "live", board: true, focus: ws });

  const t0 = performance.now();
  const end = t0 + minutes * 60_000;
  const elapsedMin = () => (performance.now() - t0) / 60_000;
  const health: Array<number> = [];
  const calls: Array<number> = [];
  const stalls: Array<{ atMin: number; ms: number; probe: string }> = [];
  const memory: Array<{ atMin: number; hubMb: number; nodeMb: number }> = [];
  const cpu0 = { hub: procStat(fleet.hubPid)?.cpuMs ?? 0, node: procStat(fleet.nodePid() ?? -1)?.cpuMs ?? 0 };
  let writers = 0;
  let failures = 0;

  const healthLoop = (async () => {
    while (performance.now() < end) {
      const s = performance.now();
      const ok = await fetch(`${f.hubUrl}/healthz`).then((x) => x.ok, () => false);
      const ms = performance.now() - s;
      if (!ok) failures++;
      health.push(ms);
      if (ms > STALL_MS) stalls.push({ atMin: round(elapsedMin(), 2), ms: round(ms, 0), probe: "healthz" });
      await sleep(50);
    }
  })();
  const callLoop = (async () => {
    while (performance.now() < end) {
      const s = performance.now();
      const out = await watchers[0]!.call("fleetd_status", {}, 30_000).catch(() => undefined);
      const ms = performance.now() - s;
      if (out?.ok !== true) failures++;
      calls.push(ms);
      if (ms > STALL_MS) stalls.push({ atMin: round(elapsedMin(), 2), ms: round(ms, 0), probe: "app call" });
      await sleep(Math.max(0, 1000 - ms));
    }
  })();
  const memoryLoop = (async () => {
    while (performance.now() < end) {
      memory.push({ atMin: round(elapsedMin(), 2), hubMb: round(procStat(fleet.hubPid)?.rssMb ?? Number.NaN, 1), nodeMb: round(procStat(fleet.nodePid() ?? -1)?.rssMb ?? Number.NaN, 1) });
      await sleep(10_000);
    }
  })();
  const decisionLoop = (async () => {
    for (let i = 0; performance.now() < end; i++) {
      await fleet.admin("decisions_record", { key: `compare.soak.d${i % 50}`, value: `soak write ${i}`, scope: { kind: "global" } }).catch(() => failures++);
      await sleep(10_000);
    }
  })();
  const writerLoop = (async () => {
    const prompt = ["Soak turn.", ...Array.from({ length: 200 }, (_, i) => `lab-run: echo ${i}`)].join("\n");
    while (performance.now() < end - 60_000) {
      const started = performance.now();
      const cursor = await f.cursor();
      const task = f.spawnWriter(ws, uniqueTitle(writers++), prompt);
      await fleet.turnsEnded([task.taskId as string], cursor, 300_000).then((r) => (failures += r.failed), () => failures++);
      f.lead("stop_agent", { taskId: task.taskId });
      await sleep(Math.max(0, 60_000 - (performance.now() - started)));
    }
  })();
  await Promise.all([healthLoop, callLoop, memoryLoop, decisionLoop, writerLoop]);
  for (const w of watchers) w.close();

  const steady = memory.filter((m) => m.atMin >= Math.min(5, minutes / 4));
  const growth = (k: "hubMb" | "nodeMb") => ({
    firstMb: memory[0]?.[k],
    lastMb: memory.at(-1)?.[k],
    maxMb: Math.max(...memory.map((m) => m[k])),
    slopeMbPerHour: round(slope(steady.map((m) => [m.atMin / 60, m[k]])), 1),
  });
  const wallS = (performance.now() - t0) / 1000;
  const cpu = (pid: number | undefined, from: number) => round(((procStat(pid ?? -1)?.cpuMs ?? from) - from) / 1000, 1);
  result = {
    minutes,
    writers,
    failures,
    stallThresholdMs: STALL_MS,
    stalls: { count: stalls.length, healthz: stalls.filter((s) => s.probe === "healthz").length, appCall: stalls.filter((s) => s.probe === "app call").length, worstMs: Math.max(0, ...stalls.map((s) => s.ms)), worst: stalls.sort((a, b) => b.ms - a.ms).slice(0, 10) },
    healthzMs: { ...summary(health), p99: round([...health].sort((a, b) => a - b)[Math.floor(0.99 * health.length)] ?? Number.NaN) },
    appCallMs: { ...summary(calls), p99: round([...calls].sort((a, b) => a - b)[Math.floor(0.99 * calls.length)] ?? Number.NaN) },
    hub: { ...growth("hubMb"), cpuS: cpu(fleet.hubPid, cpu0.hub), cpuPct: round((100 * cpu(fleet.hubPid, cpu0.hub)) / wallS, 2) },
    node: { ...growth("nodeMb"), cpuS: cpu(fleet.nodePid(), cpu0.node), cpuPct: round((100 * cpu(fleet.nodePid(), cpu0.node)) / wallS, 2) },
    memory,
  };
});
writeResult(name, "soak", result, bin);
process.exit(0);

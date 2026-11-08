// `node bench.ts [--impl <name>] [--bin <fleetd>] [<bench>…]`: the runtime numbers of one fleetd binary, the same
// script for every implementation; each bench writes results/<impl>/<bench>.json. Benches (default: all):
// - size: the binary's bytes.
// - startup: `fleetd --version` and `fleetd help`, 30 runs each (the first is the coldest the page cache allows).
// - hub-ready: `hub start` on a fresh home to /healthz 200, and again on the home it made (migrations done); the
//   hub's RSS at ready; SIGTERM to exit.
// - idle: a fleet (hub, node, project; tests/lab/factory) left alone for a minute: RSS, PSS and CPU of each.
// - sessions: #1127's 20-session bench from outside: 20 writers spawned, each holding at its first call until all
//   run, then all at once one turn of --calls tool calls (the offline claude stand-in's Bash calls, about 2 stream
//   lines each), followed by 5 /app watchers; from the go to every turn's end: wall time, CPU and peak RSS of hub,
//   node and the node's session hosts.
// - fanout: N /app watchers (1, 10, 50, 100) and 50 writes (decisions_record over MCP): each write's event to every
//   watcher, from the write's start: latency p50/p95/max, until the last watcher heard it, missed, and the hub's CPU.
// - sql: #1127's slow reads, through the tools: a hub whose database a fleet run filled with real events and time
//   spans, multiplied to --events / --spans, then reopened alone; events_list (busiest project, paging back, small,
//   small + hub-wide, none) and an order's time_spans / time_breakdown across 400 lead runs. Median of 9.
// - weaknet: #1128's connect numbers through scripts/netem.py (300 ms RTT, 1 Mbit/s, 1.5% loss, 128 KB queue; and a
//   clean link): dial → 101 → ready → snapshot → the first call's answer, and bytes down, median of 5.
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { connectApp } from "./app.ts";
import { withFleet, type Fleet } from "./fleet.ts";
import { arg, pssMb, procStat, REPO, round, sampler, scratch, summary, target, uniqueTitle, writeResult } from "./lib.ts";

const { name, bin } = target();
const ALL = ["size", "startup", "hub-ready", "idle", "sessions", "fanout", "sql", "weaknet"];
const positional = process.argv.slice(2).filter((a, i, all) => !a.startsWith("--") && !all[i - 1]?.startsWith("--"));
const wanted = positional.length === 0 ? ALL : positional;
const unknown = wanted.filter((w) => !ALL.includes(w));
if (unknown.length > 0) throw new Error(`unknown bench ${unknown.join(", ")}; known: ${ALL.join(", ")}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const num = (flag: string, fallback: number) => Number(arg(flag, undefined, String(fallback)));

const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const s = net.createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const port = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(port));
    });
  });

/** A hub of its own: fresh FLEETD_HOME and HOME under `dir`, its own port; stopped by its PID. */
const startHub = async (dir: string, port: number) => {
  fs.mkdirSync(path.join(dir, "user"), { recursive: true });
  const env = { HOME: path.join(dir, "user"), FLEETD_HOME: dir, PATH: process.env.PATH ?? "", LANG: "C.UTF-8", USER: process.env.USER ?? "bench" };
  const log = fs.openSync(path.join(dir, "hub.log"), "a");
  const t0 = performance.now();
  const child = spawn(bin, ["hub", "start", "--home", path.join(dir, "hub"), "--listen", `127.0.0.1:${port}`], { env, stdio: ["ignore", log, log] });
  fs.closeSync(log);
  const exited = new Promise<number | null>((r) => child.once("exit", (code) => r(code)));
  for (;;) {
    if (child.exitCode !== null) throw new Error(`the hub exited ${child.exitCode} before it was ready; see ${dir}/hub.log`);
    if (performance.now() - t0 > 120_000) throw new Error(`the hub wasn't ready in 120 s; see ${dir}/hub.log`);
    const up = await fetch(`http://127.0.0.1:${port}/healthz`).then((r) => r.ok, () => false);
    if (up) break;
    await sleep(5);
  }
  const readyMs = performance.now() - t0;
  return {
    env,
    url: `http://127.0.0.1:${port}`,
    pid: child.pid!,
    readyMs,
    stop: async () => {
      const s0 = performance.now();
      const timer = setTimeout(() => child.kill("SIGKILL"), 20_000);
      child.kill("SIGTERM");
      await exited;
      clearTimeout(timer);
      return performance.now() - s0;
    },
  };
};

const benches: Record<string, () => Promise<unknown>> = {
  size: async () => ({ bytes: fs.statSync(bin).size, mb: round(fs.statSync(bin).size / 2 ** 20, 1) }),

  startup: async () => {
    const home = scratch("startup-home");
    const run = (args: Array<string>) => {
      const t0 = performance.now();
      const r = spawnSync(bin, args, { stdio: "ignore", env: { PATH: process.env.PATH ?? "", HOME: home } });
      if (r.status !== 0) throw new Error(`fleetd ${args.join(" ")} exited ${r.status}`);
      return performance.now() - t0;
    };
    const series = (args: Array<string>) => {
      const xs = Array.from({ length: 30 }, () => run(args));
      return { first: round(xs[0]!), ...summary(xs.slice(1)) };
    };
    return { versionMs: series(["--version"]), helpMs: series(["help"]) };
  },

  "hub-ready": async () => {
    const fresh: Array<number> = [];
    const again: Array<number> = [];
    const rss: Array<number> = [];
    const stop: Array<number> = [];
    for (let i = 0; i < 7; i++) {
      const dir = scratch(`hub-ready-${name}`);
      const port = await freePort();
      const first = await startHub(dir, port);
      fresh.push(first.readyMs);
      rss.push(procStat(first.pid)?.rssMb ?? Number.NaN);
      stop.push(await first.stop());
      const second = await startHub(dir, port);
      again.push(second.readyMs);
      await second.stop();
      fs.rmSync(dir, { recursive: true, force: true });
    }
    return { freshHomeMs: summary(fresh), existingHomeMs: summary(again), rssAtReadyMb: summary(rss), sigtermToExitMs: summary(stop) };
  },

  idle: async () => {
    let out: unknown;
    await withFleet(path.join(scratch(`idle-${name}`), "f"), bin, async (fleet) => {
      await sleep(30_000);
      const groups = { hub: () => [fleet.hubPid], node: () => [fleet.nodePid() ?? -1] };
      const s = sampler(groups, 1000);
      await sleep(60_000);
      out = { ...s.stop(), hubPssMb: round(pssMb(fleet.hubPid) ?? Number.NaN, 1), nodePssMb: round(pssMb(fleet.nodePid() ?? -1) ?? Number.NaN, 1), settleS: 30, windowS: 60 };
    });
    return out;
  },

  sessions: async () => {
    const n = num("--sessions", 20);
    const calls = num("--calls", 250);
    let out: unknown;
    await withFleet(path.join(scratch(`ses-${name}`), "f"), bin, async (fleet) => {
      const { f } = fleet;
      await raiseCaps(fleet, n + 5);
      const ws = f.workstream("The 20-session bench.");
      const watchers = Array.from({ length: 5 }, () => connectApp(f.hubUrl, fleet.humanKey, { deflate: true }));
      await Promise.all(watchers.map((w) => w.next((x) => x.t === "snapshot")));
      for (const w of watchers) w.send({ t: "live", board: true, focus: ws });
      // Each writer's first call waits for the go file, so all n stream their calls at once once it's there.
      const go = path.join(f.dir, "go");
      const prompt = ["One long turn.", `lab-run: while [ ! -e '${go}' ]; do sleep 0.05; done`, ...Array.from({ length: calls }, (_, i) => `lab-run: echo ${i}`)].join("\n");
      const cursor = await f.cursor();
      const s0 = performance.now();
      const tasks = Array.from({ length: n }, (_, i) => f.spawnWriter(ws, uniqueTitle(i), prompt));
      const spawnedMs = performance.now() - s0;
      await f.until(`${n} writers running`, 120_000, async () => ((await f.running()) >= n ? true : (await sleep(250), undefined)));
      const s = sampler({ hub: () => [fleet.hubPid], node: () => [fleet.nodePid() ?? -1], hosts: fleet.hostPids }, 250);
      const t0 = performance.now();
      fs.writeFileSync(go, "");
      const { failed } = await fleet.turnsEnded(tasks.map((t) => t.taskId as string), cursor, 900_000);
      const wallMs = performance.now() - t0;
      const usage = s.stop();
      const frames = watchers.map((w) => w.frames.length);
      for (const w of watchers) w.close();
      for (const t of tasks) f.lead("stop_agent", { taskId: t.taskId });
      out = { sessions: n, callsPerSession: calls, followed: watchers.length, turnsFailed: failed, wallMs: round(wallMs, 0), spawnMs: round(spawnedMs, 0), ...usage, framesPerWatcher: summary(frames) };
    });
    return out;
  },

  fanout: async () => {
    const sizes = (arg("--watchers") ?? "1,10,50,100").split(",").map(Number);
    const writes = num("--writes", 50);
    const out: Record<string, unknown> = {};
    await withFleet(path.join(scratch(`fan-${name}`), "f"), bin, async (fleet) => {
      const { f } = fleet;
      for (const size of sizes) {
        const watchers = Array.from({ length: size }, () => connectApp(f.hubUrl, fleet.humanKey, { deflate: true }));
        await Promise.all(watchers.map((w) => w.next((x) => x.t === "snapshot", 60_000)));
        await sleep(500);
        const s = sampler({ hub: () => [fleet.hubPid] }, 100);
        const latencies: Array<number> = [];
        const allHeard: Array<number> = [];
        let missed = 0;
        for (let i = 0; i < writes; i++) {
          const key = `compare.fanout.n${size}.w${i}`;
          const t0 = performance.now();
          const hear = watchers.map((w) => w.next((x) => x.t === "event" && JSON.stringify(x).includes(key), 10_000, t0).then((x) => x.at - t0, () => undefined));
          const wrote = await fleet.admin("decisions_record", { key, value: `write ${i}`, scope: { kind: "global" } });
          if (wrote.isError) throw new Error(`decisions_record: ${JSON.stringify(wrote.body)}`);
          const heard = await Promise.all(hear);
          for (const ms of heard) ms === undefined ? missed++ : latencies.push(ms);
          allHeard.push(Math.max(...heard.map((ms) => ms ?? Number.NaN)));
        }
        const usage = s.stop();
        out[`watchers${size}`] = {
          watchers: size,
          writes,
          latencyMs: summary(latencies),
          p95Ms: round(latencies.sort((a, b) => a - b)[Math.floor(0.95 * latencies.length)] ?? Number.NaN),
          allHeardMs: summary(allHeard),
          missed,
          hubCpuMs: usage.hub?.cpuMs,
          hubPeakRssMb: usage.hub?.peakRssMb,
        };
        for (const w of watchers) w.close();
        await sleep(1000);
      }
    });
    return out;
  },

  sql: async () => {
    const root = scratch(`sql-${name}`);
    const dir = path.join(root, "f");
    let ref: { machineId: string; projectId: string } | undefined;
    let workstream = "";
    // A real run first, so every seeded row is one this implementation wrote and reads back.
    await withFleet(dir, bin, async (fleet) => {
      const { f } = fleet;
      ref = f.ref;
      await f.leadDigest();
      workstream = f.workstream("SQL bench order.");
      const cursor = await f.cursor();
      const tasks = Array.from({ length: 3 }, (_, i) => f.spawnWriter(workstream, uniqueTitle(i), ["Seed.", ...Array.from({ length: 10 }, (_, j) => `lab-run: echo ${j}`)].join("\n")));
      await fleet.turnsEnded(tasks.map((t) => t.taskId as string), cursor, 300_000);
      for (const t of tasks) f.lead("stop_agent", { taskId: t.taskId });
      await sleep(5000);
    });
    const dbFile = findDb(path.join(dir, "hub"));
    const seeded = seed(dbFile, ref!, workstream, num("--events", 70_000), num("--spans", 200_000), num("--lead-runs", 400));
    const hub = await startHub(dir, await freePort());
    try {
      const keyFile = path.join(root, "sql.key");
      // The reopened hub may hold the database a while (its projectors catching up on the seeded rows).
      for (let i = 0; ; i++) {
        const made = spawnSync(bin, ["hub", "key", "create", "--name", "sql", "--role", "admin", "--machines", "*", "--out", keyFile], { env: { ...hub.env, HOME: path.join(dir, "hub-user") }, encoding: "utf8" });
        if (made.status === 0) break;
        if (i === 120 || !/locked|busy/u.test(made.stderr)) throw new Error(`hub key create: ${made.stderr}${made.stdout}`);
        await sleep(500);
      }
      await settled(hub.pid);
      const call = mcpCaller(hub.url, fs.readFileSync(keyFile, "utf8").trim());
      const since = new Date(Date.now() - 30 * 86_400_000).toISOString();
      const mid = seeded.midSeq;
      const cases: Array<[string, string, Record<string, unknown>]> = [
        ["events_list busiest project", "events_list", { projectRef: ref, limit: 51 }],
        ["events_list busiest, paging back", "events_list", { projectRef: ref, limit: 51, before: mid }],
        ["events_list small project (425 events)", "events_list", { projectRef: { machineId: ref!.machineId, projectId: "bench-small" }, limit: 51 }],
        ["events_list small + hub-wide", "events_list", { projectRef: { machineId: ref!.machineId, projectId: "bench-small" }, limit: 51, hubWide: true }],
        ["events_list project with no events", "events_list", { projectRef: { machineId: ref!.machineId, projectId: "bench-none" }, limit: 51 }],
        [`time_spans order with ${seeded.leadRuns} lead runs`, "time_spans", { scope: { kind: "order", workstreamId: workstream }, since, limit: 500 }],
        ["time_breakdown that order", "time_breakdown", { scope: { kind: "order", workstreamId: workstream }, since }],
        ["time_breakdown fleet, 30 days", "time_breakdown", { scope: { kind: "fleet" }, since }],
      ];
      const results: Record<string, unknown> = {};
      for (const [label, tool, input] of cases) {
        const first = await call(tool, input);
        if (first.error !== undefined) {
          results[label] = { error: first.error };
          continue;
        }
        const xs: Array<number> = [];
        for (let i = 0; i < 9; i++) xs.push((await call(tool, input)).ms);
        results[label] = { ms: summary(xs), rows: first.rows };
      }
      return { db: seeded, queries: results, hubReadyOnSeededDbMs: round(hub.readyMs, 0) };
    } finally {
      await hub.stop();
      fs.rmSync(root, { recursive: true, force: true });
    }
  },

  weaknet: async () => {
    const runs = num("--runs", 5);
    const links: Record<string, Array<string>> = {
      slow: ["--rtt", "0.3", "--loss", "0.015", "--mbit", "1", "--queue", "131072"],
      clean: ["--rtt", "0", "--loss", "0", "--mbit", "1000"],
    };
    const out: Record<string, unknown> = {};
    await withFleet(path.join(scratch(`net-${name}`), "f"), bin, async (fleet) => {
      const hubPort = Number(new URL(fleet.f.hubUrl).port);
      for (const [link, args] of Object.entries(links)) {
        const [listen, control] = [await freePort(), await freePort()];
        const proxy = spawn("python3", ["-I", path.join(REPO, "scripts/netem.py"), "--listen", String(listen), "--target", String(hubPort), "--control", String(control), ...args], { stdio: "ignore" });
        try {
          await waitPort(control);
          const rows: Array<Record<string, number>> = [];
          for (let i = 0; i < runs; i++) {
            await netem(control, "reset");
            const t0 = performance.now();
            const app = connectApp(`http://127.0.0.1:${listen}`, fleet.humanKey, { deflate: true });
            const opened = (await app.opened) - t0;
            const ready = (await app.next((x) => x.t === "ready", 60_000, 0)).at - t0;
            const snapshot = (await app.next((x) => x.t === "snapshot", 60_000, 0)).at - t0;
            const c0 = performance.now();
            const answered = await app.call("fleetd_status", {}, 60_000);
            const call = performance.now() - c0;
            const stats = (await netem(control, "stats")) as { down: number; up: number };
            app.close();
            rows.push({ opened, ready, snapshot, firstCall: call, ok: answered.ok ? 1 : 0, bytesDown: stats.down, bytesUp: stats.up });
            await sleep(500);
          }
          out[link] = Object.fromEntries(Object.keys(rows[0]!).map((k) => [k, summary(rows.map((r) => r[k]!))]));
        } finally {
          proxy.kill("SIGTERM");
        }
      }
    });
    return { ...out, links };
  },
};

/** Waits (up to 2 min) until a process uses under 5% of a core over a second: done with start-up work. */
const settled = async (pid: number) => {
  for (let i = 0; i < 120; i++) {
    const a = procStat(pid)?.cpuMs ?? 0;
    await sleep(1000);
    if ((procStat(pid)?.cpuMs ?? 0) - a < 50) return;
  }
};

/** Lifts the fleet, machine and project caps to `n` agents, so a bench's writers all run at once. */
const raiseCaps = async (fleet: Fleet, n: number) => {
  const r = await fleet.admin("cap_set", { cap: n, machine: { machineId: fleet.f.ref.machineId, maxAgents: n }, project: { projectRef: fleet.f.ref, maxAgents: n } });
  if (r.isError) throw new Error(`cap_set: ${JSON.stringify(r.body)}`);
};

const waitPort = async (port: number) => {
  for (let i = 0; i < 200; i++) {
    const ok = await new Promise<boolean>((r) => net.connect(port, "127.0.0.1").once("connect", function (this: net.Socket) { this.end(); r(true); }).once("error", () => r(false)));
    if (ok) return;
    await sleep(50);
  }
  throw new Error(`nothing listens on ${port}`);
};

/** One command to netem.py's control port; its JSON answer. */
const netem = (port: number, command: string) =>
  new Promise<unknown>((resolve, reject) => {
    const c = net.connect(port, "127.0.0.1", () => c.write(`${command}\n`));
    let text = "";
    c.on("data", (d) => {
      text += d;
      if (text.includes("\n")) {
        c.end();
        resolve(JSON.parse(text));
      }
    });
    c.on("error", reject);
  });

/** The hub's database file under its home (the name is the implementation's: hub.sqlite in Rust's). */
const findDb = (hubHome: string): string => {
  const found = fs.readdirSync(hubHome, { recursive: true, encoding: "utf8" }).find((p) => /hub\.(sqlite|db)$/u.test(p));
  if (found === undefined) throw new Error(`no hub database under ${hubHome}`);
  return path.join(hubHome, found);
};

/**
 * Multiplies what a real run wrote: its events, spread over the busiest (the real) project, a small one (425
 * events), the hub-wide log and none; its time spans, as the lead's turns over `leadRuns` runs of one order plus
 * many more of the same lead outside it (the shape that made #1127's order query walk the lead's whole history).
 */
const seed = (file: string, ref: { machineId: string; projectId: string }, workstream: string, events: number, spans: number, leadRuns: number) => {
  const db = new DatabaseSync(file);
  try {
    db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = OFF;");
    const now = Date.now();
    const templates = db.prepare("SELECT type, machine_id, data FROM events WHERE machine_id = ? AND json_extract(data, '$.projectId') = ?").all(ref.machineId, ref.projectId) as Array<{ type: string; machine_id: string; data: string }>;
    const hubWide = db.prepare("SELECT type, data FROM events WHERE machine_id IS NULL AND json_extract(data, '$.projectId') IS NULL").all() as Array<{ type: string; data: string }>;
    if (templates.length === 0) throw new Error("the seed run wrote no project events to copy");
    const insert = db.prepare("INSERT INTO events (created_ms, type, machine_id, data) VALUES (?, ?, ?, ?)");
    const at = (i: number, n: number) => now - 2 * 86_400_000 + Math.floor((i / n) * 2 * 86_400_000);
    db.exec("BEGIN");
    let midSeq = 0;
    for (let i = 0; i < events; i++) {
      const r = i % 100;
      const t = templates[i % templates.length]!;
      const when = at(i, events);
      const stamp = (data: string, projectId: string | null) => {
        const parsed = JSON.parse(data) as Record<string, unknown>;
        parsed.at = new Date(when).toISOString();
        if (projectId !== null) parsed.projectId = projectId;
        return JSON.stringify(parsed);
      };
      if (r < 5 && hubWide.length > 0) {
        const h = hubWide[i % hubWide.length]!;
        insert.run(when, h.type, null, stamp(h.data, null));
      } else if (i % Math.max(1, Math.floor(events / 425)) === 0) insert.run(when, t.type, t.machine_id, stamp(t.data, "bench-small"));
      else insert.run(when, t.type, t.machine_id, stamp(t.data, ref.projectId));
      if (i === Math.floor(events / 3)) midSeq = Number((db.prepare("SELECT max(seq) s FROM events").get() as { s: number }).s);
    }
    db.exec("COMMIT");
    // Spans: the lead's own, copied over `leadRuns` runs of this order and 5x as many outside it.
    const cols = (db.prepare("PRAGMA table_info(time_spans)").all() as Array<{ name: string }>).map((c) => c.name).filter((c) => c !== "id");
    const leadSpans = db.prepare("SELECT * FROM time_spans WHERE role = 'lead'").all() as Array<Record<string, unknown>>;
    const anySpans = leadSpans.length > 0 ? leadSpans : (db.prepare("SELECT * FROM time_spans").all() as Array<Record<string, unknown>>);
    if (anySpans.length === 0) throw new Error("the seed run wrote no time spans to copy");
    const lead = anySpans[0]!;
    const spanInsert = db.prepare(`INSERT INTO time_spans (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`);
    const runInsert = db.prepare("INSERT OR IGNORE INTO time_lead_runs (machine_id, thread_id, run_id, workstream_id, n, at_ms) VALUES (?, ?, ?, ?, ?, ?)");
    const allRuns = leadRuns * 6;
    db.exec("BEGIN");
    for (let i = 0; i < spans; i++) {
      const t = anySpans[i % anySpans.length]!;
      const run = `bench-run-${i % allRuns}`;
      const start = at(i, spans);
      const row: Record<string, unknown> = { ...t, src_key: `${String(t.src_key)}-bench-${i}`, start_ms: start, end_ms: start + 1500, run_id: run, machine_id: lead.machine_id, thread_id: lead.thread_id, role: "lead", workstream_id: null };
      spanInsert.run(...(cols.map((c) => (row[c] ?? null) as never)));
    }
    for (let r = 0; r < leadRuns; r++) runInsert.run(lead.machine_id as string, lead.thread_id as string, `bench-run-${r}`, workstream, 1, now - 86_400_000 + r * 1000);
    db.exec("COMMIT");
    const count = (table: string) => Number((db.prepare(`SELECT count(*) n FROM ${table}`).get() as { n: number }).n);
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    return { events: count("events"), spans: count("time_spans"), leadRuns: count("time_lead_runs"), midSeq, mb: round(fs.statSync(file).size / 2 ** 20, 1) };
  } finally {
    db.close();
  }
};

/** Plain MCP over HTTP (initialize, then tools/call), timed per call; enough for reads. */
const mcpCaller = (hubUrl: string, key: string) => {
  let session: string | undefined;
  let id = 0;
  const post = async (body: unknown) => {
    const r = await fetch(`${hubUrl}/mcp`, {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json", accept: "application/json, text/event-stream", ...(session === undefined ? {} : { "mcp-session-id": session }) },
      body: JSON.stringify(body),
    });
    session ??= r.headers.get("mcp-session-id") ?? undefined;
    const text = await r.text();
    return JSON.parse(text.startsWith("{") ? text : (/^data: (.*)$/mu.exec(text)?.[1] ?? "{}")) as { result?: { content?: Array<{ text: string }>; isError?: boolean }; error?: unknown };
  };
  let init: Promise<unknown> | undefined;
  return async (tool: string, args: unknown) => {
    init ??= post({ jsonrpc: "2.0", id: ++id, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "fleetd-compare", version: "0" } } });
    await init;
    const t0 = performance.now();
    const r = await post({ jsonrpc: "2.0", id: ++id, method: "tools/call", params: { name: tool, arguments: args } });
    const ms = performance.now() - t0;
    const text = r.result?.content?.[0]?.text ?? "";
    if (r.error !== undefined || r.result?.isError === true) return { ms, error: text || JSON.stringify(r.error) };
    const body = JSON.parse(text) as Record<string, unknown>;
    const rows = Object.values(body).find(Array.isArray) as Array<unknown> | undefined;
    return { ms, rows: rows?.length, error: undefined };
  };
};

for (const bench of wanted) {
  console.log(`${name} ${bench} …`);
  const t0 = performance.now();
  const data = await benches[bench]!();
  console.log(JSON.stringify(data));
  writeResult(name, bench, { ...(data as object), benchWallS: round((performance.now() - t0) / 1000, 0) }, bin);
}
process.exit(0);

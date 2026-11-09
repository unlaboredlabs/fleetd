// A hub starting on a big event log its time projector hasn't read: how soon it answers /healthz and an MCP call, the
// worst answer while the projector catches up, and how long the catch-up takes. Everything is in a throwaway
// FLEETD_HOME under $TMPDIR; the hub is stopped by the PID this started.
// `bun bench/start-backlog.ts [--events 500000] [--bin <fleetd>] [--keep | --seed-only]` (default: the hub run from
// source); --seed-only stops after the seed and keeps its home.
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, openSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { categoryCode, categoryOf, kindCode } from "../src/hub/time/kinds.ts";

const arg = (name: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i < 0 ? undefined : process.argv[i + 1];
};
const total = Number(arg("events") ?? 500_000);
const bin = arg("bin");
const seedOnly = process.argv.includes("--seed-only");
const keep = seedOnly || process.argv.includes("--keep");
const root = mkdtempSync(join(process.env.TMPDIR ?? "/tmp", "fleetd-backlog-"));
const hubHome = join(root, "hub");
mkdirSync(join(root, "user"), { recursive: true });
const env = { HOME: join(root, "user"), FLEETD_HOME: root, PATH: process.env.PATH ?? "", LANG: "C.UTF-8", USER: process.env.USER ?? "bench" };
const fleetd = bin === undefined ? [process.execPath, join(import.meta.dir, "../src/main.ts")] : [bin];
const port = 20_000 + Math.floor(Math.random() * 20_000);
const url = `http://127.0.0.1:${port}`;

const startHub = () => {
  const log = openSync(join(root, "hub.log"), "a");
  return Bun.spawn([...fleetd, "hub", "start", "--home", hubHome, "--listen", `127.0.0.1:${port}`], { env, stdout: log, stderr: log });
};
const healthy = () => fetch(`${url}/healthz`).then((r) => r.ok, () => false);
const untilHealthy = async (limitMs: number) => {
  const t0 = performance.now();
  while (!(await healthy())) {
    if (performance.now() - t0 > limitMs) throw new Error(`no /healthz in ${limitMs} ms; see ${root}/hub.log`);
    await Bun.sleep(2);
  }
  return performance.now() - t0;
};
const stop = async (p: ReturnType<typeof startHub>) => {
  p.kill("SIGTERM");
  await p.exited;
};

// 1. A fresh hub makes the database and its migrations; an admin key for the MCP call.
let hub = startHub();
await untilHealthy(30_000);
await stop(hub);
const keyFile = join(root, "bench.key");
const made = Bun.spawnSync([...fleetd, "hub", "key", "create", "--name", "bench", "--role", "admin", "--machines", "*", "--out", keyFile], { env });
if (made.exitCode !== 0) throw new Error(`hub key create: ${made.stderr.toString()}`);
const key = readFileSync(keyFile, "utf8").trim();

// 2. The backlog: `total` events over the last 25 days behind the projector's cursor, in the shapes it folds (an
// order's tasks queued, started, parked and done, its lead's wakes and turns, requests, offline writes) among others
// it skips; and ten node tool spans for each task's run.
const dbFile = join(hubHome, "hub.sqlite");
const seedStart = performance.now();
{
  const db = new Database(dbFile);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = OFF;");
  const insert = db.query("INSERT INTO events (created_ms, type, machine_id, data) VALUES (?1, ?2, ?3, ?4)");
  const spanInsert = db.query(
    `INSERT INTO time_spans (src, src_key, kind, cat, start_ms, end_ms, excl_ms, machine_id, project_id, workstream_id,
       task_id, thread_id, run_id, role, lane, status)
     VALUES ('n', ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, 'task', ?13, 0)`,
  );
  const bash = [kindCode("tool.bash"), categoryCode(categoryOf("tool.bash"))] as const;
  const now = Date.now();
  const span = 25 * 86_400_000;
  const m = "m-bench";
  const projectId = "bench";
  const lead = "th-lead";
  let i = 0;
  const add = (type: string, fields: Record<string, unknown>, data?: Record<string, unknown>) => {
    const at = now - span + Math.floor((i / total) * span);
    const event: Record<string, unknown> = { at: new Date(at).toISOString(), type, machineId: m, projectId, ...fields, summary: `${type} bench` };
    if (data !== undefined) event.data = data;
    insert.run(at, type, m, JSON.stringify(event));
    i += 1;
  };
  db.exec("BEGIN");
  for (let order = 1; i < total; order++) {
    const w = `W${order}`;
    const at = () => new Date(now - span + Math.floor((i / total) * span)).toISOString();
    add("workstream.created", {}, { workstreamId: w });
    for (let n = 0; n < 3 && i < total; n++) {
      const task = `T${order * 3 + n}`;
      const thread = `th-${task}`;
      add("lead.woken", { threadId: lead }, { firstTriggerAt: at(), workstreamIds: [w] });
      add("thread.started", { threadId: lead }, {});
      add("task.queued", {}, { taskId: task, queuedReason: "waiting for a slot", queuedKind: "slot" });
      add("task.started", { threadId: thread }, { taskId: task });
      add("thread.started", { threadId: thread }, {});
      add("thread.completed", { threadId: lead }, {});
      for (let k = 0; k < 6; k++) add("activity.tool", { threadId: thread }, { tool: "Bash" });
      const from = now - span + Math.floor((i / total) * span);
      for (let k = 0; k < 10; k++) {
        const start = from + k * 2000;
        spanInsert.run(`${thread}/${k}`, bash[0], bash[1], start, start + 1500, 1500, m, projectId, w, task, thread, `r-${task}`, `thread:${m}/${thread}`);
      }
      if (n === 1) {
        add("thread.usage_limited", { threadId: thread }, { runId: `r-${task}` });
        add("thread.started", { threadId: thread }, {});
      }
      add("request.opened", {}, { requestId: `Q${order * 3 + n}`, state: "open" });
      add("write.delivered", { threadId: thread }, { queuedAt: at() });
      add("thread.completed", { threadId: thread }, {});
      add("task.completed", { threadId: thread }, { taskId: task });
    }
    add("workstream.done", {}, { workstreamId: w });
  }
  db.exec("COMMIT");
  db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  db.close();
}
const seedMs = performance.now() - seedStart;
if (seedOnly) {
  console.log(`seeded ${total} events in ${Math.round(seedMs)} ms: FLEETD_HOME=${root}`);
  process.exit(0);
}

// 3. The hub again, on the backlog: /healthz, then an MCP call, timed from the spawn; then /healthz and the MCP call
// every 50 ms until the projector's cursor reaches the log's head, keeping the worst answer.
const mcp = async (id: number, method: string, params: unknown, session?: string) => {
  const r = await fetch(`${url}/mcp`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${key}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(session === undefined ? {} : { "mcp-session-id": session }),
    },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
  });
  const text = await r.text();
  if (!r.ok || !text.includes('"result"')) throw new Error(`mcp ${method}: ${r.status} ${text.slice(0, 300)}`);
  return r.headers.get("mcp-session-id") ?? session;
};
const reader = new Database(dbFile, { readonly: true });
const head = (reader.query("SELECT max(seq) AS s FROM events").get() as { s: number }).s;
const projected = () => (reader.query("SELECT value FROM time_cursors WHERE source = 'events'").get() as { value: number } | null)?.value ?? 0;

const t0 = performance.now();
hub = startHub();
try {
  const healthMs = await untilHealthy(300_000);
  const session = await mcp(1, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "bench", version: "0" } });
  await mcp(2, "tools/call", { name: "fleetd_status", arguments: {} }, session);
  const firstCallMs = performance.now() - t0;
  let worstHealth = 0;
  let worstCall = 0;
  let id = 3;
  let caughtUpMs: number | undefined;
  while (caughtUpMs === undefined) {
    const a = performance.now();
    await healthy();
    const b = performance.now();
    await mcp(id++, "tools/call", { name: "fleetd_status", arguments: {} }, session);
    const c = performance.now();
    worstHealth = Math.max(worstHealth, b - a);
    worstCall = Math.max(worstCall, c - b);
    if (projected() >= head) caughtUpMs = performance.now() - t0;
    else await Bun.sleep(50);
    if (performance.now() - t0 > 3_600_000) throw new Error("the projector didn't catch up in an hour");
  }
  const spans = (reader.query("SELECT count(*) AS n FROM time_spans").get() as { n: number }).n;
  console.log(
    JSON.stringify(
      {
        events: head,
        seedMs: Math.round(seedMs),
        healthzMs: Math.round(healthMs),
        firstMcpCallMs: Math.round(firstCallMs),
        worstHealthzMsDuringCatchUp: Math.round(worstHealth),
        worstMcpCallMsDuringCatchUp: Math.round(worstCall),
        catchUpMs: Math.round(caughtUpMs),
        spans,
      },
      null,
      2,
    ),
  );
} finally {
  await stop(hub);
  reader.close();
  if (!keep) rmSync(root, { recursive: true, force: true });
  else console.error(`kept ${root}`);
}

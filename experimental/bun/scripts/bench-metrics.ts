// metrics_get on one seeded database, through /mcp, on the Rust hub and then the Bun one:
//   bun scripts/bench-metrics.ts --rust <fleetd binary> [--bun dist/fleetd] [--merges 20000] [--touches 60000]
// A throwaway fleet under $TMPDIR (its own FLEETD_HOME, HOME and port): the Rust hub makes the database and an admin
// key, the seed fills metric_merges and metric_touches over 400 days on three repos, then each hub serves the same
// file in turn. A stand-in `gh` refuses every call, so nothing reaches GitHub. Every process is stopped by the PID it was started with.
import { Database } from "bun:sqlite";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const arg = (name: string, fallback?: string) => {
  const i = process.argv.indexOf(name);
  return i < 0 ? fallback : process.argv[i + 1];
};
const rustBin = arg("--rust");
const bunBin = arg("--bun", join(import.meta.dir, "../dist/fleetd"))!;
if (!rustBin) throw new Error("--rust <fleetd binary> is needed: it makes the database and the key");
const MERGES = Number(arg("--merges", "20000"));
const TOUCHES = Number(arg("--touches", "60000"));
const RUNS = 9;
const DAY = 86_400_000;

const root = mkdtempSync(join(process.env.TMPDIR ?? "/tmp", "fleetd-bench-metrics-"));
const home = join(root, "fleet");
const hubHome = join(home, "hub");
mkdirSync(join(home, "user"), { recursive: true });
// A `gh` that refuses everything, first on PATH: the seeded trains must never reach real GitHub from either hub.
mkdirSync(join(root, "bin"));
writeFileSync(join(root, "bin", "gh"), "#!/bin/sh\necho 'gh: bench stand-in' >&2\nexit 4\n");
chmodSync(join(root, "bin", "gh"), 0o755);
const env = { HOME: join(home, "user"), FLEETD_HOME: home, PATH: `${join(root, "bin")}:${process.env.PATH ?? ""}`, LANG: "C.UTF-8" };

const freePort = () => {
  const s = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response() });
  const port = s.port!;
  s.stop(true);
  return port;
};

async function startHub(bin: string) {
  const port = freePort();
  const t0 = performance.now();
  const proc = Bun.spawn([bin, "hub", "start", "--home", hubHome, "--listen", `127.0.0.1:${port}`], {
    env,
    cwd: root,
    stdout: Bun.file(join(root, "hub.log")),
    stderr: Bun.file(join(root, "hub.err")),
  });
  for (;;) {
    if (proc.exitCode !== null) throw new Error(`${bin} exited ${proc.exitCode}: ${readFileSync(join(root, "hub.err"), "utf8")}`);
    if (performance.now() - t0 > 60_000) throw new Error(`${bin} not ready in 60 s`);
    if (await fetch(`http://127.0.0.1:${port}/healthz`).then((r) => r.ok, () => false)) break;
    await Bun.sleep(10);
  }
  return {
    url: `http://127.0.0.1:${port}`,
    readyMs: performance.now() - t0,
    stop: async () => {
      proc.kill("SIGTERM");
      await proc.exited;
    },
  };
}

function mcp(url: string, key: string) {
  let session: string | undefined;
  let id = 0;
  const post = async (body: unknown) => {
    const r = await fetch(`${url}/mcp`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${key}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...(session === undefined ? {} : { "mcp-session-id": session }),
      },
      body: JSON.stringify(body),
    });
    session ??= r.headers.get("mcp-session-id") ?? undefined;
    const text = await r.text();
    return JSON.parse(text.startsWith("{") ? text : (/^data: (.*)$/mu.exec(text)?.[1] ?? "{}")) as {
      result?: { content?: { text: string }[]; isError?: boolean };
      error?: unknown;
    };
  };
  let init: Promise<unknown> | undefined;
  return async (tool: string, args: unknown) => {
    init ??= post({ jsonrpc: "2.0", id: ++id, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "bench", version: "0" } } });
    await init;
    const t0 = performance.now();
    const r = await post({ jsonrpc: "2.0", id: ++id, method: "tools/call", params: { name: tool, arguments: args } });
    const ms = performance.now() - t0;
    const text = r.result?.content?.[0]?.text ?? "";
    if (r.error !== undefined || r.result?.isError) throw new Error(`${tool}: ${text || JSON.stringify(r.error)}`);
    return { ms, text, body: JSON.parse(text) as { mergesTotal: number; tiles: { merged: { n: number } } } };
  };
}

/** Three repos, two projects each; landed changes and touches spread over 400 days, newest at now. */
function seed(file: string, now: number) {
  const db = new Database(file);
  db.run("PRAGMA busy_timeout = 5000");
  const repos = ["acme/web", "acme/api", "acme/mobile"];
  const routes = ["train", "train", "fleetd_by_hand", "outside", "direct", "skipped"];
  const kinds = ["chat.message", "item.answered", "steer", "decision", "app.use", "host.review", "merge.by_hand"];
  db.transaction(() => {
    repos.forEach((r, i) => {
      db.query("INSERT OR IGNORE INTO trains (repo, machine_id, project_id, watch_since_ms) VALUES (?1, 'devbox', ?2, 0)").run(r, `p${i}`);
      db.query("INSERT OR IGNORE INTO metric_repos (repo, host, last_ok_ms, backfilled_ms) VALUES (?1, 'github', ?2, 0)").run(`github.com/${r}`, now);
    });
    db.query("INSERT OR REPLACE INTO time_cursors (source, value) VALUES ('metrics:known_since', 0)").run();
    const merge = db.query(
      `INSERT INTO metric_merges (repo, unit_key, machine_id, project_id, pr_number, merged_ms, route, skip_why, workstream_id,
         requested_ms, requested_basis, pr_created_ms, author_kind, merged_by_kind, additions, deletions, title, url, src)
       VALUES (?1, ?2, 'devbox', ?3, ?4, ?5, ?6, ?7, ?8, ?9, 'source', ?10, 'human', 'human', ?11, ?12, ?13, ?14, 'event')`,
    );
    for (let i = 0; i < MERGES; i++) {
      const r = i % repos.length;
      const at = now - Math.floor((i / MERGES) * 400 * DAY) - (i % 97) * 1000;
      const route = routes[i % routes.length]!;
      const pr = i + 1;
      merge.run(
        `github.com/${repos[r]}`,
        `pr:${pr}`,
        `p${r}`,
        pr,
        at,
        route,
        route === "skipped" ? "bot" : null,
        route === "train" || route === "fleetd_by_hand" ? `W${(i % 300) + 1}` : null,
        route === "train" || route === "fleetd_by_hand" ? at - ((i % 48) + 1) * 3_600_000 : null,
        at - ((i % 12) + 1) * 3_600_000,
        (i % 400) + 1,
        i % 120,
        `Change ${pr}`,
        `https://github.com/${repos[r]}/pull/${pr}`,
      );
    }
    const touch = db.query(
      `INSERT INTO metric_touches (src, src_key, kind, at_ms, credit_ms, end_ms, machine_id, project_id, repo, pr_number, key_id,
         estimated, outside) VALUES ('bench', ?1, ?2, ?3, ?4, ?5, 'devbox', ?6, ?7, ?8, 'desk', 0, ?9)`,
    );
    for (let i = 0; i < TOUCHES; i++) {
      const r = i % repos.length;
      const at = now - Math.floor((i / TOUCHES) * 400 * DAY);
      const kind = kinds[i % kinds.length]!;
      touch.run(
        `t${i}`,
        kind,
        at,
        kind === "app.use" ? 120_000 : 60_000,
        kind === "app.use" ? at + 120_000 : null,
        `p${r}`,
        i % 2 ? `github.com/${repos[r]}` : null,
        i % 2 ? (i % MERGES) + 1 : null,
        kind === "merge.by_hand" ? 1 : 0,
      );
    }
  })();
  const mb = (db.query<{ n: number }, []>("SELECT page_count * page_size / 1048576.0 AS n FROM pragma_page_count(), pragma_page_size()").get()?.n ?? 0).toFixed(1);
  db.close();
  return { merges: MERGES, touches: TOUCHES, mb: Number(mb) };
}

/** The first path where two answers differ, keys in any order; undefined when they are the same. */
function differs(a: unknown, b: unknown, at = "$"): string | undefined {
  if (typeof a === "number" && typeof b === "number") return Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a)) ? undefined : `${at}: ${a} vs ${b}`;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return a === b ? undefined : `${at}: ${JSON.stringify(a)} vs ${JSON.stringify(b)}`;
  if (Array.isArray(a) !== Array.isArray(b)) return `${at}: array vs object`;
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) {
    const d = differs((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], `${at}.${k}`);
    if (d) return d;
  }
  return undefined;
}

const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;
const round = (x: number) => Math.round(x * 100) / 100;

try {
  // The Rust hub makes the database and an admin key, then stops so the seed can write.
  const first = await startHub(rustBin);
  const keyFile = join(root, "bench.key");
  const made = Bun.spawnSync([rustBin, "hub", "key", "create", "--name", "bench", "--role", "admin", "--machines", "*", "--out", keyFile], { env });
  if (made.exitCode !== 0) throw new Error(`hub key create: ${made.stderr}`);
  await first.stop();
  const key = readFileSync(keyFile, "utf8").trim();
  const now = Date.now();
  const seeded = seed(join(hubHome, "hub.sqlite"), now);
  const iso = (ms: number) => new Date(ms).toISOString();
  // A fixed `until`, so both hubs answer for the same range whenever each runs.
  const until = iso(now - 60_000);
  const cases: [string, Record<string, unknown>][] = [
    ["fleet, 30 days, UTC", { since: iso(now - 30 * DAY), until, tz: "UTC" }],
    ["fleet, 30 days, Europe/Berlin, compare", { since: iso(now - 30 * DAY), until, tz: "Europe/Berlin", compare: true }],
    ["fleet, 400 days, compare", { since: iso(now - 400 * DAY), until, tz: "UTC", compare: true }],
    ["one project, 30 days", { projectRef: { machineId: "devbox", projectId: "p0" }, since: iso(now - 30 * DAY), until, tz: "UTC" }],
  ];
  const out: Record<string, unknown> = { seeded };
  const answers: Record<string, unknown[]> = {};
  for (const [name, bin] of [
    ["rust", rustBin],
    ["bun", bunBin],
  ] as const) {
    const hub = await startHub(bin);
    try {
      const call = mcp(hub.url, key);
      const rows: Record<string, unknown> = { readyMs: round(hub.readyMs) };
      for (const [label, input] of cases) {
        const firstCall = await call("metrics_get", input);
        (answers[label] ??= []).push(firstCall.body);
        const xs: number[] = [];
        for (let i = 0; i < RUNS; i++) xs.push((await call("metrics_get", input)).ms);
        rows[label] = { medianMs: round(median(xs)), minMs: round(Math.min(...xs)), maxMs: round(Math.max(...xs)), merged: firstCall.body.tiles.merged.n, mergesTotal: firstCall.body.mergesTotal };
      }
      out[name] = rows;
    } finally {
      await hub.stop();
    }
  }
  // The same answer from both, `next` aside (its words are the same; nothing else may differ).
  out.sameAnswers = Object.fromEntries(Object.entries(answers).map(([label, [a, b]]) => [label, differs(a, b) ?? "same"]));
  console.log(JSON.stringify(out, null, 2));
} finally {
  rmSync(root, { recursive: true, force: true });
}

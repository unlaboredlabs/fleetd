// scripts/net-app/hub.ts: the network sweep's app rig (W793): a throwaway hub of this checkout (fleetd/src), on a home
// of its own under $TMPDIR, serving /app on its own port, with a workload port beside it that makes a lead stream
// replies into a chat as a running lead does (chat add → append deltas → finish), so the app's socket carries what it
// carries in a real session. With --web <dir>, a stand-in for fleetd cloud's side of the web app too: the built web
// app (gzip, as Cloudflare serves it), /web/session with one team, and /t/lab/app passed to the hub's /app with the
// key on the upgrade, as the cloud's session cookie stands for one.
//
//   bun scripts/net-app/hub.ts [--web app/desktop/out/web] [--history 300]
//   → {"hub":"http://127.0.0.1:…","key":"fld_…","control":…,"web":…,"project":{…}}
//
// Workload (POST, JSON answers): /lead?chars=2000&every=50&chunk=40 streams one reply (answers when it's final, with
// its messageId and final text); /truth?project= gives every message's id, seq and final text, to check the app's copy.
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, statSync } from "node:fs";
import { join, normalize } from "node:path";
import { tmpdir } from "node:os";
import { sha256 } from "../../fleetd/src/hub/auth/index.ts";
import { chat } from "../../fleetd/src/hub/chat/index.ts";
import { start } from "../../fleetd/src/hub/chat/loops.ts";
import { serve } from "../../fleetd/src/hub/http/index.ts";
import { build } from "../../fleetd/src/hub/serve/index.ts";

const flag = (name: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i < 0 ? undefined : process.argv[i + 1];
};

const root = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "net-app-"));
const home = join(root, "hub");
mkdirSync(home, { recursive: true });
process.env.FLEETD_HOME = root;
const { hub, tools } = build(home, { host: "127.0.0.1", port: 0 });
start(hub);
const server = serve(hub, tools, 0);
const hubUrl = `http://127.0.0.1:${server.port}`;

const machineId = "lab-a";
const projectId = "p1";
const project = { machineId, projectId };
hub.db.conn
  .query("INSERT INTO machines (machine_id, data) VALUES (?, ?)")
  .run(machineId, JSON.stringify({ machineId, name: machineId, nodeVersion: "1.0.0", status: "online", lastSeenAt: new Date(0).toISOString() }));
// --projects N: more bots beside the first, each with a chat of its own (the sidebar reads every one's newest line).
const others = Array.from({ length: Math.max(0, Number(flag("projects") ?? 1) - 1) }, (_, i) => ({ machineId, projectId: `p${i + 2}` }));
for (const [i, r] of [project, ...others].entries()) {
  hub.db.conn
    .query("INSERT INTO projects (machine_id, project_id, search, last_activity_at, data) VALUES (?, ?, '', '', ?)")
    .run(r.machineId, r.projectId, JSON.stringify({ ...r, title: i === 0 ? "Lab project" : `Lab bot ${i + 1}` }));
}

const BASE32 = "abcdefghijklmnopqrstuvwxyz234567";
const key = `fld_${[...crypto.getRandomValues(new Uint8Array(52))].map((b) => BASE32[b % 32]).join("")}`;
hub.db.conn
  .query("INSERT INTO agent_keys (key_id, hash, prefix, name, grants, created_ms, kind) VALUES (?, ?, ?, ?, ?, ?, 'human')")
  .run("key_lab", sha256(key), key.slice(0, 10), "lab", JSON.stringify([{ role: "admin", machines: "*" }]), Date.now());

/** Prose of about `chars` characters, varied enough that compression sees what it sees in a real reply. */
const WORDS = "the hub link node agent order branch review merge test build fix stream chat reply drop network socket reconnect frame event cursor snapshot backoff latency bandwidth packet loss jitter profile proxy measure bytes".split(" ");
let wordSeed = 7;
const prose = (chars: number) => {
  let s = "";
  while (s.length < chars) {
    wordSeed = (wordSeed * 1103515245 + 12345) & 0x7fffffff;
    s += `${WORDS[wordSeed % WORDS.length]}${wordSeed % 11 === 0 ? ".\n\n" : " "}`;
  }
  return s.slice(0, chars);
};

// A chat with history, as a project a person has used for a while: alternating asks and replies.
const history = Number(flag("history") ?? 300);
for (let i = 0; i < history; i++) {
  if (i % 2 === 0) chat(hub).add(project, { author: "human", text: prose(80 + (i % 7) * 30), source: `h${i}` });
  else {
    const m = chat(hub).add(project, { author: "lead", streaming: true, source: `l${i}` }).message;
    chat(hub).finish(m, prose(300 + (i % 5) * 400));
  }
}

for (const r of others) {
  for (let i = 0; i < 12; i++) {
    if (i % 2 === 0) chat(hub).add(r, { author: "human", text: prose(80 + (i % 7) * 30), source: `h${i}` });
    else chat(hub).finish(chat(hub).add(r, { author: "lead", streaming: true, source: `l${i}` }).message, prose(300 + (i % 5) * 400));
  }
}

let leads = 0;
const lead = async (chars: number, every: number, chunk: number) => {
  const text = prose(chars);
  let m = chat(hub).add(project, { author: "lead", streaming: true, source: `live${++leads}` }).message;
  for (let at = 0; at < text.length; at += chunk) {
    m = chat(hub).append(m, text.slice(at, at + chunk));
    await Bun.sleep(every);
  }
  m = chat(hub).finish(m, text);
  return { messageId: m.messageId, seq: m.seq, text };
};

const control = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(req) {
    const url = new URL(req.url);
    const n = (k: string, d: number) => Number(url.searchParams.get(k) ?? d);
    if (url.pathname === "/lead") return Response.json(await lead(n("chars", 2000), n("every", 50), n("chunk", 40)));
    if (url.pathname === "/truth") {
      const rows = hub.db.conn.query<{ data: string }, [string, string]>("SELECT data FROM chat_messages WHERE machine_id = ?1 AND project_id = ?2 ORDER BY n").all(machineId, projectId);
      return Response.json(rows.map((r) => JSON.parse(r.data) as { messageId: string; seq: number; text: string; state: string }).map(({ messageId, seq, text, state }) => ({ messageId, seq, text, state })));
    }
    return new Response("not found", { status: 404 });
  },
});

// The cloud stand-in for the web app: its files, its session, and the team's socket passed to the hub's /app.
const webDir = flag("web");
const WEB_DEFLATE = process.argv.includes("--web-deflate");
/** --frames <file>: one JSON line per frame the stand-in passes (direction, bytes, what it is), to see what a load costs. */
const framesFile = flag("frames");
const callTools = new Map<string, string>();
const logFrame = (dir: "up" | "down", raw: string | Buffer) => {
  if (framesFile === undefined) return;
  const text = typeof raw === "string" ? raw : raw.toString("utf8");
  let what = "?";
  try {
    const f = JSON.parse(text) as { t: string; id?: string; tool?: string; data?: { kind?: string }; kind?: string };
    if (f.t === "call" && f.id !== undefined && f.tool !== undefined) callTools.set(f.id, f.tool);
    what = f.t === "call" ? `call ${f.tool}` : f.t === "result" || (f.t === "error" && f.id !== undefined) ? `${f.t} ${callTools.get(f.id ?? "") ?? ""}` : f.t === "event" ? `event ${f.kind ?? ""}` : f.t;
  } catch {}
  const head = dir === "up" ? text.slice(0, 200) : undefined;
  appendFileSync(framesFile, `${JSON.stringify({ at: Math.round(performance.now()), dir, bytes: Buffer.byteLength(text), what, ...(head === undefined ? {} : { head }) })}\n`);
};
type Pass = { upstream?: WebSocket; queue: Array<string | Buffer>; features: string };
const web =
  webDir === undefined
    ? undefined
    : Bun.serve<Pass>({
        hostname: "127.0.0.1",
        port: Number(flag("web-port") ?? 0),
        fetch(req, srv) {
          const url = new URL(req.url);
          if (url.pathname === "/web/session") {
            return Response.json({ email: "lab@example.invalid", teams: [{ id: "lab", name: "Lab", url: "https://lab.example.invalid" }] });
          }
          if (url.pathname === "/t/lab/app") {
            return srv.upgrade(req, { data: { queue: [], features: url.searchParams.get("features") ?? "" } }) ? undefined : new Response("upgrade", { status: 400 });
          }
          const rel = normalize(url.pathname === "/" || !url.pathname.includes(".") ? "/index.html" : url.pathname);
          const file = join(webDir, rel);
          if (!file.startsWith(webDir) || !statSync(file, { throwIfNoEntry: false })?.isFile()) return new Response("not found", { status: 404 });
          const body = readFileSync(file);
          const type = Bun.file(file).type;
          const immutable = rel.startsWith("/assets/");
          const headers: Record<string, string> = { "content-type": type, "cache-control": immutable ? "public, max-age=31536000, immutable" : "no-cache" };
          if ((req.headers.get("accept-encoding") ?? "").includes("gzip") && /text|javascript|json|css|svg|wasm/u.test(type)) {
            headers["content-encoding"] = "gzip";
            return new Response(Bun.gzipSync(body), { headers });
          }
          return new Response(body, { headers });
        },
        websocket: {
          // As fleetd cloud's own server sets it (src/instance.ts): `perMessageDeflate` only when --web-deflate.
          perMessageDeflate: WEB_DEFLATE,
          open(ws) {
            const headers: Record<string, string> = { authorization: `Bearer ${key}` };
            if (ws.data.features !== "") headers["x-fleetd-features"] = ws.data.features;
            const up = new WebSocket(`${hubUrl.replace("http", "ws")}/app`, { headers } as unknown as string[]);
            ws.data.upstream = up;
            up.onopen = () => {
              for (const m of ws.data.queue.splice(0)) up.send(m);
            };
            // Bun compresses a frame only when its send asks (T4831's fix in the cloud: frames ≥ 128 bytes).
            up.onmessage = (e) => {
              logFrame("down", e.data as string);
              ws.send(e.data as string, WEB_DEFLATE && String(e.data).length >= 128);
            };
            up.onclose = (e) => ws.close(e.code === 1005 || e.code === 1006 ? 1011 : e.code, e.reason);
          },
          message(ws, raw) {
            // The cloud answers the web page's own ping (a browser can't send a WebSocket one).
            if (raw === '{"t":"ping"}') return void ws.send('{"t":"pong"}');
            // The page's `auth` carries no key (its cookie stands for one): the session's key goes in its place.
            if (typeof raw === "string" && raw.startsWith('{"t":"auth"')) raw = JSON.stringify({ ...(JSON.parse(raw) as object), key });
            logFrame("up", raw);
            const up = ws.data.upstream;
            if (up?.readyState === WebSocket.OPEN) up.send(raw);
            else ws.data.queue.push(raw);
          },
          close(ws) {
            ws.data.upstream?.close();
          },
        },
      });

process.stdout.write(`${JSON.stringify({ hub: hubUrl, key, control: control.port, web: web?.port, project, home: root })}\n`);
const quit = () => {
  server.stop(true);
  control.stop(true);
  web?.stop(true);
  process.exit(0);
};
process.on("SIGTERM", quit);
process.on("SIGINT", quit);

// A stand-in server for boat.dev (CI has no account): it keeps its boxes in memory, answers the calls fleetd's client
// makes with the shapes boat's OpenAPI file gives, checks the key's header on every call, and records each call. A box's port is a WebSocket that echoes, after checking the provider's access header and
// fleetd's secret. `fail` makes the next matching call answer a refusal.
//
// With a `Runner`, a box is more than a record: the command a client starts in it runs on this machine (its
// environment as the provider would give it, boat's environment file read back from what the client
// wrote), and the box's port is carried to the port the runner says, so a test drives a box's whole life. With a
// `Step`, each other command (a template build's) ends as it says, so a test stands in for what boat's base image does.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import { stop as stopHost } from "../../src/node/runner/host.ts";

export const KEY = "test-key-0123456789";
export const SECRET = "box-secret-abc";

export type Call = { method: string; path: string; query: URLSearchParams; headers: Headers; body: any };
export type Fail = { path: RegExp; status: number; body: unknown; times?: number };
export type StandIn = {
  url: string;
  calls: Call[];
  boxes: Map<string, any>;
  files: Map<string, Uint8Array>;
  fail(f: Fail): void;
  /** What the box's WebSocket upgrade carried. */
  upgrades: Headers[];
  /** Milliseconds each frame on a box's link waits, each way: a provider's proxy between the node and the box. */
  latencyMs: number;
  /** boat's saved snapshots by name: how many times each was asked after (ready from the second), when it was saved,
   * and one that failed. A test puts one in as another machine (or an older release) saved it. */
  saved?: Map<string, { asked: number; at: string; failed?: boolean }>;
  stop(): void;
};

type Handler = (c: Call, s: StandIn) => Response | Promise<Response>;
/** How a command a client starts (not a box's start) ends: its exit code and output. */
export type Step = (command: string) => { exitCode: number; stdout?: string; stderr?: string; running?: boolean };

/** Runs what a client starts in a box, here. */
export type Runner = {
  /** Every text the box's command reads (its environment's values, its environment file): the runner's own port in
   * place of the guest's, say. */
  rewrite(box: string, text: string): string;
  exec(box: string, argv: string[], env: Record<string, string>): void;
  /** Where the box's guest port goes; undefined: the echo. */
  port(box: string): number | undefined;
};

/** A boat launcher, run here: its environment file (written through the provider's file call) put where
 * this machine keeps scratch files, read and removed by the command as in a box. */
function launch(runner: Runner, box: string, command: string, files: Map<string, Uint8Array>): void {
  const dir = join(process.env.TMPDIR ?? "/tmp", "stand-in-env");
  mkdirSync(dir, { recursive: true });
  const text = command.replace(/\/tmp\/\.fleetd-env-[0-9a-f-]+/g, (at) => {
    const local = join(dir, at.slice(5));
    writeFileSync(local, runner.rewrite(box, new TextDecoder().decode(files.get(at) ?? new Uint8Array())), { mode: 0o600 });
    return local;
  });
  runner.exec(box, ["sh", "-c", text], {});
}

function serve(auth: (h: Headers) => boolean, route: Handler, portToken: (h: Headers, url: URL) => boolean, runner?: Runner): StandIn {
  const fails: Fail[] = [];
  const s: StandIn = {
    url: "",
    calls: [],
    boxes: new Map(),
    files: new Map(),
    upgrades: [],
    latencyMs: 0,
    fail: (f) => fails.push({ times: 1, ...f }),
    stop: () => server.stop(true),
  };
  // Frames keep their order: each waits the same time.
  const later = (f: () => void) => (s.latencyMs > 0 ? void setTimeout(f, s.latencyMs) : f());
  type Link = { to?: number; secret?: string; peer?: WebSocket; held?: (string | Uint8Array)[] };
  const server = Bun.serve<Link, never>({
    port: 0,
    async fetch(req, srv) {
      const url = new URL(req.url);
      if (url.pathname.startsWith("/ws/") || /^\/box\/[^/]+\/7787/.test(url.pathname)) {
        s.upgrades.push(req.headers);
        const box = /^\/(?:ws|box)\/([^/?]+)/.exec(url.pathname)?.[1] ?? "";
        const to = runner?.port(box);
        // Carried to the box's own guest, which checks fleetd's secret itself.
        if (to !== undefined) {
          if (!portToken(req.headers, url)) return new Response("forbidden", { status: 403 });
          return srv.upgrade(req, { data: { to, secret: req.headers.get("x-fleetd-box-secret") ?? "" } }) ? undefined : new Response("no", { status: 400 });
        }
        if (!portToken(req.headers, url) || req.headers.get("x-fleetd-box-secret") !== SECRET) return new Response("forbidden", { status: 403 });
        return srv.upgrade(req, { data: {} }) ? undefined : new Response("no", { status: 400 });
      }
      const raw = req.method === "GET" || req.method === "DELETE" ? new Uint8Array() : new Uint8Array(await req.arrayBuffer());
      const text = new TextDecoder().decode(raw);
      let body: any = text;
      try {
        body = text ? JSON.parse(text) : undefined;
      } catch {}
      const c: Call = { method: req.method, path: url.pathname, query: url.searchParams, headers: req.headers, body: body ?? (text || undefined) };
      if (req.headers.get("content-type") === "application/connect+json") c.body = raw;
      s.calls.push(c);
      const f = fails.find((f) => f.path.test(`${req.method} ${url.pathname}`) && (f.times ?? 1) > 0);
      if (f) {
        f.times = (f.times ?? 1) - 1;
        return Response.json(f.body, { status: f.status });
      }
      if (!auth(req.headers)) return Response.json({ code: 401, message: "authorization header is missing or invalid" }, { status: 401 });
      return route(c, s);
    },
    websocket: {
      open(ws) {
        const d = ws.data;
        if (d.to === undefined) return;
        d.held = [];
        const peer = new WebSocket(`ws://127.0.0.1:${d.to}/`, { headers: { "x-fleetd-box-secret": d.secret ?? "" } } as never);
        peer.binaryType = "arraybuffer";
        d.peer = peer;
        peer.onopen = () => {
          for (const m of d.held!.splice(0)) peer.send(m);
        };
        peer.onmessage = (e) => later(() => ws.send(typeof e.data === "string" ? e.data : new Uint8Array(e.data as ArrayBuffer)));
        peer.onclose = () => ws.close();
        peer.onerror = () => ws.close();
      },
      message(ws, m) {
        const d = ws.data;
        if (!d.peer) return void ws.send(m);
        const bytes = typeof m === "string" ? m : new Uint8Array(m);
        later(() => {
          if (d.peer!.readyState === WebSocket.OPEN) d.peer!.send(bytes);
          else d.held!.push(bytes);
        });
      },
      close(ws) {
        ws.data.peer?.close();
      },
    },
  });
  s.url = `http://127.0.0.1:${server.port}`;
  return s;
}

let n = 0;
const nextId = (p: string) => `${p}${(++n).toString().padStart(8, "0")}`;

/** boat's API. */
export function boatStandIn(runner?: Runner, step?: Step): StandIn {
  const idem = new Map<string, string>();
  const commands: any[] = [];
  const ended = new Map<number, ReturnType<Step>>();
  const saved = new Map<string, { asked: number; at: string; failed?: boolean }>();
  const deleted = new Set<string>();
  /** A snapshot as boat answers it: "saving" until it was asked after once, then "ready" (or "failed"). */
  const info = (name: string, v: { asked: number; at: string; failed?: boolean }) => ({ name, status: v.failed ? "failed" : v.asked < 2 ? "saving" : "ready", sourceSandboxId: "x", createdAt: v.at });
  const s = serve(
    (h) => h.get("authorization") === `Bearer ${KEY}`,
    (c, s) => {
      const p = c.path.replace(/^\/api\/v1/, "");
      if (c.method === "POST" && p === "/sandboxes") {
        // A saved snapshot that was deleted: boat's own refusal.
        const from = String(c.body?.from ?? "");
        if (deleted.has(from) && !saved.has(from)) return Response.json({ ok: false, code: "snapshot_not_found", message: "Saved snapshot not found" }, { status: 404 });
        const k = c.headers.get("idempotency-key");
        let id = k ? idem.get(k) : undefined;
        if (!id) {
          id = nextId("bx_");
          if (k) idem.set(k, id);
          s.boxes.set(id, { id, name: c.body.name, state: "provisioning", labels: c.body.labels ?? {}, req: c.body, ttlSeconds: c.body.ttlSeconds });
        }
        return Response.json({ ok: true, type: "sandbox.created", status: "provisioning", ttlSeconds: c.body.ttlSeconds, sandbox: s.boxes.get(id) }, { status: 202 });
      }
      if (c.method === "GET" && p === "/sandboxes") {
        const [k, v] = (c.query.get("label") ?? "").split("=");
        const all = [...s.boxes.values()].filter((b) => !k || b.labels[k!] === v);
        const start = Number(c.query.get("cursor") ?? 0);
        const more = start + 2 < all.length;
        return Response.json({ ok: true, type: "sandbox.list", sandboxes: all.slice(start, start + 2), pageInfo: { nextCursor: more ? String(start + 2) : null, hasMore: more, limit: 2 } });
      }
      let m = /^\/sandboxes\/([^/]+)$/.exec(p);
      if (m) {
        const b = s.boxes.get(m[1]!);
        if (!b) return Response.json({ ok: false, type: "sandbox.error", status: 404, code: "not_found", message: "Sandbox not found", error: { code: "not_found", message: "Sandbox not found", status: 404 } }, { status: 404 });
        if (c.method === "GET") {
          if (b.state === "provisioning") b.state = "ready";
          return Response.json({ ok: true, type: "sandbox.info", sandbox: b });
        }
        if (c.method === "PATCH") {
          b.ttlSeconds = c.body.ttlSeconds;
          return Response.json({ ok: true, type: "sandbox.info", sandbox: b });
        }
        if (c.method === "DELETE") {
          if (c.headers.get("x-ascii-confirm-delete") !== b.id) return Response.json({ ok: false, code: "confirm_required", message: "confirm" }, { status: 409 });
          s.boxes.delete(b.id);
          return Response.json({ ok: true, type: "sandbox.deleting", operation: { id: "op1", status: "pending" } }, { status: 202 });
        }
      }
      m = /^\/sandboxes\/([^/]+)\/files$/.exec(p);
      if (m && c.method === "PUT") {
        s.files.set(c.body.path, new TextEncoder().encode(c.body.content));
        return Response.json({ ok: true, type: "file.written", success: true });
      }
      if (m && c.method === "GET") {
        const f = s.files.get(c.query.get("path")!);
        if (!f) return Response.json({ ok: false, code: "not_found", message: "File not found" }, { status: 404 });
        if (f.length > 5 * 1024 * 1024) return Response.json({ ok: false, code: "file_too_large", message: "File is above 5 MiB" }, { status: 413 });
        return Response.json({ ok: true, type: "file.read", success: true, path: c.query.get("path"), encoding: "base64", size: f.length, content: Buffer.from(f).toString("base64") });
      }
      m = /^\/sandboxes\/([^/]+)\/commands$/.exec(p);
      if (m) {
        commands.push(c.body);
        s.boxes.get(m[1]!).commands = commands;
        // Only a box's start (the one with an environment file), never a template build's steps.
        if (runner && /\.fleetd-env-/.test(c.body.command)) launch(runner, m[1]!, c.body.command, s.files);
        else if (step) ended.set(commands.length, step(c.body.command));
        return Response.json({ ok: true, type: "command.started", success: true, processId: commands.length, pid: 100 + commands.length, command: c.body.command, startedAt: "2026-01-01T00:00:00Z" });
      }
      m = /^\/sandboxes\/([^/]+)\/commands\/(\d+)$/.exec(p);
      if (m) return Response.json({ ok: true, type: "command.status", success: true, processId: Number(m[2]), status: "exited", running: false, exitCode: 0, stdout: "", stderr: "", ...ended.get(Number(m[2])) });
      m = /^\/sandboxes\/([^/]+)\/host$/.exec(p);
      if (m) return Response.json({ ok: true, type: "port.hosted", success: true, port: c.body.port, url: `${s.url}/ws/${m[1]}?_token=port-token`, isProtected: true, access: "private" });
      if (c.method === "POST" && p === "/saved-snapshots") {
        const was = saved.get(c.body.name);
        if (was && !was.failed && was.asked < 2) return Response.json({ ok: false, code: "save_in_progress", message: "A save under this name is running" }, { status: 409 });
        saved.set(c.body.name, { asked: 0, at: new Date().toISOString() });
        return Response.json({ ok: true, snapshot: { name: c.body.name, status: "saving" } }, { status: 202 });
      }
      if (c.method === "GET" && p === "/saved-snapshots") {
        const prefix = c.query.get("namePrefix") ?? "";
        const all = [...saved].filter(([n]) => n.startsWith(prefix)).map(([n, v]) => info(n, v));
        return Response.json({ ok: true, type: "snapshot.saved.list", snapshots: all.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1)) });
      }
      m = /^\/saved-snapshots\/([^/]+)$/.exec(p);
      if (m && c.method === "DELETE") {
        saved.delete(m[1]!);
        deleted.add(m[1]!);
        return Response.json({ ok: true });
      }
      if (m && !saved.has(m[1]!)) return Response.json({ ok: false, code: "snapshot_not_found", message: "Saved snapshot not found" }, { status: 404 });
      if (m) {
        const v = saved.get(m[1]!)!;
        v.asked++;
        return Response.json({ ok: true, snapshot: info(m[1]!, v) });
      }
      return Response.json({ ok: false, code: "not_found", message: `no route ${c.method} ${p}` }, { status: 404 });
    },
    (_h, url) => url.searchParams.get("_token") === "port-token",
    runner,
  );
  s.saved = saved;
  return s;
}

/** A Runner whose boxes run on this machine, each with a port and a dir of its own (its BOX_DIR): what it started goes
 * at `cleanup`, by process group, and the session hosts its guests started by their records. */
export function localRunner(dir: string, boxDir: string): { runner: Runner; track: (s: StandIn) => void; cleanup: () => Promise<void> } {
  const ports = new Map<string, number>();
  const groups: number[] = [];
  const runner: Runner = {
    rewrite: (box, text) =>
      text
        .replace(/^7787$/, String(ports.get(box)))
        .replace(/FLEETD_BOOT_PORT='7787'/, `FLEETD_BOOT_PORT='${ports.get(box)}'`)
        .replaceAll(boxDir, join(dir, box)),
    exec: (box, argv, env) => {
      const [cmd, ...args] = argv.map((a) => a.replaceAll(boxDir, join(dir, box)));
      const child = spawn(cmd!, args, {
        // The guest's forwards on 127.0.0.2, beside this machine's own ports on 127.0.0.1.
        env: { ...process.env, PATH: `${dirname(process.execPath)}:${process.env.PATH}`, FLEETD_BOOT_LOOPBACK: "127.0.0.2", ...env },
        stdio: ["ignore", "inherit", "inherit"],
        detached: true,
      });
      child.unref();
      if (child.pid) groups.push(child.pid);
    },
    port: (box) => ports.get(box),
  };
  return {
    runner,
    // A box's port is known before its command runs: each box the stand-in records takes one.
    track: (s) => {
      const set = s.boxes.set.bind(s.boxes);
      s.boxes.set = (k: string, v: unknown) => {
        if (!ports.has(k)) void freePort().then((p) => ports.set(k, p));
        return set(k, v);
      };
    },
    cleanup: async () => {
      for (const g of groups.splice(0)) {
        try {
          process.kill(-g, "SIGKILL");
        } catch {}
      }
      for (const box of existsSync(dir) ? readdirSync(dir) : []) {
        const hosts = join(dir, box, "guest");
        if (existsSync(hosts)) for (const name of readdirSync(hosts)) await stopHost(join(hosts, name));
      }
    },
  };
}

const freePort = () =>
  new Promise<number>((resolve) => {
    const s = createServer().listen(0, "127.0.0.1", () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => resolve(port));
    });
  });

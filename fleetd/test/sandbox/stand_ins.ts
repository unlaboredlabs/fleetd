// Stand-in servers for boat.dev, E2B and Daytona (CI has no accounts): each keeps its boxes in memory, answers the
// calls fleetd's clients make with the shapes the providers' OpenAPI files give, checks the key's header on every call,
// and records each call. A box's port is a WebSocket that echoes, after checking the provider's access header and
// fleetd's secret. `fail` makes the next matching call answer a refusal.
import { frame } from "../../src/sandbox/providers/e2b.ts";

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
  stop(): void;
};

type Handler = (c: Call, s: StandIn) => Response | Promise<Response>;

function serve(auth: (h: Headers) => boolean, route: Handler, portToken: (h: Headers, url: URL) => boolean): StandIn {
  const fails: Fail[] = [];
  const s: StandIn = {
    url: "",
    calls: [],
    boxes: new Map(),
    files: new Map(),
    upgrades: [],
    fail: (f) => fails.push({ times: 1, ...f }),
    stop: () => server.stop(true),
  };
  const server = Bun.serve({
    port: 0,
    async fetch(req, srv) {
      const url = new URL(req.url);
      if (url.pathname.startsWith("/ws/") || /^\/box\/[^/]+\/7787/.test(url.pathname)) {
        s.upgrades.push(req.headers);
        if (!portToken(req.headers, url) || req.headers.get("x-fleetd-box-secret") !== SECRET) return new Response("forbidden", { status: 403 });
        return srv.upgrade(req) ? undefined : new Response("no", { status: 400 });
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
      message(ws, m) {
        ws.send(m);
      },
    },
  });
  s.url = `http://127.0.0.1:${server.port}`;
  return s;
}

let n = 0;
const nextId = (p: string) => `${p}${(++n).toString().padStart(8, "0")}`;

/** E2B's platform API and each box's envd, on one server: a box's own host is `<url>/box/<id>/<port>`. */
export function e2bStandIn(): StandIn {
  const idem = new Map<string, string>();
  const builds = new Map<string, number>();
  return serve(
    (h) => h.get("x-api-key") === KEY || h.get("x-access-token") === "envd-token",
    (c, s) => {
      const p = c.path;
      if (c.method === "POST" && p === "/v2/sandboxes") {
        const k = c.headers.get("idempotency-key");
        let id = k ? idem.get(k) : undefined;
        if (!id) {
          id = nextId("e2b");
          if (k) idem.set(k, id);
          s.boxes.set(id, { sandboxID: id, metadata: c.body.metadata, timeout: c.body.timeout, req: c.body, state: "running" });
        }
        return Response.json({ sandboxID: id, templateID: c.body.templateID, clientID: "x", envdVersion: "0.4.0", envdAccessToken: "envd-token", trafficAccessToken: "traffic-token", domain: null }, { status: 201 });
      }
      let m = /^\/sandboxes\/([^/]+)$/.exec(p);
      if (m && c.method === "DELETE") return s.boxes.delete(m[1]!) ? new Response(null, { status: 204 }) : Response.json({ code: 404, message: "sandbox not found" }, { status: 404 });
      m = /^\/sandboxes\/([^/]+)\/timeout$/.exec(p);
      if (m) {
        const b = s.boxes.get(m[1]!);
        if (!b) return Response.json({ code: 404, message: "not found" }, { status: 404 });
        b.timeout = c.body.timeout;
        return new Response(null, { status: 204 });
      }
      m = /^\/v2\/sandboxes\/([^/]+)\/connect$/.exec(p);
      if (m) return Response.json({ sandboxID: m[1], templateID: "t", clientID: "x", envdVersion: "0.4.0", envdAccessToken: "envd-token", trafficAccessToken: "traffic-token" });
      if (c.method === "GET" && p === "/v2/sandboxes") {
        const [k, v] = (c.query.get("metadata") ?? "").split("=");
        const all = [...s.boxes.values()].filter((b) => !k || b.metadata?.[k!] === v);
        const start = Number(c.query.get("nextToken") ?? 0);
        const page = all.slice(start, start + 2);
        const headers = start + 2 < all.length ? { "X-Next-Token": String(start + 2) } : undefined;
        return Response.json(
          page.map((b) => ({ sandboxID: b.sandboxID, metadata: b.metadata, state: b.state })),
          { headers },
        );
      }
      m = /^\/box\/([^/]+)\/49983\/process\.Process\/Start$/.exec(p);
      if (m) {
        s.boxes.get(m[1]!).started = c;
        const stream = new ReadableStream({
          start(ctl) {
            ctl.enqueue(frame({ event: { start: { pid: 42 } } }));
          },
        });
        return new Response(stream, { headers: { "content-type": "application/connect+json" } });
      }
      m = /^\/box\/([^/]+)\/49983\/files$/.exec(p);
      if (m) {
        const f = s.files.get(c.query.get("path")!);
        if (!f) return Response.json({ message: "file not found" }, { status: 404 });
        const r = /bytes=0-(\d+)/.exec(c.headers.get("range") ?? "");
        return new Response(r ? f.slice(0, Number(r[1]) + 1) : f, { status: r ? 206 : 200 });
      }
      if (c.method === "POST" && p === "/v3/templates") return Response.json({ templateID: "tpl1", buildID: "b1", public: false, aliases: [], names: [c.body.name], tags: [] }, { status: 202 });
      m = /^\/v2\/templates\/tpl1\/builds\/b1$/.exec(p);
      if (m) return new Response(null, { status: 202 });
      if (p === "/templates/tpl1/builds/b1/status") {
        const k = (builds.get("b1") ?? 0) + 1;
        builds.set("b1", k);
        return Response.json({ templateID: "tpl1", buildID: "b1", status: k < 2 ? "building" : "ready", logs: [], logEntries: [{ message: `step ${k}` }] });
      }
      return Response.json({ code: 404, message: `no route ${c.method} ${p}` }, { status: 404 });
    },
    (h) => h.get("e2b-traffic-access-token") === "traffic-token",
  );
}

/** boat's API. */
export function boatStandIn(): StandIn {
  const idem = new Map<string, string>();
  const commands: any[] = [];
  const saved = new Map<string, number>();
  const s = serve(
    (h) => h.get("authorization") === `Bearer ${KEY}`,
    (c, s) => {
      const p = c.path.replace(/^\/api\/v1/, "");
      if (c.method === "POST" && p === "/sandboxes") {
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
        return Response.json({ ok: true, type: "command.started", success: true, processId: commands.length, pid: 100 + commands.length, command: c.body.command, startedAt: "2026-01-01T00:00:00Z" });
      }
      m = /^\/sandboxes\/([^/]+)\/commands\/(\d+)$/.exec(p);
      if (m) return Response.json({ ok: true, type: "command.status", success: true, processId: Number(m[2]), status: "exited", running: false, exitCode: 0, stdout: "", stderr: "" });
      m = /^\/sandboxes\/([^/]+)\/host$/.exec(p);
      if (m) return Response.json({ ok: true, type: "port.hosted", success: true, port: c.body.port, url: `${s.url}/ws/${m[1]}?_token=port-token`, isProtected: true, access: "private" });
      if (c.method === "POST" && p === "/saved-snapshots") {
        saved.set(c.body.name, 0);
        return Response.json({ ok: true, snapshot: { name: c.body.name, status: "saving" } }, { status: 202 });
      }
      m = /^\/saved-snapshots\/([^/]+)$/.exec(p);
      if (m) {
        const k = (saved.get(m[1]!) ?? 0) + 1;
        saved.set(m[1]!, k);
        return Response.json({ ok: true, snapshot: { name: m[1], status: k < 2 ? "saving" : "ready", sourceSandboxId: "x", createdAt: "2026-01-01T00:00:00Z" } });
      }
      return Response.json({ ok: false, code: "not_found", message: `no route ${c.method} ${p}` }, { status: 404 });
    },
    (_h, url) => url.searchParams.get("_token") === "port-token",
  );
  return s;
}

/** Daytona's API and toolbox, on one server: the toolbox is at `<url>/toolbox/<id>`. */
export function daytonaStandIn(): StandIn {
  const snaps = new Map<string, number>();
  const s = serve(
    (h) => h.get("authorization") === `Bearer ${KEY}`,
    (c, s) => {
      const p = c.path;
      if (c.method === "POST" && p === "/sandbox") {
        if ([...s.boxes.values()].some((b) => b.name === c.body.name)) return Response.json({ statusCode: 409, message: `Sandbox with name ${c.body.name} already exists` }, { status: 409 });
        const id = nextId("dt");
        s.boxes.set(id, { id, name: c.body.name, state: "creating", labels: c.body.labels, req: c.body, ttlMinutes: c.body.ttlMinutes, toolboxProxyUrl: `${s.url}/toolbox` });
        return Response.json(s.boxes.get(id));
      }
      if (c.method === "GET" && p === "/sandbox") {
        const want = JSON.parse(c.query.get("labels") ?? "{}");
        const all = [...s.boxes.values()].filter((b) => Object.entries(want).every(([k, v]) => b.labels?.[k] === v));
        const start = Number(c.query.get("cursor") ?? 0);
        return Response.json({ items: all.slice(start, start + 2), nextCursor: start + 2 < all.length ? String(start + 2) : null });
      }
      let m = /^\/sandbox\/([^/]+)$/.exec(p);
      if (m) {
        const b = s.boxes.get(m[1]!) ?? [...s.boxes.values()].find((b) => b.name === m![1]);
        if (!b) return Response.json({ statusCode: 404, message: "Sandbox not found" }, { status: 404 });
        if (c.method === "DELETE") {
          s.boxes.delete(b.id);
          return Response.json({ ...b, state: "destroying" });
        }
        if (b.state === "creating") b.state = "started";
        return Response.json(b);
      }
      m = /^\/sandbox\/([^/]+)\/ttl\/(\d+)$/.exec(p);
      if (m) {
        const b = s.boxes.get(m[1]!);
        b.ttlMinutes = Number(m[2]);
        return Response.json(b);
      }
      m = /^\/sandbox\/([^/]+)\/ports\/(\d+)\/preview-url$/.exec(p);
      if (m) return Response.json({ sandboxId: m[1], url: `${s.url}/ws/${m[1]}`, token: "preview-token" });
      m = /^\/toolbox\/([^/]+)(\/.*)$/.exec(p);
      if (m) {
        const b = s.boxes.get(m[1]!);
        b.toolbox ??= [];
        b.toolbox.push({ path: m[2], body: c.body });
        if (m[2] === "/process/execute") {
          const at = /\/tmp\/\.fleetd-env-[0-9a-f-]+/.exec(c.body.command)?.[0];
          if (at) s.files.set(at, new TextEncoder().encode(c.body.envs.FLEETD_ENV));
          return Response.json({ exitCode: 0, result: "" });
        }
        if (m[2] === "/process/session") return new Response(null, { status: 201 });
        if (/^\/process\/session\/[^/]+\/exec$/.test(m[2]!)) return Response.json({ cmdId: "c1" }, { status: 202 });
        if (m[2] === "/files/download") {
          const f = s.files.get(c.query.get("path")!);
          return f ? new Response(f) : Response.json({ statusCode: 404, message: "file not found" }, { status: 404 });
        }
      }
      if (c.method === "POST" && p === "/snapshots") {
        snaps.set("s1", 0);
        return Response.json({ id: "s1", name: c.body.name, state: "pending" });
      }
      if (p === "/snapshots/s1") {
        const k = (snaps.get("s1") ?? 0) + 1;
        snaps.set("s1", k);
        return Response.json({ id: "s1", state: k < 2 ? "building" : "active" });
      }
      return Response.json({ statusCode: 404, message: `no route ${c.method} ${p}` }, { status: 404 });
    },
    (h) => h.get("x-daytona-preview-token") === "preview-token",
  );
  return s;
}

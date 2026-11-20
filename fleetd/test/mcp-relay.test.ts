// `fleetd mcp-relay` and the node's half of it, against a stand-in for a server that signs in with OAuth and whose
// tokens end whenever the test says (Paper's last 5 minutes): a session keeps the server past its token's life, never
// holds the token in its config or its output, and is told in plain words when the server can't be used.
import { afterAll, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { notNowText, Relay, serve } from "../src/cli/mcp_relay.ts";
import { keep, kept, sessionConfig } from "../src/node/actions/mcp.ts";
import { relayCall, renew } from "../src/node/actions/mcp_relay.ts";
import { fingerprintOf } from "../src/node/secrets/files.ts";
import { relayServer } from "../src/node/sessions/index.ts";
import { LeadRelay, serveLeadSocket } from "../src/node/lead/index.ts";
import { LocalArea } from "../src/node/api.ts";
import { Masker } from "../src/node/mask.ts";
import { tempHome } from "./helpers.ts";

type Json = Record<string, unknown>;

/** A server reached by streamable HTTP that takes only the tokens it issued and hasn't ended. */
function standIn() {
  const s = { valid: new Set<string>(), sessions: new Set<string>(), down: false, n: 0, sessionN: 0, seen: [] as string[] };
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      if (s.down) return new Response("busy", { status: 503 });
      const auth = req.headers.get("authorization") ?? "";
      s.seen.push(auth);
      if (!s.valid.has(auth.replace(/^Bearer /, ""))) return new Response("", { status: 401, headers: { "www-authenticate": 'Bearer error="invalid_token"' } });
      if (req.method === "DELETE") return new Response("");
      const m = (await req.json()) as Json;
      if (m.method === "initialize") {
        const id = `s-${++s.sessionN}`;
        s.sessions.add(id);
        return Response.json({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "stand-in", version: "1" } } }, { headers: { "mcp-session-id": id } });
      }
      if (!s.sessions.has(req.headers.get("mcp-session-id") ?? "")) return new Response("no such session", { status: 404 });
      if (m.id === undefined) return new Response("", { status: 202 });
      if (m.method === "tools/list") return Response.json({ jsonrpc: "2.0", id: m.id, result: { tools: [{ name: "get_basic_info" }] } });
      // A tool's answer on an event stream, after a notification of its own.
      const body = `event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", method: "notifications/message", params: { level: "info", data: "working" } })}\n\nevent: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: m.id, result: { content: [{ type: "text", text: "a frame" }] } })}\n\n`;
      return new Response(body, { headers: { "content-type": "text/event-stream" } });
    },
  });
  const issue = () => {
    const t = `pt-${++s.n}-${crypto.randomUUID()}`;
    s.valid.add(t);
    return t;
  };
  return { s, server, issue, url: `http://127.0.0.1:${server.port}/mcp`, endAll: () => s.valid.clear() };
}

const paper = standIn();
const home = tempHome();
afterAll(() => {
  paper.server.stop(true);
  home.done();
});

const SESSION = "th-1";
const dir = join(home.dir, "sessions", SESSION);
/** The node holds `token` as the server's header, as the hub's push leaves it in the node's secrets file. */
function hold(token: string | undefined, name = "paper") {
  mkdirSync(join(home.dir, "mcp-secrets", "projects"), { recursive: true });
  const servers = token === undefined ? {} : { [name]: { "header/Authorization": { value: `Bearer ${token}` } } };
  writeFileSync(join(home.dir, "mcp-secrets", "projects", "p1.json"), JSON.stringify({ servers }));
}
keep(dir, {
  role: "writer",
  config: {
    userServers: false,
    servers: [
      {
        name: "paper",
        secrets: { kind: "project", projectId: "p1" },
        roles: { lead: true, writers: true, reviewers: true },
        transport: { type: "http", url: paper.url },
        env: [],
        headers: [{ kind: "secret", name: "Authorization" }],
        oauth: true,
      },
    ],
  },
});

/** The hub's `mcp_oauth_renew` as a test drives it: renews (issuing a token the server takes, or one it turns away), or
 * says the sign-in is gone. */
const hub = { mode: "renew" as "renew" | "refused" | "signed_out", asks: [] as Json[] };
const ask = async (args: Json): Promise<Json> => {
  hub.asks.push(args);
  if (hub.mode === "signed_out" || args.refused) return { renewed: "signed_out", problem: "login.stand-in ended the sign-in (invalid_grant), so you need to sign in again." };
  hold(hub.mode === "renew" ? paper.issue() : `dead-${crypto.randomUUID()}`);
  return { renewed: "yes" };
};

function relay(name = "paper") {
  const out: Json[] = [];
  const lines: string[] = [];
  const r = new Relay(name, {
    node: (call) => relayCall(home.dir, SESSION, call, ask),
    fetch: (url, init) => fetch(url, init),
    write: async (line) => {
      lines.push(line);
      out.push(JSON.parse(line) as Json);
    },
    log: (line) => lines.push(line),
    timeoutMs: 5_000,
  });
  return { r, out, lines, last: () => out.at(-1)! };
}
const call = (id: number, name = "get_basic_info") => ({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: {} } });
const textOf = (m: Json) => ((m.result as Json).content as { text: string }[])[0]!.text;

test("a session reaches a signed-in server through the relay, and its config holds no token", () => {
  const token = paper.issue();
  hold(token);
  const config = sessionConfig(home.dir, kept(dir), undefined, SESSION, relayServer(["/opt/fleetd"], "/n/node.sock", SESSION));
  expect(JSON.parse(config.json).mcpServers.paper).toEqual({
    type: "stdio",
    command: "/opt/fleetd",
    args: ["mcp-relay", "--server", "paper"],
    env: { FLEETD_NODE_SOCK: "/n/node.sock", FLEETD_THREAD_ID: SESSION },
  });
  expect(config.json).not.toContain(token);
  // Still masked in what the session reports.
  expect(config.secrets).toEqual([["paper.Authorization", `Bearer ${token}`]]);
});

test("the server stays usable past its token's life: each request takes the newest token, and a 401 renews it", async () => {
  hub.mode = "renew";
  hub.asks = [];
  hold(paper.issue());
  const { r, out, lines, last } = relay();
  await serve(
    r,
    (async function* () {
      yield JSON.stringify({ jsonrpc: "2.0", id: 0, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "claude-code", version: "x" } } });
      yield JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" });
      yield JSON.stringify(call(1));
    })(),
  );
  expect(out[0]).toMatchObject({ id: 0, result: { serverInfo: { name: "stand-in" } } });
  expect(out.find((m) => m.id === 1)).toMatchObject({ result: { content: [{ text: "a frame" }] } });
  // The server's own notification on the tool's stream reaches claude too.
  expect(out.some((m) => m.method === "notifications/message")).toBe(true);

  // The hub renewed at half-life and the old token ended: the next call takes the new one, with nothing to renew.
  paper.endAll();
  hold(paper.issue());
  await r.deliver(call(2));
  expect(textOf(last())).toBe("a frame");
  expect(hub.asks).toEqual([]);

  // The token ended before the hub's renewal reached the machine: the 401 has it renewed now, and the call goes again.
  paper.endAll();
  await r.deliver(call(3));
  expect(last()).toMatchObject({ id: 3, result: { content: [{ text: "a frame" }] } });
  expect(hub.asks).toEqual([{ server: "paper" }]);

  // A session the server forgot is started again, and the call goes through.
  paper.s.sessions.clear();
  await r.deliver(call(4));
  expect(last()).toMatchObject({ id: 4, result: { content: [{ text: "a frame" }] } });

  // No token in anything claude reads.
  expect(lines.join("\n")).not.toContain("pt-");
});

test("a dead sign-in, a refused renewal and an unreachable server answer in words the agent can act on, and the server stays", async () => {
  hold(paper.issue());
  const { r, last, lines } = relay();
  await r.deliver({ jsonrpc: "2.0", id: 0, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "c", version: "1" } } });

  // The service ended the sign-in: the hub can't renew it.
  hub.mode = "signed_out";
  hub.asks = [];
  paper.endAll();
  await r.deliver(call(1));
  const said = last();
  expect(said).toMatchObject({ id: 1, result: { isError: true } });
  expect(textOf(said)).toBe(
    "paper's sign-in has ended (login.stand-in ended the sign-in (invalid_grant), so you need to sign in again). Ask the person to sign in to paper again: Reconnect on paper in the bot's Settings › Integrations. Until then, carry on without paper and say so in your result.",
  );
  expect(textOf(said)).not.toContain("/mcp");
  // A request other than a tool's call is answered with its error, in the same words.
  await r.deliver({ jsonrpc: "2.0", id: 2, method: "tools/list" });
  expect(last()).toMatchObject({ id: 2, error: { code: -32603, message: expect.stringContaining("Settings › Integrations") } });

  // Renewed, and the new token turned away too: the hub hears it (and signs the server out).
  hub.mode = "refused";
  hub.asks = [];
  await r.deliver(call(3));
  expect(hub.asks).toEqual([{ server: "paper" }, { server: "paper", refused: true }]);
  expect(textOf(last())).toContain("Reconnect on paper");

  // The server is down for a while: it says so, and the next call after works.
  hub.mode = "renew";
  hold(paper.issue());
  paper.s.down = true;
  await r.deliver(call(4));
  expect(textOf(last())).toBe(notNowText("paper", "it answered HTTP 503: busy"));
  paper.s.down = false;
  await r.deliver(call(5));
  expect(last()).toMatchObject({ id: 5, result: { content: [{ text: "a frame" }] } });

  // Nothing answers at its address at all.
  const gone = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("") });
  const port = gone.port;
  gone.stop(true);
  const elsewhere = { ...kept(dir)!, config: { ...kept(dir)!.config, servers: [{ ...kept(dir)!.config.servers![0]!, name: "far", transport: { type: "http" as const, url: `http://127.0.0.1:${port}/mcp` } }] } };
  const farDir = join(home.dir, "sessions", "th-far");
  keep(farDir, elsewhere);
  const farLines: Json[] = [];
  const far = new Relay("far", {
    node: (c) => relayCall(home.dir, "th-far", c, ask),
    fetch: (url, init) => fetch(url, init),
    write: async (line) => void farLines.push(JSON.parse(line) as Json),
    log: () => {},
    timeoutMs: 5_000,
  });
  hold(paper.issue(), "far");
  await far.deliver(call(6));
  expect(textOf(farLines.at(-1)!)).toStartWith("far can't be reached right now (");
  expect(lines.join("\n")).not.toContain("pt-");
});

test("the node renews only a token it still holds, and says when the sign-in is gone", async () => {
  const fresh = paper.issue();
  hold(fresh);
  hub.asks = [];
  // Turned away with a token the node has replaced since: the newer one, and no renewal.
  const newer = await renew(home.dir, SESSION, "paper", fingerprintOf("Bearer old"), false, ask);
  expect(newer).toMatchObject({ headers: { Authorization: `Bearer ${fresh}` }, fingerprint: fingerprintOf(`Bearer ${fresh}`) });
  expect(hub.asks).toEqual([]);
  // The hub took the token off the machine (signed out): the relay hears so.
  hold(undefined);
  expect(await relayCall(home.dir, SESSION, { op: "mcp_header", server: "paper" }, ask)).toEqual({ op: "mcp_header", refused: "paper is signed out", signedOut: true });
  // Only the session's own signed-in servers.
  expect(await relayCall(home.dir, SESSION, { op: "mcp_header", server: "other" }, ask)).toMatchObject({ signedOut: true });
});

/** A server on MCP's older SSE transport: a GET opens the stream, which names where to POST; answers come on it. */
function sseStandIn(valid: Set<string>) {
  const s = { streams: new Map<string, ReadableStreamDefaultController<Uint8Array>>(), inits: 0, n: 0 };
  const send = (id: string, m: Json) => s.streams.get(id)?.enqueue(new TextEncoder().encode(`event: message\ndata: ${JSON.stringify(m)}\n\n`));
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    idleTimeout: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (!valid.has((req.headers.get("authorization") ?? "").replace(/^Bearer /, ""))) return new Response("", { status: 401 });
      if (req.method === "GET") {
        const id = `c-${++s.n}`;
        const body = new ReadableStream<Uint8Array>({
          start(c) {
            s.streams.set(id, c);
            c.enqueue(new TextEncoder().encode(`event: endpoint\ndata: /messages?c=${id}\n\n`));
          },
        });
        return new Response(body, { headers: { "content-type": "text/event-stream" } });
      }
      const id = url.searchParams.get("c") ?? "";
      if (!s.streams.has(id)) return new Response("gone", { status: 404 });
      const m = (await req.json()) as Json;
      if (m.method === "initialize") {
        s.inits++;
        send(id, { jsonrpc: "2.0", id: m.id, result: { protocolVersion: "2024-11-05", capabilities: {}, serverInfo: { name: "old" } } });
      } else if (m.id !== undefined) send(id, { jsonrpc: "2.0", id: m.id, result: { content: [{ type: "text", text: "old frame" }] } });
      return new Response("", { status: 202 });
    },
  });
  /** The server ends every open stream. */
  const drop = () => {
    for (const [id, c] of s.streams) {
      c.close();
      s.streams.delete(id);
    }
  };
  return { s, server, drop, url: `http://127.0.0.1:${server.port}/sse` };
}

test("the older SSE transport is relayed too: a turned-away POST renews, and a dropped stream opens again as a new session", async () => {
  const old = sseStandIn(paper.s.valid);
  try {
    const sseDir = join(home.dir, "sessions", "th-sse");
    keep(sseDir, { ...kept(dir)!, config: { ...kept(dir)!.config, servers: [{ ...kept(dir)!.config.servers![0]!, name: "old", transport: { type: "sse" as const, url: old.url } }] } });
    hold(paper.issue(), "old");
    const out: Json[] = [];
    const lines: string[] = [];
    hub.mode = "renew";
    hub.asks = [];
    const holdOld = (t: string) => hold(t, "old");
    const r = new Relay("old", {
      node: (c) =>
        relayCall(home.dir, "th-sse", c, async (args) => {
          hub.asks.push(args);
          holdOld(paper.issue());
          return { renewed: "yes" };
        }),
      fetch: (url, init) => fetch(url, init),
      write: async (line) => {
        lines.push(line);
        out.push(JSON.parse(line) as Json);
      },
      log: (line) => lines.push(line),
      timeoutMs: 5_000,
    });
    await r.deliver({ jsonrpc: "2.0", id: 0, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "c", version: "1" } } });
    await r.deliver({ jsonrpc: "2.0", method: "notifications/initialized" });
    await r.deliver(call(1));
    expect(out.map((m) => m.id)).toEqual([0, 1]);
    // The token ends: the POST is turned away, renewed, and sent again.
    paper.endAll();
    await r.deliver(call(2));
    expect(out.at(-1)).toMatchObject({ id: 2, result: { content: [{ text: "old frame" }] } });
    expect(hub.asks).toEqual([{ server: "old" }]);
    // The server drops the stream: the next call opens it again, initializes the new session itself, and goes.
    old.drop();
    await Bun.sleep(20);
    await r.deliver(call(3));
    expect(out.at(-1)).toMatchObject({ id: 3, result: { content: [{ text: "old frame" }] } });
    expect(old.s.inits).toBe(2);
    expect(out.filter((m) => m.id === "fleetd-relay-initialize")).toEqual([]);
    expect(lines.join("\n")).not.toContain("pt-");
    await r.close();
  } finally {
    old.server.stop(true);
  }
});

test("`fleetd mcp-relay` runs as claude starts it, asking the node over its socket as the session it runs in", async () => {
  hold(paper.issue());
  const local = new LocalArea();
  for (const op of ["mcp_header", "mcp_renew"]) local.on(op, async (session, frame) => ({ result: await relayCall(home.dir, session, { ...(frame.call as Json), op }, ask) }));
  const sock = join(home.dir, "node.sock");
  const stop = await serveLeadSocket(sock, {
    relay: new LeadRelay(),
    identify: () => ({ kind: "session", session: SESSION }),
    maskFor: () => new Masker(),
    browser: (session, frame) => local.answer(session, frame),
  });
  try {
    const entry = JSON.parse(sessionConfig(home.dir, kept(dir), undefined, SESSION, relayServer([process.execPath, join(import.meta.dir, "../src/main.ts")], sock, SESSION)).json).mcpServers.paper;
    const child = Bun.spawn([entry.command, ...entry.args], { env: { ...process.env, ...entry.env }, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 0, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "c", version: "1" } } })}\n`);
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
    child.stdin.write(`${JSON.stringify(call(1))}\n`);
    child.stdin.end();
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect(code).toBe(0);
    const answers = stdout.trim().split("\n").map((l) => JSON.parse(l) as Json);
    expect(answers.find((m) => m.id === 1)).toMatchObject({ result: { content: [{ text: "a frame" }] } });
    expect(stdout + stderr).not.toContain("pt-");
  } finally {
    stop();
  }
});

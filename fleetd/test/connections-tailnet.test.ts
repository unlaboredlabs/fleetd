// Tailscale in Connections on a self-hosted hub (W807): its row reads the hub computer's own Tailscale (a stand-in
// here), Connect and Disconnect only turn the hub's route on and off and tell the machines, and a machine that isn't on
// the tailnet reaches a tailnet MCP server through it: the hub's signed dial route, then an agent's `fleetd mcp-relay`
// calling a tool through the node. A machine on the tailnet reaches it directly. Everything on 127.0.0.1; the
// stand-in resolver maps the tailnet's names and addresses to it.
import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { connect } from "node:net";
import { join } from "node:path";
import { Relay } from "../src/cli/mcp_relay.ts";
import { serve, stop } from "../src/hub/http/index.ts";
import { NOT_RUNNING } from "../src/hub/tailnet/index.ts";
import { start as startTailnet } from "../src/hub/tailnet/loops.ts";
import { type Dialer, tailnetAddress } from "../src/hub/tailnet/route.ts";
import { mcpServers } from "../src/hub/mcp_servers/index.ts";
import { mayDial, tailnetTargets } from "../src/hub/mcp_servers/model.ts";
import { keep, relayed, sessionConfig } from "../src/node/actions/mcp.ts";
import { viaRoute } from "../src/node/actions/mcp_relay.ts";
import { refresh, setLocalTailscale, viaHub } from "../src/node/actions/mcp_tailnet.ts";
import { loadOrCreateIdentity } from "../src/node/identity.ts";
import { NodeTailnet, setNodeTailnet } from "../src/node/sandbox/tailnet.ts";
import { dialFetch } from "../src/node/sandbox/tailnet_fetch.ts";
import type { McpServer, TailnetState } from "../src/shared/contracts.ts";
import { CAP_MCP_TAILNET } from "../src/shared/node_link.ts";
import type { McpSessionServer } from "../src/shared/sessions.ts";
import type { LocalTailscale } from "../src/shared/tailnet_local.ts";
import { tempHome } from "./helpers.ts";
import { addMachine, caller, testHub } from "./screens_helpers.ts";
import { tinyMcp } from "./tiny_mcp.ts";

const tiny = tinyMcp({ name: "tiny-tailnet" });
afterAll(() => tiny.server.stop(true));

/** The tailnet as the hub's computer sees it: a MagicDNS name and its address, both served by `tiny` here. */
const NAME = "tiny.tail1234.ts.net";
const ADDRESS = "100.101.102.103";
const standIn: Dialer = {
  async lookup(host) {
    if (host === NAME) return ADDRESS;
    if (host === "printer.lan") return "192.168.1.5";
    if (/^\d+\.\d+\.\d+\.\d+$/u.test(host)) return host;
    throw new Error("ENOTFOUND");
  },
  connect: (ip, port) =>
    new Promise((resolve, reject) => {
      if (ip !== ADDRESS) return reject(new Error("unreachable"));
      const s = connect({ host: "127.0.0.1", port: port === 8765 ? tiny.port : port });
      s.once("connect", () => resolve(s));
      s.once("error", reject);
    }),
};

let t: ReturnType<typeof testHub>;
let hubTailscale: LocalTailscale;
const told: { machineId: string; tailnet: unknown }[] = [];
const admin = caller("admin", { kind: "human" });
const call = async <T>(tool: string, input: unknown = {}) => {
  const r = await t.tools.call(t.hub, admin, tool, input);
  if ("error" in r) throw r.error.kind === "tool" ? r.error.error : new Error(r.error.kind);
  return r.output as T;
};

beforeEach(() => {
  t = testHub();
  hubTailscale = { running: true, tailnet: "ada@example.com", device: "devbox.tail1234.ts.net", suffix: "tail1234.ts.net" };
  t.hub.area("tailnet.host", () => async () => hubTailscale);
  t.hub.area("tailnet.dialer", () => standIn);
  told.length = 0;
  addMachine(t.hub, "laptop");
  t.link.linked.set("laptop", { id: 1, caps: new Set([CAP_MCP_TAILNET]), out: [] });
  t.link.answer = async (machineId, frame) => {
    const f = frame as unknown as { action?: string; tailnet?: unknown };
    if (f.action === "tailnet") told.push({ machineId, tailnet: f.tailnet });
    return {};
  };
});
afterEach(() => t.done());

test("the row reads the hub computer's Tailscale; Connect and Disconnect turn the route on and off and tell the machines", async () => {
  hubTailscale = { running: false };
  expect(await call<TailnetState>("tailnet_get")).toEqual({ status: "failed", problem: NOT_RUNNING });
  await expect(call("tailnet_connect")).rejects.toMatchObject({ message: "Tailscale isn't running on the hub's computer." });
  expect(told).toEqual([]);

  hubTailscale = { running: true, tailnet: "ada@example.com", device: "devbox.tail1234.ts.net", suffix: "tail1234.ts.net" };
  expect(await call<TailnetState>("tailnet_get")).toEqual({ status: "off", tailnet: "ada@example.com", device: "devbox.tail1234.ts.net" });
  expect(await call<TailnetState>("tailnet_connect")).toEqual({ status: "connected", tailnet: "ada@example.com", device: "devbox.tail1234.ts.net" });
  expect(told).toEqual([{ machineId: "laptop", tailnet: { suffix: "tail1234.ts.net" } }]);
  // Kept across a read: the switch is the hub's, the rest is read again.
  expect((await call<TailnetState>("tailnet_get")).status).toBe("connected");
  expect(await call<TailnetState>("tailnet_disconnect")).toEqual({ status: "off", tailnet: "ada@example.com", device: "devbox.tail1234.ts.net" });
  expect(told.at(-1)).toEqual({ machineId: "laptop", tailnet: null });
  // A machine that links hears it too.
  startTailnet(t.hub);
  await call("tailnet_connect");
  for (const fn of t.link.linkedFns) fn({ machineId: "laptop" } as never);
  await new Promise((r) => setTimeout(r, 10));
  expect(told.at(-1)).toEqual({ machineId: "laptop", tailnet: { suffix: "tail1234.ts.net" } });
});

test("a machine off the tailnet reaches a tailnet MCP server through the hub, and an agent's relay calls its tool", async () => {
  const server = serve(t.hub, t.tools, 0);
  const home = tempHome();
  try {
    const hubUrl = `http://127.0.0.1:${server.port}`;
    const nodeHome = join(home.dir, "node");
    mkdirSync(nodeHome, { recursive: true });
    const identity = loadOrCreateIdentity(nodeHome);
    t.hub.auth.nodes.enrollNode(t.hub.auth.nodes.createEnrollToken("laptop", "laptop").token, "laptop", identity.pubKey());
    const node = new NodeTailnet(hubUrl, "laptop", identity, { now: () => t.hub.clock.now() });
    node.set({ suffix: "tail1234.ts.net" });
    const fetchThrough = dialFetch((h, p) => node.dial(h, p));

    // The team's tailnet MCP server, for every bot; another machine's own bot has one too.
    const row = (name: string, url: string, scope: McpServer["scope"]): McpServer => ({ scope, name, enabled: true, roles: { lead: true, writers: true, reviewers: true }, transport: { type: "http", url }, env: [], headers: [], updatedAt: "2026-11-22T00:00:00.000Z" });
    mcpServers(t.hub).put(row("tiny", `http://${NAME}:8765/mcp`, { kind: "global" }));
    mcpServers(t.hub).put(row("theirs", `http://${ADDRESS}:9000/mcp`, { kind: "project", machineId: "desk", projectId: "p9" }));
    // The route is off until Connect.
    await expect(node.dial(NAME, 8765)).rejects.toThrow();
    await call("tailnet_connect");
    // Only the tailnet MCP servers this machine's bots get: not another port of the same host (its SSH), not another
    // machine's bot's server, not a name off the tailnet; and a stranger's call not at all.
    await expect(node.dial(NAME, 22)).rejects.toThrow();
    await expect(node.dial(ADDRESS, 9000)).rejects.toThrow();
    await expect(node.dial("printer.lan", 80)).rejects.toThrow();
    expect(await tailnetAddress(standIn, "printer.lan")).toEqual({ error: "printer.lan isn't on the tailnet" });
    expect(await tailnetAddress(standIn, NAME)).toEqual({ ip: ADDRESS });
    expect(tailnetTargets(mcpServers(t.hub).list({ kind: "global" }), "laptop", "tail1234.ts.net")).toEqual([{ host: NAME, port: 8765 }]);
    expect(mayDial([{ host: NAME, port: 8765 }], NAME.toUpperCase(), 8765)).toBe(true);
    const forged = new NodeTailnet(hubUrl, "laptop", loadOrCreateIdentity(join(home.dir, "other")), { now: () => t.hub.clock.now() });
    forged.set({ suffix: "tail1234.ts.net" });
    await expect(forged.dial(NAME, 8765)).rejects.toThrow();

    const init = await fetchThrough(`http://${NAME}:8765/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
    });
    expect(((await init.json()) as { result: { serverInfo: { name: string } } }).result.serverInfo.name).toBe("tiny-tailnet");

    // The agent's side: claude speaks to `fleetd mcp-relay`, which asks the node, which sends through the hub.
    const session = "s-relay";
    const dir = join(nodeHome, "sessions", session);
    const tinyServer: McpSessionServer = {
      name: "tiny",
      secrets: { kind: "global" },
      roles: { lead: true, writers: true, reviewers: true },
      transport: { type: "http", url: `http://${NAME}:8765/mcp` },
      headers: [{ kind: "plain", name: "X-Who", value: "fleetd" }],
      tailnet: true,
    };
    keep(dir, { role: "writer", config: { userServers: false, servers: [tinyServer] } });
    setNodeTailnet(node);
    setLocalTailscale(async () => ({ running: false }));
    await refresh();
    expect(viaHub()).toBe(true);
    expect(relayed(tinyServer)).toBe(true);
    expect(JSON.parse(sessionConfig(nodeHome, { role: "writer", config: { userServers: false, servers: [tinyServer] } }, undefined, session, (n) => ({ type: "stdio", command: "fleetd", args: ["mcp-relay", "--server", n] })).json)).toEqual({
      mcpServers: { tiny: { type: "stdio", command: "fleetd", args: ["mcp-relay", "--server", "tiny"] } },
    });
    // Only to the server's own address.
    expect(await viaRoute(nodeHome, session, "tiny", { url: "http://other.tail1234.ts.net/mcp", method: "POST" }, () => fetchThrough)).toEqual({
      refused: "tiny's requests go to its own address only",
      signedOut: false,
    });

    const lines: string[] = [];
    const relay = new Relay("tiny", {
      node: async (c) => {
        if (c.op === "mcp_header") {
          const { relayHeaders } = await import("../src/node/actions/mcp.ts");
          return relayHeaders(nodeHome, dir, "tiny");
        }
        if (c.op === "mcp_fetch") return viaRoute(nodeHome, session, "tiny", c, () => fetchThrough);
        throw new Error(`unexpected ${String(c.op)}`);
      },
      fetch: () => Promise.reject(new Error("the relay never dials a tailnet server itself here")),
      write: async (line) => void lines.push(line),
      log: () => {},
    });
    await relay.deliver({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "claude", version: "1" } } });
    await relay.deliver({ jsonrpc: "2.0", method: "notifications/initialized" });
    await relay.deliver({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "echo", arguments: { text: "hello from an agent" } } });
    expect(JSON.parse(lines.at(-1)!)).toEqual({ jsonrpc: "2.0", id: 2, result: { content: [{ type: "text", text: "tiny-tailnet heard: hello from an agent" }] } });
    expect(tiny.seen.at(-1)).toEqual({ method: "tools/call", auth: null });

    // A machine on the tailnet reaches it directly: no relay, its URL as it is.
    setLocalTailscale(async () => ({ running: true, suffix: "tail1234.ts.net" }));
    await refresh();
    expect(relayed(tinyServer)).toBe(false);
    expect(JSON.parse(sessionConfig(nodeHome, { role: "writer", config: { userServers: false, servers: [tinyServer] } }, undefined, session).json).mcpServers.tiny).toEqual({
      type: "http",
      url: `http://${NAME}:8765/mcp`,
      headers: { "X-Who": "fleetd" },
    });

    // Disconnect: the route takes no more dials.
    await call("tailnet_disconnect");
    await expect(node.dial(NAME, 8765)).rejects.toThrow();
  } finally {
    setNodeTailnet(undefined);
    setLocalTailscale(async () => ({ running: true }));
    await refresh();
    await stop(server);
    home.done();
  }
});

// `GET /node/tailnet/dial` on a self-hosted hub (shared/tailnet.ts): a websocket per TCP connection from a node whose
// machine isn't on the tailnet to one of its bots' tailnet MCP servers (and nothing else), dialed from the hub's
// computer, which is on the tailnet. Each call is signed
// by the node's own identity key, checked against the key the hub enrolled for the machine, within SKEW_MS of the
// hub's clock and once per nonce. Only the tailnet is reached: the name is resolved by the hub computer's own resolver
// (MagicDNS) and dialed only when it is one of the tailnet's addresses, never the hub's LAN, loopback or the internet.
// Nothing here logs an address, a name or a byte. Lookups (`/node/tailnet/dns`) are for hosted boxes, which only
// fleetd's cloud runs.
import { lookup } from "node:dns/promises";
import { connect, isIP } from "node:net";
import type { Duplex } from "node:stream";
import { verifyEd25519 } from "../../shared/upgrade_proof.ts";
import { ACK_EVERY, AT_HEADER, CAP, MACHINE_HEADER, NONCE_HEADER, SIG_HEADER, SKEW_MS, signedMessage, tailnetIp } from "../../shared/tailnet.ts";
import type { Hub } from "../api/hub.ts";
import { json, type Route, type Socket, type SocketHandler, upgrade } from "../http/route.ts";
import { mcpServers } from "../mcp_servers/index.ts";
import { mayDial, tailnetTargets } from "../mcp_servers/model.ts";
import { NOT_RUNNING, routeOn, routing, suffix } from "./index.ts";

/** The nonces seen within SKEW_MS, by when they expire. */
const seen = new Map<string, number>();

/** The machine a call is from, when its signature over `op` and `what` holds; else why not. */
export function caller(hub: Hub, req: Request, op: "dial" | "dns", what: string, now = hub.clock.now()): { machineId: string } | { refused: string } {
  const machineId = req.headers.get(MACHINE_HEADER) ?? "";
  const at = Number(req.headers.get(AT_HEADER) ?? "");
  const nonce = req.headers.get(NONCE_HEADER) ?? "";
  const sig = req.headers.get(SIG_HEADER) ?? "";
  if (!machineId || !Number.isFinite(at) || !/^[A-Za-z0-9_-]{16,64}$/u.test(nonce) || !sig) return { refused: "unsigned" };
  if (Math.abs(now - at) > SKEW_MS) return { refused: "the call's time is too far from the workspace's" };
  let key: string | undefined;
  try {
    key = hub.auth.nodes.nodePubKey(machineId);
  } catch {
    key = undefined;
  }
  if (!key || !verifyEd25519(key, signedMessage(machineId, at, nonce, op, what), sig)) return { refused: "the signature doesn't verify" };
  for (const [n, until] of seen) if (until < now) seen.delete(n);
  if (seen.has(nonce)) return { refused: "the call was made already" };
  seen.set(nonce, now + SKEW_MS * 2);
  return { machineId };
}

const port = (v: string | null) => {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 && n < 65536 ? n : undefined;
};

/** How the route reaches a host; a test gives its own. */
export type Dialer = { lookup(host: string): Promise<string>; connect(ip: string, port: number): Promise<Duplex> };

export const hostDialer: Dialer = {
  async lookup(host) {
    return isIP(host) !== 0 ? host : (await lookup(host)).address;
  },
  connect: (ip, p) =>
    new Promise((resolve, reject) => {
      const s = connect({ host: ip, port: p });
      const timer = setTimeout(() => s.destroy(new Error(`${ip}:${p} didn't answer within 15 s`)), 15_000);
      s.once("connect", () => {
        clearTimeout(timer);
        resolve(s);
      });
      s.once("error", (e) => {
        clearTimeout(timer);
        reject(e);
      });
    }),
};

const dialer = (hub: Hub) => hub.area<Dialer>("tailnet.dialer", () => hostDialer);

/** `host` resolved by the hub's computer, when it is on the tailnet; else why not, in words for the agent. */
export async function tailnetAddress(d: Dialer, host: string): Promise<{ ip: string } | { error: string }> {
  let ip: string;
  try {
    ip = await d.lookup(host.replace(/^\[(.*)\]$/u, "$1"));
  } catch {
    return { error: `the workspace's computer can't find ${host} on its tailnet` };
  }
  return tailnetIp(ip) ? { ip } : { error: `${host} isn't on the tailnet` };
}

type DialState = { conn?: Duplex; early: Buffer[]; closed: boolean; host: string; port: number; held: number; taken: number };

function forward(ws: Socket, st: DialState, conn: Duplex, bytes: Buffer): void {
  conn.write(bytes, () => {
    st.held -= bytes.length;
    st.taken += bytes.length;
    if (st.taken >= ACK_EVERY && !st.closed) {
      ws.send(JSON.stringify({ ack: st.taken }));
      st.taken = 0;
    }
  });
}

function handler(hub: Hub): SocketHandler {
  return {
    async open(ws: Socket) {
      const st = ws.data.state as DialState;
      const fail = (error: string) => {
        if (st.closed) return;
        ws.send(JSON.stringify({ error: error.slice(0, 300) }));
        ws.close();
      };
      const at = await tailnetAddress(dialer(hub), st.host);
      if ("error" in at) return fail(at.error);
      let conn: Duplex;
      try {
        conn = await dialer(hub).connect(at.ip, st.port);
      } catch (e) {
        return fail(`${st.host}:${st.port} refused the workspace's computer (${(e as Error).message})`);
      }
      if (st.closed) return void conn.destroy();
      st.conn = conn;
      ws.send(JSON.stringify({ ok: true }));
      for (const b of st.early.splice(0)) forward(ws, st, conn, b);
      conn.on("data", (d: Buffer) => {
        if (ws.send(d) === -1) conn.pause();
      });
      conn.on("end", () => ws.close());
      conn.on("close", () => ws.close());
      conn.on("error", () => ws.close());
    },
    message(ws: Socket, message: string | Buffer) {
      const st = ws.data.state as DialState;
      if (typeof message === "string") return;
      st.held += message.length;
      if (st.held > CAP) return void ws.close(1009, "past the tailnet window");
      if (st.conn) forward(ws, st, st.conn, Buffer.from(message));
      else st.early.push(Buffer.from(message));
    },
    drain(ws: Socket) {
      (ws.data.state as DialState).conn?.resume();
    },
    close(ws: Socket) {
      const st = ws.data.state as DialState;
      st.closed = true;
      st.conn?.destroy();
    },
  };
}

/** One TCP connection to a tailnet host, from the hub's computer, for a machine that isn't on the tailnet. */
export const dialRoute: Route = (req, ctx) => {
  const q = new URL(req.url).searchParams;
  const host = q.get("host") ?? "";
  const p = port(q.get("port"));
  if (!host || host.length > 253 || /[\s/]/u.test(host) || p === undefined) return json({ error: "host and port" }, 400);
  const who = caller(ctx.hub, req, "dial", `${host}:${p}`);
  if ("refused" in who) return json({ error: who.refused }, 401);
  if (!routeOn(ctx.hub)) return json({ error: "the team's Tailscale isn't connected: connect it in Connections" }, 503);
  if (!routing(ctx.hub)) return json({ error: NOT_RUNNING }, 503);
  // Only the tailnet MCP servers the machine's sessions get: Connect lends the hub's tailnet to them, not to its SSH,
  // its NAS or anything else the hub's computer reaches there.
  const s = mcpServers(ctx.hub);
  const targets = tailnetTargets([...s.list({ kind: "global" }), ...s.perBot()], who.machineId, suffix(ctx.hub));
  if (!mayDial(targets, host, p)) return json({ error: `${host}:${p} isn't a tailnet MCP server of this machine's bots` }, 403);
  const state: DialState = { early: [], closed: false, host, port: p, held: 0, taken: 0 };
  return upgrade(req, ctx, handler(ctx.hub), state);
};

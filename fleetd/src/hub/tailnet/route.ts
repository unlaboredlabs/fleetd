// Where a node's hosted boxes reach the team's tailnet (shared/tailnet.ts): `GET /node/tailnet/dial`, a websocket per
// TCP connection, and `GET /node/tailnet/dns`, one lookup. Each call is signed by the node's own identity key, checked
// against the key the hub enrolled for the machine, within SKEW_MS of the hub's clock and once per nonce. Nothing here
// logs an address, a name or a byte. Only the tailnet is reached: an address of its ranges or a MagicDNS name, never
// anything the hub's machine reaches by itself (its loopback, its LAN, the internet), which a userspace tailscaled
// would otherwise dial on the host's own network. The gateway narrows that to its netmap's peers (./local.ts `dial`):
// never its own address or name, which userspace tailscaled hands to the hub machine's loopback.
import type { Duplex } from "node:stream";
import { verifyEd25519 } from "../../shared/upgrade_proof.ts";
import { AT_HEADER, MACHINE_HEADER, NONCE_HEADER, NOT_HERE, SIG_HEADER, SKEW_MS, signedMessage, tailnetIp, tailnetName } from "../../shared/tailnet.ts";
import type { Hub } from "../api/hub.ts";
import { json, type Route, type Socket, type SocketHandler, upgrade } from "../http/route.ts";
import { NotHere, Off } from "./gateway.ts";
import { tailnet } from "./index.ts";

/** The nonces seen within SKEW_MS, by when they expire. */
const seen = new Map<string, number>();

/** The machine a call is from, when its signature over `op` and `what` holds; else why not. */
export function caller(hub: Hub, req: Request, op: "dial" | "dns", what: string, now = hub.clock.now()): { machineId: string } | { refused: string } {
  const machineId = req.headers.get(MACHINE_HEADER) ?? "";
  const at = Number(req.headers.get(AT_HEADER) ?? "");
  const nonce = req.headers.get(NONCE_HEADER) ?? "";
  const sig = req.headers.get(SIG_HEADER) ?? "";
  if (!machineId || !Number.isFinite(at) || !/^[A-Za-z0-9_-]{16,64}$/u.test(nonce) || !sig) return { refused: "unsigned" };
  if (Math.abs(now - at) > SKEW_MS) return { refused: "the call's time is too far from the hub's" };
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

/** One lookup: the gateway's DNS answer's bytes; 421 where another host holds the gateway, 503 while it is off. */
export const dnsRoute: Route = async (req, { hub }) => {
  const q = new URL(req.url).searchParams;
  const name = q.get("name") ?? "";
  const type = Number(q.get("type") ?? "");
  if (!name || name.length > 253 || !Number.isInteger(type) || type <= 0 || type > 65535) return json({ error: "name and type" }, 400);
  if (!tailnetName(name, tailnet(hub).suffix())) return json({ error: `${name} isn't a name on the tailnet` }, 403);
  const who = caller(hub, req, "dns", `${name}/${type}`);
  if ("refused" in who) return json({ error: who.refused }, 401);
  try {
    const bytes = await tailnet(hub).dns(name, type, AbortSignal.timeout(10_000));
    return new Response(bytes, { headers: { "content-type": "application/dns-message" } });
  } catch (error) {
    if (error instanceof NotHere) return json({ error: error.message }, NOT_HERE);
    if (error instanceof Off) return json({ error: error.message }, 503);
    return json({ error: (error as Error).message }, 502);
  }
};

type DialState = { conn?: Duplex; early: Buffer[]; closed: boolean; host: string; port: number; machineId: string };

/** The bytes between the node's socket and the gateway's connection, once the dial went through. */
function handler(hub: Hub): SocketHandler {
  return {
    async open(ws: Socket) {
      const st = ws.data.state as DialState;
      let conn: Duplex;
      try {
        conn = await tailnet(hub).dial(st.host, st.port, AbortSignal.timeout(15_000));
      } catch (error) {
        const retry = error instanceof NotHere;
        if (!st.closed) {
          ws.send(JSON.stringify({ error: (error as Error).message.slice(0, 300), ...(retry ? { retry: true } : {}) }));
          ws.close();
        }
        return;
      }
      if (st.closed) return void conn.destroy();
      st.conn = conn;
      ws.send(JSON.stringify({ ok: true }));
      for (const b of st.early.splice(0)) conn.write(b);
      conn.on("data", (d: Buffer) => {
        // Past Bun's buffer: the gateway's side waits until the node's side drained.
        if (ws.send(d) === -1) conn.pause();
      });
      conn.on("end", () => ws.close());
      conn.on("close", () => ws.close());
      conn.on("error", () => ws.close());
    },
    message(ws: Socket, message: string | Buffer) {
      const st = ws.data.state as DialState;
      if (typeof message === "string") return;
      if (st.conn) st.conn.write(message);
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

/** Whether a dial's `host` is the tailnet's: one of its addresses, or a MagicDNS name. */
export const onTailnet = (host: string, suffix: string | undefined) => tailnetIp(host.replace(/^\[(.*)\]$/u, "$1")) || tailnetName(host, suffix);

/** One TCP connection through the gateway, for a box of the calling machine's. */
export const dialRoute: Route = (req, ctx) => {
  const q = new URL(req.url).searchParams;
  const host = q.get("host") ?? "";
  const p = port(q.get("port"));
  if (!host || host.length > 253 || /[\s/]/u.test(host) || p === undefined) return json({ error: "host and port" }, 400);
  if (!onTailnet(host, tailnet(ctx.hub).suffix())) return json({ error: `${host} isn't on the tailnet` }, 403);
  const who = caller(ctx.hub, req, "dial", `${host}:${p}`);
  if ("refused" in who) return json({ error: who.refused }, 401);
  const state: DialState = { early: [], closed: false, host, port: p, machineId: who.machineId };
  return upgrade(req, ctx, handler(ctx.hub), state);
};

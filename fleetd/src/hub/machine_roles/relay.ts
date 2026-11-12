// The relay for sessions hosted on another machine than their agent's:
// what a session streams (a browser's CDP) between the agent's node and the runner's, through the hub, one websocket
// channel per connection the agent's driver makes.
//
// Each hosted session has one token for its agent's side, minted at its start and given only to the agent's node (the
// hub keeps its SHA-256). A connection on `/relay/<token>` names the session; the hub then mints a one-time channel
// token, asks the runner's node to connect it (`relay_dial`), and pipes the two sockets frame for frame until either
// ends. Nothing here logs a frame, a payload or a token.
import type { Hub } from "../api/hub.ts";
import { link } from "../link/index.ts";
import { type RouteContext, type Socket, type SocketHandler, type Route, upgrade, expectUpgrade } from "../http/route.ts";
import { newRelayToken, type Place, placeByRelay } from "./places.ts";
import { DIAL_WAIT, GONE_HEADER, goneProof, hashToken, isToken } from "./relay_rules.ts";

export { DIAL_WAIT, GONE_HEADER, goneProof, hashToken, isToken, MAX_MESSAGE } from "./relay_rules.ts";

/** One side of a channel: the other, once both are there, and what came before the other did. */
type Side = { peer: Socket | undefined; early: (string | Buffer)[]; closed: boolean };

/** Channels waiting for their runner's side, by their one-time token. */
export class Relays {
  readonly waiting = new Map<string, { since: number; agent: Socket; timer: Timer }>();
  /** Every payload piped, for tests that the hub carried only what the nodes encrypted. */
  tap: ((payload: string | Buffer) => void) | undefined;
}

export const relays = (hub: Hub) => hub.area("machine_roles.relays", () => new Relays());

function pipeTo(r: Relays, from: Side, message: string | Buffer): void {
  r.tap?.(message);
  if (from.peer) from.peer.send(message);
  else from.early.push(message);
}

function handler(hub: Hub): SocketHandler {
  const r = relays(hub);
  return {
    open(ws) {
      const state = ws.data.state as { side: Side; place?: Place; token?: string };
      // The agent's side: the runner connects the other with a channel token of its own.
      if (state.place) {
        const token = newRelayToken();
        state.token = token;
        const timer = setTimeout(() => {
          r.waiting.delete(token);
          ws.close();
        }, DIAL_WAIT);
        r.waiting.set(token, { since: Date.now(), agent: ws, timer });
        const dialed = link(hub).send(state.place.runner, {
          t: "relay_dial",
          hostKey: state.place.key,
          token,
          stream: "cdp",
        });
        if (!dialed) {
          clearTimeout(timer);
          r.waiting.delete(token);
          ws.close();
        }
      }
    },
    message(ws, message) {
      const { side } = ws.data.state as { side: Side };
      pipeTo(r, side, message);
    },
    close(ws) {
      const state = ws.data.state as { side: Side; token?: string };
      state.side.closed = true;
      if (state.token) {
        const waiting = r.waiting.get(state.token);
        if (waiting?.agent === ws) {
          clearTimeout(waiting.timer);
          r.waiting.delete(state.token);
        }
      }
      state.side.peer?.close();
    },
  };
}

/** `/relay/<token>`: the runner's side of a channel the hub asked it for, or an agent's node opening one. */
export const relay: Route = (req, ctx: RouteContext) => {
  if (req.headers.get("upgrade")?.toLowerCase() !== "websocket") return expectUpgrade();
  const token = ctx.params.token ?? "";
  if (!isToken(token)) return new Response("not a fleetd session relay", { status: 403 });
  const hub = ctx.hub;
  const r = relays(hub);
  const waiting = r.waiting.get(token);
  if (waiting && Date.now() - waiting.since < DIAL_WAIT) {
    r.waiting.delete(token);
    clearTimeout(waiting.timer);
    // The runner's side: joined to the agent's, which takes what it held back.
    const agentState = waiting.agent.data.state as { side: Side };
    const side: Side = { peer: waiting.agent, early: [], closed: false };
    const joined: SocketHandler = {
      open(ws) {
        if (agentState.side.closed) return ws.close();
        agentState.side.peer = ws;
        for (const m of agentState.side.early.splice(0)) ws.send(m);
      },
      message(ws, message) {
        pipeTo(r, (ws.data.state as { side: Side }).side, message);
      },
      close(ws) {
        (ws.data.state as { side: Side }).side.closed = true;
        waiting.agent.close();
      },
    };
    return upgrade(req, ctx, joined, { side });
  }
  const hashed = hashToken(token);
  let place: Place | undefined;
  try {
    place = placeByRelay(hub.db.conn, hashed);
  } catch (e) {
    console.warn("session relay: lookup failed:", e);
    return new Response("the hub failed", { status: 500 });
  }
  if (!place) {
    return new Response("no session open at this relay", { status: 410, headers: { [GONE_HEADER]: goneProof(hashed) } });
  }
  const side: Side = { peer: undefined, early: [], closed: false };
  return upgrade(req, ctx, handler(hub), { side, place });
};

// The agent's only way to its session's browser: a CDP websocket on 127.0.0.1 at `/devtools/browser/<token>`, one token
// per agent session, signed with the proxy's key, which the agent's AGENT_BROWSER_CDP names. Chrome itself has no
// debugging port; its pipe is the broker's (cdp.ts). The proxy forwards the driver's commands under ids of its own,
// sends back their answers and the events the driver may see, and answers itself instead when the command isn't one
// agent-browser sends, or the agent may not drive now (guard.ts, session.ts). Once the session filled a value,
// everything the driver hears is scrubbed of it, and a write to a field it filled is refused (credentials.ts).
// Sockets only: the node keeps its port and key across restarts (./proxy.ts), and a service with no node passes its
// own key, so a new holder signs the same tokens.
import { createHmac, timingSafeEqual } from "node:crypto";
import type { Message } from "./cdp.ts";
import { filledFieldRefusal, unplacedWrite, writesNode } from "./credentials.ts";
import { refused } from "./guard.ts";
import type { Session } from "./session.ts";

/** A full-page screenshot or a large DOM is several MB. */
const MAX_MESSAGE = 128 << 20;
const PATH = "/devtools/browser/";

/** Where the proxy finds a thread's session, here or on another machine through the hub's relay. */
export interface Sessions {
  live(thread: string): Session | undefined;
  /** A session hosted elsewhere: its relay on the hub, and the key the two nodes seal it with. */
  remote?(thread: string): { url: string; key: Uint8Array } | undefined;
  /** The relay says the session there ended: forget it here. */
  gone?(thread: string): void;
  /** Why a sealed session refuses the driver's DOM write (credentials.ts `filledFieldRefusal`, the default). */
  writeRefusal?(session: Session, command: Message): Promise<string | undefined>;
  /** Carries the driver to a session hosted elsewhere, sealed, through its relay (the node's: ./proxy.ts). */
  pipe?(driver: DriverEnd, relay: { url: string; key: Uint8Array }, thread: string): void;
}

/** One message of the driver's or to it. */
export type Frame = string | Uint8Array;

/** The driver's side of a channel to a session elsewhere (../session_route/relay.ts `End`). */
export type DriverEnd = {
  ready: Promise<boolean>;
  send(message: Frame): void;
  close(): void;
  onMessage(fn: (message: Frame) => void): void;
  onClose(fn: () => void): void;
};

/** What the proxy uses of Bun's server and its sockets (named here, not imported: the package takes no npm types). */
type Server<D> = { port?: number; upgrade(req: Request, options: { data: D }): boolean; stop(closeActive?: boolean): unknown };
type ServerWebSocket<D> = { data: D; send(message: string | Uint8Array): unknown; close(): void };

type Data =
  | { session: Session; queue?: Promise<void> }
  | { relay: { url: string; key: Uint8Array }; thread: string; message?: (m: Frame) => void; closed?: () => void };

export class Proxy {
  protected constructor(
    readonly port: number,
    private readonly key: string,
    private readonly server: Server<Data>,
  ) {}

  /** Listens on 127.0.0.1 at `port` (0: any free one), signing tokens with `key` (64 hex characters). Any other key
   * is refused: one anybody could guess would let an agent sign another session's token. */
  static serve(key: string, sessions: Sessions, port = 0): Proxy {
    if (!/^[0-9a-f]{64}$/.test(key)) throw new Error("the browser proxy's key must be 64 hex characters (32 random bytes)");
    let proxy!: Proxy;
    const server = Bun.serve<Data>({ hostname: "127.0.0.1", port, ...handlers(sessions, () => proxy) }) as unknown as Server<Data>;
    proxy = new Proxy(server.port ?? 0, key, server);
    return proxy;
  }

  private sign(thread: string): string {
    // As the Rust proxy signs: HMAC-SHA256 under the hex key's own bytes.
    return createHmac("sha256", this.key).update(thread).digest("hex");
  }

  /** The agent session's URL: `<thread>.<its signature>`, the same across node restarts. `port`: the one the agent
   * reaches the proxy at, where that isn't this proxy's own (a box's loopback relayed to it). */
  url(thread: string, port = this.port): string {
    return `ws://127.0.0.1:${port}${PATH}${thread}.${this.sign(thread)}`;
  }

  threadOf(token: string): string | undefined {
    const dot = token.lastIndexOf(".");
    if (dot < 0) return undefined;
    const [thread, signature] = [token.slice(0, dot), token.slice(dot + 1)];
    if (!/^([0-9a-f]{2})+$/.test(signature)) return undefined;
    const want = Buffer.from(this.sign(thread), "hex");
    const got = Buffer.from(signature, "hex");
    return got.length === want.length && timingSafeEqual(got, want) ? thread : undefined;
  }

  stop(): void {
    void this.server.stop(true);
  }
}

function handlers(sessions: Sessions, proxy: () => Proxy) {
  return {
    fetch(req: Request, server: Server<Data>): Response | undefined {
      const path = new URL(req.url).pathname;
      const thread = path.startsWith(PATH) ? proxy().threadOf(path.slice(PATH.length)) : undefined;
      if (!thread) return new Response("not a fleetd browser session", { status: 403 });
      const session = sessions.live(thread);
      let data: Data;
      if (session) data = { session };
      else {
        // On another machine: the hub's relay carries the driver there, sealed.
        const relay = sessions.pipe ? sessions.remote?.(thread) : undefined;
        if (!relay) return new Response("No browser session is open: call session_start first.", { status: 409 });
        data = { relay, thread };
      }
      return server.upgrade(req, { data }) ? undefined : new Response("Expected a WebSocket upgrade", { status: 426 });
    },
    websocket: {
      maxPayloadLength: MAX_MESSAGE,
      open(ws: ServerWebSocket<Data>) {
        const d = ws.data;
        if ("session" in d) {
          d.session.proxyTo((message) => ws.send(JSON.stringify(d.session.outgoing(message))));
          return;
        }
        // The driver's side of the channel: piped sealed to the session's relay on the hub.
        const driver: DriverEnd = {
          ready: Promise.resolve(true),
          send: (m) => void ws.send(m),
          close: () => ws.close(),
          onMessage: (fn) => (d.message = fn),
          onClose: (fn) => (d.closed = fn),
        };
        if (sessions.pipe) sessions.pipe(driver, d.relay, d.thread);
        else ws.close();
      },
      message(ws: ServerWebSocket<Data>, raw: string | Buffer) {
        const d = ws.data;
        if (!("session" in d)) return void d.message?.(raw);
        let command: Message;
        try {
          command = JSON.parse(raw.toString()) as Message;
        } catch {
          return;
        }
        const session = d.session;
        const commandIn = (filled: string | undefined) => {
          const why = filled ?? session.refusal(command);
          if (why) {
            ws.send(JSON.stringify(refused(command.id ?? null, why)));
            return;
          }
          if (!session.cdp.forward(command)) ws.send(JSON.stringify(refused(command.id ?? null, "the browser closed")));
        };
        // A write to a field the session filled: the browser says which node it names first. The driver's commands
        // keep their order meanwhile.
        if (d.queue || (session.sealed() && writesNode(command.method))) {
          const ahead = d.queue ?? Promise.resolve();
          const mine: Promise<void> = ahead
            .then(() => (sessions.writeRefusal ?? filledFieldRefusal)(session, command))
            // A check that fails says nothing about the field: the write is refused, never let through.
            .then(commandIn, () => commandIn(unplacedWrite(command.method)))
            .finally(() => {
              if (d.queue === mine) d.queue = undefined;
            });
          d.queue = mine;
          return;
        }
        commandIn(undefined);
      },
      close(ws: ServerWebSocket<Data>) {
        const d = ws.data;
        if ("session" in d) d.session.proxyTo(undefined);
        else d.closed?.();
      },
    },
  };
}

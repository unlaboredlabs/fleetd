// The agent's only way to its session's browser (crates/fleetd/src/node/browser/proxy.rs): a CDP websocket on
// 127.0.0.1 at `/devtools/browser/<token>`, one token per agent session, which the node puts in the session's
// `AGENT_BROWSER_CDP`. A claude runs on through a node restart and keeps that environment, so the port and the tokens
// do too: the port is kept in `browser/proxy.json`, with the key each token is signed with. Chrome itself has no
// debugging port; its pipe is the node's (cdp.ts). The proxy forwards the driver's commands under ids of its own, sends
// back their answers and the events the driver may see, and answers itself instead when the command isn't one
// agent-browser sends, or the agent may not drive now (guard.ts, session.ts). Once the session filled a value from
// 1Password, everything the driver hears is scrubbed of it, and a write to a field it filled is refused
// (credentials.ts).
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Server, ServerWebSocket } from "bun";
import type { Message } from "./cdp.ts";
import { filledFieldRefusal, writesNode } from "./credentials.ts";
import { refused } from "./guard.ts";
import type { Session } from "./session.ts";
import { clientEnd, type End, type Frame, pipeSealed, relaySaysGone } from "../session_route/relay.ts";

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
}

type Kept = { port: number; key: string };
type Data =
  | { session: Session; queue?: Promise<void> }
  | { relay: { url: string; key: Uint8Array }; thread: string; message?: (m: Frame) => void; closed?: () => void };

const keptPath = (home: string) => join(home, "browser", "proxy.json");

function readKept(home: string): Kept | undefined {
  try {
    const kept = JSON.parse(readFileSync(keptPath(home), "utf8")) as Kept;
    return typeof kept.port === "number" && typeof kept.key === "string" && kept.key.length === 64 ? kept : undefined;
  } catch {
    return undefined;
  }
}

export class Proxy {
  private constructor(
    readonly port: number,
    private readonly key: string,
    private readonly server: Server<Data>,
  ) {}

  /**
   * Listens on the port the node's last run did, so the claudes that ran on through its restart still reach it; on a
   * new one only when that port is taken.
   */
  static start(home: string, sessions: Sessions): Proxy {
    const kept = readKept(home);
    const key = kept?.key ?? randomBytes(32).toString("hex");
    let server: Server<Data>;
    const options = (port: number) => ({ hostname: "127.0.0.1", port, ...handlers(sessions, () => proxy) });
    let proxy!: Proxy;
    try {
      server = Bun.serve<Data>(options(kept?.port ?? 0));
    } catch (e) {
      if (!kept) throw e;
      console.warn(`browser proxy: port ${kept.port} is taken; the agents that ran on through the restart lose their browser`);
      server = Bun.serve<Data>(options(0));
    }
    const path = keptPath(home);
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const next = `${path}.next`;
    writeFileSync(next, `${JSON.stringify({ port: server.port, key })}\n`, { mode: 0o600 });
    chmodSync(next, 0o600);
    renameSync(next, path);
    proxy = new Proxy(server.port ?? 0, key, server);
    return proxy;
  }

  private sign(thread: string): string {
    // As the Rust proxy signs: HMAC-SHA256 under the hex key's own bytes.
    return createHmac("sha256", this.key).update(thread).digest("hex");
  }

  /** The agent session's URL: `<thread>.<its signature>`, the same across node restarts. */
  url(thread: string): string {
    return `ws://127.0.0.1:${this.port}${PATH}${thread}.${this.sign(thread)}`;
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
        const relay = sessions.remote?.(thread);
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
          d.session.cdp.proxyEvents((message) => ws.send(JSON.stringify(d.session.outgoing(message))));
          return;
        }
        // The driver's side of the channel: piped sealed to the session's relay on the hub.
        const driver: End = {
          ready: Promise.resolve(true),
          send: (m) => void ws.send(m),
          close: () => ws.close(),
          onMessage: (fn) => (d.message = fn),
          onClose: (fn) => (d.closed = fn),
        };
        const hub = new WebSocket(d.relay.url);
        // A session that ended there by itself (idle, a person, a lost runner): forget its relay here too.
        hub.addEventListener("error", () => void relaySaysGone(d.relay.url).then((gone) => gone && sessions.gone?.(d.thread)), { once: true });
        void pipeSealed(driver, clientEnd(hub), d.relay.key, "agent");
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
            .then(() => filledFieldRefusal(session, command))
            .then(commandIn, () => commandIn(undefined))
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
        if ("session" in d) d.session.cdp.proxyEvents(undefined);
        else d.closed?.();
      },
    },
  };
}

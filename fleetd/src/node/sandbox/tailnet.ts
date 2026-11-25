// The team's tailnet as this node's hosted boxes reach it (W722): through the team's Tailscale gateway, which the hub
// runs (hub/tailnet). The hub tells the node whether it is on, with its MagicDNS suffix (`node_action` tailnet); the
// node passes that to each of its boxes (./box.ts `tailnet`), whose capture (./tailnet_box.ts) sends each tailnet
// connection and lookup up the box's own link. The node carries each one on to the hub: a websocket per connection
// (shared/tailnet.ts DIAL_PATH), a request per lookup (DNS_PATH), signed with the node's own identity key. A host that
// doesn't hold the gateway (a cloud's) answers so, and the node calls again.
import { randomBytes } from "node:crypto";
import { Duplex } from "node:stream";
import { AT_HEADER, DIAL_PATH, DNS_PATH, MACHINE_HEADER, NONCE_HEADER, NOT_HERE, NOT_HERE_TRIES, SIG_HEADER, signedMessage, ACK_EVERY, WINDOW } from "../../shared/tailnet.ts";

/** What a box's link asks of the node for the tailnet. */
export type TailnetHooks = {
  /** A TCP connection to `host` (a tailnet address or name) on `port`; throws why not, in plain words. */
  dial(host: string, port: number): Promise<Duplex>;
  /** The gateway's DNS answer to `name` of type `type`. */
  dns(name: string, type: number): Promise<Uint8Array>;
};

/** How long a dial's first answer may take: the gateway's own dial and the hub's word on it. */
const DIAL_WAIT_MS = 20_000;

type Signer = { signTailnet(message: string): string };

export class NodeTailnet implements TailnetHooks {
  #suffix: string | undefined;
  #on = false;
  #listeners = new Set<() => void>();

  constructor(
    readonly hub: string,
    readonly machineId: string,
    private readonly identity: Signer,
    private readonly o: { now?: () => number; fetch?: typeof fetch } = {},
  ) {}

  /** Whether the team's gateway is on. */
  get on(): boolean {
    return this.#on;
  }

  /** Its MagicDNS suffix while it is on. */
  get suffix(): string | undefined {
    return this.#on ? this.#suffix : undefined;
  }

  /** The hub's word (`node_action` tailnet): on with its suffix, or off (null). */
  set(t: { suffix?: unknown } | null | undefined): void {
    const on = t !== null && t !== undefined && typeof t === "object";
    const suffix = on && typeof t.suffix === "string" && t.suffix ? t.suffix : undefined;
    if (on === this.#on && suffix === this.#suffix) return;
    this.#on = on;
    this.#suffix = suffix;
    for (const fn of this.#listeners) fn();
  }

  onChange(fn: () => void): () => void {
    this.#listeners.add(fn);
    return () => void this.#listeners.delete(fn);
  }

  #signed(op: "dial" | "dns", what: string): Record<string, string> {
    const at = (this.o.now ?? Date.now)();
    const nonce = randomBytes(18).toString("base64url");
    return {
      [MACHINE_HEADER]: this.machineId,
      [AT_HEADER]: String(at),
      [NONCE_HEADER]: nonce,
      [SIG_HEADER]: this.identity.signTailnet(signedMessage(this.machineId, at, nonce, op, what)),
    };
  }

  #url(path: string, q: Record<string, string>, ws = false): string {
    const u = new URL(this.hub);
    if (ws) u.protocol = u.protocol === "https:" ? "wss:" : "ws:";
    u.pathname = path;
    u.search = new URLSearchParams(q).toString();
    u.hash = "";
    return u.href;
  }

  async dns(name: string, type: number): Promise<Uint8Array> {
    if (!this.#on) throw new Error("the team has no Tailscale connection");
    for (let i = 0; ; i++) {
      const res = await (this.o.fetch ?? fetch)(this.#url(DNS_PATH, { name, type: String(type) }), {
        headers: this.#signed("dns", `${name}/${type}`),
        signal: AbortSignal.timeout(10_000),
      });
      if (res.ok) return new Uint8Array(await res.arrayBuffer());
      if (res.status === NOT_HERE && i + 1 < NOT_HERE_TRIES) continue;
      throw new Error(await words(res));
    }
  }

  async dial(host: string, port: number): Promise<Duplex> {
    if (!this.#on) throw new Error("the team has no Tailscale connection: an admin connects it in Connections");
    for (let i = 0; ; i++) {
      const got = await this.#dialOnce(host, port);
      if ("duplex" in got) return got.duplex;
      if (!got.retry || i + 1 >= NOT_HERE_TRIES) throw new Error(got.error);
    }
  }

  #dialOnce(host: string, port: number): Promise<{ duplex: Duplex } | { error: string; retry?: boolean }> {
    const ws = new WebSocket(this.#url(DIAL_PATH, { host, port: String(port) }, true), { headers: this.#signed("dial", `${host}:${port}`) } as unknown as string[]);
    ws.binaryType = "arraybuffer";
    return new Promise((resolve) => {
      let settled = false;
      const done = (v: { duplex: Duplex } | { error: string; retry?: boolean }) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (!("duplex" in v)) ws.close();
        resolve(v);
      };
      const timer = setTimeout(() => done({ error: `the workspace didn't answer the dial within ${DIAL_WAIT_MS / 1000} s` }), DIAL_WAIT_MS);
      ws.onerror = () => done({ error: "the workspace refused the dial" });
      ws.onclose = () => done({ error: "the workspace ended the dial" });
      ws.onmessage = (e) => {
        if (typeof e.data !== "string") return done({ error: "the workspace's first answer to a dial wasn't its word" });
        let m: { ok?: unknown; error?: unknown; retry?: unknown };
        try {
          m = JSON.parse(e.data) as typeof m;
        } catch {
          m = {};
        }
        if (m.ok === true) done({ duplex: wsDuplex(ws) });
        else done({ error: typeof m.error === "string" ? m.error : "the dial failed", retry: m.retry === true });
      };
    });
  }
}

/** A websocket whose first word was taken, as a byte stream: what it writes is held back once WINDOW bytes wait for
 * the hub's ack (shared/tailnet.ts), so neither side holds more of the connection than that. */
function wsDuplex(ws: WebSocket): Duplex {
  let unacked = 0;
  let waiting: (() => void) | undefined;
  const go = () => {
    const w = waiting;
    waiting = undefined;
    w?.();
  };
  const d = new Duplex({
    read() {},
    write(chunk: Buffer, _encoding, callback) {
      // In pieces no bigger than an ack's, each sent once the window has room.
      void (async () => {
        for (let at = 0; at < chunk.length; at += ACK_EVERY) {
          if (unacked >= WINDOW) await new Promise<void>((r) => (waiting = r));
          if (ws.readyState !== WebSocket.OPEN) return callback(new Error("the workspace's side of the connection closed"));
          const piece = chunk.subarray(at, at + ACK_EVERY);
          ws.send(piece);
          unacked += piece.length;
        }
        callback();
      })();
    },
    final(callback) {
      ws.close();
      callback();
    },
    destroy(error, callback) {
      go();
      try {
        ws.close();
      } catch {}
      callback(error);
    },
  });
  ws.onmessage = (e) => {
    if (typeof e.data !== "string") return void d.push(Buffer.from(e.data as ArrayBuffer));
    let n = 0;
    try {
      n = Number((JSON.parse(e.data) as { ack?: unknown }).ack);
    } catch {}
    if (!(n > 0)) return;
    unacked = Math.max(0, unacked - n);
    if (unacked < WINDOW) go();
  };
  ws.onclose = () => (go(), d.push(null));
  ws.onerror = () => d.destroy();
  return d;
}

async function words(res: Response): Promise<string> {
  try {
    const j = (await res.json()) as { error?: unknown };
    if (typeof j.error === "string") return j.error;
  } catch {}
  return `the workspace answered ${res.status}`;
}

let current: NodeTailnet | undefined;

/** The node's tailnet, once its start made it. */
export const nodeTailnet = (): NodeTailnet | undefined => current;
export const setNodeTailnet = (t: NodeTailnet | undefined) => void (current = t);

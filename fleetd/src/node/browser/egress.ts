// The browser of an agent that runs in a box (a VM, a hosted sandbox) sees the box's network, not this machine's. Its
// Chrome runs here, on this machine, so it is started with `--proxy-server` pointed at a SOCKS5 proxy of the session's
// own (`Egress`), on 127.0.0.1 at a port of its own, and the proxy makes each connection through the box's link
// (../sandbox/box.ts `dial`): the guest connects from inside the box and looks the name up with the box's own DNS. So
// the page's localhost is the box's (its dev server), and this machine's loopback, its LAN and tailnet addresses (the
// hub) are as far out of reach as they are from the box itself.
//
// Nothing goes around it (`boxedArgs`): loopback isn't bypassed (`<-loopback>`), names are never looked up here (SOCKS5
// carries the name, and any lookup of Chrome's own fails), QUIC is off (SOCKS5 here carries TCP only), and WebRTC
// sends UDP only through the proxy, which takes none. Websockets, service workers and prefetches use the same network
// stack, so the proxy. What the network can't carry, the guard refuses (guard.ts `boxedRefusal`): local schemes
// (file:, chrome:) and paths the box doesn't show (`boxPaths`).
import { existsSync, realpathSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { basename, dirname, isAbsolute, join, normalize } from "node:path";
import type { Duplex } from "node:stream";
import { guestOwn, shows, type View } from "../place/view.ts";
import type { BoxedPaths } from "./guard.ts";

/** How a connection goes out: the box's dial (../sandbox/box.ts), its stream once connected, else why not. */
export type Dial = (host: string, port: number) => Promise<Duplex>;

/** How long a client may take to say where it goes. */
const GREETING_MS = 10_000;

/** SOCKS5's reply codes (RFC 1928 §6). */
const REPLY = { ok: 0, failure: 1, network: 3, host: 4, refused: 5, ttl: 6, command: 7, address: 8 } as const;

/** The reply for the guest's error (an errno code, or its words). */
export function replyFor(why: string): number {
  if (/ECONNREFUSED/u.test(why)) return REPLY.refused;
  if (/ENOTFOUND|EAI_AGAIN|EAI_NONAME|EHOSTUNREACH|EHOSTDOWN/u.test(why)) return REPLY.host;
  if (/ENETUNREACH|ENETDOWN|EADDRNOTAVAIL/u.test(why)) return REPLY.network;
  if (/ETIMEDOUT|no answer/u.test(why)) return REPLY.ttl;
  return REPLY.failure;
}

const reply = (code: number) => Buffer.from([5, code, 0, 1, 0, 0, 0, 0, 0, 0]);

/** A client's SOCKS5 greeting (RFC 1928 §3), from the bytes so far: more to wait for, refused (it offers no
 * "no authentication"), or the bytes past it. */
export function greeting(b: Buffer): { more: true } | { refuse: true } | { rest: Buffer } {
  if (b.length < 2) return { more: true };
  if (b[0] !== 5) return { refuse: true };
  const methods = b[1]!;
  if (b.length < 2 + methods) return { more: true };
  if (!b.subarray(2, 2 + methods).includes(0)) return { refuse: true };
  return { rest: Buffer.from(b.subarray(2 + methods)) };
}

/** A client's SOCKS5 request (§4), from the bytes so far: more to wait for, refused (its reply code), or a CONNECT's
 * host and port and the bytes past it. */
export function request(r: Buffer): { more: true } | { refuse: number } | { host: string; port: number; rest: Buffer } {
  if (r.length < 4) return { more: true };
  if (r[0] !== 5) return { refuse: REPLY.failure };
  if (r[1] !== 1) return { refuse: REPLY.command };
  let host: string;
  let at: number;
  switch (r[3]) {
    case 1:
      if (r.length < 10) return { more: true };
      host = [...r.subarray(4, 8)].join(".");
      at = 8;
      break;
    case 3: {
      const n = r[4] ?? 0;
      if (r.length < 5 + n + 2) return { more: true };
      host = r.subarray(5, 5 + n).toString("latin1");
      at = 5 + n;
      break;
    }
    case 4: {
      if (r.length < 22) return { more: true };
      const parts: string[] = [];
      for (let i = 0; i < 16; i += 2) parts.push(r.readUInt16BE(4 + i).toString(16));
      host = parts.join(":");
      at = 20;
      break;
    }
    default:
      return { refuse: REPLY.address };
  }
  const port = r.readUInt16BE(at);
  if (!host || port === 0) return { refuse: REPLY.address };
  return { host, port, rest: Buffer.from(r.subarray(at + 2)) };
}

/** A session's way out through its box: a SOCKS5 proxy on 127.0.0.1, ended with the session. */
export class Egress {
  readonly #sockets = new Set<Socket | Duplex>();
  #closed = false;

  private constructor(
    readonly port: number,
    private readonly server: Server,
  ) {}

  static async start(dial: Dial): Promise<Egress> {
    let egress!: Egress;
    const server = createServer({ allowHalfOpen: true }, (socket) => egress.#serve(socket, dial));
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const address = server.address();
    egress = new Egress(typeof address === "object" && address ? address.port : 0, server);
    return egress;
  }

  /** The proxy Chrome is pointed at. */
  get url(): string {
    return `socks5://127.0.0.1:${this.port}`;
  }

  #serve(socket: Socket, dial: Dial): void {
    if (this.#closed) return void socket.destroy();
    this.#sockets.add(socket);
    socket.once("close", () => this.#sockets.delete(socket));
    socket.on("error", () => socket.destroy());
    let got: Buffer = Buffer.alloc(0);
    let greeted = false;
    const timer = setTimeout(() => socket.destroy(), GREETING_MS);
    const onData = (chunk: Buffer) => {
      got = got.length ? Buffer.concat([got, chunk]) : chunk;
      if (!greeted) {
        const g = greeting(got);
        if ("more" in g) return;
        if ("refuse" in g) {
          clearTimeout(timer);
          socket.off("data", onData);
          socket.end(Buffer.from([5, 0xff]));
          return;
        }
        greeted = true;
        got = g.rest;
        socket.write(Buffer.from([5, 0]));
      }
      const r = request(got);
      if ("more" in r) return;
      socket.off("data", onData);
      socket.pause();
      clearTimeout(timer);
      if ("refuse" in r) return void socket.end(reply(r.refuse));
      void this.#connect(socket, dial, r);
    };
    socket.on("data", onData);
  }

  async #connect(socket: Socket, dial: Dial, to: { host: string; port: number; rest: Buffer }): Promise<void> {
    let far: Duplex;
    try {
      far = await dial(to.host.replace(/^\[(.*)\]$/u, "$1"), to.port);
    } catch (error) {
      if (!socket.destroyed) socket.end(reply(replyFor((error as Error).message)));
      return;
    }
    if (this.#closed || socket.destroyed) return void far.destroy();
    this.#sockets.add(far);
    far.once("close", () => this.#sockets.delete(far));
    far.on("error", () => far.destroy());
    socket.write(reply(REPLY.ok));
    if (to.rest.length) far.write(to.rest);
    socket.pipe(far);
    far.pipe(socket);
    socket.once("close", () => far.destroy());
    far.once("close", () => socket.destroy());
    socket.resume();
  }

  /** Ends the proxy and every connection through it. */
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.server.close();
    for (const s of this.#sockets) s.destroy();
    this.#sockets.clear();
  }
}

/** Chrome's flags for a boxed session: every connection through `proxy` (Egress.url), none around it. */
export function boxedArgs(proxy: string): string[] {
  return [
    `--proxy-server=${proxy}`,
    // Chrome's implicit bypass of localhost, 127/8 and [::1] taken away: the page's loopback is the box's.
    "--proxy-bypass-list=<-loopback>",
    // No name is looked up on this machine: SOCKS5 carries names to the box, and whatever else asked gets none. The
    // proxy's own address is left out, or Chrome couldn't reach the proxy either.
    "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1",
    "--disable-quic",
    "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
    "--webrtc-ip-handling-policy=disable_non_proxied_udp",
    "--dns-prefetch-disable",
  ];
}

/** `path` with its links resolved as this machine sees it; for one not made yet (a download dir), its nearest parent
 * that is, with the rest after it. */
export function realOrParent(path: string): string {
  const rest: string[] = [];
  let at = path;
  for (;;) {
    try {
      const real = realpathSync(at);
      return rest.length ? join(real, ...rest.reverse()) : real;
    } catch {
      if (existsSync(at) || dirname(at) === at) return path;
      rest.push(basename(at));
      at = dirname(at);
    }
  }
}

/** How a boxed session's paths are checked (guard.ts `BoxedPaths`): a path is the browser's to use only where the box
 * shows this machine's own file at that path, writable for a download, and its links lead nowhere else. The box's own
 * dirs (/tmp, /etc …) aren't this machine's, so they are refused too; a hosted box (`view` none) shows nothing. */
export function boxPaths(view: View | undefined, real: (path: string) => string = realOrParent): BoxedPaths {
  return (path, write) => {
    const what = write ? "downloads" : "uploads";
    if (!view) {
      return `This agent runs in a hosted sandbox, and its browser runs on another machine that has none of the sandbox's files, so ${what} are refused here.`;
    }
    if (!isAbsolute(path)) return `${JSON.stringify(path)} isn't an absolute path: give the full path, under your worktree.`;
    const named = normalize(path);
    const at = real(named);
    for (const p of [named, at]) {
      if (guestOwn(p)) {
        return `${path} is in the sandbox's own ${p.split("/")[1] ? `/${p.split("/")[1]}` : "/"}, which the browser (outside the sandbox) can't see: put ${write ? "downloads" : "the file"} under your worktree.`;
      }
      if (!shows(view, { path: p, rw: write })) {
        return `${path} is refused for ${what}: this agent runs in a sandbox, and its browser may use only paths the sandbox shows${write ? " writable" : ""}, such as your worktree.`;
      }
    }
    return undefined;
  };
}

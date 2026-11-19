// The team's tailnet inside a hosted box (W722), run by the box's guest (./guest.ts) while the node says it is on. Every
// program in the box reaches tailnet addresses and MagicDNS names as it reaches anything else, with no proxy setting:
//
// - Addresses: a TUN device (`tailnet0`, hev-socks5-tunnel from the box's template, run as root) takes the routes of the
//   tailnet's ranges (shared/tailnet.ts RANGES), and hands each TCP connection to them to the guest's listener on the
//   box's loopback (SOCKS_PORT). The guest opens a channel up its link for each (`{"tailnet":{"host","port"}}`), which
//   the node carries to the team's gateway (./tailnet.ts), and answers the connection once the node says how the dial
//   went (`{"op":"tailnetDialed","channel"[,"error"]}`). Nothing else is routed there: public traffic goes as before.
// - Names: the guest answers the box's DNS at DNS_ADDR, the box's only nameserver while the tailnet is on, with the
//   tailnet's MagicDNS suffix first among its search domains. A MagicDNS name (or a reverse lookup of a tailnet
//   address) goes up the link to the gateway (`{"tailnetDns":{"name","type"}}`); every other name goes to the box's own
//   nameservers, as before. The box's own resolv.conf is kept beside it and comes back when the tailnet goes.
// - UDP to the tailnet isn't carried (only DNS, as above).
import { createSocket } from "node:dgram";
import { createServer, connect, isIP, type Server, type Socket } from "node:net";
import { readFileSync } from "node:fs";
import type { Duplex } from "node:stream";
import { RANGES, tailnetIp, tailnetName } from "../../shared/tailnet.ts";
import { TUNNEL as PIN } from "../../sandbox/providers/recipe.ts";
import { pair, type Target } from "./mux.ts";

/** Where the TUN's connections come to the guest, on the box's loopback. */
export const SOCKS_PORT = 41_081;
/** Where the box's DNS is answered while the tailnet is on: a loopback address of the guest's own, never 127.0.0.53
 * or 127.0.0.54, where systemd-resolved answers in a box that runs it (boat.dev's do). Its stub then stays one of the
 * box's own nameservers, which every name not on the tailnet goes to. */
export const DNS_ADDR = "127.77.0.53";
export const TUN = "tailnet0";
/** The tunnel the box's template installs (sandbox/providers/recipe.ts). */
export const TUNNEL = PIN.path;
/** Where the box's own resolv.conf is kept while the tailnet is on. */
export const KEPT = "/etc/resolv.conf.fleetd";
const RUN = "/run/fleetd-tailnet";
const DIAL_MS = 25_000;
const UPSTREAM_MS = 4_000;

/** How the guest reaches its node and runs as root. */
export type BoxTailnetOptions = {
  /** Opens a channel up the link to `target`, `local` its end here; false when the link is down. */
  open(target: Target, local: Duplex): number | undefined;
  /** Runs `script` with sh as root (sudo where the guest's user isn't): its exit and its output. */
  root(script: string): Promise<{ code: number | null; out: string }>;
  /** Tests: another address and ports than the box's, and another resolv.conf. */
  dnsAddr?: string;
  dnsPort?: number;
  socksPort?: number;
  resolvConf?: string;
  upstreamPort?: number;
  /** Tests: no TUN, no routes and no resolv.conf: only the guest's own listeners. */
  noSystem?: boolean;
};

const q = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;

/** Every root script here runs only in a fleetd box (its image's /etc/fleetd/guest.env): a stand-in guest beside its
 * node changes nothing of the machine. */
export const GUARD = '[ -e /etc/fleetd/guest.env ] || { echo "not in a fleetd box"; exit 1; }';

/** The root half of switching it on: the TUN, its routes, and the guest's right to answer DNS on port 53. */
export function upScript(socksPort = SOCKS_PORT): string {
  const conf = [
    "tunnel:",
    `  name: ${TUN}`,
    "  mtu: 8500",
    "  ipv4: 198.18.0.1",
    "  ipv6: 'fc00::1'",
    "socks5:",
    `  port: ${socksPort}`,
    "  address: 127.0.0.1",
    "  udp: 'udp'",
    "misc:",
    `  pid-file: ${RUN}/tunnel.pid`,
    "  log-level: warn",
  ];
  return [
    GUARD,
    "set -e",
    `[ -x ${TUNNEL} ] || { echo "this box's template has no ${TUNNEL}: a box from fleetd's newer template has it"; exit 3; }`,
    `mkdir -p ${RUN}`,
    // The guest runs as the box's user, and answers DNS at port 53.
    "sysctl -qw net.ipv4.ip_unprivileged_port_start=53",
    `printf '%s\\n' ${conf.map(q).join(" ")} > ${RUN}/tunnel.yml`,
    `if ! ip link show ${TUN} >/dev/null 2>&1; then`,
    `  setsid ${TUNNEL} ${RUN}/tunnel.yml > ${RUN}/tunnel.log 2>&1 < /dev/null &`,
    `  i=0; until ip link show ${TUN} >/dev/null 2>&1; do i=$((i+1)); [ $i -lt 50 ] || { cat ${RUN}/tunnel.log; exit 4; }; sleep 0.1; done`,
    "fi",
    `ip link set ${TUN} up`,
    `ip route replace ${RANGES.v4} dev ${TUN}`,
    `ip -6 route replace ${RANGES.v6} dev ${TUN} 2>/dev/null || true`,
  ].join("\n");
}

/** Points the box's resolver at the guest, the tailnet's suffix first among its search domains; its own kept beside. */
export function resolvScript(suffix: string | undefined, file = "/etc/resolv.conf", dnsAddr = DNS_ADDR): string {
  const kept = file === "/etc/resolv.conf" ? KEPT : `${file}.fleetd`;
  return [
    ...(file === "/etc/resolv.conf" ? [GUARD] : []),
    "set -e",
    `[ -f ${q(kept)} ] || cp -p ${q(file)} ${q(kept)}`,
    `search=$(sed -n 's/^search[[:space:]]*//p' ${q(kept)} | tr '\\n' ' ')`,
    `{ echo "# fleetd: the team's tailnet, through its gateway; this box's own is ${kept}"; echo "nameserver ${dnsAddr}"; echo "search ${suffix ? `${suffix} ` : ""}$search"; grep '^options' ${q(kept)} || true; } > ${q(`${file}.new`)}`,
    // In place: a provider may mount it.
    `cat ${q(`${file}.new`)} > ${q(file)} && rm -f ${q(`${file}.new`)}`,
  ].join("\n");
}

/** Switching it off: the box's own resolver back, the TUN gone (its routes with it), port 53 the root's again. */
export function downScript(file = "/etc/resolv.conf", system = true): string {
  const kept = file === "/etc/resolv.conf" ? KEPT : `${file}.fleetd`;
  return [
    ...(file === "/etc/resolv.conf" ? [GUARD] : []),
    `if [ -f ${q(kept)} ]; then cat ${q(kept)} > ${q(file)} && rm -f ${q(kept)}; fi`,
    ...(system
      ? [
          `[ -f ${RUN}/tunnel.pid ] && kill "$(cat ${RUN}/tunnel.pid)" 2>/dev/null || true`,
          `i=0; while ip link show ${TUN} >/dev/null 2>&1 && [ $i -lt 30 ]; do i=$((i+1)); sleep 0.1; done`,
          `rm -rf ${RUN}`,
          "sysctl -qw net.ipv4.ip_unprivileged_port_start=1024 || true",
        ]
      : []),
  ].join("\n");
}

/** The nameservers in a resolv.conf's text, but the guest's own. */
export function nameservers(text: string, own = DNS_ADDR): string[] {
  return [...text.matchAll(/^nameserver\s+(\S+)/gmu)].map((m) => m[1]!).filter((ns) => ns !== own && isIP(ns.replace(/%.*$/u, "")) !== 0);
}

/** A DNS query's id, first question's name and type, and where its question ends; undefined when it isn't one. */
export function question(msg: Uint8Array): { name: string; type: number; end: number } | undefined {
  if (msg.length < 12 || ((msg[2]! >> 3) & 0xf) !== 0 || (msg[4]! << 8) + msg[5]! < 1) return undefined;
  const labels: string[] = [];
  let at = 12;
  for (;;) {
    const n = msg[at];
    if (n === undefined || n > 63) return undefined;
    at++;
    if (n === 0) break;
    if (at + n > msg.length) return undefined;
    labels.push(Buffer.from(msg.subarray(at, at + n)).toString("latin1"));
    at += n;
  }
  if (at + 4 > msg.length) return undefined;
  return { name: labels.join(".").toLowerCase(), type: (msg[at]! << 8) + msg[at + 1]!, end: at + 4 };
}

/** A SERVFAIL answer to `query`. */
export function servfail(query: Uint8Array): Uint8Array {
  const qn = question(query);
  const head = Buffer.alloc(12);
  head.writeUInt16BE((query[0]! << 8) + query[1]!, 0);
  head.writeUInt16BE(0x8182 | ((query[2]! & 0x01) << 8), 2);
  head.writeUInt16BE(qn ? 1 : 0, 4);
  return new Uint8Array(Buffer.concat([head, qn ? Buffer.from(query.subarray(12, qn.end)) : Buffer.alloc(0)]));
}

/** `answer` with `query`'s id. */
const withId = (answer: Uint8Array, query: Uint8Array) => {
  const out = new Uint8Array(answer);
  out[0] = query[0]!;
  out[1] = query[1]!;
  return out;
};

const read = (path: string) => {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
};

/** Everything a stream gives until it ends, at most `max` bytes. */
function drain(s: Duplex, max = 65_535, ms = 12_000): Promise<Uint8Array> {
  return new Promise((resolve) => {
    const parts: Buffer[] = [];
    let n = 0;
    const done = () => (clearTimeout(t), resolve(new Uint8Array(Buffer.concat(parts))));
    const t = setTimeout(() => (s.destroy(), done()), ms);
    s.on("data", (d: Buffer) => {
      n += d.length;
      if (n <= max) parts.push(d);
    });
    s.once("end", done);
    s.once("close", done);
    s.once("error", done);
  });
}

export class BoxTailnet {
  #suffix: string | undefined;
  #on = false;
  #socks: Server | undefined;
  #udp: ReturnType<typeof createSocket> | undefined;
  #tcp: Server | undefined;
  #upstream: string[] = [];
  #dials = new Map<number, (error: string | undefined) => void>();

  constructor(readonly o: BoxTailnetOptions) {}

  get on(): boolean {
    return this.#on;
  }

  /** The node's word on a channel the guest opened for a connection. */
  dialed(channel: number, error: string | undefined): void {
    this.#dials.get(channel)?.(error);
  }

  /** On with the tailnet's `suffix` (its search domain), or off (null); what it did, in a few words. */
  async set(suffix: string | null): Promise<string> {
    if (suffix === null) return this.#off();
    const file = this.o.resolvConf ?? "/etc/resolv.conf";
    if (!this.#on) {
      if (!this.o.noSystem) await this.#root(upScript(this.o.socksPort ?? SOCKS_PORT), "the tailnet's device couldn't be set up in the box");
      await this.#listenSocks();
      // The box's own nameservers, read before the guest takes their place (from the copy kept, should it have).
      this.#upstream = nameservers(read(`${file}.fleetd`) || read(file), this.o.dnsAddr ?? DNS_ADDR);
      await this.#listenDns();
      this.#on = true;
    }
    if (this.#suffix !== suffix || !this.#on) {
      await this.#root(resolvScript(suffix || undefined, file, this.o.dnsAddr ?? DNS_ADDR), "the box's resolver couldn't be pointed at the tailnet");
      this.#suffix = suffix;
    }
    return `on${suffix ? ` (${suffix})` : ""}`;
  }

  async #off(): Promise<string> {
    if (!this.#on && !this.#socks) return "off";
    this.#on = false;
    this.#suffix = undefined;
    await this.#root(downScript(this.o.resolvConf ?? "/etc/resolv.conf", !this.o.noSystem), "the box's resolver couldn't be given back");
    for (const s of [this.#socks, this.#tcp]) s?.close();
    this.#udp?.close();
    this.#socks = this.#tcp = this.#udp = undefined;
    for (const settle of this.#dials.values()) settle("the tailnet was disconnected");
    return "off";
  }

  async #root(script: string, what: string): Promise<void> {
    const r = await this.o.root(script);
    if (r.code !== 0) throw new Error(`${what}: ${r.out.trim().split("\n").slice(-3).join(" ") || `exit ${r.code}`}`);
  }

  /** Where the TUN's connections come, once it listens: SOCKS_PORT in a box, the OS's pick for a test's 0. */
  get socksPort(): number | undefined {
    const a = this.#socks?.address();
    return a && typeof a === "object" ? a.port : undefined;
  }

  /** Where the box's DNS is answered, once it listens (UDP and TCP alike). */
  get dnsPort(): number | undefined {
    const a = this.#tcp?.address();
    return a && typeof a === "object" ? a.port : undefined;
  }

  async #listenSocks(): Promise<void> {
    if (this.#socks) return;
    const server = createServer({ allowHalfOpen: true }, (c) => void this.#socksConn(c));
    await listen(server, this.o.socksPort ?? SOCKS_PORT, "127.0.0.1");
    this.#socks = server;
  }

  /** One connection from the TUN: SOCKS5's greeting and CONNECT, then a channel to the node for its target. */
  async #socksConn(c: Socket): Promise<void> {
    c.on("error", () => {});
    // One listener takes every byte until the channel is up: what comes before the node's word waits here.
    let buf = Buffer.alloc(0);
    let ended = false;
    let wake: (() => void) | undefined;
    const onData = (d: Buffer) => ((buf = Buffer.concat([buf, d])), wake?.());
    const onEnd = () => ((ended = true), wake?.());
    c.on("data", onData);
    c.once("end", onEnd);
    c.once("close", onEnd);
    const need = async (n: number): Promise<boolean> => {
      while (buf.length < n) {
        if (ended) return false;
        await new Promise<void>((resolve) => (wake = resolve));
        wake = undefined;
      }
      return true;
    };
    const reply = (code: number) => Buffer.from([5, code, 0, 1, 0, 0, 0, 0, 0, 0]);
    if (!(await need(2)) || buf[0] !== 5 || !(await need(2 + buf[1]!))) return void c.destroy();
    buf = buf.subarray(2 + buf[1]!);
    c.write(Buffer.from([5, 0]));
    if (!(await need(5))) return void c.destroy();
    if (buf[1] !== 1) return void c.end(reply(7));
    let host: string;
    let at: number;
    if (buf[3] === 1) {
      if (!(await need(10))) return void c.destroy();
      host = [...buf.subarray(4, 8)].join(".");
      at = 8;
    } else if (buf[3] === 4) {
      if (!(await need(22))) return void c.destroy();
      const b = buf.subarray(4, 20);
      host = Array.from({ length: 8 }, (_, i) => b.readUInt16BE(i * 2).toString(16)).join(":");
      at = 20;
    } else if (buf[3] === 3) {
      if (!(await need(5 + buf[4]! + 2))) return void c.destroy();
      host = buf.subarray(5, 5 + buf[4]!).toString("latin1");
      at = 5 + buf[4]!;
    } else return void c.end(reply(8));
    const port = buf.readUInt16BE(at);
    // The TUN gives only tailnet addresses; a program speaking SOCKS here itself gets the tailnet and nothing else.
    if (!tailnetIp(host) && !tailnetName(host, this.#suffix)) return void c.end(reply(2));
    const [here, there] = pair();
    let settle!: (error: string | undefined) => void;
    const said = new Promise<string | undefined>((resolve) => (settle = resolve));
    const channel = this.o.open({ tailnet: { host, port } }, there);
    if (channel === undefined) return void c.end(reply(1));
    this.#dials.set(channel, settle);
    // Ended before the node's word: the node refused it (a node from before the tailnet, say).
    const early = () => settle("the node ended the connection");
    there.once("finish", early);
    const timer = setTimeout(() => settle("the node didn't answer the dial"), DIAL_MS);
    const error = await said;
    clearTimeout(timer);
    this.#dials.delete(channel);
    there.off("finish", early);
    if (error !== undefined) {
      here.destroy();
      return void c.end(reply(/refused/iu.test(error) ? 5 : 4));
    }
    c.off("data", onData);
    c.off("end", onEnd);
    c.off("close", onEnd);
    c.write(reply(0));
    const rest = buf.subarray(at + 2);
    if (rest.length) here.write(rest);
    if (ended) here.end();
    else c.pipe(here);
    here.pipe(c);
    here.on("error", () => c.destroy());
    c.on("close", () => here.destroy());
  }

  /** UDP and TCP on one port at the box's DNS address: 53 in a box; a test's 0 takes a port free for both. What one
   * bind took is let go when the other fails, so nothing is left listening. */
  async #listenDns(): Promise<void> {
    const addr = this.o.dnsAddr ?? DNS_ADDR;
    const want = this.o.dnsPort ?? 53;
    for (let tries = want === 0 ? 5 : 1; ; tries--) {
      const udp = createSocket(isIP(addr) === 6 ? "udp6" : "udp4");
      udp.on("message", (msg, from) => {
        void this.#answer(new Uint8Array(msg), "udp").then((a) => a && udp.send(a, from.port, from.address));
      });
      try {
        await new Promise<void>((resolve, reject) => {
          udp.once("error", reject);
          udp.bind(want, addr, () => (udp.off("error", reject), resolve()));
        });
      } catch (error) {
        udp.close();
        throw new Error(`the box's DNS couldn't listen at ${addr}:${want}: ${(error as Error).message}`);
      }
      udp.on("error", () => {});
      const tcp = createServer((c) => this.#dnsTcp(c));
      try {
        await listen(tcp, udp.address().port, addr);
      } catch (error) {
        udp.close();
        // A port the OS gave UDP may be taken for TCP: another try.
        if (tries > 1) continue;
        throw new Error(`the box's DNS couldn't listen at ${addr}:${want}: ${(error as Error).message}`);
      }
      this.#udp = udp;
      this.#tcp = tcp;
      return;
    }
  }

  /** One TCP connection to the box's DNS: length-prefixed queries, each answered as it comes. */
  #dnsTcp(c: Socket): void {
    c.on("error", () => {});
    let buf = Buffer.alloc(0);
    c.on("data", (d: Buffer) => {
      buf = Buffer.concat([buf, d]);
      while (buf.length >= 2 && buf.length >= 2 + buf.readUInt16BE(0)) {
        const one = new Uint8Array(buf.subarray(2, 2 + buf.readUInt16BE(0)));
        buf = buf.subarray(2 + one.length);
        void this.#answer(one, "tcp").then((a) => {
          if (!a || c.destroyed) return;
          const len = Buffer.alloc(2);
          len.writeUInt16BE(a.length);
          c.write(Buffer.concat([len, a]));
        });
      }
    });
  }

  /** The answer to one query: the gateway's for a tailnet name, the box's own nameservers' for any other. */
  async #answer(query: Uint8Array, via: "udp" | "tcp"): Promise<Uint8Array | undefined> {
    const qn = question(query);
    if (!qn) return undefined;
    if (tailnetName(qn.name, this.#suffix)) {
      const [here, there] = pair();
      if (this.o.open({ tailnetDns: { name: qn.name, type: qn.type } }, there) === undefined) return servfail(query);
      here.end();
      const got = await drain(here);
      return got.length >= 12 ? withId(got, query) : servfail(query);
    }
    for (const ns of this.#upstream) {
      const port = this.o.upstreamPort ?? 53;
      const got = await (via === "udp" ? udpAsk(ns, port, query) : tcpAsk(ns, port, query)).catch(() => undefined);
      if (got) return got;
    }
    return servfail(query);
  }
}

function udpAsk(ns: string, port: number, query: Uint8Array): Promise<Uint8Array | undefined> {
  return new Promise((resolve) => {
    const s = createSocket(isIP(ns.replace(/%.*$/u, "")) === 6 ? "udp6" : "udp4");
    const done = (v: Uint8Array | undefined) => (clearTimeout(t), s.close(), resolve(v));
    const t = setTimeout(() => done(undefined), UPSTREAM_MS);
    s.on("message", (m) => {
      if (m.length >= 2 && m[0] === query[0] && m[1] === query[1]) done(new Uint8Array(m));
    });
    s.on("error", () => done(undefined));
    s.send(query, port, ns);
  });
}

function tcpAsk(ns: string, port: number, query: Uint8Array): Promise<Uint8Array | undefined> {
  return new Promise((resolve) => {
    const s = connect({ host: ns, port });
    let buf = Buffer.alloc(0);
    const done = (v: Uint8Array | undefined) => (clearTimeout(t), s.destroy(), resolve(v));
    const t = setTimeout(() => done(undefined), UPSTREAM_MS);
    s.on("connect", () => {
      const len = Buffer.alloc(2);
      len.writeUInt16BE(query.length);
      s.write(Buffer.concat([len, query]));
    });
    s.on("data", (d: Buffer) => {
      buf = Buffer.concat([buf, d]);
      if (buf.length >= 2 && buf.length >= 2 + buf.readUInt16BE(0)) done(new Uint8Array(buf.subarray(2, 2 + buf.readUInt16BE(0))));
    });
    s.on("error", () => done(undefined));
  });
}

/** `server` listening at `host`:`port`, or why not (the server closed). */
function listen(server: Server, port: number, host: string): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", (error) => (server.close(), reject(error)));
    server.listen(port, host, () => resolve());
  });
}

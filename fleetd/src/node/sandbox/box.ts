// The node's side of one box: its one link to the box's guest helper (./guest.ts), dialled with whatever stream the
// box kind gives (`dial`), and dialled again when it drops until the guest is gone for `goneMs`. Over it (./mux.ts):
// - the session host's lines (`start`, then `dialHost`, which HostLink.connect takes as its dial), open across drops
//   both ways: the session host inside resends the events the node didn't acknowledge, and the node resends the lines
//   (commands, acks) the guest didn't confirm it took (./guest.ts HostPipe);
// - each connection to the box's node.sock, answered as a node.sock call of the box's session (`lead`: the node's is
//   ../lead/index.ts leadChannel): the session is the box's, by the link it came in on, never a pid or what a call claims;
// - each connection to one of the box's TCP forwards, piped to the same port on this machine's 127.0.0.1;
// - each connection to one of its relays (a guest address and port the node named), piped to the host and port the
//   relay names, as this machine reaches it (a Claude gateway on its tailnet, say);
// - each connection to the box's build-slot socket: a build of the box's that takes the machine's build slots here
//   (`slots`: the node's is ../build_slots.ts slotChannel), so the box's builds queue with every other agent's.
// - each dial the node opens (`dial`): a connection the guest makes from inside the box (a screen's, its port on the
//   box's loopback), so it reaches what the box reaches and no more;
// - in a hosted box, each connection to the team's tailnet and each lookup of a tailnet name its capture makes
//   (./tailnet_box.ts), carried on to the team's gateway by the node (./tailnet.ts `tailnet`).
// A channel to anywhere else is refused.
// Box side (docs/CONTRIBUTING.md "The package"): sockets only, and what answers node.sock and build-slot connections
// comes in as options, so a service with no node drives a box with it too.
import { connect } from "node:net";
import { Duplex } from "node:stream";
import type { ConfinedRun, RunOutcome } from "../cmd/run.ts";
import type { HostHandlers, HostSocket } from "../runner/host_link.ts";
import { GUEST_PROTOCOL, HOST, type HostInfo, Mux, NODE_CHANNELS, pair, READ_CHUNK, type Target } from "./mux.ts";
import type { TailnetHooks } from "./tailnet.ts";

export type { TailnetHooks } from "./tailnet.ts";

const HELLO_MS = 5_000;
const ANSWER_MS = 15_000;
/** How long a dial from inside the box may take, the guest's own wait (guest.ts DIAL_MS) and its answer. */
const DIAL_WAIT_MS = 15_000;
const GONE_MS = 30_000;
const REDIAL_MIN_MS = 50;
const REDIAL_MAX_MS = 1_000;
/** How often the node asks a box's guest whether it still answers, and how long it waits before the box counts as
 * hung (a frozen guest can keep its link open, so it never drops by itself). */
export const PING_MS = 10_000;
export const SILENT_MS = 60_000;

export type BoxOptions = {
  /** The session the box runs: every call from it acts as this session. */
  session: string;
  /** A new stream to the guest helper: the provider's port, or a unix socket to a stand-in. */
  dial: () => Promise<Duplex>;
  /** The node's socket, at whose path the guest listens (FLEETD_NODE_SOCK). */
  nodeSock: string;
  /** This machine's ports the box reaches at the same numbers (the browser proxy's, adb's). */
  tcp: number[];
  /** Where the box reaches what this machine reaches, through the node. */
  relays?: Relay[];
  /** Answers one connection to the box's node.sock as a call of `session`, the box's (the node's: ../lead/index.ts
   * leadChannel over its serveLeadSocket hooks). */
  lead: (session: string) => Duplex;
  /** Where the guest listens for its builds' slots, and what answers one connection to it (the node's:
   * ../build_slots.ts slotChannel of its home). */
  slots?: { sock: string; channel: () => Duplex };
  /** How long a dropped link is dialled again before the guest counts as gone. */
  goneMs?: number;
  /** Whether the box still runs: a dropped link of a box that doesn't ends at once, with no redial. */
  alive?: () => boolean;
  /** Called once when the guest stopped answering for `silentMs` (it's ended then); and the stand-ins' times. */
  hung?: (why: string) => void;
  pingMs?: number;
  silentMs?: number;
  /** Where the box's tailnet connections and lookups go (a hosted box's): none, and the box opens none. */
  tailnet?: TailnetHooks;
};

/** A port in the box (on its loopback, or on `addr`, an address of the guest's own) whose connections the node pipes
 * to `to`, as this machine reaches it. */
export type Relay = { port: number; addr?: string; to: { host: string; port: number } };

const relayKey = (port: number, addr?: string) => `${addr ?? ""}|${port}`;

export class Box {
  #mux: Mux | undefined;
  #tcp: Set<number>;
  #relays = new Map<string, Relay>();
  #hostRuns = false;
  /** How many of the node's lines the session host took, as the guest last said. */
  #hostLines = 0;
  #bridge: HostBridge | undefined;
  #requests = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  #nextId = 0;
  #runs = 0;
  /** This link's own mark on its run ids: a run a dropped link left going in the guest never refuses a new link's. */
  readonly #tag = crypto.randomUUID().slice(0, 8);
  #nextDial = NODE_CHANNELS;
  /** The dials the guest hasn't answered yet, by channel: undefined once it connected, else why not. */
  #dials = new Map<number, (why: string | undefined) => void>();
  #over = false;
  #connecting = false;
  #goneResolve!: (why: string) => void;
  /** Why the link ended for good: the guest went away, or the node let go (`close`). */
  readonly gone: Promise<string> = new Promise((r) => (this.#goneResolve = r));

  #ping: ReturnType<typeof setInterval> | undefined;

  private constructor(readonly o: BoxOptions) {
    this.#tcp = new Set(o.tcp);
    for (const r of o.relays ?? []) this.#relays.set(relayKey(r.port, r.addr), r);
  }

  /** Dials the box's guest and sets up its forwards. */
  static async open(o: BoxOptions): Promise<Box> {
    const box = new Box(o);
    await box.#connect();
    if (o.hung) {
      box.#ping = setInterval(() => void box.#pingOnce(), o.pingMs ?? PING_MS);
      box.#ping.unref?.();
    }
    return box;
  }

  /** Starts the session's host in the box. What the guest says of it: the session host's protocol, or why it refused
   * (its program missing, say). Its pids are the guest's and mean nothing here. */
  async start(l: { sessionId: string; program: string; args: string[]; cwd: string; env: Record<string, string | undefined> }): Promise<HostInfo> {
    const info = (await this.#request({ op: "start", ...l })) as HostInfo;
    this.#hostRuns = !info.refused;
    this.#hostLines = 0;
    return info;
  }

  /** Runs a command in the box (a setup command), confined to its cwd, its group killed at its timeout or `r.signal`.
   * A link that drops meanwhile ends the wait with a run that didn't finish. `root`: the node's own commands in the box
   * (its pin to Claude's relay). */
  async run(r: ConfinedRun & { root?: boolean }): Promise<RunOutcome> {
    const run = `r${++this.#runs}-${this.#tag}`;
    const cancel = () => void this.#request({ op: "cancel", run }).catch(() => {});
    r.signal?.addEventListener("abort", cancel, { once: true });
    try {
      const m: Record<string, unknown> = { op: "run", run, argv: r.argv, cwd: r.cwd, timeoutSec: r.timeoutSec, scrub: r.scrub ?? [] };
      if (r.env) m.env = r.env;
      if (r.root) m.root = true;
      return (await this.#request(m, r.timeoutSec * 1000 + ANSWER_MS)) as RunOutcome;
    } catch (error) {
      return { exitCode: null, outputTail: "", timedOut: false, notRun: `the box didn't run it: ${(error as Error).message}` };
    } finally {
      r.signal?.removeEventListener("abort", cancel);
    }
  }

  /** The session host's lines, for HostLink.connect: open until the session host or the guest is gone. */
  async dialHost(h: HostHandlers): Promise<HostSocket> {
    if (this.#over) throw new Error("the box is gone");
    if (!this.#hostRuns) throw new Error("no session host runs in the box");
    this.#bridge?.lost();
    const bridge = new HostBridge(h);
    this.#bridge = bridge;
    // While a link is being set up, its setup opens the channel.
    if (this.#mux && !this.#connecting) this.#mux.open(HOST, { host: true }, bridge.attach(this.#hostLines));
    return bridge.socket;
  }

  /** A connection the guest makes from inside the box to `host`:`port` (a screen's: ../place/box_screens.ts), so it
   * reaches what the box reaches and no more: its stream here once the guest connected. Throws why not, in the guest's
   * words (ECONNREFUSED, ENOTFOUND), or that its guest predates dials. */
  async dial(host: string, port: number): Promise<Duplex> {
    const mux = this.#mux;
    if (this.#over || !mux || mux.closed || this.#connecting) throw new Error("the box's link is down");
    const channel = this.#nextDial;
    this.#nextDial = channel >= 0xffff_ffff ? NODE_CHANNELS : channel + 1;
    const [here, there] = pair();
    let settle!: (why: string | undefined) => void;
    const said = new Promise<string | undefined>((resolve) => (settle = resolve));
    this.#dials.set(channel, settle);
    // Ended or dropped before a word: a guest that doesn't dial (an older one) ends the channel at once.
    const closed = () => settle("the box's guest ended the connection before it connected (a guest from before dials)");
    there.once("finish", closed);
    there.once("close", closed);
    const timer = setTimeout(() => settle(`the box's guest didn't answer the dial within ${DIAL_WAIT_MS / 1000} s`), DIAL_WAIT_MS);
    mux.open(channel, { dial: { host, port } }, there);
    const why = await said;
    clearTimeout(timer);
    this.#dials.delete(channel);
    there.off("finish", closed);
    there.off("close", closed);
    if (why !== undefined) {
      here.destroy();
      there.destroy();
      throw new Error(why);
    }
    return here;
  }

  /** The team's tailnet in the box: on with its MagicDNS `suffix`, or off (null). What the guest did, in its words. */
  async tailnet(suffix: string | null): Promise<string> {
    return String(await this.#request({ op: "tailnet", suffix }, ANSWER_MS * 2));
  }

  /** Reaches this machine's `port` from the box, at the same number. */
  async forward(port: number): Promise<void> {
    this.#tcp.add(port);
    if (this.#mux) await this.#request({ op: "listen", tcp: port });
  }

  /** Pipes the box's `r.port` (on `r.addr`) to `r.to`, as this machine reaches it. */
  async relay(r: Relay): Promise<void> {
    const key = relayKey(r.port, r.addr);
    this.#relays.set(key, r);
    try {
      await this.#request(listenOf(r));
    } catch (error) {
      // One the guest can't listen for would fail every later dial too.
      this.#relays.delete(key);
      throw error;
    }
  }

  /** The box's relays, for its record. */
  get relays(): Relay[] {
    return [...this.#relays.values()];
  }

  /** Writes `bytes` to `path` in the box, in pieces a frame takes. */
  async write(path: string, bytes: Uint8Array, mode = 0o600): Promise<void> {
    const piece = (READ_CHUNK * 3) / 4;
    for (let at = 0; at === 0 || at < bytes.length; at += piece) {
      const data = Buffer.from(bytes.subarray(at, at + piece)).toString("base64");
      await this.#request({ op: "write", path, data, append: at > 0, mode }, ANSWER_MS * 4);
    }
  }

  /** `path` in the box from byte `from` on, refused past `max` bytes. */
  async read(path: string, max: number, from = 0): Promise<Uint8Array> {
    const parts: Buffer[] = [];
    let at = from;
    for (;;) {
      const got = (await this.#request({ op: "read", path, offset: at, max: READ_CHUNK }, ANSWER_MS * 4)) as { data: string; size: number };
      if (got.size > max) throw new Error(`${path} in the box is larger than ${max} bytes`);
      const b = Buffer.from(got.data, "base64");
      parts.push(b);
      at += b.length;
      if (b.length === 0 || at >= got.size) return new Uint8Array(Buffer.concat(parts));
    }
  }

  /** Whether the link ended for good: the guest went away, or the node let go. */
  get ended(): boolean {
    return this.#over;
  }

  /** Lets go of the link (the node's shutdown): the guest and its session go on, for the next node to dial. */
  close(): void {
    this.#end("the node let go of the box");
  }

  /** Dials once; the link's drops dial again only once this returned. */
  async #connect(): Promise<void> {
    this.#connecting = true;
    try {
      await this.#dial();
    } finally {
      this.#connecting = false;
    }
  }

  async #dial(): Promise<void> {
    // A dial that never answers counts as a failed one.
    let late = false;
    const dialled = this.o.dial();
    dialled.then((l) => late && l.destroy(), () => {});
    const link = await Promise.race([
      dialled,
      Bun.sleep(HELLO_MS).then(() => {
        late = true;
        throw new Error(`the box's guest didn't answer the dial within ${HELLO_MS / 1000} s`);
      }),
    ]);
    let hello!: (m: Record<string, unknown> | undefined) => void;
    // A link that closes before its hello (a box whose guest isn't listening yet) fails the dial at once.
    const said = new Promise<Record<string, unknown> | undefined>((r) => (hello = r));
    const mux: Mux = new Mux(link, {
      control: (m) => {
        if (m.op === "hello") hello(m);
        else if (m.op === "hostLines" && Number.isInteger(m.n)) {
          this.#hostLines = m.n as number;
          this.#bridge?.confirm(this.#hostLines);
        } else if (m.op === "dial" && typeof m.channel === "number") this.#dials.get(m.channel)?.(typeof m.error === "string" ? m.error : undefined);
        else this.#answer(m);
      },
      open: (channel, target) => this.#open(channel, target),
      closed: (why) => {
        hello(undefined);
        this.#dropped(mux, why);
      },
    });
    this.#mux = mux;
    try {
      const m = await Promise.race([said, Bun.sleep(HELLO_MS).then(() => undefined)]);
      if (!m || m.protocol !== GUEST_PROTOCOL)
        throw new Error(m ? `the guest speaks protocol ${String(m.protocol)}, this node ${GUEST_PROTOCOL}` : "the guest didn't say hello");
      const host = m.host as { lines?: unknown } | null;
      this.#hostRuns = host !== null && typeof host === "object";
      this.#hostLines = this.#hostRuns && Number.isInteger(host?.lines) ? (host!.lines as number) : 0;
      await this.#request({ op: "listen", unix: this.o.nodeSock });
      if (this.o.slots) await this.#request({ op: "listen", unix: this.o.slots.sock });
      for (const port of this.#tcp) await this.#request({ op: "listen", tcp: port });
      for (const r of this.#relays.values()) await this.#request(listenOf(r));
    } catch (error) {
      if (this.#mux === mux) this.#mux = undefined;
      mux.close((error as Error).message);
      throw error;
    }
    const bridge = this.#bridge;
    if (bridge && !bridge.closed) {
      if (this.#hostRuns) mux.open(HOST, { host: true }, bridge.attach(this.#hostLines));
      else bridge.lost();
    }
  }

  #open(channel: number, target: Target): Duplex | undefined {
    if (channel <= HOST || channel >= NODE_CHANNELS) return undefined;
    // The target alone says what a channel is; nothing in it names a session.
    if ("unix" in target && target.unix === this.o.nodeSock) return this.o.lead(this.o.session);
    if ("unix" in target && this.o.slots && target.unix === this.o.slots.sock) return this.o.slots.channel();
    if ("tailnet" in target) return this.#tailnetDial(channel, target.tailnet);
    if ("tailnetDns" in target) return this.#tailnetDns(target.tailnetDns);
    if (!("tcp" in target)) return undefined;
    const relay = this.#relays.get(relayKey(target.tcp, target.addr));
    if (relay) return connect({ host: relay.to.host, port: relay.to.port });
    if (target.addr === undefined && this.#tcp.has(target.tcp)) return connect({ host: "127.0.0.1", port: target.tcp });
    return undefined;
  }

  /** A connection the box's capture makes to the tailnet: dialled through the node, the guest told how it went before
   * any of its bytes. */
  #tailnetDial(channel: number, to: { host?: unknown; port?: unknown }): Duplex | undefined {
    const hooks = this.o.tailnet;
    const port = Number(to.port);
    if (!hooks || typeof to.host !== "string" || !to.host || !Number.isInteger(port) || port <= 0 || port > 65535) return undefined;
    const [here, there] = pair();
    const mux = this.#mux;
    void hooks.dial(to.host, port).then(
      (conn) => {
        if (here.destroyed || mux !== this.#mux) return void conn.destroy();
        mux?.control({ op: "tailnetDialed", channel });
        here.pipe(conn).pipe(here);
        conn.on("error", () => here.destroy());
        here.on("close", () => conn.destroy());
      },
      (error: unknown) => {
        mux?.control({ op: "tailnetDialed", channel, error: (error as Error).message.slice(0, 300) });
        here.destroy();
      },
    );
    return there;
  }

  /** A lookup of a tailnet name from the box: the gateway's answer, then the channel's end (at once, with none). */
  #tailnetDns(q: { name?: unknown; type?: unknown }): Duplex | undefined {
    const hooks = this.o.tailnet;
    const type = Number(q.type);
    if (!hooks || typeof q.name !== "string" || !q.name || q.name.length > 253 || !Number.isInteger(type)) return undefined;
    const [here, there] = pair();
    here.resume();
    void hooks.dns(q.name, type).then(
      (bytes) => here.end(Buffer.from(bytes)),
      () => here.end(),
    );
    return there;
  }

  #request(m: Record<string, unknown>, ms = ANSWER_MS): Promise<unknown> {
    const mux = this.#mux;
    if (!mux || mux.closed) return Promise.reject(new Error("the box's link is down"));
    const id = ++this.#nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#requests.delete(id);
        reject(new Error(`the box's guest didn't answer ${String(m.op)} within ${Math.round(ms / 1000)} s`));
      }, ms);
      this.#requests.set(id, {
        resolve: (v) => (clearTimeout(timer), resolve(v)),
        reject: (e) => (clearTimeout(timer), reject(e)),
      });
      try {
        mux.control({ id, ...m });
      } catch (error) {
        this.#requests.get(id)?.reject(error as Error);
        this.#requests.delete(id);
      }
    });
  }

  #answer(m: Record<string, unknown>): void {
    const pending = typeof m.id === "number" ? this.#requests.get(m.id) : undefined;
    if (!pending) return;
    this.#requests.delete(m.id as number);
    if (typeof m.error === "string") pending.reject(new Error(m.error));
    else pending.resolve(m.ok);
  }

  #dropped(mux: Mux, why: string): void {
    if (this.#mux !== mux) return;
    this.#mux = undefined;
    for (const r of this.#requests.values()) r.reject(new Error(`the box's link dropped: ${why}`));
    this.#requests.clear();
    if (!this.#over && !this.#connecting) void this.#redial(why);
  }

  async #redial(why: string): Promise<void> {
    const deadline = Date.now() + (this.o.goneMs ?? GONE_MS);
    for (let wait = REDIAL_MIN_MS; !this.#over; wait = Math.min(wait * 2, REDIAL_MAX_MS)) {
      // A box that is gone won't answer again: its link ends now, not when the redials give up.
      if (this.o.alive && !this.o.alive()) {
        this.#end(`the box ended: ${why}`);
        return;
      }
      if (Date.now() >= deadline) {
        this.#end(`the box's guest is gone: ${why}`);
        return;
      }
      await Bun.sleep(wait);
      if (this.#over || this.#mux) return;
      try {
        await this.#connect();
        return;
      } catch (error) {
        why = (error as Error).message;
      }
    }
  }

  /** One ask whether the guest answers: any answer will do (a guest from before `ping` says it has no such op). One
   * that gets none in `silentMs`, on a link that's up, ends the box as hung. */
  async #pingOnce(): Promise<void> {
    if (this.#over || !this.#mux || this.#pinging) return;
    this.#pinging = true;
    const silent = this.o.silentMs ?? SILENT_MS;
    try {
      await this.#request({ op: "ping" }, silent);
    } catch (error) {
      const message = (error as Error).message;
      if (this.#over || !/didn't answer/u.test(message)) return;
      const why = `the box's guest stopped answering for ${Math.round(silent / 1000)} s`;
      this.#end(why);
      this.o.hung?.(why);
    } finally {
      this.#pinging = false;
    }
  }

  #pinging = false;

  #end(why: string): void {
    if (this.#over) return;
    this.#over = true;
    if (this.#ping) clearInterval(this.#ping);
    this.#bridge?.lost();
    this.#mux?.close(why);
    this.#goneResolve(why);
  }
}

const listenOf = (r: Relay) => ({ op: "listen", tcp: r.port, ...(r.addr ? { addr: r.addr } : {}) });

/** The node's end of the session host's lines, across links. What comes in is handed on in whole lines only, so a link
 * that drops mid-line leaves no half of it (the host resends it whole). What HostLink writes is kept, line by line,
 * until the guest confirms the host took it, and what it didn't confirm goes again on the next link: a command made
 * while a link was dropping isn't lost, nor taken twice. */
class HostBridge {
  /** Lines written and not yet confirmed, after the first `#confirmed` lines. */
  #sent: Buffer[] = [];
  #confirmed = 0;
  #partial: Buffer = Buffer.alloc(0);
  #end: Duplex | undefined;
  #ended = false;
  closed = false;
  readonly socket: HostSocket = {
    write: (data) => this.#write(data),
    end: () => this.#endIt(),
  };

  constructor(readonly h: HostHandlers) {}

  /** The host took the node's first `lines` lines. */
  confirm(lines: number): void {
    if (lines <= this.#confirmed) return;
    this.#sent.splice(0, lines - this.#confirmed);
    this.#confirmed = lines;
  }

  /** This link's end of channel 1, the host having taken `lines` of the node's lines: the rest go first. */
  attach(lines: number): Duplex {
    this.confirm(lines);
    let tail: Buffer = Buffer.alloc(0);
    const end: Duplex = new Duplex({
      read() {},
      write: (chunk: Buffer, _encoding, callback) => {
        const all = tail.length ? Buffer.concat([tail, chunk]) : chunk;
        const nl = all.lastIndexOf(10);
        if (nl < 0) tail = Buffer.from(all);
        else {
          tail = Buffer.from(all.subarray(nl + 1));
          if (!this.closed) this.h.data(undefined, all.subarray(0, nl + 1));
        }
        callback();
      },
      // The guest ended channel 1: the session host is gone.
      final: (callback) => {
        callback();
        this.lost();
      },
    });
    end.on("close", () => {
      if (this.#end === end) this.#end = undefined;
    });
    this.#end = end;
    for (const line of this.#sent) end.push(line);
    if (this.#ended) end.push(null);
    return end;
  }

  #write(data: Uint8Array): number {
    if (this.closed || this.#ended) return -1;
    const all = this.#partial.length ? Buffer.concat([this.#partial, data]) : Buffer.from(data);
    let at = 0;
    for (let nl = all.indexOf(10); nl >= 0; nl = all.indexOf(10, at)) {
      const line = Buffer.from(all.subarray(at, nl + 1));
      at = nl + 1;
      this.#sent.push(line);
      this.#end?.push(line);
    }
    this.#partial = Buffer.from(all.subarray(at));
    return data.length;
  }

  #endIt(): void {
    if (this.#ended) return;
    this.#ended = true;
    if (this.#end) this.#end.push(null);
    else queueMicrotask(() => this.lost());
  }

  /** The session host is gone, or the node let go of it. */
  lost(): void {
    if (this.closed) return;
    this.closed = true;
    this.#end?.destroy();
    this.h.close();
  }
}

// The node's side of one box: its one link to the box's guest helper (./guest.ts), dialled with whatever stream the
// box kind gives (`dial`), and dialled again when it drops until the guest is gone for `goneMs`. Over it (./mux.ts):
// - the session host's lines (`start`, then `dialHost`, which HostLink.connect takes as its dial), open across drops
//   both ways: the session host inside resends the events the node didn't acknowledge, and the node resends the lines
//   (commands, acks) the guest didn't confirm it took (./guest.ts HostPipe);
// - each connection to the box's node.sock, answered as a node.sock call of the box's session (../lead/index.ts
//   leadChannel): the session is the box's, by the link it came in on, never a pid or what a call claims;
// - each connection to one of the box's TCP forwards, piped to the same port on this machine's 127.0.0.1;
// - each connection to one of its relays (a guest address and port the node named), piped to the host and port the
//   relay names, as this machine reaches it (a Claude gateway on its tailnet, say);
// - each connection to the box's build-slot socket: a build of the box's that takes the machine's build slots here
//   (../build_slots.ts slotChannel), so the box's builds queue with every other agent's.
// - each dial the node opens (`dial`): a connection the guest makes from inside the box, the browser's way out
//   (../browser/egress.ts), so the agent's browser reaches what the box reaches and no more.
// A channel to anywhere else is refused.
import { connect } from "node:net";
import { Duplex } from "node:stream";
import type { ConfinedRun, RunOutcome } from "../cmd/index.ts";
import type { HostHandlers, HostSocket } from "../runner/host.ts";
import { slotChannel } from "../build_slots.ts";
import { leadChannel, type LeadSocketHooks } from "../lead/index.ts";
import { GUEST_PROTOCOL, READ_CHUNK, type HostInfo } from "./guest.ts";
import { HOST, Mux, NODE_CHANNELS, type Target } from "./mux.ts";

const HELLO_MS = 5_000;
const ANSWER_MS = 15_000;
/** How long a dial from inside the box may take, the guest's own wait (guest.ts DIAL_MS) and its answer. */
const DIAL_WAIT_MS = 15_000;
const GONE_MS = 30_000;
const REDIAL_MIN_MS = 50;
const REDIAL_MAX_MS = 1_000;
/** How often the node asks a box's guest whether it still answers, and how long it waits before the box counts as
 * hung (a frozen or panicked guest keeps its vsock socket open, so its link never drops by itself). */
export const PING_MS = 10_000;
export const SILENT_MS = 60_000;
/** How often a local VM's clock is set again from this machine's. */
export const CLOCK_MS = 10 * 60_000;

export type BoxOptions = {
  /** The session the box runs: every call from it acts as this session. */
  session: string;
  /** A new stream to the guest helper: vsock through the VMM's socket, or a unix socket to a stand-in. */
  dial: () => Promise<Duplex>;
  /** The node's socket, at whose path the guest listens (FLEETD_NODE_SOCK). */
  nodeSock: string;
  /** This machine's ports the box reaches at the same numbers (the browser proxy's, adb's). */
  tcp: number[];
  /** Where the box reaches what this machine reaches, through the node. */
  relays?: Relay[];
  /** How node.sock calls are answered (the node's serveLeadSocket hooks). */
  lead: LeadSocketHooks;
  /** Where the guest listens for its builds' slots, and the node home whose slots they take. */
  slots?: { sock: string; home: string };
  /** How long a dropped link is dialled again before the guest counts as gone. */
  goneMs?: number;
  /** Whether the box still runs (its VMM): a dropped link of a box that doesn't ends at once, with no redial. */
  alive?: () => boolean;
  /** Called once when the guest stopped answering for `silentMs` (it's ended then); and the stand-ins' times. */
  hung?: (why: string) => void;
  pingMs?: number;
  silentMs?: number;
  /** Set the guest's clock from this machine's, on each link and every CLOCK_MS: a local VM's (it has no clock of
   * its own to keep). */
  clock?: boolean;
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
  #nextDial = NODE_CHANNELS;
  /** The dials the guest hasn't answered yet, by channel: undefined once it connected, else why not. */
  #dials = new Map<number, (why: string | undefined) => void>();
  #over = false;
  #connecting = false;
  #goneResolve!: (why: string) => void;
  /** Why the link ended for good: the guest went away, or the node let go (`close`). */
  readonly gone: Promise<string> = new Promise((r) => (this.#goneResolve = r));

  #ping: ReturnType<typeof setInterval> | undefined;
  #clockAt = 0;

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
   * A link that drops meanwhile ends the wait with a run that didn't finish. As the agent's user where the guest runs
   * it as one (a local VM's), unless `root`: the node's own commands in the box (its pin to Claude's relay). */
  async run(r: ConfinedRun & { root?: boolean }): Promise<RunOutcome> {
    const run = `r${++this.#runs}`;
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

  /** A connection the guest makes from inside the box to `host`:`port` (a browser's: ../browser/egress.ts), so it
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
    const closed = () => settle("the box's guest ended the connection before it connected (a guest from before dials: a new task's VM has one)");
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

  /** `path` in the box, refused past `max` bytes. */
  async read(path: string, max: number): Promise<Uint8Array> {
    const parts: Buffer[] = [];
    let at = 0;
    for (;;) {
      const got = (await this.#request({ op: "read", path, offset: at, max: READ_CHUNK }, ANSWER_MS * 4)) as { data: string; size: number };
      if (got.size > max) throw new Error(`${path} in the box is larger than ${max} bytes`);
      const b = Buffer.from(got.data, "base64");
      parts.push(b);
      at += b.length;
      if (b.length === 0 || at >= got.size) return new Uint8Array(Buffer.concat(parts));
    }
  }

  /** Has the box's kernel forget the files it caches but holds no open file of (a local VM's: its share's server
   * then closes the fd it keeps for each). */
  async forget(): Promise<void> {
    await this.#request({ op: "forget" }, ANSWER_MS * 4);
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
    // A dial that never answers (a vsock connect, say) counts as a failed one.
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
    // A link that closes before its hello (a VM whose guest isn't listening yet) fails the dial at once.
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
      if (this.o.clock) await this.#setClock();
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
    if ("unix" in target && target.unix === this.o.nodeSock) return leadChannel(this.o.session, this.o.lead);
    if ("unix" in target && this.o.slots && target.unix === this.o.slots.sock) return slotChannel(this.o.slots.home);
    if (!("tcp" in target)) return undefined;
    const relay = this.#relays.get(relayKey(target.tcp, target.addr));
    if (relay) return connect({ host: relay.to.host, port: relay.to.port });
    if (target.addr === undefined && this.#tcp.has(target.tcp)) return connect({ host: "127.0.0.1", port: target.tcp });
    return undefined;
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
      // A box whose VMM is gone won't answer again: its link ends now, not when the redials give up.
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
      if (this.o.clock && Date.now() - this.#clockAt >= CLOCK_MS) await this.#setClock(silent);
      else await this.#request({ op: "ping" }, silent);
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

  /** The guest's clock set to this machine's, to the millisecond. */
  async #setClock(ms = ANSWER_MS): Promise<void> {
    this.#clockAt = Date.now();
    try {
      await this.#request({ op: "clock", ms: Date.now() }, ms);
    } catch (error) {
      // A guest from before `clock` answers that it has none: its clock is the kernel line's, as it was.
      if (/didn't answer/u.test((error as Error).message)) throw error;
    }
  }

  #end(why: string): void {
    if (this.#over) return;
    this.#over = true;
    if (this.#ping) clearInterval(this.#ping);
    this.#bridge?.lost();
    this.#mux?.close(why);
    this.#goneResolve(why);
  }
}

/** One end of an in-memory stream (`pair`): what it writes, the other end reads, its write done once that end read it. */
class End extends Duplex {
  other!: End;
  #waiting: (() => void) | undefined;
  override _read(): void {
    const go = this.other.#waiting;
    this.other.#waiting = undefined;
    go?.();
  }
  override _write(chunk: Buffer, _encoding: BufferEncoding, done: (error?: Error | null) => void): void {
    if (this.other.push(chunk)) done();
    else this.#waiting = () => done();
  }
  override _final(done: (error?: Error | null) => void): void {
    this.other.push(null);
    done();
  }
  override _destroy(error: Error | null, done: (error?: Error | null) => void): void {
    this.other.destroy();
    done(error);
  }
}

/** Two ends of one stream: a dial's, its channel on one and its user on the other. */
function pair(): [Duplex, Duplex] {
  const a = new End();
  const b = new End();
  a.other = b;
  b.other = a;
  return [a, b];
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

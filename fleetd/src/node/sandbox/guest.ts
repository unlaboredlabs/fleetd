// `fleetd sandbox-guest --listen <path> --dir <dir>`: the helper inside a box. It serves one node link at a time on
// the unix socket `--listen` (a new connection is the node again, after a drop or its restart, and replaces the old),
// and over it (./mux.ts):
// - starts the session's host (`fleetd session-host`, ../runner/host/serve.ts) in `<dir>/<session id>` when the node
//   asks, and pipes its socket's lines on channel 1, unchanged. Its connection to the host is ended, never cut, when a
//   link drops, and made again for the next link: the host takes every whole line the node sent before it, and then
//   resends the events it kept. The node keeps its lines until the guest confirms them (`hostLines`), and sends again
//   only those it didn't;
// - listens where the node asks, at the node.sock path the agent's FLEETD_NODE_SOCK names and on 127.0.0.1 at the node's
//   forwarded TCP ports, and opens a channel for each connection there. The node decides what a channel is and whose
//   session it acts as; nothing here names one;
// - connects from inside the box where the node opens a dial channel (`{"dial":{"host","port"}}`, its browser's),
//   answering `{"op":"dial","channel":n}`, or with `"error"`, once it connected or failed.
//
// A guest started again (a hosted box's node restarted: a node.sock that didn't answer) takes over the session host
// one before it started that still runs, from its registration in `--dir`, as a node on a plain machine adopts its
// hosts: the node's next link joins it rather than starting a second claude on the session.
//
// A connection made where the guest listens while no link is up (the node restarting, a hosted box's link moving to
// another of the service's hosts) waits, unread, for the next link, up to HOLD_MS, and is closed only then. One whose
// link drops under it is closed: a lead call's CLI sends it again (../../cli/agent_mcp/socket.ts), and it waits here.
//
// A hosted box has no unix socket the node reaches: there the guest listens on `--port` for one WebSocket at a time,
// through the provider's private port, and takes it only with fleetd's own per-box secret in SECRET_HEADER (the
// value of FLEETD_BOX_SECRET in its environment, given at its start, never at the box's create).
//
// - runs a command where the agent runs when the node asks (a worktree's setup commands), confined to its cwd and
//   killed with its process group at its timeout or the node's `cancel`.
//
// Control messages, node → guest: `{"id":n,"op":"listen","unix":path}` or `"tcp":port` (with `"addr":ip`, one of the
// guest's own addresses, to listen there instead of its loopback),
// `{"id":n,"op":"start","sessionId","program","args","cwd","env"}`, `{"id":n,"op":"run","run","argv","cwd","env",
// "timeoutSec","scrub","root"?}` (`root`: the node's own command, never run as the agent's user) and `{"id":n,"op":"cancel","run"}`, and for a box without the node's files (hosted)
// `{"id":n,"op":"write","path","data":base64,"append"?,"mode"?}` and `{"id":n,"op":"read","path","offset","max"}`
// (answers `{"data":base64,"size"}`), and `{"id":n,"op":"ping"}` (any answer: it still answers); guest → node `{"id":n,"ok":{…}}` or
// `{"id":n,"error":"…"}`, on every link first `{"op":"hello","protocol":n,"host":{"protocol","refused","lines"}|null}`,
// `{"op":"hostLines","n":n}`: the session host has taken the node's first n lines, and `{"op":"dial","channel"[,"error"]}`.
// In a hosted box, `{"id":n,"op":"tailnet","suffix":s|null}` switches the team's tailnet in the box on or off
// (./tailnet_box.ts), and the node says how each of its connections' dials went with `{"op":"tailnetDialed","channel"[,"error"]}`.
import { type ChildProcess, spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { appendFile, chmod, mkdir, open, writeFile } from "node:fs/promises";
import { createServer, connect, isIP, type Server, type Socket } from "node:net";
import { dirname, join } from "node:path";
import { Duplex } from "node:stream";
import { runConfined, type RunOutcome } from "../cmd/index.ts";
import { timingSafeEqual } from "node:crypto";
import { selfArgv } from "../util.ts";
import { SECRET_HEADER } from "../../sandbox/providers/common.ts";
import { COMMAND as SESSION_HOST, hostAlive, readRegistration, type Registration } from "../runner/host.ts";
import { GUEST_PROTOCOL, HOST, type HostInfo, Mux, NODE_CHANNELS, READ_CHUNK, type Target } from "./mux.ts";
import { BoxTailnet } from "./tailnet_box.ts";

export { GUEST_PROTOCOL, READ_CHUNK, type HostInfo } from "./mux.ts";

export const GUEST_COMMAND = "sandbox-guest";
const START_TIMEOUT_MS = 10_000;
/** How long an ended connection to the session host may take to close before it is cut. */
const CLOSE_MS = 2_000;
const CONFIRM_MS = 200;
/** How long a connection made while no link is up waits for one (the node's own wait for its hub link, after a drop,
 * is as long: lead/channel.ts RELINK_WAIT_MS). */
const HOLD_MS = 30_000;
/** The variable holding the per-box secret a hosted guest takes its link with. */
export const SECRET_ENV = "FLEETD_BOX_SECRET";

type Options = {
  listen: string;
  dir: string;
  /** The address the TCP forwards listen on: 127.0.0.1 in a box; a stand-in box beside its node takes another of
   * 127/8, where the node's own ports aren't. */
  loopback: string;
  /** HOLD_MS; tests pass their own. */
  holdMs?: number;
};

const warn = (message: string) => process.stderr.write(`${new Date().toISOString()} WARN sandbox-guest: ${message}\n`);

export class Guest {
  #mux: Mux | undefined;
  #listeners = new Map<string, Server>();
  #next = 2;
  #host: { dir: string; alive: () => boolean; info: HostInfo; pipe: HostPipe } | undefined;
  #server: Server | undefined;
  /** Commands running for the node, by its run id. */
  #runs = new Map<string, AbortController>();
  #ws: { stop(close?: boolean): void } | undefined;
  #tailnet: BoxTailnet | undefined;
  /** Connections waiting for the next link, each with what opens its channel there. */
  #held = new Set<{ socket: Socket; open: (mux: Mux) => void; timer: ReturnType<typeof setTimeout> }>();

  constructor(readonly o: Options) {}

  /** Listens for the node on the unix socket `listen` (a stand-in box beside its node). A socket there that nothing
   * answers is a guest's that ended without removing it: it goes, and this one takes its place; one a live guest
   * answers stays, and this guest doesn't listen. */
  async serve(): Promise<void> {
    mkdirSync(this.o.dir, { recursive: true, mode: 0o700 });
    this.#adopt();
    const server = createServer({ allowHalfOpen: false }, (socket) => this.#link(socket));
    this.#server = server;
    const listen = () =>
      new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(this.o.listen, () => (server.off("error", reject), resolve()));
      });
    try {
      await listen();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE" || (await answers(this.o.listen))) throw error;
      rmSync(this.o.listen, { force: true });
      await listen();
    }
  }

  /** Listens for the node's WebSocket on `port` (all addresses: the provider's proxy reaches it from outside), taking
   * one only with `secret` in SECRET_HEADER. */
  serveWs(port: number, secret: string): void {
    this.#adopt();
    const want = Buffer.from(secret);
    const ends = new WeakMap<object, Duplex>();
    this.#ws = Bun.serve<undefined, never>({
      port,
      hostname: "0.0.0.0",
      fetch: (req, server) => {
        const got = Buffer.from(req.headers.get(SECRET_HEADER) ?? "");
        if (want.length === 0 || got.length !== want.length || !timingSafeEqual(got, want)) return new Response("no", { status: 403 });
        return server.upgrade(req) ? undefined : new Response("a WebSocket only", { status: 426 });
      },
      websocket: {
        maxPayloadLength: 4 << 20,
        idleTimeout: 0,
        sendPings: true,
        open: (ws) => {
          let waiting: (() => void) | undefined;
          const end: Duplex = new Duplex({
            read() {},
            write(chunk: Buffer, _encoding, callback) {
              // -1: queued past Bun's buffer; it says drain when it can take more.
              if (ws.send(chunk) === -1) waiting = callback;
              else callback();
            },
            destroy(error, callback) {
              try {
                ws.close();
              } catch {}
              callback(error);
            },
          });
          (end as Duplex & { drained?: () => void }).drained = () => {
            const w = waiting;
            waiting = undefined;
            w?.();
          };
          ends.set(ws, end);
          this.#link(end);
        },
        message: (ws, data) => {
          const end = ends.get(ws);
          end?.push(typeof data === "string" ? Buffer.from(data) : Buffer.from(data));
        },
        drain: (ws) => (ends.get(ws) as (Duplex & { drained?: () => void }) | undefined)?.drained?.(),
        close: (ws) => {
          const end = ends.get(ws);
          ends.delete(ws);
          end?.push(null);
          end?.destroy();
        },
      },
    });
  }

  stop(): void {
    for (const r of this.#runs.values()) r.abort();
    this.#ws?.stop(true);
    this.#server?.close();
    for (const l of this.#listeners.values()) l.close();
    for (const h of this.#held) (clearTimeout(h.timer), h.socket.destroy());
    this.#held.clear();
    this.#mux?.close("the guest stopped");
  }

  #link(socket: Duplex): void {
    this.#mux?.close("the node dialled again");
    const mux: Mux = new Mux(socket, {
      control: (m) => void this.#control(mux, m),
      open: (channel, target) => {
        if (channel === HOST && "host" in target) return this.#live()?.pipe.attach();
        return channel >= NODE_CHANNELS && "dial" in target ? dial(mux, channel, target.dial) : undefined;
      },
      closed: () => {
        if (this.#mux === mux) this.#mux = undefined;
      },
    });
    this.#mux = mux;
    const h = this.#live();
    mux.control({ op: "hello", protocol: GUEST_PROTOCOL, host: h ? { ...h.info, lines: h.pipe.lines } : null });
    const held = [...this.#held];
    this.#held.clear();
    for (const c of held) (clearTimeout(c.timer), c.open(mux));
  }

  /** Opens `socket`'s channel to `target` on the link, or on the next one when none is up. */
  #carry(socket: Socket, target: Target): void {
    const open = (mux: Mux) => {
      mux.open(this.#next++, target, socket);
      socket.resume();
    };
    const mux = this.#mux;
    if (mux && !mux.closed) return open(mux);
    const holdMs = this.o.holdMs ?? HOLD_MS;
    const held = { socket, open, timer: setTimeout(() => (this.#held.delete(held), socket.destroy()), holdMs) };
    this.#held.add(held);
    socket.once("close", () => (clearTimeout(held.timer), this.#held.delete(held)));
  }

  #live() {
    const h = this.#host;
    return h?.alive() ? h : undefined;
  }

  /** Takes over a session host a guest before this one started in `dir` and left running. */
  #adopt(): void {
    let names: string[] = [];
    try {
      names = readdirSync(this.o.dir);
    } catch {}
    for (const name of names) {
      const dir = join(this.o.dir, name);
      const r = readRegistration(dir);
      if (!r || r.refused || !hostAlive(r)) continue;
      this.#host = { dir, alive: () => hostAlive(r), info: { protocol: r.protocol, refused: null }, pipe: this.#pipe(dir) };
      return;
    }
  }

  #pipe(dir: string): HostPipe {
    return new HostPipe(dir, (n) => this.#mux?.control({ op: "hostLines", n }));
  }

  async #control(mux: Mux, m: Record<string, unknown>): Promise<void> {
    // The node's word on a tailnet connection: no answer.
    if (m.op === "tailnetDialed") return void this.#tailnet?.dialed(Number(m.channel), typeof m.error === "string" ? m.error : undefined);
    const id = m.id;
    let answer: Record<string, unknown>;
    try {
      if (m.op === "listen") answer = { ok: await this.#listen(m) };
      else if (m.op === "start") answer = { ok: await this.#start(m) };
      else if (m.op === "run") answer = { ok: await this.#run(m) };
      else if (m.op === "write") answer = { ok: await write(m) };
      else if (m.op === "read") answer = { ok: await read(m) };
      else if (m.op === "cancel") answer = { ok: this.#runs.get(String(m.run))?.abort() ?? null };
      else if (m.op === "ping") answer = { ok: null };
      else if (m.op === "tailnet") answer = { ok: await this.#setTailnet(m) };
      else throw new Error(`no such op: ${String(m.op)}`);
    } catch (error) {
      answer = { error: (error as Error).message };
    }
    mux.control({ id, ...answer });
  }

  /** The team's tailnet in the box, on with its suffix or off (`suffix` null). */
  #setTailnet(m: Record<string, unknown>): Promise<string> {
    const suffix = m.suffix === null ? null : typeof m.suffix === "string" ? m.suffix : undefined;
    if (suffix === undefined) throw new Error("tailnet needs a suffix, or null");
    if (suffix !== null && !/^[a-z0-9.-]{0,253}$/iu.test(suffix)) throw new Error("tailnet's suffix isn't a domain");
    this.#tailnet ??= new BoxTailnet({
      open: (target, local) => {
        const mux = this.#mux;
        if (!mux || mux.closed) return undefined;
        const channel = this.#next++;
        mux.open(channel, target, local);
        return channel;
      },
      root: asRoot,
    });
    return this.#tailnet.set(suffix);
  }

  /** Listens where the node asks, once: a node that dials again asks again. */
  async #listen(m: Record<string, unknown>): Promise<Target> {
    const port = Number.isInteger(m.tcp) && (m.tcp as number) > 0 && (m.tcp as number) < 65536 ? (m.tcp as number) : undefined;
    if (m.addr !== undefined && (typeof m.addr !== "string" || !isIP(m.addr))) throw new Error("listen's addr is an IP address");
    const target: Target | undefined =
      typeof m.unix === "string" ? { unix: m.unix } : port !== undefined ? { tcp: port, ...(m.addr ? { addr: m.addr as string } : {}) } : undefined;
    if (!target) throw new Error("listen needs a unix path or a tcp port");
    const key = JSON.stringify(target);
    if (this.#listeners.has(key)) return target;
    // Never removes what is at the path: in a box whose node home is shared with the host, that file is the node's.
    if ("unix" in target && existsSync(target.unix)) throw new Error(`${target.unix} exists already`);
    const server = createServer({ allowHalfOpen: true, pauseOnConnect: true }, (socket) => this.#carry(socket, target));
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      if ("unix" in target) server.listen(target.unix, () => resolve());
      else server.listen(target.tcp, target.addr ?? this.o.loopback, () => resolve());
    });
    this.#listeners.set(key, server);
    return target;
  }

  /** Runs a command for the node, as the node runs a setup command on a plain machine. */
  async #run(m: Record<string, unknown>): Promise<RunOutcome> {
    const { run, argv, cwd, env, timeoutSec, scrub } = m as Record<string, unknown>;
    if (typeof run !== "string" || typeof cwd !== "string" || !Array.isArray(argv) || !argv.every((a) => typeof a === "string") || typeof timeoutSec !== "number")
      throw new Error("run needs a run id, argv, a cwd and a timeout");
    if (this.#runs.has(run)) throw new Error(`run ${run} runs already`);
    const abort = new AbortController();
    this.#runs.set(run, abort);
    try {
      return await runConfined(
        {
          cwd,
          argv: argv as string[],
          timeoutSec,
          ...(env && typeof env === "object" ? { env: { ...(env as Record<string, string>), ...imageEnv() } } : {}),
          scrub: Array.isArray(scrub) ? scrub.filter((v): v is string => typeof v === "string") : [],
          signal: abort.signal,
        },
        [cwd],
      );
    } finally {
      this.#runs.delete(run);
    }
  }

  /** Starts the session's host, as the node starts one on a plain machine, and waits for it to register. */
  async #start(m: Record<string, unknown>): Promise<HostInfo> {
    const { sessionId, program, args, cwd, env } = m as { sessionId: unknown; program: unknown; args: unknown; cwd: unknown; env: unknown };
    if (typeof sessionId !== "string" || !/^[\w.-]+$/.test(sessionId) || typeof program !== "string" || typeof cwd !== "string")
      throw new Error("start needs a session id, a program and a cwd");
    if (!Array.isArray(args) || !args.every((a) => typeof a === "string")) throw new Error("start's args are strings");
    if (this.#live()) throw new Error("a session host already runs in this box");
    const dir = join(this.o.dir, sessionId);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    for (const f of ["host.json", "sock"]) rmSync(join(dir, f), { force: true });
    const log = openSync(join(dir, "host.log"), "w");
    const [exe, ...argv] = [...selfArgv(), SESSION_HOST, dir, sessionId, "--", program, ...(args as string[])];
    let child: ChildProcess;
    try {
      child = spawn(exe!, argv, {
        cwd,
        env: { ...(env && typeof env === "object" ? env : process.env), ...imageEnv() } as NodeJS.ProcessEnv,
        stdio: ["ignore", "ignore", log],
        detached: true,
      });
    } finally {
      closeSync(log);
    }
    child.unref();
    let failed: string | undefined;
    child.on("error", (e) => (failed = `it didn't start: ${e.message}`));
    child.on("exit", (code, signal) => (failed ??= `it exited (${signal ?? `exit status: ${code}`})`));
    const deadline = Date.now() + START_TIMEOUT_MS;
    let r: Registration | undefined;
    while (!(r = readRegistration(dir))) {
      if (failed) throw new Error(`no host came up: ${failed}`);
      if (Date.now() >= deadline) {
        child.kill("SIGKILL");
        throw new Error(`no host came up: it hadn't started claude after ${START_TIMEOUT_MS / 1000} s`);
      }
      await Bun.sleep(5);
    }
    const info = { protocol: r.protocol, refused: r.refused ?? null };
    if (!r.refused) {
      this.#host = { dir, alive: () => child.exitCode === null && child.signalCode === null, info, pipe: this.#pipe(dir) };
    }
    return info;
  }
}

/** Where a box's image names what its own programs need (Playwright's browsers, say): its init gives them to the guest,
 * and the guest to every session host and command it starts, over what the node sent. */
export const IMAGE_ENV = "/etc/fleetd/guest.env";

/** The image's variables, as this guest got them. */
export function imageEnv(file = IMAGE_ENV, own: Record<string, string | undefined> = process.env): Record<string, string> {
  const out: Record<string, string> = {};
  let text = "";
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return out;
  }
  for (const line of text.split("\n")) {
    const name = /^([A-Za-z_][A-Za-z0-9_]*)=/u.exec(line)?.[1];
    const value = name ? own[name] : undefined;
    if (name && value !== undefined) out[name] = value;
  }
  return out;
}

/** The guest's end of the session host's lines, across node links. */
class HostPipe {
  /** The node's whole lines taken for the host: none is lost but with the host itself. */
  lines = 0;
  #conn: Socket | undefined;
  #closing: Promise<void> = Promise.resolve();
  #link: Duplex | undefined;
  /** Lines waiting for the next connection. */
  #queue: Buffer[] = [];
  #confirm: ReturnType<typeof setTimeout> | undefined;

  constructor(
    readonly dir: string,
    readonly confirmed: (lines: number) => void,
  ) {}

  /** This link's end of channel 1. The host gets whole lines only: a link that drops mid-line leaves no half of it, and
   * the node sends the line again whole. */
  attach(): Duplex {
    const old = this.#link;
    this.#link = undefined;
    old?.destroy();
    this.#end();
    let tail: Buffer = Buffer.alloc(0);
    const link: Duplex = new Duplex({
      read() {},
      write: (chunk: Buffer, _encoding, callback) => {
        const all = tail.length ? Buffer.concat([tail, chunk]) : chunk;
        const nl = all.lastIndexOf(10);
        if (nl < 0) tail = Buffer.from(all);
        else {
          tail = Buffer.from(all.subarray(nl + 1));
          const whole = Buffer.from(all.subarray(0, nl + 1));
          if (this.#conn) this.#conn.write(whole);
          else this.#queue.push(whole);
          for (const b of whole) if (b === 10) this.lines++;
          this.#confirm ??= setTimeout(() => {
            this.#confirm = undefined;
            this.confirmed(this.lines);
          }, CONFIRM_MS);
        }
        callback();
      },
      // The node let go of the host (its HostLink detached).
      final: (callback) => {
        this.#end();
        link.push(null);
        callback();
      },
    });
    link.on("close", () => {
      if (this.#link !== link) return;
      this.#link = undefined;
      this.#end();
    });
    this.#link = link;
    void this.#closing.then(() => {
      if (this.#link === link && !link.writableEnded) this.#open(link);
    });
    return link;
  }

  #open(link: Duplex): void {
    const conn = dialHost(this.dir);
    this.#conn = conn;
    for (const b of this.#queue.splice(0)) conn.write(b);
    conn.on("data", (d: Buffer) => {
      if (this.#conn === conn) link.push(d);
    });
    // The host went away by itself: the node's lines end.
    conn.on("close", () => {
      if (this.#conn !== conn) return;
      this.#conn = undefined;
      link.push(null);
    });
    conn.on("error", () => {});
  }

  /** Ends the connection to the host, which takes every line written to it before it closes; a node that doesn't come
   * back leaves the host alone, as on a plain machine. */
  #end(): void {
    const conn = this.#conn;
    if (!conn) return;
    this.#conn = undefined;
    this.#closing = new Promise((resolve) => {
      const timer = setTimeout(() => (conn.destroy(), resolve()), CLOSE_MS);
      conn.once("close", () => (clearTimeout(timer), resolve()));
    });
    conn.end();
  }
}

/** `write`: a file of the box, its dirs made; `append` adds to it (a file sent in pieces). */
async function write(m: Record<string, unknown>): Promise<number> {
  if (typeof m.path !== "string" || !m.path.startsWith("/") || typeof m.data !== "string") throw new Error("write needs an absolute path and data");
  const bytes = Buffer.from(m.data, "base64");
  await mkdir(dirname(m.path), { recursive: true });
  const mode = Number.isInteger(m.mode) ? (m.mode as number) : 0o600;
  if (m.append) await appendFile(m.path, bytes);
  else await writeFile(m.path, bytes, { mode });
  await chmod(m.path, mode);
  return bytes.length;
}

/** `read`: up to READ_CHUNK bytes of a file of the box from `offset`, and its size. */
async function read(m: Record<string, unknown>): Promise<{ data: string; size: number }> {
  if (typeof m.path !== "string") throw new Error("read needs a path");
  const offset = Number.isInteger(m.offset) && (m.offset as number) > 0 ? (m.offset as number) : 0;
  const max = Math.min(Number.isInteger(m.max) && (m.max as number) > 0 ? (m.max as number) : READ_CHUNK, READ_CHUNK);
  const f = await open(m.path, "r");
  try {
    const size = (await f.stat()).size;
    const buf = Buffer.alloc(Math.max(0, Math.min(max, size - offset)));
    const { bytesRead } = buf.length ? await f.read(buf, 0, buf.length, offset) : { bytesRead: 0 };
    return { data: buf.subarray(0, bytesRead).toString("base64"), size };
  } finally {
    await f.close();
  }
}

/** How long a dial from inside the box may take to connect. */
const DIAL_MS = 10_000;

/** The node's dial (a screen's connection, ../place/box_screens.ts): made from inside the box, so it reaches what the
 * box reaches and no more, its name looked up by the box's own DNS. The node hears how it went before any byte. */
function dial(mux: Mux, channel: number, to: { host?: unknown; port?: unknown } | undefined): Duplex | undefined {
  const host = to?.host;
  const port = to?.port;
  if (typeof host !== "string" || !host || !Number.isInteger(port) || (port as number) < 1 || (port as number) > 65535) {
    mux.control({ op: "dial", channel, error: "a dial needs a host and a port" });
    return undefined;
  }
  const socket = connect({ host, port: port as number, allowHalfOpen: true });
  let said = false;
  const say = (error?: string) => {
    if (said) return;
    said = true;
    clearTimeout(timer);
    mux.control({ op: "dial", channel, ...(error ? { error } : {}) });
  };
  const timer = setTimeout(() => {
    say(`no answer from ${host}:${port} within ${DIAL_MS / 1000} s`);
    socket.destroy();
  }, DIAL_MS);
  socket.once("connect", () => say());
  // Before the mux's own handler, which ends the channel: the node hears why first.
  socket.once("error", (e: NodeJS.ErrnoException) => say(e.code ?? e.message));
  return socket;
}

/** A connection to the session host in `dir`, through an open fd of the dir when its own path is too long for a socket
 * address (as ../runner/host.ts dials). */
function dialHost(dir: string): Socket {
  const path = join(dir, "sock");
  if (path.length < 100 || process.platform !== "linux") return connect(path);
  const fd = openSync(dir, "r");
  const socket = connect(`/proc/self/fd/${fd}/sock`);
  socket.once("connect", () => closeSync(fd)).once("error", () => closeSync(fd));
  return socket;
}

/** Whether something listens on the unix socket `path`. */
function answers(path: string): Promise<boolean> {
  return new Promise((resolve) => {
    const s = connect(path);
    s.once("connect", () => (s.destroy(), resolve(true))).once("error", () => resolve(false));
  });
}

const USAGE = `usage: fleetd ${GUEST_COMMAND} (--listen <unix path> | --port <n>) --dir <dir>`;

export async function main(argv: string[]): Promise<number> {
  const flag = (name: string) => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const listen = flag("--listen");
  const port = Number(flag("--port"));
  const dir = flag("--dir");
  if ((!listen && !(port > 0)) || !dir) {
    process.stderr.write(`${USAGE}\n`);
    return 2;
  }
  let finished!: () => void;
  const over = new Promise<void>((r) => (finished = r));
  const guest = new Guest({ listen: listen ?? "", dir, loopback: flag("--loopback") ?? "127.0.0.1" });
  try {
    if (listen) await guest.serve();
    else {
      // The secret goes no further: not into the session host's environment, nor any command's.
      const secret = process.env[SECRET_ENV] ?? "";
      delete process.env[SECRET_ENV];
      if (secret.length < 16) {
        warn(`${SECRET_ENV} is missing: no node could take the link`);
        return 2;
      }
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      guest.serveWs(port, secret);
    }
  } catch (error) {
    warn(`can't listen at ${listen ?? `port ${port}`}: ${(error as Error).message}`);
    return 1;
  }
  process.once("SIGTERM", finished);
  process.once("SIGINT", finished);
  await over;
  guest.stop();
  return 0;
}

/** Runs `script` with sh as root: as the guest itself where it is root, else with sudo (a hosted box's user has it,
 * with no password). */
export async function asRoot(script: string, timeoutMs = 30_000): Promise<{ code: number | null; out: string }> {
  const argv = process.getuid?.() === 0 ? ["sh", "-c", script] : ["sudo", "-n", "sh", "-c", script];
  const child = Bun.spawn(argv, { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
  const [out, err] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
  const code = await child.exited;
  clearTimeout(timer);
  // sudo's own grumble in a box with no /etc/hosts entry for its name says nothing of the script.
  const said = `${out}${err}`.split("\n").filter((l) => !/^sudo: unable to resolve host/u.test(l)).join("\n");
  return { code, out: said.slice(-2000) };
}

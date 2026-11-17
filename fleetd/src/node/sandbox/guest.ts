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
//   session it acts as; nothing here names one.
//
// Control messages, node → guest: `{"id":n,"op":"listen","unix":path}` or `"tcp":port`, and
// `{"id":n,"op":"start","sessionId","program","args","cwd","env"}`; guest → node `{"id":n,"ok":{…}}` or
// `{"id":n,"error":"…"}`, on every link first `{"op":"hello","protocol":n,"host":{"protocol","refused","lines"}|null}`,
// and `{"op":"hostLines","n":n}`: the session host has taken the node's first n lines.
import { type ChildProcess, spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync } from "node:fs";
import { createServer, connect, type Server, type Socket } from "node:net";
import { join } from "node:path";
import { Duplex } from "node:stream";
import { selfArgv } from "../util.ts";
import { COMMAND as SESSION_HOST, type Registration } from "../runner/host.ts";
import { HOST, Mux, type Target } from "./mux.ts";

/** Bumped when the link's frames or control messages change incompatibly. */
export const GUEST_PROTOCOL = 1;
export const GUEST_COMMAND = "sandbox-guest";
const START_TIMEOUT_MS = 10_000;
/** How long an ended connection to the session host may take to close before it is cut. */
const CLOSE_MS = 2_000;
const CONFIRM_MS = 200;

export type HostInfo = { protocol: number; refused: Registration["refused"] };

type Options = {
  listen: string;
  dir: string;
  /** The address the TCP forwards listen on: 127.0.0.1 in a box; a stand-in box beside its node takes another of
   * 127/8, where the node's own ports aren't. */
  loopback: string;
};

const warn = (message: string) => process.stderr.write(`${new Date().toISOString()} WARN sandbox-guest: ${message}\n`);

export class Guest {
  #mux: Mux | undefined;
  #listeners = new Map<string, Server>();
  #next = 2;
  #host: { dir: string; child: ChildProcess; info: HostInfo; pipe: HostPipe } | undefined;
  #server: Server | undefined;

  constructor(readonly o: Options) {}

  /** Listens for the node. */
  serve(): Promise<void> {
    mkdirSync(this.o.dir, { recursive: true, mode: 0o700 });
    const server = createServer({ allowHalfOpen: false }, (socket) => this.#link(socket));
    this.#server = server;
    return new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(this.o.listen, () => resolve());
    });
  }

  stop(): void {
    this.#server?.close();
    for (const l of this.#listeners.values()) l.close();
    this.#mux?.close("the guest stopped");
  }

  #link(socket: Socket): void {
    this.#mux?.close("the node dialled again");
    const mux: Mux = new Mux(socket, {
      control: (m) => void this.#control(mux, m),
      open: (channel, target) => (channel === HOST && "host" in target ? this.#live()?.pipe.attach() : undefined),
      closed: () => {
        if (this.#mux === mux) this.#mux = undefined;
      },
    });
    this.#mux = mux;
    const h = this.#live();
    mux.control({ op: "hello", protocol: GUEST_PROTOCOL, host: h ? { ...h.info, lines: h.pipe.lines } : null });
  }

  #live() {
    const h = this.#host;
    return h && h.child.exitCode === null && h.child.signalCode === null ? h : undefined;
  }

  async #control(mux: Mux, m: Record<string, unknown>): Promise<void> {
    const id = m.id;
    let answer: Record<string, unknown>;
    try {
      if (m.op === "listen") answer = { ok: await this.#listen(m) };
      else if (m.op === "start") answer = { ok: await this.#start(m) };
      else throw new Error(`no such op: ${String(m.op)}`);
    } catch (error) {
      answer = { error: (error as Error).message };
    }
    mux.control({ id, ...answer });
  }

  /** Listens where the node asks, once: a node that dials again asks again. */
  async #listen(m: Record<string, unknown>): Promise<Target> {
    const target: Target | undefined =
      typeof m.unix === "string" ? { unix: m.unix } : Number.isInteger(m.tcp) && (m.tcp as number) > 0 && (m.tcp as number) < 65536 ? { tcp: m.tcp as number } : undefined;
    if (!target) throw new Error("listen needs a unix path or a tcp port");
    const key = JSON.stringify(target);
    if (this.#listeners.has(key)) return target;
    // Never removes what is at the path: in a box whose node home is shared with the host, that file is the node's.
    if ("unix" in target && existsSync(target.unix)) throw new Error(`${target.unix} exists already`);
    const server = createServer({ allowHalfOpen: true, pauseOnConnect: true }, (socket) => {
      const mux = this.#mux;
      if (!mux) {
        socket.destroy();
        return;
      }
      mux.open(this.#next++, target, socket);
      socket.resume();
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      if ("unix" in target) server.listen(target.unix, () => resolve());
      else server.listen(target.tcp, this.o.loopback, () => resolve());
    });
    this.#listeners.set(key, server);
    return target;
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
    const [exe, ...pre] = selfArgv();
    let child: ChildProcess;
    try {
      child = spawn(exe!, [...pre, SESSION_HOST, dir, sessionId, "--", program, ...(args as string[])], {
        cwd,
        env: (env && typeof env === "object" ? env : process.env) as NodeJS.ProcessEnv,
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
    while (!(r = registration(dir))) {
      if (failed) throw new Error(`no host came up: ${failed}`);
      if (Date.now() >= deadline) {
        child.kill("SIGKILL");
        throw new Error(`no host came up: it hadn't started claude after ${START_TIMEOUT_MS / 1000} s`);
      }
      await Bun.sleep(5);
    }
    const info = { protocol: r.protocol, refused: r.refused ?? null };
    if (!r.refused) this.#host = { dir, child, info, pipe: new HostPipe(dir, (n) => this.#mux?.control({ op: "hostLines", n })) };
    return info;
  }
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

function registration(dir: string): Registration | undefined {
  try {
    return JSON.parse(readFileSync(join(dir, "host.json"), "utf8")) as Registration;
  } catch {
    return undefined;
  }
}

const USAGE = `usage: fleetd ${GUEST_COMMAND} --listen <unix path> --dir <dir>`;

export async function main(argv: string[]): Promise<number> {
  const flag = (name: string) => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const listen = flag("--listen");
  const dir = flag("--dir");
  if (!listen || !dir) {
    process.stderr.write(`${USAGE}\n`);
    return 2;
  }
  const guest = new Guest({ listen, dir, loopback: flag("--loopback") ?? "127.0.0.1" });
  try {
    await guest.serve();
  } catch (error) {
    warn(`can't listen at ${listen}: ${(error as Error).message}`);
    return 1;
  }
  await new Promise<void>((resolve) => {
    process.once("SIGTERM", resolve);
    process.once("SIGINT", resolve);
  });
  guest.stop();
  return 0;
}

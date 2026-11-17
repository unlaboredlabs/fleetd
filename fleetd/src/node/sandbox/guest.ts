// `fleetd sandbox-guest --listen <path> --dir <dir>`: the helper inside a box. It serves one node link at a time on
// the unix socket `--listen` (a new connection is the node again, after a drop or its restart, and replaces the old),
// and over it (./mux.ts):
// - starts the session's host (`fleetd session-host`, ../runner/host/serve.ts) in `<dir>/<session id>` when the node
//   asks, and pipes its socket's lines on channel 1, unchanged: on a new link the host resends what it kept;
// - listens where the node asks, at the node.sock path the agent's FLEETD_NODE_SOCK names and on 127.0.0.1 at the node's
//   forwarded TCP ports, and opens a channel for each connection there. The node decides what a channel is and whose
//   session it acts as; nothing here names one.
//
// Control messages, node → guest: `{"id":n,"op":"listen","unix":path}` or `"tcp":port`, and
// `{"id":n,"op":"start","sessionId","program","args","cwd","env"}`; guest → node `{"id":n,"ok":{…}}` or
// `{"id":n,"error":"…"}`, and on every link first `{"op":"hello","protocol":n,"host":{"protocol","refused"}|null}`.
import { type ChildProcess, spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync } from "node:fs";
import { createServer, connect, type Server, type Socket } from "node:net";
import { join } from "node:path";
import { selfArgv } from "../util.ts";
import { COMMAND as SESSION_HOST, type Registration } from "../runner/host.ts";
import { HOST, Mux, type Target } from "./mux.ts";

/** Bumped when the link's frames or control messages change incompatibly. */
export const GUEST_PROTOCOL = 1;
export const GUEST_COMMAND = "sandbox-guest";
const START_TIMEOUT_MS = 10_000;

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
  #host: { dir: string; child: ChildProcess; info: HostInfo } | undefined;
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
      open: (channel, target) => (channel === HOST && "host" in target ? this.#hostEnd() : undefined),
      closed: () => {
        if (this.#mux === mux) this.#mux = undefined;
      },
    });
    this.#mux = mux;
    mux.control({ op: "hello", protocol: GUEST_PROTOCOL, host: this.#live()?.info ?? null });
  }

  #live() {
    const h = this.#host;
    return h && h.child.exitCode === null && h.child.signalCode === null ? h : undefined;
  }

  /** A connection to the session host's socket, for channel 1; none when no host runs. */
  #hostEnd(): Socket | undefined {
    const h = this.#live();
    if (!h) return undefined;
    // Through an open fd of the dir when its own path is too long for a socket address (as ../runner/host.ts dials).
    const path = join(h.dir, "sock");
    if (path.length < 100 || process.platform !== "linux") return connect(path);
    const fd = openSync(h.dir, "r");
    const socket = connect(`/proc/self/fd/${fd}/sock`);
    socket.once("connect", () => closeSync(fd)).once("error", () => closeSync(fd));
    return socket;
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
    if (!r.refused) this.#host = { dir, child, info };
    return info;
  }
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

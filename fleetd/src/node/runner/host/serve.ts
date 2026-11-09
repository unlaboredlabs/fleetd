// A session's host (crates/fleetd/src/node/runner/host.rs `serve`, `main`): the small process that owns a session's
// claude, so the claude outlives the node. `fleetd session-host <dir> <session id> -- <program> <args…>` starts claude,
// registers in its dir (`host.json`) and serves the session on its socket (`sock`) to whichever node connects; the
// lines are ../host.ts's. A node restart re-adopts it and streams on from where the last one stopped.
//
// A host whose claude exited waits for a node to take the exit, at most `lingerMs`, and then exits. A host that no node
// has been connected to for `aloneMs` (its node was stopped, not restarted, or its machine removed) ends its session
// the same way: a restart takes seconds. `fleetd session-host stop-all <hosts dir>` stops them all at once.
import { closeSync, openSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { nowIso } from "../../util.ts";
import { COMMAND, leftFile, marker as newMarker, PROTOCOL, startOf, sweep, type Registration } from "../host.ts";
import type { RunnerEvent, SessionCommand } from "./events.ts";
import { adoptOrphans, recordLeftIn, SESSION_MARKER } from "./reaper.ts";
import { startSession, type Session } from "./session.ts";

/** How long a host waits for a node. */
export type Bounds = {
  /** After claude exited: for a node to take its last events. */
  lingerMs: number;
  /** With no node connected: before it ends the session. Far longer than any restart, an update's included. */
  aloneMs: number;
};
export const BOUNDS: Bounds = { lingerMs: 10 * 60_000, aloneMs: 15 * 60_000 };

const warn = (message: string) => process.stderr.write(`${nowIso()} WARN ${message}\n`);
const zero = { Shutdown: { grace: { secs: 0, nanos: 0 } } } satisfies SessionCommand;

/** One connection to a node: Bun's sockets don't buffer, so what the kernel didn't take yet waits for a drain. */
class Conn {
  #out: Uint8Array | undefined;
  #buf = "";
  #decoder = new TextDecoder();
  constructor(readonly socket: Bun.Socket<unknown>) {}
  write(line: string): void {
    const bytes = new TextEncoder().encode(`${line}\n`);
    this.#out = this.#out ? Buffer.concat([this.#out, bytes]) : bytes;
    this.flush();
  }
  flush(): void {
    const out = this.#out;
    if (!out) return;
    const wrote = this.socket.write(out);
    this.#out = wrote < 0 || wrote >= out.length ? undefined : out.subarray(wrote);
  }
  lines(chunk: Uint8Array): string[] {
    this.#buf += this.#decoder.decode(chunk, { stream: true });
    const parts = this.#buf.split("\n");
    this.#buf = parts.pop()!;
    return parts;
  }
}

/** The host's half of the socket: serves `session`'s events from `listen`'s connections until the session has exited
 * and a node took the exit, or `lingerMs` after the exit with none. `stop` (the host's SIGTERM), and `aloneMs` with no
 * node connected, end the session. */
export class Server {
  #kept: [number, string][] = [];
  #seq = 0;
  #conn: Conn | undefined;
  #exited = false;
  #stopping = false;
  #until: ReturnType<typeof setTimeout> | undefined;
  #alone: ReturnType<typeof setTimeout> | undefined;
  #session: Session | undefined;
  #done!: () => void;
  readonly done = new Promise<void>((resolve) => (this.#done = resolve));
  #finished = false;
  #listener: Bun.UnixSocketListener<unknown> | undefined;

  constructor(readonly bounds: Bounds) {
    // Since when no node is connected; the node that launched the host connects at once.
    this.#startAlone();
  }

  /** Binds the socket in `dir` (through an open fd of the dir when its own path is too long for an address). */
  listen(dir: string): void {
    const path = join(dir, "sock");
    rmSync(path, { force: true });
    const handlers: Bun.SocketHandler<unknown> = {
      open: (socket) => this.#accept(socket),
      data: (socket, chunk) => this.#data(socket, chunk),
      drain: (socket) => (this.#conn?.socket === socket ? this.#conn.flush() : undefined),
      close: (socket) => this.#closed(socket),
      error: (socket) => this.#closed(socket),
    };
    if (path.length < 100 || process.platform !== "linux") this.#listener = Bun.listen({ unix: path, socket: handlers });
    else {
      const fd = openSync(dir, "r");
      try {
        this.#listener = Bun.listen({ unix: `/proc/self/fd/${fd}/sock`, socket: handlers });
      } finally {
        closeSync(fd);
      }
    }
  }

  serve(session: Session): void {
    this.#session = session;
  }

  /** One of the session's events, in order. */
  event(event: RunnerEvent): void {
    if (this.#exited) return;
    if (typeof event === "object" && "Exited" in event) {
      this.#exited = true;
      this.#until = setTimeout(() => {
        warn(`no node took the session's last events {"left":${this.#kept.length}}`);
        this.#finish();
      }, this.bounds.lingerMs);
    }
    const line = JSON.stringify({ seq: ++this.#seq, event });
    this.#conn?.write(line);
    this.#kept.push([this.#seq, line]);
    this.#check();
  }

  /** The host's SIGTERM. */
  stop(): void {
    if (this.#stopping) return;
    this.#stopping = true;
    this.#session?.command(zero);
    this.#check();
  }

  #accept(socket: Bun.Socket<unknown>): void {
    // One node at a time: a new one is the node after a restart.
    const old = this.#conn;
    this.#conn = new Conn(socket);
    old?.socket.end();
    for (const [, line] of this.#kept) this.#conn.write(line);
    clearTimeout(this.#alone);
    this.#alone = undefined;
  }

  #data(socket: Bun.Socket<unknown>, chunk: Uint8Array): void {
    const conn = this.#conn;
    if (conn?.socket !== socket) return;
    for (const raw of conn.lines(chunk)) {
      let line: unknown;
      try {
        line = JSON.parse(raw);
      } catch (error) {
        warn(`a line from the node that isn't one: ${(error as Error).message}`);
        continue;
      }
      if (line === "stop") {
        this.#stopping = true;
        this.#session?.command(zero);
      } else if (line !== null && typeof line === "object" && "ack" in line && typeof line.ack === "number") {
        const upto = line.ack;
        while (this.#kept.length && this.#kept[0]![0] <= upto) this.#kept.shift();
      } else if (line !== null && typeof line === "object" && "command" in line) {
        this.#session?.command(line.command as SessionCommand);
      } else warn(`a line from the node that isn't one: ${raw.slice(0, 200)}`);
    }
    this.#check();
  }

  #closed(socket: Bun.Socket<unknown>): void {
    if (this.#conn?.socket !== socket) return;
    this.#conn = undefined;
    this.#startAlone();
  }

  #startAlone(): void {
    clearTimeout(this.#alone);
    this.#alone = setTimeout(() => {
      this.#alone = undefined;
      if (this.#stopping) return;
      warn("no node came back for the session: ending it");
      this.stop();
    }, this.bounds.aloneMs);
  }

  /** Done once a node took everything, the exit included, or once a stop ended the session. */
  #check(): void {
    if (this.#exited && (!this.#kept.length || this.#stopping)) this.#finish();
  }

  #finish(): void {
    if (this.#finished) return;
    this.#finished = true;
    clearTimeout(this.#until);
    clearTimeout(this.#alone);
    this.#listener?.stop(true);
    this.#conn?.socket.end();
    this.#done();
  }
}

/** Writes `r` to `dir`'s host.json, atomically. */
export function register(dir: string, r: Registration): void {
  const tmp = join(dir, ".host.json.tmp");
  writeFileSync(tmp, JSON.stringify(r));
  renameSync(tmp, join(dir, "host.json"));
}

/** A whole host in this process: starts `program`, registers in `dir` and serves it. For main and for tests. */
export async function host(dir: string, sessionId: string, program: string, args: string[], marker: string, bounds: Bounds = BOUNDS): Promise<Server> {
  const server = new Server(bounds);
  const session = await startSession(program, args, sessionId, marker, (e) => server.event(e));
  server.serve(session);
  server.listen(dir);
  const own = process.pid;
  register(dir, { protocol: PROTOCOL, hostPid: own, hostStart: startOf(own) ?? null, pid: session.pid, start: startOf(session.pid) ?? null, marker, refused: null });
  return server;
}

const USAGE = `usage: fleetd ${COMMAND} <dir> <session id> -- <program> <args…>`;

/** `fleetd session-host <dir> <session id> -- <program> <args…>`: starts the session's claude with this process's
 * environment and working directory, registers in `<dir>`, and serves it until it's done. `stop-all <hosts dir>` stops
 * every host there with its session, for a machine whose node goes for good (`fleetd machine remove`). */
export async function main(argv: string[]): Promise<number> {
  if (argv.length === 2 && argv[0] === "stop-all") {
    const stopped = await sweep(argv[1]!, new Set());
    console.log(`stopped ${stopped} agent session(s)`);
    return 0;
  }
  const split = argv.indexOf("--");
  if (split < 0) {
    process.stderr.write(`${USAGE}\n`);
    return 2;
  }
  const [dir, session] = argv.slice(0, split);
  const [program, ...args] = argv.slice(split + 1);
  if (dir === undefined || session === undefined || program === undefined) {
    process.stderr.write(`fleetd ${COMMAND}: a dir, a session id and a program are needed\n`);
    return 2;
  }
  // The node sets the spawn's marker in the host's environment.
  const marker = process.env[SESSION_MARKER] || newMarker(session);
  const refuse = (error: unknown) => {
    const own = process.pid;
    const e = error as NodeJS.ErrnoException;
    try {
      register(dir, {
        protocol: PROTOCOL,
        hostPid: own,
        hostStart: startOf(own) ?? null,
        pid: 0,
        start: null,
        marker,
        refused: { message: refusal(e), missing: e?.code === "ENOENT" },
      });
    } catch {}
    return 1;
  };
  recordLeftIn(leftFile(dir));
  adoptOrphans();
  let server: Server;
  try {
    server = await host(dir, session, program, args, marker);
  } catch (error) {
    return refuse(error);
  }
  process.on("SIGTERM", () => server.stop());
  await server.done;
  return 0;
}

/** A spawn error in the words Rust's io errors use ("No such file or directory (os error 2)"), which the node shows. */
function refusal(e: NodeJS.ErrnoException | undefined): string {
  const words: Record<string, string> = { ENOENT: "No such file or directory (os error 2)", EACCES: "Permission denied (os error 13)", ETXTBSY: "Text file busy (os error 26)" };
  return (e?.code && words[e.code]) || e?.message || String(e);
}

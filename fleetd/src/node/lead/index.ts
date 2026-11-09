// Lead-side CLI calls (crates/fleetd/src/node/lead.rs): the `fleetd` CLI and an agent's MCP server write one
// `lead_call` line to `<node home>/node.sock` and read one `lead_result` line back. The node forwards each call over
// whichever link is up under a node-chosen id, so two callers picking the same id cannot cross answers, and relays the
// hub's answer under the caller's id. A call from a session leaves the machine with its secrets masked (../mask.ts).
import { chmodSync, existsSync, lstatSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { mkdirPrivate } from "../config.ts";
import type { Masker } from "../mask.ts";
import type { NodeFrame } from "../wire.ts";
import { headUtf16 } from "../util.ts";
import { peerPid, type PeerSession } from "./peer.ts";

export const leadSocketPath = (home: string) => join(home, "node.sock");
export const HUB_UNREACHABLE = "fleetd hub is restarting; try again shortly";
/** How long a call waits for the hub link to be up. */
const LINK_WAIT_MS = 5_000;
/** How long it waits instead when the link dropped within RECENT_DROP_MS: the hub is likely restarting for an update. */
const RELINK_WAIT_MS = 30_000;
const RECENT_DROP_MS = 60_000;
const ANSWER_TIMEOUT_MS = 30_000;
const MAX_FRAME_BYTES = 256 * 1024;
const MAX_BROWSER_FRAME_BYTES = 8 << 20;

/** Lead calls only the node makes, for a session's browser and the agents' Mac (hub/tasks/policy.rs NODE_OPS). */
export const NODE_OPS = [
  "browser_session", "browser_recording_part", "browser_takeover", "purchase_open", "purchase_claim", "purchase_filled",
  "secure_input_open", "secure_input_claim", "secure_input_filled", "session_route", "session_step", "mac_where", "mac_send",
];

export type McpToolError = { code: string; message: string; fix?: string };
export type LeadCallFrame = { id: string; cwd: string; call: { op: string } & Record<string, unknown>; threadId?: string };
export type LeadResultFrame = { id: string; result?: unknown; error?: McpToolError };

const errorFrame = (id: string, error: McpToolError): LeadResultFrame => ({ id, error });
const unanswered = (id: string, why: string) =>
  errorFrame(id, { code: "machine_offline", message: `${why}; the call may or may not have gone through`, fix: "try again shortly" });

/** The node's half of lead-side calls: frames in from the socket, out over whichever link is up. */
export class LeadRelay {
  #send: ((frame: NodeFrame) => void) | undefined;
  #pending = new Map<string, (frame: LeadResultFrame) => void>();
  #nextId = 0;
  #hubCaps: string[] = [];
  #linkedWaiters: (() => void)[] = [];
  /** When the hub link last dropped (performance.now()). */
  #dropped: number | undefined;
  /** Holds the node's agents between steps (`fleetd update` ahead of the node's restart). */
  hold: (() => number) | undefined;
  /** The agents' Mac: no lead call leaves it. */
  toolOnly = false;

  /** A welcomed link routes calls through `send` until the returned function detaches it, failing what still waits. */
  attach(send: (frame: NodeFrame) => void, hubCaps: string[]): () => void {
    this.#send = send;
    this.#hubCaps = hubCaps;
    for (const w of this.#linkedWaiters.splice(0)) w();
    return () => {
      if (this.#send !== send) return;
      this.#send = undefined;
      this.#dropped = performance.now();
      const pending = [...this.#pending];
      this.#pending.clear();
      for (const [id, answer] of pending) answer(unanswered(id, "the link to the fleetd hub dropped before it answered"));
    };
  }

  hubCan(capability: string): boolean {
    return this.#hubCaps.includes(capability);
  }

  /** A `lead_result` frame from the hub. */
  resolve(frame: LeadResultFrame): void {
    const answer = this.#pending.get(frame.id);
    if (answer) {
      this.#pending.delete(frame.id);
      answer(frame);
    }
  }

  /** Forwards one frame and returns the hub's answer under the caller's id. Never throws: trouble is an error frame.
   * A call is sent once: one lost after sending may have run, so it is never sent again. */
  async call(frame: LeadCallFrame, waitMs = ANSWER_TIMEOUT_MS): Promise<LeadResultFrame> {
    const callerId = frame.id;
    if (!this.#send) {
      const restarting = this.#dropped !== undefined && performance.now() - this.#dropped < RECENT_DROP_MS;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, restarting ? RELINK_WAIT_MS : LINK_WAIT_MS);
        this.#linkedWaiters.push(() => (clearTimeout(timer), resolve()));
      });
    }
    const send = this.#send;
    if (!send) return errorFrame(callerId, { code: "machine_offline", message: HUB_UNREACHABLE });
    const id = `lc-${++this.#nextId}`;
    const answered = new Promise<LeadResultFrame>((resolve) => this.#pending.set(id, resolve));
    send({ t: "lead_call", ...frame, id });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<LeadResultFrame>((resolve) => {
      timer = setTimeout(() => resolve(unanswered(id, `the fleetd hub did not answer within ${Math.round(waitMs / 1000)} s`)), waitMs);
    });
    const result = await Promise.race([answered, timeout]);
    clearTimeout(timer);
    this.#pending.delete(id);
    return { ...result, id: callerId };
  }
}

/** Names the session a call comes from by where its process runs, never by what the frame claims. */
export function attribute(frame: LeadCallFrame, peer: PeerSession | undefined): LeadCallFrame | LeadResultFrame {
  const refuse = (message: string, fix: string) => errorFrame(frame.id, { code: "forbidden", message, fix });
  const claimed = frame.threadId;
  if (!peer) return refuse("the node could not tell which process made this call", "run fleetd from a normal shell on this machine");
  switch (peer.kind) {
    case "detached":
      return refuse(
        `this call comes from a process session ${peer.session} left running in the background`,
        "make the call from the session itself, through its fleetd tools",
      );
    case "session":
      if (claimed !== undefined && claimed !== peer.session)
        return refuse(
          `this call names session ${claimed} but runs in session ${peer.session}`,
          "use your own fleetd tools; a session acts only as itself",
        );
      return { ...frame, threadId: peer.session };
    case "outside":
      if (claimed !== undefined)
        return refuse(`this call names fleetd session ${claimed} but does not run in it`, "unset FLEETD_THREAD_ID to act as yourself");
      return frame;
  }
}

const isResult = (v: LeadCallFrame | LeadResultFrame): v is LeadResultFrame => !("call" in v);

export type LeadSocketHooks = {
  relay: LeadRelay;
  /** Which session a calling process runs in. */
  identify: (pid: number) => PeerSession;
  /** The masker for a session's calls; throws why there is none. */
  maskFor: (session: string) => Masker;
  /** Answers a `browser_call` (node/browser's); without it, browser calls are refused. */
  browser?: (session: string, frame: Record<string, unknown>) => Promise<Record<string, unknown>>;
  /** Answers a session's `fleetd mac` step (node/mac_tool's, through node.area("local")): `{ result }` or `{ error }`.
   * Without it, `mac` is refused. */
  mac?: (session: string, frame: Record<string, unknown>) => Promise<Record<string, unknown>>;
};

/** Answers one line from the socket. */
export async function answerLine(line: string, pid: number | undefined, hooks: LeadSocketHooks): Promise<Record<string, unknown>> {
  const bad = (message: string) => ({ t: "lead_result", ...errorFrame("invalid", { code: "invalid", message: headUtf16(message, 500) }) });
  let frame: Record<string, unknown>;
  try {
    frame = JSON.parse(line) as Record<string, unknown>;
  } catch (error) {
    return bad(`not a lead_call frame: ${(error as Error).message}`);
  }
  const peer = () => (pid === undefined ? undefined : hooks.identify(pid));
  if (frame.t === "hold") {
    const who = peer();
    if (who?.kind !== "outside") return bad("only a person's shell holds the node's agents, never a session");
    if (!hooks.relay.hold) return bad("this node doesn't hold its agents");
    return { t: "held", steps: hooks.relay.hold() };
  }
  if (frame.t === "browser_call") {
    const refuse = (message: string, fix: string) => ({ t: "browser_result", id: frame.id, error: { code: "forbidden", message, fix } });
    if (!hooks.browser)
      return { t: "browser_result", id: frame.id, error: { code: "invalid", message: "this machine runs no browser sessions", fix: "do without a browser and say so in your result" } };
    const who = peer();
    if (who?.kind === "session" && (frame.threadId === undefined || frame.threadId === who.session))
      return { t: "browser_result", ...(await hooks.browser(who.session, frame)) };
    return refuse("a browser session belongs to an agent's session, and this call comes from none", "use the browser tools of a fleetd agent");
  }
  if (frame.t !== "lead_call") return bad('not a lead_call frame: expected t: "lead_call", "browser_call" or "hold"');
  const call = frame as unknown as LeadCallFrame;
  if (typeof call.id !== "string" || typeof call.call?.op !== "string") return bad("not a lead_call frame: it has no id or call");
  const op = call.call.op;
  if (line.length > MAX_FRAME_BYTES && !(op === "artifact_publish" && line.length <= MAX_BROWSER_FRAME_BYTES))
    return bad(`frame is larger than ${MAX_FRAME_BYTES} bytes (${line.length} for lead_call ${call.id})`);
  const reply = (r: LeadResultFrame) => ({ t: "lead_result", ...r });
  if (hooks.relay.toolOnly)
    return reply(
      errorFrame(call.id, {
        code: "forbidden",
        message: "this Mac is a tool for agents elsewhere: run fleetd from your own machine",
        fix: "agents reach this Mac with `mac run` and `mac sim` from their own machine; a person runs fleetd commands on theirs",
      }),
    );
  // `fleetd mac` is the node's to answer, for the session its process runs in: never masked or sent on as it is.
  if (op === "mac") {
    if (!hooks.mac) return reply(errorFrame(call.id, { code: "invalid", message: "this node doesn't reach the agents' Mac" }));
    const attributed = attribute(call, peer());
    if (isResult(attributed)) return reply(attributed);
    if (attributed.threadId === undefined)
      return reply(
        errorFrame(call.id, {
          code: "forbidden",
          message: "the agents' Mac is for agents' sessions, and this call comes from none",
          fix: "run fleetd mac from an agent's session",
        }),
      );
    const answered = await hooks.mac(attributed.threadId, attributed as unknown as Record<string, unknown>);
    return reply(
      answered.error !== undefined
        ? errorFrame(call.id, answered.error as McpToolError)
        : { id: call.id, result: answered.result },
    );
  }
  if (NODE_OPS.includes(op))
    return reply(
      errorFrame(call.id, {
        code: "forbidden",
        message: `${op} is the node's own call for a browser session`,
        fix: "use session_start and session_end; the node reports the session itself",
      }),
    );
  const attributed = attribute(call, peer());
  if (isResult(attributed)) return reply(attributed);
  if (attributed.threadId === undefined) return reply(await hooks.relay.call(attributed));
  // No masker, no call: a session's call goes out masked or not at all.
  let masker: Masker;
  try {
    masker = hooks.maskFor(attributed.threadId);
  } catch (error) {
    return reply(
      errorFrame(call.id, {
        code: "failed",
        message: `the node could not read the session's secrets to mask this call (${(error as Error).message}), so it was not sent`,
        fix: "try again; if it keeps failing, check the node's log and restart it",
      }),
    );
  }
  return reply(await hooks.relay.call({ ...attributed, call: masker.value(attributed.call) }));
}

/** Serves the lead socket (mode 0600, in the node's 0700 home) until the returned function stops it. */
export async function serveLeadSocket(path: string, hooks: LeadSocketHooks): Promise<() => void> {
  mkdirPrivate(dirname(path));
  if (existsSync(path)) {
    if (!lstatSync(path).isSocket()) throw new Error(`${path} exists and is not a socket; move it away and start the node again`);
    const live = await Bun.connect({ unix: path, socket: { data() {} } }).then(
      (s) => (s.end(), true),
      () => false,
    );
    if (live) throw new Error(`another fleetd node is already serving ${path}; stop it first`);
    rmSync(path, { force: true });
  }
  /** One decoder per connection, streaming: a character split across two reads comes out whole. `out`: what of the
   * answer the socket hasn't taken yet. */
  type Conn = { buf: string; done: boolean; pid: number | undefined; decoder: TextDecoder; out?: Uint8Array };
  /** Writes what is left of the answer and, once all of it is out, ends the connection. Bun's sockets don't buffer: a
   * write past what the kernel takes at once returns short, and the rest goes when the socket drains. An answer past
   * the socket's buffer (a screenshot, a long `mac run` output) went cut otherwise, and its caller waited for a line
   * that never ended. */
  const flush = (socket: Bun.Socket<Conn>) => {
    const out = socket.data.out;
    if (!out) return;
    const wrote = socket.write(out);
    if (wrote < 0) {
      socket.data.out = undefined;
      return;
    }
    if (wrote < out.length) {
      socket.data.out = out.subarray(wrote);
      return;
    }
    socket.data.out = undefined;
    socket.end();
  };
  const answerWith = (socket: Bun.Socket<Conn>, frame: unknown) => {
    socket.data.out = new TextEncoder().encode(`${JSON.stringify(frame)}\n`);
    flush(socket);
  };
  const server = Bun.listen<Conn>({
    unix: path,
    socket: {
      open(socket) {
        socket.data = { buf: "", done: false, pid: peerPid((socket as unknown as { fd?: number }).fd), decoder: new TextDecoder() };
      },
      data(socket, chunk) {
        const conn = socket.data;
        if (conn.done) return;
        conn.buf += conn.decoder.decode(chunk, { stream: true });
        const nl = conn.buf.indexOf("\n");
        if (nl < 0) {
          if (conn.buf.length > MAX_BROWSER_FRAME_BYTES) {
            conn.done = true;
            answerWith(socket, { t: "lead_result", id: "invalid", error: { code: "invalid", message: `frame is larger than ${MAX_BROWSER_FRAME_BYTES} bytes` } });
          }
          return;
        }
        conn.done = true;
        respond(socket, conn.buf.slice(0, nl));
      },
      drain: flush,
      // Half-open: a caller that ends its side after writing still gets the answer.
      end(socket) {
        const conn = socket.data;
        conn.buf += conn.decoder.decode();
        if (!conn.done && conn.buf.trim()) {
          conn.done = true;
          respond(socket, conn.buf);
        }
      },
    },
  });
  const respond = (socket: Bun.Socket<Conn>, line: string) => {
    answerLine(line, socket.data.pid, hooks).then(
      (answer) => answerWith(socket, answer),
      () => socket.end(),
    );
  };
  chmodSync(path, 0o600);
  return () => {
    server.stop(true);
    rmSync(path, { force: true });
  };
}

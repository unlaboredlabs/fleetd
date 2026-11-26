// A node.sock call answered: one `lead_call` line (or `browser_call`, `hold`) in, one result line back, from a process on
// this machine or a box's channel (`leadChannel`), sent on over whichever link to the hub is up (`LeadRelay`). Box side
// (docs/CONTRIBUTING.md "The package"): the socket itself and the kernel's word on who called are ./index.ts and
// ./peer.ts, so a service with no node answers a box's node.sock calls with it too.
import { Duplex } from "node:stream";
import type { Masker } from "../mask.ts";
import { isCallId, LEAD_CALL_ONCE } from "../../shared/lead_once.ts";
import type { NodeFrame } from "../../shared/node_link.ts";
import { headUtf16 } from "../text.ts";

export type PeerSession = { kind: "session"; session: string } | { kind: "detached"; session: string } | { kind: "outside" };

/** Where a call to the node came in: a process on this machine, by the kernel's pid for it (undefined when the kernel
 * didn't say), or a box's channel (../sandbox/box.ts), which is its session's by the connection alone: nothing in a
 * box has a pid on this machine, and nothing it sends names another session. */
export type Caller = number | undefined | { box: string };

/** The session `caller` runs in: a box's is its own; a process's is what `byPid` finds from its pid. */
export function identify(caller: Caller, byPid: (pid: number) => PeerSession): PeerSession | undefined {
  if (typeof caller === "object") return { kind: "session", session: caller.box };
  return caller === undefined ? undefined : byPid(caller);
}

export const HUB_UNREACHABLE = "fleetd workspace is restarting; try again shortly";
/** How long a call waits for the hub link to be up. */
const LINK_WAIT_MS = 5_000;
/** How long it waits instead when the link dropped within RECENT_DROP_MS: the hub is likely restarting for an update. */
const RELINK_WAIT_MS = 30_000;
const RECENT_DROP_MS = 60_000;
const ANSWER_TIMEOUT_MS = 30_000;
/** A box's `mac_where` and `mac_send`: past the hub's own wait for the Mac (hub/mac_tool SEND_WAIT, 170 s). */
const MAC_WAIT_MS = 180_000;
const MAX_FRAME_BYTES = 256 * 1024;
export const MAX_BROWSER_FRAME_BYTES = 8 << 20;

/** Lead calls only the node makes, for a session's browser, the agents' Mac and its MCP relay (hub/tasks/policy.rs
 * NODE_OPS). */
export const NODE_OPS = [
  "browser_session", "browser_recording_part", "browser_takeover", "purchase_open", "purchase_claim", "purchase_filled",
  "secure_input_open", "secure_input_claim", "secure_input_filled", "vault_fill", "vault_filled", "session_route", "session_step", "mac_where",
  "mac_send", "mcp_oauth_renew",
];

/** The node's own calls a box's session sends itself: in a hosted box, the node's half of `fleetd mac` runs in the box,
 * where the worktree is (cli/mac_tool.ts). Each goes out as the box's session, sealed to the Mac, never masked. */
export const BOX_MAC_OPS = ["mac_where", "mac_send"];

export type McpToolError = { code: string; message: string; fix?: string };
/** `resent`: the caller sends it again after a cut before its answer (../../shared/lead_once.ts). */
export type LeadCallFrame = { id: string; cwd: string; call: { op: string } & Record<string, unknown>; threadId?: string; resent?: boolean };
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
      for (const [id, answer] of pending) answer(unanswered(id, "the link to the fleetd workspace dropped before it answered"));
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

  /** Forwards one frame and returns the hub's answer under the caller's id, which goes with it as `callId` when it is
   * one call's own. Never throws: trouble is an error frame. A call lost after sending may have run, so this never
   * sends it again; a caller that does (`resent`) is sent on only to a hub that answers a repeated `callId` once. */
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
    const callId = isCallId(callerId) ? callerId : undefined;
    if (frame.resent && !(callId && this.hubCan(LEAD_CALL_ONCE)))
      return unanswered(callerId, "the connection was cut before the answer came, and this workspace can't take the call again safely");
    const id = `lc-${++this.#nextId}`;
    const answered = new Promise<LeadResultFrame>((resolve) => this.#pending.set(id, resolve));
    send({ t: "lead_call", ...frame, id, ...(callId ? { callId } : {}) });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<LeadResultFrame>((resolve) => {
      timer = setTimeout(() => resolve(unanswered(id, `the fleetd workspace did not answer within ${Math.round(waitMs / 1000)} s`)), waitMs);
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

/** Answers one line from the socket, or from a box's channel (`caller` a box: leadChannel). */
export async function answerLine(line: string, caller: Caller, hooks: LeadSocketHooks): Promise<Record<string, unknown>> {
  const bad = (message: string) => ({ t: "lead_result", ...errorFrame("invalid", { code: "invalid", message: headUtf16(message, 500) }) });
  let frame: Record<string, unknown>;
  try {
    frame = JSON.parse(line) as Record<string, unknown>;
  } catch (error) {
    return bad(`not a lead_call frame: ${(error as Error).message}`);
  }
  const peer = () => identify(caller, hooks.identify);
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
  const boxMac = typeof caller === "object" && BOX_MAC_OPS.includes(op);
  // A push's piece is up to 2 MB, sealed.
  if (line.length > MAX_FRAME_BYTES && !((op === "artifact_publish" || boxMac) && line.length <= MAX_BROWSER_FRAME_BYTES))
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
    // Nothing here answers a repeat once: a step sent again would run again.
    if (call.resent) return reply(unanswered(call.id, "the connection was cut before the answer came"));
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
  if (NODE_OPS.includes(op) && !boxMac)
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
  // The step names the box's session, as the Mac checks its envelope against: never another's.
  if (boxMac) return reply(await hooks.relay.call(op === "mac_send" ? { ...attributed, call: { ...attributed.call, threadId: attributed.threadId } } : attributed, MAC_WAIT_MS));
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

/** One connection to a box's node.sock forward (../sandbox/box.ts), as one to the socket: a line in, one line out,
 * then the end. Its session is `box`'s, whatever the line claims. */
export function leadChannel(box: string, hooks: LeadSocketHooks): Duplex {
  let buf = "";
  let done = false;
  const decoder = new TextDecoder();
  const answer = (frame: unknown) => {
    channel.push(`${JSON.stringify(frame)}\n`);
    channel.push(null);
  };
  const respond = (line: string) => {
    done = true;
    answerLine(line, { box }, hooks).then(answer, () => channel.push(null));
  };
  const channel = new Duplex({
    read() {},
    write(chunk: Uint8Array, _encoding, callback) {
      if (!done) {
        buf += decoder.decode(chunk, { stream: true });
        const nl = buf.indexOf("\n");
        if (nl >= 0) respond(buf.slice(0, nl));
        else if (buf.length > MAX_BROWSER_FRAME_BYTES) {
          done = true;
          answer({ t: "lead_result", id: "invalid", error: { code: "invalid", message: `frame is larger than ${MAX_BROWSER_FRAME_BYTES} bytes` } });
        }
      }
      callback();
    },
    // Half-open: a caller that ends its side after writing still gets the answer.
    final(callback) {
      buf += decoder.decode();
      if (!done && buf.trim()) respond(buf);
      else if (!done) {
        done = true;
        channel.push(null);
      }
      callback();
    },
  });
  return channel;
}


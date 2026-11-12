// Commands the hub runs on a machine through its node: a request frame out, the matching reply back by id.
// `cmd` checks and the merge train's git steps (timeouts up to 30 min),
// sealed secrets, approved (gated) commands, the doctor's node actions, hosted sessions, the agents' Mac, and session
// calls.
import type { HubToNodeTag } from "../../shared/wire_tags.ts";
import { type HubFrame, type NodeFrame, REPLY_OF, type ReplyTag, type RequestTag } from "../../shared/node_link.ts";

export const DEFAULT_TIMEOUT_SEC = 120;
/** A command's longest run: a gated run's cap (`ledger::GATED_MAX_TIMEOUT_SEC`). */
export const MAX_TIMEOUT_SEC = 1800;
/** How long past the command's own timeout the hub waits for the node's answer. */
const REPLY_GRACE_SEC = 30;
/** A node update downloads the new binary before it answers. */
const UPDATE_WAIT_SEC = 600;
/** A node's `claude install`, a minute past its own limit (45 minutes, for a slow link). */
const CLAUDE_WAIT_SEC = 45 * 60 + 60;
/** A node's login: 30 s for its URL, or a minute to end once it has the code, and a grace. */
const LOGIN_WAIT_SEC = 90;
/** How long the hub waits for a node to write a secret. */
const SECRET_REPLY_SEC = 30;
/** A session call's default wait, as the executor's READ_TIMEOUT. */
export const SESSION_CALL_WAIT_SEC = 30;

export type NodeCommandErrorReason = "offline" | "lost" | "no_reply" | "invalid";

export class NodeCommandError extends Error {
  constructor(
    readonly machineId: string,
    readonly reason: NodeCommandErrorReason,
    message: string,
  ) {
    super(message);
    this.name = "NodeCommandError";
  }
}

const offline = (machineId: string) =>
  new NodeCommandError(machineId, "offline", `${machineId}'s node is not linked to the hub`);
const lost = (machineId: string) =>
  new NodeCommandError(machineId, "lost", `the link to ${machineId}'s node dropped while the command ran`);

type Link = { id: number; send: (frame: HubFrame) => boolean };

type Pending = {
  machineId: string;
  linkId: number;
  /** The reply frame's tag this request expects. */
  reply: ReplyTag;
  resolve: (frame: NodeFrame) => void;
  reject: (error: NodeCommandError) => void;
  /** Takes a second reply to the same id once the first came (a refused restart after an update). */
  then?: (frame: NodeFrame) => void;
};

/** A UUID v4, as the Rust hub's `new_id`. */
const newId = () => crypto.randomUUID();

/** Options of one request: how long to wait (default: by its kind), and a second reply's taker. */
export type RequestOptions = { waitSec?: number; then?: (frame: NodeFrame) => void };

/** Request/reply over each welcomed link. The link server calls `attach` and `resolve`; other areas call the rest. */
export class NodeCommands {
  private readonly links = new Map<string, Link>();
  private readonly pending = new Map<string, Pending>();

  /**
   * The node link registers each welcomed link here. Two links of one machine can attach in either order, so the
   * newer one keeps the entry. Returns the detach: commands in flight on the link fail as lost.
   */
  attach(machineId: string, id: number, send: (frame: HubFrame) => boolean): () => void {
    const current = this.links.get(machineId);
    if (!current || current.id <= id) this.links.set(machineId, { id, send });
    return () => {
      if (this.links.get(machineId)?.id === id) this.links.delete(machineId);
      for (const [key, p] of this.pending) {
        if (p.linkId === id && p.machineId === machineId) {
          this.pending.delete(key);
          p.reject(lost(machineId));
        }
      }
    };
  }

  /** Sends one frame that wants no reply over the machine's live link. */
  send(machineId: string, frame: HubFrame): void {
    const link = this.links.get(machineId);
    if (!link) throw offline(machineId);
    if (!link.send(frame)) throw lost(machineId);
  }

  /** Which link the machine's node is on now: a new number each time it links again. */
  linkId(machineId: string): number | undefined {
    return this.links.get(machineId)?.id;
  }

  linked(machineId: string): boolean {
    return this.links.has(machineId);
  }

  /**
   * Hands over a reply frame; true when a request took it. Only the machine a request went to may answer it, and
   * only with the reply its request expects.
   */
  resolve(machineId: string, frame: NodeFrame): boolean {
    const id = typeof frame.id === "string" ? frame.id : undefined;
    if (id === undefined) return false;
    const p = this.pending.get(id);
    if (!p || p.machineId !== machineId || p.reply !== frame.t) return false;
    this.pending.delete(id);
    p.resolve(frame);
    if (p.then) {
      const then = p.then;
      this.pending.set(id, { ...p, resolve: then, reject: () => {}, then: undefined });
    }
    return true;
  }

  /** Stops waiting for a second reply to `id` (`request`'s `then`). */
  forget(id: string): void {
    this.pending.delete(id);
  }

  /**
   * Sends `frame` (its `id` replaced) over the machine's live link and resolves with its reply (REPLY_OF), at most
   * `waitSec` (by default the Rust hub's wait for its kind). Rejects with a NodeCommandError: `offline` with no link,
   * `lost` when the link drops first, `no_reply` past the wait.
   */
  request<T extends RequestTag>(
    machineId: string,
    frame: HubFrame<T>,
    options: RequestOptions = {},
  ): Promise<NodeFrame<(typeof REPLY_OF)[T]> & { id: string }> {
    return this.requestWithId(machineId, frame, options).then(([reply]) => reply);
  }

  /** `request`, with the id it sent. */
  requestWithId<T extends RequestTag>(
    machineId: string,
    frame: HubFrame<T>,
    options: RequestOptions = {},
  ): Promise<[NodeFrame<(typeof REPLY_OF)[T]> & { id: string }, string]> {
    const reply = REPLY_OF[frame.t as T];
    if (!reply) {
      return Promise.reject(new NodeCommandError(machineId, "invalid", `${frame.t} is not a request with a reply`));
    }
    const link = this.links.get(machineId);
    if (!link) return Promise.reject(offline(machineId));
    const id = newId();
    const waitSec = options.waitSec ?? defaultWait(frame);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        // A reply or a lost link already took it out; a waiter for a second reply may stand in its place.
        if (this.pending.get(id)?.resolve === done) this.pending.delete(id);
        reject(new NodeCommandError(machineId, "no_reply", `${machineId}'s node did not answer within ${waitSec} s`));
      }, waitSec * 1000);
      const done = (frame: NodeFrame) => {
        clearTimeout(timer);
        resolve([frame as NodeFrame<(typeof REPLY_OF)[T]> & { id: string }, id]);
      };
      this.pending.set(id, {
        machineId,
        linkId: link.id,
        reply,
        resolve: done,
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
        ...(options.then ? { then: options.then } : {}),
      });
      if (!link.send({ ...frame, id })) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(lost(machineId));
      }
    });
  }

  /** `cmd_check` -> `cmd_result`. */
  run(machineId: string, input: { cwd: string; argv: string[]; timeoutSec?: number }) {
    const timeoutSec = input.timeoutSec ?? DEFAULT_TIMEOUT_SEC;
    const invalid = (m: string) => Promise.reject(new NodeCommandError(machineId, "invalid", m));
    if (!Number.isInteger(timeoutSec) || timeoutSec < 1 || timeoutSec > MAX_TIMEOUT_SEC) {
      return invalid(`timeout must be 1-${MAX_TIMEOUT_SEC} s, got ${timeoutSec}`);
    }
    if (!input.cwd.startsWith("/")) return invalid(`cwd must be absolute, got ${input.cwd}`);
    if (input.argv.length === 0 || input.argv.length > 64) return invalid("argv must have 1-64 entries");
    return this.request(machineId, { t: "cmd_check", cwd: input.cwd, argv: input.argv, timeoutSec });
  }

  /** Relays a sealed secret to the sink's node; it answers with the fingerprint or why it could not write it. */
  deliverSecret(machineId: string, input: Record<string, unknown>) {
    return this.request(machineId, { ...input, t: "secret_deliver" });
  }

  /** Runs an approved command on the node, waiting up to its own timeout plus a grace. */
  runGated(machineId: string, input: Record<string, unknown>) {
    return this.request(machineId, { ...input, t: "gated_run" });
  }

  /** Asks the node for the result of the approved command it ran for `input.requestId`. */
  resumeGated(machineId: string, input: Record<string, unknown>) {
    return this.request(machineId, { ...input, t: "gated_resume" });
  }

  /** The doctor's node actions, each with its own wait. */
  runAction(machineId: string, action: string, extra: Record<string, unknown> = {}) {
    return this.request(machineId, { ...extra, t: "node_action", action });
  }

  /**
   * A node's update: it answers once the new build is in place, before its restart, and again only if the service
   * manager refused that restart; `refused` gets that second answer. Call `forget(id)` to stop waiting for it.
   */
  updateNode(machineId: string, update: unknown, refused: (frame: NodeFrame) => void) {
    return this.requestWithId(machineId, { t: "node_action", action: "update", update }, { then: refused });
  }

  installClaude(machineId: string, version: string) {
    return this.runAction(machineId, "claude", { claude: version });
  }

  /** Without `code` it starts and answers its sign-in URL; with the code that page showed, it ends and says how. */
  claudeLogin(machineId: string, code?: string) {
    return code === undefined ? this.runAction(machineId, "claude_login") : this.runAction(machineId, "claude_login_code", { code });
  }

  screens(machineId: string, screens: unknown) {
    return this.runAction(machineId, "screens", { screens });
  }

  /** `hold`; with `unhosted`, a node whose sessions carry on through its restart holds none (`NodeAction.unhosted`). */
  holdNode(machineId: string, unhosted = false) {
    return this.runAction(machineId, "hold", unhosted ? { unhosted: true } : {});
  }

  /**
   * The `cmd_check`s this hub process runs on the machine's node now (the train's checks and regenerations): its node's
   * restart cuts them off. One that ran across the hub's own restart has no waiter left, and its asker runs it again.
   */
  checksRunning(machineId: string): number {
    let n = 0;
    for (const p of this.pending.values()) if (p.machineId === machineId && p.reply === "cmd_result") n++;
    return n;
  }

  fetchUpdate(machineId: string, update: unknown) {
    return this.runAction(machineId, "fetch", { update });
  }

  /** `session_host` -> `session_host_result`: one of an agent's session calls, answered by the runner's node. */
  hostSession(
    machineId: string,
    input: { hostKey: unknown; frame: unknown; sealed?: string; project?: string },
    waitSec: number,
  ) {
    return this.request(machineId, { ...input, t: "session_host" }, { waitSec });
  }

  /** `mac_call` -> `mac_result`: one sealed step of an agent's for the agents' Mac. */
  macCall(machineId: string, caller: unknown, sealed: string, waitSec: number) {
    return this.request(machineId, { t: "mac_call", caller, sealed }, { waitSec });
  }

  /** `session_call` -> `session_reply`: `call` is the SessionCall (`{ op, … }`); the reply's `result` is `{ ok } | { err }`. */
  sessionCall(machineId: string, call: { op: string } & Record<string, unknown>, waitSec = SESSION_CALL_WAIT_SEC) {
    return this.request(machineId, { t: "session_call", call }, { waitSec });
  }
}

/** The Rust hub's wait for a request of this kind, in seconds. */
function defaultWait(frame: HubFrame): number {
  const t = frame.t as HubToNodeTag;
  switch (t) {
    case "cmd_check":
    case "gated_run":
    case "gated_resume": {
      const timeout = Number(frame.timeoutSec ?? (t === "cmd_check" ? DEFAULT_TIMEOUT_SEC : 0));
      return (Number.isFinite(timeout) ? timeout : 0) + REPLY_GRACE_SEC;
    }
    case "secret_deliver":
      return SECRET_REPLY_SEC;
    case "node_action":
      switch (frame.action) {
        case "claude":
          return CLAUDE_WAIT_SEC;
        case "claude_login":
        case "claude_login_code":
          return LOGIN_WAIT_SEC;
        case "update":
          return UPDATE_WAIT_SEC;
        default:
          return 30;
      }
    default:
      return SESSION_CALL_WAIT_SEC;
  }
}

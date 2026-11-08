// An agent's session tools, routed through the hub (crates/fleetd/src/node/session_route.rs, machine roles W46). A
// call for a session this node's broker has live goes straight to it. Every other call, `session_start` first, goes to
// the hub (`session_route`), which places the session: back here (the broker answers), or on another machine, whose
// answer comes back. A session placed elsewhere is driven through the hub's relay: this node's proxy pipes the agent's
// driver there, sealed with a relay key this node made and sealed to the runner (relay.ts).
//
// The other side: a session the hub placed on this machine for an agent elsewhere comes in as `session_host`, opened
// with this node's box key, and is answered by the broker under the key the hub gave it; `relay_dial` connects one of
// its channels to the session's own proxy here.
//
// TODO(bun): devices, desktops and the agents' Mac's screen (their starts and steps through the hub), 1Password fills
// of a session hosted elsewhere, a hosted session's secrets for scrubbing its recording.
import { seal } from "../../shared/sealed_box.ts";
import { ToolError } from "../../shared/errors.ts";
import type {
  BrowserCallFrame,
  BrowserResultFrame,
  RelayDialFrame,
  SessionHostFrame,
  SessionRouteResult,
} from "../../shared/screens_wire.ts";
import { type Broker, broker as brokerOf, drivesBrowser } from "../browser/index.ts";
import type { ThreadItem } from "../../shared/sessions.ts";
import { hubCall, type Node, onHub, toHub } from "../browser/node.ts";
import { hostOf, router as screens } from "../device/router.ts";
import { loadOrCreateBoxKey } from "../identity.ts";
import { dial, relayUrl } from "./relay.ts";

/** A step's output past this goes cut. */
const STEP_OUTPUT = 64 * 1024;

/** How long the node waits for the hub to place a session: past the hub's own wait for a runner's start. */
export const ROUTE_WAIT = 150_000;

/** What the agent's node seals to the machine that will host its session: its secrets and the relay's key. */
type Seal = { secrets: [string, string][]; relayKey: string };

const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");

/** A hosted session's relay key, by the key the hub gave it. */
type Hosted = Map<string, Uint8Array>;

export class Router {
  /** This node's agents' sessions hosted elsewhere: their relay on the hub and its key. */
  readonly remotes = new Map<string, { url: string; key: Uint8Array; sessionId?: string }>();
  readonly hosted: Hosted = new Map();
  /** A hosted start's secrets, to scrub its recording with: read once by the broker, then gone from here. */
  private readonly secretsFor = new Map<string, [string, string][]>();

  constructor(
    private readonly node: Node,
    private readonly broker: Broker,
    /** This node's X25519 box key, which the hub's runners' seals open with. */
    private readonly boxKey: { open(sealed: Uint8Array): Uint8Array | null },
  ) {}

  private hubUrl(): string {
    return String(this.node.config.hub ?? "");
  }

  /** One `session_route` call to the hub. */
  private async ask(thread: string, frame: BrowserCallFrame, sealed?: { runner: string; dataB64: string }): Promise<SessionRouteResult> {
    const call = { frame: { ...frame, threadId: thread }, host: hostOf(frame), ...(sealed ? { sealed } : {}) };
    const answer = await Promise.race([
      hubCall(this.node, "session_route", call, { threadId: thread, cwd: frame.cwd, waitMs: ROUTE_WAIT }),
      Bun.sleep(ROUTE_WAIT).then(() => {
        throw new ToolError("failed", "the hub did not place the session in time", "try again");
      }),
    ]);
    return answer as unknown as SessionRouteResult;
  }

  /** An agent's session call: here, or wherever the hub placed its session. */
  async route(thread: string, frame: BrowserCallFrame): Promise<Record<string, unknown>> {
    const op = frame.call.op;
    if (screens(this.node).live(thread)) return this.here(thread, frame);
    let routed = await this.ask(thread, frame);
    if (!routed.here && !routed.answer && routed.sealTo) {
      // Placed on another machine, which needs the session's relay key first: sealed to it. The Bun node holds no
      // session secrets to send with it yet (TODO above), so the runner scrubs nothing of its own.
      const relayKey = crypto.getRandomValues(new Uint8Array(32));
      const plain: Seal = { secrets: [], relayKey: b64(relayKey) };
      let data: string;
      try {
        data = b64(seal(Buffer.from(routed.sealTo, "base64"), new TextEncoder().encode(JSON.stringify(plain))));
      } catch (e) {
        throw new ToolError(
          "failed",
          `The node could not seal this session's secrets for ${routed.runner} (${(e as Error).message}).`,
          "try again; if it keeps failing, check the node's log",
        );
      }
      routed = await this.ask(thread, frame, { runner: routed.runner, dataB64: data });
      if (routed.relay) this.remotes.set(thread, { url: relayUrl(this.hubUrl(), routed.relay), key: relayKey });
    }
    if (routed.here) return this.here(thread, frame);
    if (op === "session_end") this.remotes.delete(thread);
    const answer = routed.answer;
    if (!answer) throw new ToolError("failed", "the hub placed the session but sent no answer", "try again");
    if (answer.error) throw new ToolError(answer.error.code, answer.error.message, answer.error.fix);
    const result = { ...(answer.result ?? {}) };
    // The agent's own address for it, as its AGENT_BROWSER_CDP names it: never the runner's.
    if (op === "session_start" && this.remotes.has(thread)) result.cdp = this.broker.proxy.url(thread);
    return result;
  }

  /** A call for a screen on this machine, of whichever kind (node/device's router); a hosted start's secrets with it. */
  private here(thread: string, frame: BrowserCallFrame): Promise<{ op: string } & Record<string, unknown>> {
    const secrets = this.secretsFor.get(thread);
    this.secretsFor.delete(thread);
    // A hosted browser's start: the broker scrubs its recording with them, read once there.
    if (secrets && frame.call.op === "session_start") this.broker.secretsFor(thread, secrets);
    return screens(this.node).handle(thread, frame);
  }

  /** The hub's `session_host`: a session call for one this machine hosts for an agent elsewhere, under `hostKey`. */
  async host(frame: SessionHostFrame): Promise<BrowserResultFrame> {
    const key = frame.hostKey;
    const id = frame.frame.id;
    const refuse = (message: string): BrowserResultFrame => ({ id, error: { code: "invalid", message } });
    const op = frame.frame.call.op;
    try {
      if (op === "session_start") {
        const plain = frame.sealed ? this.boxKey.open(Buffer.from(frame.sealed, "base64")) : null;
        let opened: Seal | undefined;
        try {
          opened = plain ? (JSON.parse(new TextDecoder().decode(plain)) as Seal) : undefined;
        } catch {
          opened = undefined;
        }
        if (!opened) {
          return refuse("this machine could not open the session's sealed secrets, so it hosts nothing it can't scrub");
        }
        const relayKey = Buffer.from(opened.relayKey, "base64");
        if (relayKey.length !== 32) return refuse("the session's sealed relay key is not 32 bytes");
        // TODO(bun): a person's screen on a project's kept profile (`navi`): the Bun broker keeps no profiles yet.
        this.hosted.set(key, relayKey);
        this.secretsFor.set(key, Array.isArray(opened.secrets) ? opened.secrets : []);
        try {
          return { id, result: await this.here(key, frame.frame) };
        } catch (e) {
          this.hosted.delete(key);
          throw e;
        }
      }
      const result = await this.here(key, frame.frame);
      if (op === "session_end") this.hosted.delete(key);
      return { id, result };
    } catch (e) {
      if (e instanceof ToolError) return { id, error: e.toJSON() };
      return { id, error: { code: "failed", message: (e as Error).message } };
    }
  }

  /**
   * A finished `agent-browser` command of the agent's whose session runs on another machine: sent to the runner for
   * its recording (`session_step`), its output cut short. TODO(bun): masked with the session's secrets first, as
   * session_route.rs `masked_step` does, once the Bun node holds them.
   */
  async step(thread: string, item: ThreadItem): Promise<void> {
    if (this.broker.live(thread) || !this.remotes.has(thread)) return;
    const kind = item.kind;
    if (kind.type !== "command" || !drivesBrowser(kind.command) || (item.status !== "completed" && item.status !== "failed")) return;
    const output = kind.output === undefined ? undefined : kind.output.slice(0, STEP_OUTPUT);
    const sent = { ...item, kind: { ...kind, ...(output === undefined ? {} : { output }) } };
    try {
      await hubCall(this.node, "session_step", { threadId: thread, item: sent }, { threadId: thread });
    } catch (e) {
      console.info(`session step not sent to its runner: ${(e as Error).message}`);
    }
  }

  /** The hub's `relay_dial`: one channel of a session hosted here, connected to its proxy. */
  dial(frame: RelayDialFrame): void {
    const key = this.hosted.get(frame.hostKey);
    if (!key || !this.broker.live(frame.hostKey)) return;
    void dial(this.hubUrl(), frame.token, this.broker.proxy.url(frame.hostKey), key);
  }
}

/** The node's router: `given` (a test's) when it is the first to ask, else the node's own. */
export const router = (node: Node, given?: Router) =>
  node.area("session_route", (n) => given ?? new Router(n, brokerOf(n), loadOrCreateBoxKey(n.home)));

/**
 * Wires routing into the node: agent-mcp's `session_start` and `session_end` go through it in place of the broker's
 * own, the hub's `session_host` and `relay_dial` come to it, and the proxy finds sessions hosted elsewhere by it.
 */
export function start(node: Node, given?: Router): Router {
  const r = router(node, given);
  const agentOnly = () => new ToolError("forbidden", "A browser session belongs to an agent's session, and this call comes from none.");
  for (const op of ["session_start", "session_end"]) {
    // The call's own working directory (its frame's `cwd`, the agent's worktree): a desktop launches its apps there.
    node.area("local").on(op, async (thread, frame) => {
      try {
        if (!thread) throw agentOnly();
        const cwd = typeof frame.cwd === "string" && frame.cwd.startsWith("/") ? frame.cwd : "/";
        return { result: await r.route(thread, { id: op, cwd, call: { ...((frame.call ?? {}) as Record<string, unknown>), op } }) };
      } catch (e) {
        if (e instanceof ToolError) return { error: e.toJSON() };
        return { error: { code: "failed", message: (e as Error).message } };
      }
    });
  }
  onHub(node, "session_host", (f) => {
    const frame = f as unknown as SessionHostFrame & { id: string };
    void r.host(frame).then((answer) => toHub(node, { t: "session_host_result", id: frame.id, frame: answer }));
  });
  onHub(node, "relay_dial", (f) => r.dial(f as unknown as RelayDialFrame));
  // A step of the agent's for the recording of a session hosted here, under the key the hub gave it.
  onHub(node, "session_step", (f) => void brokerOf(node).item(String(f.hostKey), f.item as ThreadItem));
  // And the other way: an agent's command that drove its session hosted elsewhere goes to the runner's recording.
  node.area("items").on((thread, item) => void r.step(thread, item));
  const b = brokerOf(node);
  b.remote = (thread) => r.remotes.get(thread);
  b.gone = (thread) => void r.remotes.delete(thread);
  return r;
}

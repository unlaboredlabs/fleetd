// An agent's session tools, routed through the hub (crates/fleetd/src/node/session_route.rs, machine roles W46). A
// call for a session this node's broker has live goes straight to it. Every other call, `session_start` first, goes to
// the hub (`session_route`), which places the session: back here (the broker answers), or on another machine, whose
// answer comes back. A session placed elsewhere is driven through the hub's relay: this node's proxy pipes the agent's
// driver there, sealed with a relay key this node made and sealed to the runner (relay.ts).
//
// Every kind goes this way. The agent's node seals the session's secrets to the runner with the relay key, so the
// runner scrubs its recording of them, and masks each step it sends there for that recording (`step`). The agents'
// Mac's screen (kind mac) is always the hub's to place, and sealed to the Mac with its relay key alone: the Mac's node
// is a tool every agent shares, so it gets none of the session's secrets. An Android screen the hub would place
// elsewhere is refused before anything is sealed: agent-device drives an emulator over adb, which crosses no machine.
//
// The other side: a session the hub placed on this machine for an agent elsewhere comes in as `session_host`, opened
// with this node's box key, and is answered by the screen's kind (node/device's router) under the key the hub gave
// it; `relay_dial` connects one of its channels to the session's own proxy here, and a `device` step (the hub's
// install of a PR's build into a person's Android screen) runs only sealed with the session's relay key, after the one
// before it (node/device/work.ts). What was sealed to this node for a session goes once it ends, however it ended.
//
// A `fill_credential` of a session hosted elsewhere is read here, with this machine's token, and only the value goes,
// sealed to the runner, which fills it under the same checks as a fill there (browser/credentials.ts).
import { seal } from "../../shared/sealed_box.ts";
import { ToolError } from "../../shared/errors.ts";
import {
  type BrowserCallFrame,
  type BrowserResultFrame,
  IOS_GONE,
  type RelayDialFrame,
  type SessionHostFrame,
  type SessionRouteResult,
} from "../../shared/screens_wire.ts";
import { TOKEN_ENV } from "../actions/onepassword.ts";
import type { SessionsArea } from "../api.ts";
import { Masker } from "../mask.ts";
import { type DeviceCall, type DeviceDone, isHostKey, openCall, sealDone } from "../device/work.ts";
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
/** A value the agent's node read from its 1Password for a `fill_credential` of a session hosted elsewhere, sealed to
 * the runner, which fills it into the item's own sites only. */
type Fill = { value: string; urls: string[] };

const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");

/**
 * What an agent's node sealed to this one for a session it hosts, by the key the hub gave it: the session's secrets,
 * kept only until its screen read them at its start; its relay key, until it ends; and the count of its last sealed
 * device step, which each must come after.
 */
type HostedSession = { relayKey: Uint8Array; secrets: [string, string][] | undefined; deviceCount: number };

export class Router {
  /** This node's agents' sessions hosted elsewhere: their relay on the hub and its key. */
  readonly remotes = new Map<string, { url: string; key: Uint8Array; sessionId?: string; runner?: string; sealTo?: string }>();
  readonly hosted = new Map<string, HostedSession>();

  constructor(
    private readonly node: Node,
    private readonly broker: Broker,
    /** This node's X25519 box key, which the hub's runners' seals open with. */
    private readonly boxKey: { open(sealed: Uint8Array): Uint8Array | null },
  ) {}

  private hubUrl(): string {
    return String(this.node.config.hub ?? "");
  }

  private sessions(): SessionsArea | undefined {
    try {
      return this.node.area("sessions");
    } catch {
      return undefined;
    }
  }

  /**
   * The secrets a screen of `thread`'s scrubs its recording of: for a session hosted here (a host key), what its
   * agent's node sealed to this one; else the node's own session's. Throws why they can't be read.
   */
  secretsOf(thread: string): [string, string][] {
    if (isHostKey(thread)) return this.hosted.get(thread)?.secrets ?? [];
    return this.sessions()?.secretsFor(thread) ?? [];
  }

  /** The masker for what this node's agent session sends elsewhere (session_route.rs `mask_for`). */
  private maskerOf(thread: string): Masker {
    return this.sessions()?.maskFor(thread) ?? new Masker();
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

  /**
   * The session's secrets (none for `relayOnly`, the agents' Mac) and a new relay key, sealed to `to` (the runner's
   * box key), base64. Never the 1Password token: the agent's node reads 1Password itself.
   */
  private sealFor(thread: string, to: string, runner: string, relayOnly: boolean): { data: string; relayKey: Uint8Array } {
    const relayKey = crypto.getRandomValues(new Uint8Array(32));
    try {
      const secrets = relayOnly ? [] : this.secretsOf(thread).filter(([name]) => name !== TOKEN_ENV);
      const plain: Seal = { secrets, relayKey: b64(relayKey) };
      return { data: b64(seal(Buffer.from(to, "base64"), new TextEncoder().encode(JSON.stringify(plain)))), relayKey };
    } catch (e) {
      throw new ToolError(
        "failed",
        `The node could not seal this session's secrets for ${runner} (${(e as Error).message}).`,
        "try again; if it keeps failing, check the node's log",
      );
    }
  }

  /** An agent's session call: here, or wherever the hub placed its session. */
  async route(thread: string, frame: BrowserCallFrame): Promise<Record<string, unknown>> {
    const op = frame.call.op;
    if (screens(this.node).live(thread)) return this.here(thread, frame);
    const host = hostOf(frame);
    // iOS simulators are the agents' Mac's (`mac sim`): the hub isn't asked.
    if (host === "ios") throw new ToolError("invalid", IOS_GONE, "mac --help says the rest; fleetd docs: The agents' Mac");
    // A lead's runs here, on its project's kept profile: another machine hasn't that profile.
    if (this.broker.staysHere(thread)) return this.here(thread, frame);
    // A fill of a session hosted elsewhere: read here, with this machine's token, and only the value goes, sealed.
    const remote = this.remotes.get(thread);
    const fill = op === "fill_credential" && remote?.runner && remote.sealTo ? await this.sealedFill(thread, String(frame.call.ref ?? ""), remote.runner, remote.sealTo) : undefined;
    let routed = await this.ask(thread, frame, fill);
    if (!routed.here && !routed.answer && routed.sealTo) {
      if (host === "android") throw androidElsewhere();
      // Placed on another machine, which needs the session's secrets and relay key first: sealed to it. The agents'
      // Mac gets the relay key alone.
      const relayOnly = host === "mac" || routed.relayOnly === true;
      const { data, relayKey } = this.sealFor(thread, routed.sealTo, routed.runner, relayOnly);
      const placed = { runner: routed.runner, sealTo: routed.sealTo };
      routed = await this.ask(thread, frame, { runner: placed.runner, dataB64: data });
      // The agent's driver reaches a browser or a desktop through the hub's relay, from this node's proxy; a Mac
      // screen is driven by its desktop actions alone.
      if (routed.relay && host !== "mac") this.remotes.set(thread, { url: relayUrl(this.hubUrl(), routed.relay), key: relayKey, ...placed });
    }
    if (routed.here) return this.here(thread, frame);
    if (op === "session_end") this.remotes.delete(thread);
    const answer = routed.answer;
    if (!answer) throw new ToolError("failed", "the hub placed the session but sent no answer", "try again");
    if (host === "android" && op === "session_start") {
      // Placed elsewhere and already started there (a hub that doesn't ask for a seal first): ended there.
      if (answer.result) {
        const end: BrowserCallFrame = { id: "device-elsewhere", cwd: frame.cwd, call: { op: "session_end" } };
        await this.ask(thread, end).catch(() => undefined);
      }
      if (!answer.error) throw androidElsewhere();
    }
    if (answer.error) throw new ToolError(answer.error.code, answer.error.message, answer.error.fix);
    const result = { ...(answer.result ?? {}) };
    // The agent's own address for it, as its AGENT_BROWSER_CDP names it: never the runner's.
    if (op === "session_start" && this.remotes.has(thread)) result.cdp = this.broker.proxy.url(thread);
    return result;
  }

  /** The agent's claude exited: its screens end now, not at their idle timeout, here or on the machine hosting one
   * (session_route.rs `ended`). */
  ended(thread: string): void {
    screens(this.node).ended(thread);
    if (!this.remotes.has(thread)) return;
    const end: BrowserCallFrame = { id: "ended", cwd: "/", call: { op: "session_end" } } as BrowserCallFrame;
    void this.route(thread, end).catch((e) => console.info(`hosted session not ended: ${(e as Error).message}`));
  }

  /** A `fill_credential` of a session hosted on `runner`: the reference read from this machine's 1Password and the value
   * sealed to the runner alone. The value is masked in this agent's reports from now on, as a fill here is. */
  private async sealedFill(thread: string, reference: string, runner: string, sealTo: string): Promise<{ runner: string; dataB64: string }> {
    const credential = await this.broker.resolveCredential(thread, reference);
    const plain = new TextEncoder().encode(JSON.stringify({ value: credential.value, urls: credential.urls } satisfies Fill));
    let data: string;
    try {
      data = b64(seal(Buffer.from(sealTo, "base64"), plain));
    } catch (e) {
      throw new ToolError("failed", `the fill was not sealed to its runner: ${(e as Error).message}`);
    } finally {
      plain.fill(0);
    }
    this.broker.credentials.filled(thread, reference, credential.value);
    return { runner, dataB64: data };
  }

  /** A call for a screen on this machine, of whichever kind (node/device's router); a browser's start with the
   * secrets its recording scrubs (a desktop's and an Android's read them through `secretsOf` at their start). */
  private here(thread: string, frame: BrowserCallFrame): Promise<{ op: string } & Record<string, unknown>> {
    const call = frame.call;
    if (call.op === "session_start" && (call.kind === undefined || call.kind === "browser")) {
      let secrets: [string, string][];
      try {
        secrets = this.secretsOf(thread);
      } catch (e) {
        throw new ToolError(
          "failed",
          `The node could not read this session's secrets to scrub its recording (${(e as Error).message}).`,
          "try again; if it keeps failing, check the node's log",
        );
      }
      this.broker.secretsFor(thread, secrets);
    }
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
        // Only the hub's own word opens a project's profile (a person's screen_open, D239): never anything sealed, which
        // any node can make for any runner.
        if (frame.navi !== undefined) {
          const kind = frame.frame.call.kind;
          const known = this.broker.sessionsArea()?.hasProject?.(frame.navi) ?? false;
          if ((kind !== undefined && kind !== "browser") || !known) return refuse(`this machine has no project ${frame.navi} with a browser to open`);
          this.broker.personScreen(key, frame.navi);
        }
        const secrets = (Array.isArray(opened.secrets) ? opened.secrets : [])
          .filter((pair) => Array.isArray(pair) && pair.length === 2)
          .map(([name, value]) => [String(name), String(value)] as [string, string]);
        const hosted: HostedSession = { relayKey, secrets, deviceCount: 0 };
        this.hosted.set(key, hosted);
        try {
          const result = await this.here(key, frame.frame);
          // Its screen read them at the start: they leave this node's memory now.
          hosted.secrets = undefined;
          return { id, result };
        } catch (e) {
          this.hosted.delete(key);
          this.broker.notNavi(key);
          throw e;
        }
      }
      if (op === "device") return await this.device(key, frame.frame);
      // A fill comes with the value the agent's node read, sealed to this node: filled under the same checks as a fill
      // here (the item's own sites, reads sealed after it).
      if (op === "fill_credential" && frame.sealed) {
        const plain = this.boxKey.open(Buffer.from(frame.sealed, "base64"));
        let given: Fill | undefined;
        try {
          given = plain ? (JSON.parse(new TextDecoder().decode(plain)) as Fill) : undefined;
        } catch {}
        plain?.fill(0);
        if (!given || typeof given.value !== "string" || !Array.isArray(given.urls)) return refuse("the fill's sealed value did not open on this machine");
        return { id, result: await this.broker.call(key, frame.frame, given) };
      }
      const result = await this.here(key, frame.frame);
      if (op === "session_end") {
        this.hosted.delete(key);
        this.broker.notNavi(key);
      }
      return { id, result };
    } catch (e) {
      if (op === "session_end") this.hosted.delete(key);
      if (e instanceof ToolError) return { id, error: e.toJSON() };
      return { id, error: { code: "failed", message: (e as Error).message } };
    }
  }

  /**
   * A device step for a screen hosted here: run only sealed by whoever started it (the agent's node, or the hub for a
   * person's screen), after its last, never one the hub made up or played again. Its answer goes back sealed.
   */
  private async device(key: string, frame: BrowserCallFrame): Promise<BrowserResultFrame> {
    const call = frame.call as unknown as DeviceCall;
    const hosted = this.hosted.get(key);
    if (call.step !== "sealed") return { id: frame.id, error: { code: "invalid", message: "device steps come sealed by the agent's node" } };
    const count = Number(call.count);
    const opened = hosted && Number.isSafeInteger(count) && count > hosted.deviceCount ? openCall(hosted.relayKey, count, String(call.dataB64)) : undefined;
    if (!hosted || !opened) {
      return { id: frame.id, error: { code: "invalid", message: "the device step did not open with this session's key, or came again" } };
    }
    hosted.deviceCount = count;
    const { op: _, ...done } = await this.here(key, { ...frame, call: { op: "device", ...opened } });
    return { id: frame.id, result: { op: "device", ...sealDone(hosted.relayKey, count, done as unknown as DeviceDone) } };
  }

  /**
   * A finished command of the agent's that drove its session on another machine: sent to the runner for its
   * recording (`session_step`), its output cut short and the session's secrets masked first. One whose secrets can't
   * be read never leaves unmasked.
   */
  async step(thread: string, item: ThreadItem): Promise<void> {
    if (this.broker.live(thread) || !this.remotes.has(thread)) return;
    const kind = item.kind;
    if (kind.type !== "command" || !drivesBrowser(kind.command) || (item.status !== "completed" && item.status !== "failed")) return;
    const output = kind.output === undefined ? undefined : cut(kind.output, STEP_OUTPUT);
    let sent: ThreadItem;
    try {
      sent = this.maskerOf(thread).value({ ...item, kind: { ...kind, ...(output === undefined ? {} : { output }) } });
    } catch (e) {
      console.info(`session step not sent to its runner: its secrets weren't read (${(e as Error).message})`);
      return;
    }
    try {
      await hubCall(this.node, "session_step", { threadId: thread, item: sent }, { threadId: thread });
    } catch (e) {
      console.info(`session step not sent to its runner: ${(e as Error).message}`);
    }
  }

  /** The hub's `relay_dial`: one channel of a session hosted here, connected to its proxy. */
  dial(frame: RelayDialFrame): void {
    const hosted = this.hosted.get(frame.hostKey);
    if (!hosted || !this.broker.live(frame.hostKey)) return;
    void dial(this.hubUrl(), frame.token, this.broker.proxy.url(frame.hostKey), hosted.relayKey);
  }

  /** A hosted session's end, as its screen reported it to the hub (its agent, idle, a person, the app): what was
   * sealed to this node for it goes, its relay key with it. */
  reported(thread: string, state: unknown): void {
    if (state !== "live" && isHostKey(thread)) this.hosted.delete(thread);
  }
}

/** The refusal of an Android screen the hub would place on another machine. */
const androidElsewhere = () =>
  new ToolError(
    "failed",
    "The hub placed this Android session on another machine, and agent-device can't drive an emulator there from here yet.",
    "say so in your result: Android sessions run only on the agent's own machine for now",
  );

/** `text` cut to at most `max` UTF-8 bytes, on a character's boundary. */
function cut(text: string, max: number): string {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length <= max) return text;
  let end = max;
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end--;
  return bytes.subarray(0, end).toString("utf8");
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
  // The browser calls beyond a start and an end route the same way: here when the session is here, else to its runner.
  for (const op of ["session_start", "session_end", "fill_credential", "purchase_request", "purchase_fill", "request_secure_input", "secure_input_fill"]) {
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
  // The agent's claude exited: its screens go with it.
  node.area("launch").contribute({ ended: (thread) => r.ended(thread) });
  const b = brokerOf(node);
  b.remote = (thread) => r.remotes.get(thread);
  b.gone = (thread) => void r.remotes.delete(thread);
  // However a hosted session ends here, its report of it makes this node forget what was sealed to it for it.
  const link = node.area("link");
  const leadCall = link.leadCall.bind(link);
  link.leadCall = (op, args, opts) => {
    if (op === "browser_session") r.reported(String(args.threadId ?? opts?.threadId ?? ""), args.state);
    return leadCall(op, args, opts);
  };
  return r;
}

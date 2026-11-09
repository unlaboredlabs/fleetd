// One node link per machine (crates/fleetd/src/hub/link/server.rs): challenge, hello (signature, enroll token or
// enrolled key), welcome, then heartbeats, session frames, lead calls and command replies until the socket ends. 45 s
// of silence takes the machine offline: no frame and, where the kernel's count can be read (../http/counted.ts), no
// byte. A linked machine is online while its node's runner is usable (`runner_info`: a supported version, logged in)
// and degraded with the runner's problem otherwise.
//
// `hub.area("link")` is the seam other areas use: `on(tag, fn)` for node frames, `send`/`request` for hub frames,
// `can(machineId, cap)` for what the node's hello listed, `linkId`, and `onLinked`/`onUnlinked`.
import { createPublicKey, verify } from "node:crypto";
import { hostname } from "node:os";
import { NODE_TO_HUB, type NodeToHubTag } from "../../gen/wire.ts";
import { type HubEvent, type Machine, type MachineStatus, PROTOCOL_VERSION } from "../../shared/contracts.ts";
import type { Hub } from "../api/hub.ts";
import { isoMs } from "../auth/index.ts";
import { Unauthorized } from "../auth/nodes.ts";
import { type Peer, ReadCounts } from "../http/counted.ts";
import type { Socket, SocketHandler } from "../http/route.ts";
import { onLeadCallFrame } from "../lead_calls/index.ts";
import type { LeadCallFrame } from "../lead_calls/types.ts";
import { events, type NewEvent } from "../store/events.ts";
import { store } from "../store/hub_store.ts";
import { NodeCommandError, NodeCommands, type RequestOptions } from "./commands.ts";
import { Deflater, Inflater, MIN_DEFLATE_BYTES } from "./deflate.ts";
import { type NodeSessions, type NodeToHubSession, READ_TIMEOUT_MS } from "../executor/index.ts";
import { executorsOf, SESSION_FRAMES } from "./executor.ts";
import { BadFrames, FrameError, undecodable } from "./frames.ts";
import { problem as networkProblemOf } from "./network.ts";
import { brake, brakeText } from "../usage/state.ts";
import { pausedText, why as guardWhy } from "./guard.ts";
import {
  CAP_AGENTS_MAC,
  CAP_LINK_DEFLATE,
  CLOSE,
  closeReason,
  HEARTBEAT_INTERVAL_SECS,
  HEARTBEAT_TIMEOUT_SECS,
  HUB_CAP_LINK_DEFLATE,
  HUB_CAP_SESSION_ROUTE,
  type HubFrame,
  type NodeBusy,
  type NodeFrame,
  type NodeHello,
  type NodeLoad,
  protocolBehind,
  REPLY_OF,
  REPLY_TAGS,
  type RequestTag,
} from "../../shared/node_link.ts";

export const HELLO_TIMEOUT_MS = 10_000;
/** How many heartbeats apart the hub re-reads the runner's state, so a fixed or expired login shows within a minute. */
const RUNNER_CHECK_EVERY = 4;
/**
 * How long a link may keep heartbeating while its executor isn't live before the hub attaches its sessions again:
 * otherwise a subscription lost on a healthy link leaves the machine offline until its node restarts.
 */
export const REATTACH_AFTER_MS = 30_000;
/** How often bytes still arriving on a link, in a frame not yet whole, count as a sighting (`progress`). */
export const PROGRESS_EVERY_MS = 5000;
/** The most one compressed node frame may inflate to: the socket's own message cap, a put_file's 64 MiB. */
const MAX_INFLATED = 64 << 20;
const NODE_TAGS: ReadonlySet<string> = new Set(NODE_TO_HUB);

/** A node frame's handler: the machine it came from and the frame. Never awaited: the link's frame loop goes on. */
export type FrameHandler<T extends NodeToHubTag = NodeToHubTag> = (machineId: string, frame: NodeFrame<T>) => unknown;

/** A welcomed link, as `onLinked` hears of it. */
export type Linked = { machineId: string; linkId: number; hello: NodeHello };

export type Timings = { heartbeatMs: number; silenceMs: number; helloMs: number; progressMs: number };

type Announced = "online" | "degraded";

/** Why a machine takes no new agents: its line, and which of the guard and the usage brake holds it. */
type Paused = { text: string; guard: boolean; brake: boolean };

/** One socket's link, from its challenge to its end. */
type LinkSocket = {
  nonce: string;
  phase: "hello" | "linked" | "closed";
  machineId?: string;
  id?: number;
  helloTimer?: Timer;
  heartbeat?: Timer;
  /** Who dialed, from the upgrade: what its connection read is counted by it (`progress`). */
  peer?: Peer;
  /** What its connection had read at the last `progress`. */
  read?: number;
  beats: number;
  /** The link's executor sender, once welcomed: `reattachIfDark` subscribes on it again. */
  sessions?: NodeSessions;
  /** When this link's heartbeats first found its executor not live. */
  darkSince?: number;
  inflater?: Inflater;
  deflater?: Deflater;
  /** This link's frames that didn't decode, per minute. */
  badFrames: BadFrames;
  /** Frames in, one at a time in order (an inflate is async). */
  inbox: Promise<void>;
  /** Frames out, in order, once compression is on. */
  outbox: Promise<void>;
  detach?: () => void;
};

/** Raw 32-byte ed25519 public key (base64) verifying `sig` (base64) over the nonce's UTF-8 bytes. */
export function verifyNonceSignature(pubKey: string, nonce: string, sig: string): boolean {
  try {
    const raw = Buffer.from(pubKey, "base64");
    const signature = Buffer.from(sig, "base64");
    if (raw.length !== 32 || signature.length !== 64) return false;
    const spki = Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), raw]);
    const key = createPublicKey({ key: spki, format: "der", type: "spki" });
    return verify(null, Buffer.from(nonce), key, signature);
  } catch {
    return false;
  }
}

const nonce = () => Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");

/** `fleetd-<hostname>`, the name the hub gives itself in its welcome. */
export function hubId(): string {
  const host = hostname().trim();
  return `fleetd-${host === "" ? "localhost" : host}`;
}

/** `model::duration_text`: "45s", "10m46s", "2h05m". */
export function durationText(ms: number): string {
  const s = Math.floor(Math.max(0, ms) / 1000);
  const pad = (n: number) => String(n).padStart(2, "0");
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m${pad(s % 60)}s`;
  return `${Math.floor(s / 3600)}h${pad(Math.floor((s % 3600) / 60))}m`;
}

/** `executor::providers::runner_problem`: None while logged in, else the runner's own problem or "not logged in". */
export function runnerProblem(info: { login?: string; problem?: string }): string | undefined {
  if (info.login === "logged_in") return undefined;
  return info.problem ?? "claude is not logged in on this machine";
}

class Refused extends Error {
  constructor(
    readonly code: number,
    readonly reason: string,
  ) {
    super(reason);
  }
}

/** A hello, checked for the fields NodeHello requires. */
function readHello(frame: Record<string, unknown>): NodeHello | undefined {
  const str = (v: unknown) => typeof v === "string";
  const optional = (v: unknown) => v === undefined || v === null || typeof v === "string";
  if (
    !str(frame.machineId) ||
    !/^[a-z0-9-]{1,32}$/.test(frame.machineId as string) ||
    !str(frame.name) ||
    !str(frame.nodeVersion) ||
    typeof frame.protocol !== "number" ||
    !str(frame.pubKey) ||
    frame.pubKey === "" ||
    !str(frame.sig) ||
    frame.sig === "" ||
    !optional(frame.enrollToken) ||
    !optional(frame.boxPubKey) ||
    !optional(frame.machineFingerprint) ||
    (frame.capabilities !== undefined && !(Array.isArray(frame.capabilities) && frame.capabilities.every(str)))
  ) {
    return undefined;
  }
  return frame as unknown as NodeHello;
}

/** The hub's node links: `link(hub)` names it. */
export const link = (hub: Hub) => hub.area("link", (h) => new Link(h));

export class Link {
  readonly commands = new NodeCommands();
  timings: Timings = {
    heartbeatMs: HEARTBEAT_INTERVAL_SECS * 1000,
    silenceMs: HEARTBEAT_TIMEOUT_SECS * 1000,
    helloMs: HELLO_TIMEOUT_MS,
    progressMs: PROGRESS_EVERY_MS,
  };
  /** What each link's connection read so far; tests put a fake in. */
  readCounts = new ReadCounts();
  readonly hubId = hubId();
  /** The live link per machine; a newer link replaces an older one. */
  private readonly links = new Map<string, { id: number; ws: Socket; state: LinkSocket }>();
  /** What this hub process last announced per machine, until it announces the machine offline. */
  private readonly announced = new Map<string, Announced>();
  /** Per-machine silence timers. They outlive the socket, so a quick reconnect never flaps. */
  private readonly watchdogs = new Map<string, Timer>();
  /** Reads the live links' byte counts while there are links (`progress`). */
  private progressTimer: Timer | undefined;
  private sampling = false;
  private nextLinkId = 0;
  private readonly loads = new Map<string, NodeLoad>();
  private readonly busyBy = new Map<string, NodeBusy>();
  private readonly pausedBy = new Map<string, Paused>();
  /** What each live link's node said it understands in its hello. */
  private readonly capabilities = new Map<string, Set<string>>();
  private readonly handlers = new Map<string, Set<FrameHandler>>();
  private readonly linkedHooks = new Set<(linked: Linked) => void>();
  private readonly unlinkedHooks = new Set<(machineId: string, linkId: number) => void>();
  private readonly readyHooks = new Set<(machineId: string, ready: boolean) => void>();
  private readonly readyBy = new Map<string, boolean>();
  /** The runner's problem as its link's last check found it (undefined: usable); absent until that check answers. */
  private readonly runnerBy = new Map<string, string | undefined>();
  /** Machines git can't reach GitHub from, as the landing scanner last found. */
  private readonly githubDown = new Set<string>();
  /** The socket handler `GET /node/link` upgrades to. */
  readonly socket: SocketHandler;
  /** Lead calls being answered now, across every link: the hub's stop waits for them (`stop`). */
  private calls = 0;
  private readonly callsDone = new Set<() => void>();
  /** The hub is stopping: lead calls that come in now aren't run, and say so. */
  private stopping = false;

  constructor(private readonly hub: Hub) {
    this.socket = {
      open: (ws) => this.open(ws),
      message: (ws, message) => this.message(ws, message),
      close: (ws) => this.closed(ws),
    };
    hub.shutdown.signal.addEventListener("abort", () => {
      for (const timer of this.watchdogs.values()) clearTimeout(timer);
      this.watchdogs.clear();
      clearInterval(this.progressTimer);
      this.progressTimer = undefined;
    });
  }

  // ---- The seam (D346).

  /**
   * The hub stops (SIGTERM): lead calls that come in from now on are answered as not run, the ones being answered get
   * up to `waitMs` to finish and send their answers, and then every link closes with `CLOSE.RESTART`, so each node
   * redials at once rather than find its socket reset.
   */
  async stop(waitMs: number): Promise<void> {
    this.stopping = true;
    if (this.calls > 0) {
      let done: () => void = () => {};
      const finished = new Promise<void>((resolve) => this.callsDone.add((done = resolve)));
      let timer: Timer | undefined;
      await Promise.race([finished, new Promise<void>((resolve) => (timer = setTimeout(resolve, waitMs)))]);
      clearTimeout(timer);
      this.callsDone.delete(done);
    }
    for (const live of [...this.links.values()]) this.close(live.ws, live.state, CLOSE.RESTART, "hub restarting");
  }

  /** One lead call being answered, counted until its `end`; undefined once the hub is stopping. */
  callStarted(): { end(): void } | undefined {
    if (this.stopping) return undefined;
    this.calls++;
    let ended = false;
    return {
      end: () => {
        if (ended) return;
        ended = true;
        if (--this.calls === 0) for (const done of [...this.callsDone]) done();
      },
    };
  }

  /** Calls `fn(machineId, frame)` for each frame tagged `tag` from any node; returns the unsubscribe. */
  on<T extends NodeToHubTag>(tag: T, fn: FrameHandler<T>): () => void {
    let set = this.handlers.get(tag);
    if (!set) this.handlers.set(tag, (set = new Set()));
    set.add(fn as FrameHandler);
    return () => set.delete(fn as FrameHandler);
  }

  /** Sends `frame` to the machine's live node; false when it has none. */
  send(machineId: string, frame: HubFrame): boolean {
    const live = this.links.get(machineId);
    if (!live) return false;
    return this.write(live.ws, live.state, frame);
  }

  /**
   * Sends a request frame (`cmd_check`, `node_action`, `session_call`, `secret_deliver`, `gated_run`,
   * `gated_resume`, `session_host`, `mac_call`; its `id` is set here) and resolves with the matching reply by id.
   * Rejects with a NodeCommandError: `offline`, `lost` when the link drops first, `no_reply` past the wait.
   */
  request<T extends RequestTag>(machineId: string, frame: HubFrame<T>, options?: RequestOptions) {
    return this.commands.request(machineId, frame, options);
  }

  /** Whether the machine's live node listed `cap` in its hello. */
  can(machineId: string, cap: string): boolean {
    return this.capabilities.get(machineId)?.has(cap) ?? false;
  }

  /** Whether the machine's node is linked and doesn't list `cap`: a node too old for it. */
  lacks(machineId: string, cap: string): boolean {
    const caps = this.capabilities.get(machineId);
    return caps !== undefined && !caps.has(cap);
  }

  /** The machine's live link, by its id: a new one each time its node links. */
  linkId(machineId: string): number | undefined {
    return this.links.get(machineId)?.id;
  }

  /** Called after each welcome, once commands and requests reach the node. Returns the unsubscribe. */
  onLinked(fn: (linked: Linked) => void): () => void {
    this.linkedHooks.add(fn);
    return () => this.linkedHooks.delete(fn);
  }

  /** Called when a machine's link `linkId` ends or goes silent. Returns the unsubscribe. */
  onUnlinked(fn: (machineId: string, linkId: number) => void): () => void {
    this.unlinkedHooks.add(fn);
    return () => this.unlinkedHooks.delete(fn);
  }

  /** Whether the machine is linked and announced online: what an offline queue waits for. */
  ready(machineId: string): boolean {
    return this.links.has(machineId) && this.readyBy.get(machineId) === true;
  }

  /** Called when a machine's readiness changes (`set_runner_ready`). */
  onReady(fn: (machineId: string, ready: boolean) => void): () => void {
    this.readyHooks.add(fn);
    return () => this.readyHooks.delete(fn);
  }

  /** The load the machine's node last reported; undefined from older nodes and offline machines. */
  load(machineId: string): NodeLoad | undefined {
    return this.loads.get(machineId);
  }

  /** What keeps the machine busy, as its node's latest heartbeat said. */
  busy(machineId: string): NodeBusy | undefined {
    return this.busyBy.get(machineId);
  }

  /** Why new agents wait on the machine, e.g. "Paused new agents: 14 GB free on builder-1". */
  paused(machineId: string): string | undefined {
    return this.pausedBy.get(machineId)?.text;
  }

  /**
   * Why the machine is degraded for its network ("no IPv4 network on enp3s0, …"), with the fix; undefined while it
   * has IPv4 or GitHub answers it.
   */
  networkProblem(machineId: string): string | undefined {
    return networkProblemOf(this.loads.get(machineId)?.network, this.githubDown.has(machineId));
  }

  /**
   * What the landing scanner found of git on the machine reaching GitHub: with no IPv4 there too, the machine is
   * degraded until either is back.
   */
  githubReached(machineId: string, reached: boolean): void {
    const before = this.networkProblem(machineId);
    if (reached) this.githubDown.delete(machineId);
    else this.githubDown.add(machineId);
    if (this.networkProblem(machineId) !== before) this.settle(machineId);
  }

  /** Whether the machine is a Mac, as its node last said what it can host. False before its first heartbeat. */
  isMac(machineId: string): boolean {
    const hosts = this.loads.get(machineId)?.hosts;
    return (hosts ?? []).some(
      (h) => (h.host === "mac" || h.host === "ios") && (h.ready || (h.off !== undefined && h.off !== "unsupported")),
    );
  }

  /** What the machine can host, as its node answered a change of its screen settings: kept until its next heartbeat. */
  setHosts(machineId: string, hosts: NodeLoad["hosts"]): void {
    const load = this.loads.get(machineId);
    if (load) load.hosts = hosts;
  }

  // ---- Loops.

  /**
   * Arms the silence timer for every machine the store says is not offline: after a hub restart the store still
   * says online for machines whose nodes may never come back, and only a link arms the timer.
   */
  start(): void {
    try {
      for (const m of store(this.hub).machinesList()) if (m.status !== "offline") this.touch(m.machineId);
    } catch (error) {
      console.error("node link: could not list machines:", error);
    }
  }

  // ---- Internals.

  private nowIso(): string {
    return isoMs(this.hub.clock.now());
  }

  private append(type: string, machineId: string, summary: string, data?: unknown, attention?: string): HubEvent | undefined {
    const event = { at: this.nowIso(), type, machineId, summary } as Record<string, unknown>;
    if (data !== undefined) event.data = data;
    if (attention !== undefined) event.attention = attention;
    try {
      return events(this.hub).append(event as NewEvent);
    } catch (error) {
      console.error(`node link: event append failed (${type}):`, error);
      return undefined;
    }
  }

  private write(ws: Socket, state: LinkSocket, frame: HubFrame | Record<string, unknown>): boolean {
    if (state.phase === "closed") return false;
    const text = JSON.stringify(frame);
    const deflater = state.deflater;
    if (!deflater) return ws.send(text) >= 0;
    // Once compressed, every frame goes through the queue, so a short Text one never overtakes a deflating one.
    state.outbox = state.outbox.then(async () => {
      if (state.phase === "closed") return;
      if (text.length < MIN_DEFLATE_BYTES) ws.send(text);
      else ws.send(await deflater.deflate(text));
    });
    return true;
  }

  private close(ws: Socket, state: LinkSocket, code: number, reason: string): void {
    if (state.phase === "closed") return;
    // What waits to go out goes first, then the close.
    void state.outbox.then(() => ws.close(code, closeReason(reason)));
    if (code !== 0) console.info(`node link: refused code=${code} reason=${reason}`);
  }

  private open(ws: Socket): void {
    // `nodeLink` hands the upgrade's peer over in the socket's state.
    const peer = (ws.data.state as { peer?: Peer } | undefined)?.peer;
    const state: LinkSocket = {
      ...(peer ? { peer } : {}),
      nonce: nonce(),
      phase: "hello",
      beats: 0,
      badFrames: new BadFrames(),
      inbox: Promise.resolve(),
      outbox: Promise.resolve(),
    };
    ws.data.state = state;
    this.write(ws, state, { t: "challenge", nonce: state.nonce });
    state.helloTimer = setTimeout(
      () => this.close(ws, state, CLOSE.BAD_FRAME, `no hello within ${Math.floor(this.timings.helloMs / 1000)} s`),
      this.timings.helloMs,
    );
  }

  private message(ws: Socket, message: string | Buffer): void {
    const state = ws.data.state as LinkSocket;
    if (state.phase === "closed") return;
    const inflater = state.inflater;
    if (typeof message === "string" || !inflater) {
      const text = typeof message === "string" ? message : message.toString("utf8");
      // In order: behind any frame still inflating.
      state.inbox = state.inbox.then(() => this.frame(ws, state, text));
      return;
    }
    const inflated = inflater.inflate(message);
    state.inbox = state.inbox.then(async () => {
      let text: string;
      try {
        text = await inflated;
      } catch (error) {
        return this.close(ws, state, CLOSE.BAD_FRAME, (error as Error).message);
      }
      return this.frame(ws, state, text);
    });
  }

  private frame(ws: Socket, state: LinkSocket, text: string): void | Promise<void> {
    if (state.phase === "closed") return;
    try {
      if (state.phase === "hello") return this.hello(ws, state, text);
      this.linkedFrame(ws, state, text);
    } catch (error) {
      if (error instanceof Refused) return this.close(ws, state, error.code, error.reason);
      console.error("node link: frame failed:", error);
    }
  }

  /** The handshake: hello checked against the challenge, then the machine written and welcomed. */
  private hello(ws: Socket, state: LinkSocket, text: string): void {
    clearTimeout(state.helloTimer);
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Refused(CLOSE.BAD_FRAME, "expected a hello frame");
    }
    const raw = parsed as Record<string, unknown> | null;
    const hello = raw && typeof raw === "object" && raw.t === "hello" ? readHello(raw) : undefined;
    if (!hello) throw new Refused(CLOSE.BAD_FRAME, "expected a hello frame");
    if (hello.protocol !== PROTOCOL_VERSION) {
      throw new Refused(CLOSE.PROTOCOL_MISMATCH, protocolBehind(PROTOCOL_VERSION, hello.protocol));
    }
    this.authenticate(state, hello);
    this.welcome(ws, state, hello);
  }

  private authenticate(state: LinkSocket, hello: NodeHello): void {
    const { machineId } = hello;
    const nodes = this.hub.auth.nodes;
    // Checked before the token, so a bad signature cannot burn someone's enroll token.
    if (!verifyNonceSignature(hello.pubKey, state.nonce, hello.sig)) {
      throw new Refused(CLOSE.UNAUTHORIZED, "signature does not verify against the hello's key");
    }
    const fingerprint = hello.machineFingerprint ?? undefined;
    if (hello.enrollToken) {
      try {
        nodes.enrollNode(hello.enrollToken, machineId, hello.pubKey, fingerprint);
        return;
      } catch (error) {
        if (error instanceof Unauthorized) throw new Refused(CLOSE.UNAUTHORIZED, error.reason());
        console.error("node link: enroll token check failed:", error);
        throw new Refused(CLOSE.UNAUTHORIZED, "the hub could not check the enroll token");
      }
    }
    let key: string | undefined;
    try {
      key = nodes.nodePubKey(machineId);
    } catch (error) {
      console.error("node link: node key read failed:", error);
      throw new Refused(CLOSE.UNAUTHORIZED, "the hub could not read the enrolled key");
    }
    if (key === undefined) {
      throw new Refused(CLOSE.UNAUTHORIZED, `${machineId} is not enrolled: run fleetd pair --worker ${machineId} on the hub`);
    }
    if (key !== hello.pubKey) throw new Refused(CLOSE.UNAUTHORIZED, `key does not match the key enrolled for ${machineId}`);
    // A node enrolled before fingerprints: its first hello since records its computer.
    if (fingerprint !== undefined && nodes.nodeFingerprint(machineId) === undefined) {
      try {
        nodes.setNodeFingerprint(machineId, fingerprint);
      } catch (error) {
        console.warn(`node link: could not record ${machineId}'s fingerprint:`, error);
      }
    }
  }

  private welcome(ws: Socket, state: LinkSocket, hello: NodeHello): void {
    const { machineId } = hello;
    const caps = hello.capabilities ?? [];
    const id = ++this.nextLinkId;
    this.capabilities.set(machineId, new Set(caps));
    // Until this link's runner check answers.
    this.runnerBy.delete(machineId);
    const previous = this.links.get(machineId);
    this.links.set(machineId, { id, ws, state });
    state.phase = "linked";
    state.machineId = machineId;
    state.id = id;
    if (previous) this.close(previous.ws, previous.state, CLOSE.REPLACED, "a newer link for this machine took over");

    const agentsMac = caps.includes(CAP_AGENTS_MAC);
    let cloud = false;
    try {
      cloud = this.hub.auth.nodes.isPool(machineId);
    } catch {}
    const hubStore = store(this.hub);
    let lastSlept: Machine["lastSlept"];
    try {
      lastSlept = hubStore.machineGet(machineId)?.lastSlept;
    } catch {}
    // Keys in the Rust struct's order, absent ones left out, so rows read the same.
    const machine: Record<string, unknown> = {
      machineId,
      name: hello.name,
      tags: [],
      // Until the runner check answers.
      status: "degraded",
      lastSeenAt: this.nowIso(),
      nodeVersion: hello.nodeVersion,
      degradedReason: "checking the node's runner",
    };
    // Browsers seal this machine's secrets to it; a node from before M8 sends none and takes none.
    if (hello.boxPubKey) machine.boxPubKey = hello.boxPubKey;
    if (lastSlept) machine.lastSlept = lastSlept;
    if (agentsMac) machine.agentsMac = true;
    if (cloud) machine.cloud = true;
    try {
      hubStore.machineUpsert(machine as Machine);
    } catch (error) {
      console.error("node link: machine write failed:", error);
    }
    if (this.announced.has(machineId)) {
      this.append("machine.linked", machineId, `${machineId}'s node linked again, on fleetd ${hello.nodeVersion}`, {
        nodeVersion: hello.nodeVersion,
      });
    }
    this.touch(machineId);
    this.write(ws, state, {
      t: "welcome",
      hubId: this.hubId,
      protocol: PROTOCOL_VERSION,
      capabilities: [HUB_CAP_SESSION_ROUTE, HUB_CAP_LINK_DEFLATE],
    });
    // Compressed both ways from here on, for a node that asked.
    if (caps.includes(CAP_LINK_DEFLATE)) {
      state.deflater = new Deflater();
      state.inflater = new Inflater(MAX_INFLATED);
    }
    state.detach = this.commands.attach(machineId, id, (frame) => this.write(ws, state, frame));
    state.sessions = { linkId: id, send: (frame) => this.write(ws, state, frame) };
    try {
      executorsOf(this.hub).attach(machineId, state.sessions);
    } catch (error) {
      console.error("node link: the executor did not take the link:", error);
    }
    state.heartbeat = setInterval(() => this.write(ws, state, { t: "hb", at: this.nowIso() }), this.timings.heartbeatMs);
    this.progressTimer ??= setInterval(() => void this.progress(), this.timings.progressMs);
    // After the attach, so whoever acts on it can already run commands there.
    for (const hook of this.linkedHooks) {
      try {
        hook({ machineId, linkId: id, hello });
      } catch (error) {
        console.error("node link: onLinked hook failed:", error);
      }
    }
    this.checkRunner(machineId);
    console.info(`node link: welcomed machine_id=${machineId} link_id=${id}`);
  }

  /**
   * One frame after the welcome. A frame that doesn't decode is refused alone: logged by its tag, id, size and why
   * (never its contents), a lead call answered with an error so its agent isn't left waiting, and the link carries
   * on, unless more than BAD_FRAMES_PER_MINUTE came within a minute.
   */
  private linkedFrame(ws: Socket, state: LinkSocket, text: string): void {
    try {
      this.decodedFrame(ws, state, text);
    } catch (error) {
      if (!(error instanceof FrameError)) throw error;
      const machineId = state.machineId as string;
      const bad = undecodable(text, error.message);
      const where = `machine_id=${machineId} link_id=${state.id} tag=${bad.tag} bytes=${Buffer.byteLength(text)} error=${bad.error}`;
      if (!state.badFrames.take(this.hub.clock.now())) {
        console.warn(`node link: too many frames that do not decode; closing the link ${where}`);
        throw new Refused(CLOSE.BAD_FRAME, "too many frames that do not decode");
      }
      console.warn(`node link: a frame does not decode; refused it alone ${where}`);
      if (bad.tag === "lead_call" && bad.id !== undefined) {
        this.write(ws, state, {
          t: "lead_result",
          id: bad.id,
          error: {
            code: "invalid",
            message: `the hub could not read this call: ${bad.error}`,
            fix: "this machine and the hub may run different fleetd versions: carry on without this call and say so in your result",
          },
        });
      }
    }
  }

  private decodedFrame(ws: Socket, state: LinkSocket, text: string): void {
    const machineId = state.machineId as string;
    const id = state.id as number;
    let frame: NodeFrame;
    try {
      frame = JSON.parse(text) as NodeFrame;
    } catch (error) {
      throw new FrameError((error as Error).message);
    }
    const tag = frame && typeof frame === "object" && !Array.isArray(frame) ? frame.t : undefined;
    if (typeof tag !== "string" || !NODE_TAGS.has(tag)) {
      // An older node's word on a preview it still runs: previews are gone from the hub.
      if (typeof tag === "string" && tag.startsWith("preview_")) return;
      throw new FrameError(typeof tag === "string" ? `unknown variant \`${tag}\`` : "missing field `t`");
    }
    // A replaced or timed-out link must not keep the machine alive.
    if (this.links.get(machineId)?.id !== id) return;
    this.touch(machineId);
    switch (tag as NodeToHubTag) {
      case "hello":
        throw new Refused(CLOSE.BAD_FRAME, "hello after welcome");
      case "hb":
        if (this.forgetIfRevoked(machineId, id)) {
          throw new Refused(CLOSE.UNAUTHORIZED, `${machineId} was removed from this hub: its node key is revoked`);
        }
        this.heartbeat(machineId, frame);
        break;
      case "slept":
        this.slept(machineId, frame);
        break;
      case "machine_event": {
        const event = frame.event as { type?: string } | undefined;
        // The runner the node pushes (a probe, a login that expired or came back) while the link lives.
        if (event?.type === "runner_info") this.applyRunner(machineId, runnerProblem(event as never));
        break;
      }
      case "lead_call":
        // The frame's own fields, as LeadCallFrame decodes them; the call itself is decoded by lead_calls.
        if (typeof frame.id !== "string" || frame.id === "") throw new FrameError("missing field `id`");
        if (typeof frame.cwd !== "string") throw new FrameError("missing field `cwd`");
        if (!frame.call || typeof frame.call !== "object" || Array.isArray(frame.call)) throw new FrameError("missing field `call`");
        {
          const inFlight = this.callStarted();
          if (!inFlight) {
            // Not run, so trying it again can't run it twice.
            this.write(ws, state, {
              t: "lead_result",
              id: frame.id,
              error: { code: "failed", message: "fleetd hub is restarting, so this call didn't run", fix: "try it again in a few seconds" },
            });
            break;
          }
          // Off the frame loop: a slow call must not hold up heartbeats or other calls. Its answer goes back on this
          // link, which may have closed by then.
          void onLeadCallFrame(this.hub, machineId, frame as unknown as LeadCallFrame, (result) => {
            this.write(ws, state, result);
            // Counted until its answer is queued ahead of the link's close.
            inFlight.end();
          }).finally(() => inFlight.end());
        }
        break;
      default:
        // A reply a request waits for is that request's alone.
        if (REPLY_TAGS.has(tag) && this.commands.resolve(machineId, frame)) return;
    }
    if (SESSION_FRAMES.has(tag)) {
      try {
        executorsOf(this.hub).handleFrame(machineId, frame as unknown as NodeToHubSession);
      } catch (error) {
        console.error(`node link: the executor failed on ${tag}:`, error);
      }
    }
    this.dispatch(machineId, frame);
  }

  private dispatch(machineId: string, frame: NodeFrame): void {
    const set = this.handlers.get(frame.t);
    if (!set) return;
    for (const fn of set) {
      try {
        const out = fn(machineId, frame);
        if (out instanceof Promise) out.catch((error) => console.error(`node link: ${frame.t} handler failed:`, error));
      } catch (error) {
        console.error(`node link: ${frame.t} handler failed:`, error);
      }
    }
  }

  private heartbeat(machineId: string, frame: NodeFrame): void {
    const busy = frame.busy as NodeBusy | undefined;
    if (busy) this.busyBy.set(machineId, busy);
    else this.busyBy.delete(machineId);
    this.observeLoad(machineId, (frame.load as NodeLoad | undefined) ?? undefined, typeof frame.at === "string" ? frame.at : "");
    const status: MachineStatus = this.announced.get(machineId) === "degraded" ? "degraded" : "online";
    try {
      store(this.hub).machineSetStatus(machineId, status, this.nowIso());
    } catch (error) {
      console.error("node link: status write failed:", error);
    }
    const live = this.links.get(machineId);
    if (live && ++live.state.beats % RUNNER_CHECK_EVERY === 0) this.checkRunner(machineId);
    if (live) this.reattachIfDark(machineId, live.state);
  }

  /**
   * On each heartbeat of a link: once its executor hasn't been live for `REATTACH_AFTER_MS` while heartbeats kept
   * coming, its sessions are attached again. `state.darkSince` is when this link's heartbeats first found it not live.
   */
  reattachIfDark(machineId: string, state: { sessions?: NodeSessions; darkSince?: number }): void {
    const ex = executorsOf(this.hub);
    if (!state.sessions || ex.isConnected(machineId)) {
      state.darkSince = undefined;
      return;
    }
    const now = this.hub.clock.now();
    const since = (state.darkSince ??= now);
    if (now - since < REATTACH_AFTER_MS) return;
    console.warn(
      `node link: heartbeats arrive but its sessions aren't live; attaching them again machine_id=${machineId} link_id=${state.sessions.linkId} dark_ms=${now - since}`,
    );
    state.darkSince = now;
    try {
      ex.reattach(machineId, state.sessions);
    } catch (error) {
      console.error("node link: the executor did not take the link again:", error);
    }
  }

  /**
   * Keeps a heartbeat's load, and runs the disk guard and the usage soft brake over it: `machine.guard` marks each
   * pause and resume. The guard's line goes first, as a full disk outlasts a usage window; the line's figure updates
   * with every heartbeat. `machine.hosts` marks what the node can host when it first says it, or says something
   * else. `nodeAt` is the heartbeat's time on the node's clock: the brake ages a usage reading by it.
   */
  observeLoad(machineId: string, load: NodeLoad | undefined, nodeAt = ""): void {
    const now = this.hub.clock.now();
    const parsed = Date.parse(nodeAt);
    const nodeNow = Number.isNaN(parsed) ? now : parsed;
    const was = this.pausedBy.get(machineId);
    const hostsChanged =
      load?.hosts !== undefined && JSON.stringify(this.loads.get(machineId)?.hosts) !== JSON.stringify(load.hosts);
    const why = load ? guardWhy(load, was?.guard ?? false) : undefined;
    const braked = load ? brake(load.limits ?? [], was?.brake ?? false, now, nodeNow) : undefined;
    const network = this.networkProblem(machineId);
    if (load) this.loads.set(machineId, load);
    else this.loads.delete(machineId);
    if (this.networkProblem(machineId) !== network) this.settle(machineId);
    if (hostsChanged) this.append("machine.hosts", machineId, `${machineId} said what it can host`);
    if (why === undefined && braked === undefined && !was) return;
    let name = machineId;
    try {
      name = store(this.hub).machineGet(machineId)?.name ?? machineId;
    } catch {}
    const text = why !== undefined ? pausedText(why, name) : braked !== undefined ? brakeText(braked, name) : undefined;
    if (text === undefined) this.pausedBy.delete(machineId);
    else this.pausedBy.set(machineId, { text, guard: why !== undefined, brake: braked !== undefined });
    if ((was !== undefined) !== (text !== undefined)) {
      this.append("machine.guard", machineId, text ?? `New agents start again on ${name}`, { paused: !was });
    }
  }

  /** The node woke from sleep: kept on the machine for the status views, and logged as machine.slept. */
  private slept(machineId: string, frame: NodeFrame): void {
    const fromMs = Number(frame.fromMs);
    const toMs = Number(frame.toMs);
    if (!(Number.isInteger(fromMs) && Number.isInteger(toMs) && fromMs >= 0)) throw new FrameError("fromMs and toMs must be counts");
    if (toMs <= fromMs) throw new FrameError("toMs must be after fromMs");
    const hubStore = store(this.hub);
    const stored = hubStore.machineGet(machineId);
    if (!stored) return;
    hubStore.machineUpsert({ ...stored, lastSlept: { fromMs, toMs } });
    this.append("machine.slept", machineId, `${machineId} slept ${durationText(toMs - fromMs)}`, { fromMs, toMs });
  }

  /** Any frame restarts the machine's silence timer, armed for the link it came on. */
  private touch(machineId: string): void {
    const armedFor = this.linkId(machineId);
    clearTimeout(this.watchdogs.get(machineId));
    this.watchdogs.set(
      machineId,
      setTimeout(() => this.markOffline(machineId, armedFor), this.timings.silenceMs),
    );
  }

  /**
   * Bytes still arriving keep a link alive while one large frame comes in slowly, as frames would: every
   * `progressMs`, each live link whose connection read more since the last look restarts its silence timer. Stops once
   * no link is left; the next welcome starts it again.
   */
  private async progress(): Promise<void> {
    if (this.sampling) return;
    if (this.links.size === 0) {
      clearInterval(this.progressTimer);
      this.progressTimer = undefined;
      return;
    }
    const live = [...this.links.entries()].flatMap(([machineId, l]) => (l.state.peer ? [{ machineId, ...l, peer: l.state.peer }] : []));
    this.sampling = true;
    try {
      const counts = await this.readCounts.sample(live.map((l) => l.peer));
      if (!counts) return;
      for (const l of live) {
        const now = ReadCounts.read(counts, l.peer);
        if (now === undefined) continue;
        const seen = l.state.read;
        l.state.read = now;
        if (seen !== undefined && now !== seen && this.links.get(l.machineId)?.id === l.id) this.touch(l.machineId);
      }
    } catch (error) {
      console.error("node link: reading links' byte counts failed:", error);
    } finally {
      this.sampling = false;
    }
  }

  /** Rewrites the stored machine's status; `degradedReason` is kept only while degraded. */
  private writeStatus(machineId: string, status: MachineStatus, reason?: string): void {
    const hubStore = store(this.hub);
    let stored: Machine | undefined;
    try {
      stored = hubStore.machineGet(machineId);
    } catch (error) {
      return console.error("node link: machine read failed:", error);
    }
    if (!stored) return;
    const { degradedReason: previous, ...rest } = stored;
    // Going offline is silence, not a sighting: keep the last heartbeat's time.
    const machine: Machine = { ...rest, status, lastSeenAt: status === "offline" ? stored.lastSeenAt : this.nowIso() };
    if (status === "degraded") machine.degradedReason = reason ?? previous ?? "its node's runner is unavailable";
    try {
      hubStore.machineUpsert(machine);
    } catch (error) {
      console.error("node link: machine write failed:", error);
    }
  }

  /** Emits machine.online or machine.degraded when the machine's announced status changes. */
  private announce(machineId: string, status: Announced, reason?: string): void {
    if (this.announced.get(machineId) === status) return;
    this.announced.set(machineId, status);
    if (status === "online") this.append("machine.online", machineId, `${machineId} is online`);
    else {
      const why = reason ?? "";
      this.append("machine.degraded", machineId, `${machineId} is degraded: ${why}`, { degradedReason: why });
    }
  }

  private setReady(machineId: string, ready: boolean): void {
    try {
      executorsOf(this.hub).setRunnerReady(machineId, ready);
    } catch (error) {
      console.error("node link: the executor did not take the runner's readiness:", error);
    }
    if ((this.readyBy.get(machineId) ?? false) === ready) return;
    this.readyBy.set(machineId, ready);
    for (const hook of this.readyHooks) {
      try {
        hook(machineId, ready);
      } catch (error) {
        console.error("node link: onReady hook failed:", error);
      }
    }
  }

  /** Asks the node how its runner is, and announces the machine online or degraded by the answer. */
  private checkRunner(machineId: string): void {
    // Through the executor, as the Rust hub's `executors.runner_info`: its session call, and its read timeout.
    executorsOf(this.hub)
      .call(machineId, "read", { op: "runner_info" }, READ_TIMEOUT_MS)
      .then((output) =>
        output.kind === "runner_info" ? runnerProblem(output as never) : `${machineId}'s node answered runner_info with something else`,
      )
      .catch((error: Error) => error.message)
      .then((problem) => this.applyRunner(machineId, problem));
  }

  /** Keeps the runner's verdict (`problem`: undefined when usable) and announces the machine by it. */
  private applyRunner(machineId: string, problem: string | undefined): void {
    // A link that went away meanwhile must not announce anything.
    if (!this.links.has(machineId)) return;
    // The agents' Mac runs no claude: it is online whatever its runner says.
    this.runnerBy.set(machineId, this.can(machineId, CAP_AGENTS_MAC) ? undefined : problem);
    this.settle(machineId);
  }

  /**
   * Online while the runner is usable and the network is fine, else degraded with the runner's problem, or the
   * network's. Only the runner decides whether sessions start there: without IPv4, claude may still reach its API
   * over IPv6. Nothing before the link's first runner check answers.
   */
  private settle(machineId: string): void {
    if (!this.links.has(machineId) || !this.runnerBy.has(machineId)) return;
    const runner = this.runnerBy.get(machineId);
    const network = this.networkProblem(machineId);
    if (runner !== undefined) {
      this.setReady(machineId, false);
      this.writeStatus(machineId, "degraded", runner);
      this.announce(machineId, "degraded", runner);
    } else if (network !== undefined) {
      this.writeStatus(machineId, "degraded", network);
      this.announce(machineId, "degraded", network);
      this.setReady(machineId, true);
    } else {
      this.writeStatus(machineId, "online");
      this.announce(machineId, "online");
      // After machine.online is logged, so no queued write reaches the machine before it.
      this.setReady(machineId, true);
    }
  }

  /** The machine went silent on `armedFor`, the link its timer was armed on (undefined: none yet, after a start). */
  private markOffline(machineId: string, armedFor: number | undefined): void {
    const live = this.links.get(machineId);
    // A timer that fired as a newer link came in: that link has a timer of its own.
    if (live && live.id !== armedFor) return;
    this.announced.delete(machineId);
    this.watchdogs.delete(machineId);
    this.loads.delete(machineId);
    this.busyBy.delete(machineId);
    this.pausedBy.delete(machineId);
    this.runnerBy.delete(machineId);
    const seconds = Math.floor(this.timings.silenceMs / 1000);
    this.writeStatus(machineId, "offline");
    // No attention: a node back within minutes (a restart, an update) needs nobody. One still away after
    // hub/outage's 10 minutes pages the admins then, once.
    this.append("machine.offline", machineId, `${machineId} went offline: no word from its node for ${seconds} s`);
    if (live) {
      this.unlink(machineId, live.id, live.state);
      this.close(live.ws, live.state, CLOSE.HEARTBEAT_TIMEOUT, `no frame for ${seconds} s`);
    }
    console.info(`node link: machine offline machine_id=${machineId}`);
  }

  /**
   * A node whose key was revoked since its hello (`fleetd machine remove`, maybe outside this hub's process) is
   * ended at its next heartbeat; with its machine record gone too, what its link wrote since is forgotten again.
   */
  private forgetIfRevoked(machineId: string, id: number): boolean {
    if (this.hub.auth.nodes.nodePubKey(machineId) !== undefined) return false;
    const live = this.links.get(machineId);
    if (live?.id === id) this.unlink(machineId, id, live.state);
    const hubStore = store(this.hub);
    if (hubStore.machineGet(machineId) === undefined) {
      // `fleetd machine remove` ran outside this hub, so no open app has heard yet.
      this.append("machine.removed", machineId, `${machineId} was removed from the hub`);
      try {
        const rows = hubStore.machineRemove(machineId);
        if (rows > 0) console.info(`node link: a removed machine's rows forgotten again machine_id=${machineId} rows=${rows}`);
      } catch (error) {
        console.error("node link: a removed machine's rows weren't forgotten:", error);
      }
    }
    console.info(`node link: ${machineId}'s key was revoked, so its link ends`);
    return true;
  }

  /** The link `id` ended: commands on it fail as lost, and what its hello listed is forgotten unless a newer took over. */
  private unlink(machineId: string, id: number, state: LinkSocket): void {
    clearInterval(state.heartbeat);
    const detach = state.detach;
    state.detach = undefined;
    if (detach) {
      detach();
      try {
        executorsOf(this.hub).detachLink(machineId, id);
      } catch (error) {
        console.error("node link: the executor did not let the link go:", error);
      }
    }
    if (this.links.get(machineId)?.id === id) {
      this.links.delete(machineId);
      this.capabilities.delete(machineId);
    }
    if (this.links.has(machineId)) return;
    this.setReady(machineId, false);
    for (const hook of this.unlinkedHooks) {
      try {
        hook(machineId, id);
      } catch (error) {
        console.error("node link: onUnlinked hook failed:", error);
      }
    }
  }

  private closed(ws: Socket): void {
    const state = ws.data.state as LinkSocket;
    clearTimeout(state.helloTimer);
    if (state.phase === "linked" && state.machineId !== undefined && state.id !== undefined) {
      this.unlink(state.machineId, state.id, state);
    }
    state.phase = "closed";
    state.deflater?.close();
    state.inflater?.close();
  }
}

export { NodeCommandError, REPLY_OF };

// A watched screen's frames and a person's input peer to peer (W837), over WebRTC data channels straight between
// this node and the app; the hub only passes the offer and the answer on (`browser_rtc`). The app offers, with a
// `frames` and an `input` channel and its ICE candidates gathered (STUN only, no TURN); the node answers with
// werift's peer, which is pure TypeScript, so the one binary carries it to every machine it's built for, with no
// native library per platform.
//
// Every screen kind's frames leave through the link area's `browser_frame` (api.ts `LinkArea.screens`): each one also
// goes to the session's open peers, and stays off the link while the hub says every watcher has a peer (`relay`
// false). The app acks each frame, and a peer sends through the same ack-paced FrameSender as the hub's socket
// (hub/browser/flow.ts), and only while the channel has put what went before on the wire (SCTP's own congestion
// window). A peer starts at a whole picture (the newest JPEG, or a keyframe it asks of the screen). The screen is
// asked for keys and budgets with the hub's own watch frame, sent on to the screens again with `key`, or with the
// lower of the hub's budget and the peers' own.
//
// Input on the peer reaches the screen only while the app's key may drive it (the hub's `input`) and the screen says a
// person has control: its newest frame, or the hub's `browser_control` since it (a still screen sends no frame when a
// person takes it over, and the screen itself still refuses input it doesn't take). Each peer ends with its app's socket (the hub's close) and with the link,
// because the hub that let it in can't take it back after that.
import { RTCPeerConnection } from "werift";
import { RTC_CHUNK, RTC_HB_MS, RTC_STUN, type BrowserFrame, type BrowserInput, type RtcFromApp, type RtcFromNode, type ScreenPerf } from "../../shared/contracts.ts";
import { RTC_INPUT_EVERY_MS, type BrowserControlFrame, type BrowserRtcFrame, type BrowserRtcReport, type BrowserWatchFrame } from "../../shared/screens_wire.ts";
import { FrameSender } from "../../hub/browser/flow.ts";
import { CAP_BROWSER_RTC } from "../../shared/node_link.ts";
import type { Node } from "../api.ts";
import { stamp, type MachineNow } from "../screen/perf.ts";
import { machineNow } from "../screen/perf_machine.ts";

/** Peers open on this node at once: a person's few windows, with room to spare. */
export const MAX_PEERS = 8;
/** A peer whose channels aren't open this long after its answer is given up on: its app stays on the socket. */
export const OPEN_MS = 15_000;
/** A peer ICE calls disconnected this long is given up on (it fails by itself only after 30 s). */
export const DISCONNECTED_MS = 4_000;
/** A key asked of a screen again this soon after the last goes unasked: one is on its way. */
const KEY_EVERY = 250;
/** A budget that moved this little, or this soon after the last told, goes untold (hub/browser/live.ts's). */
const RETELL_SHARE = 0.2;
const RETELL_EVERY = 2_000;
/** A frame goes while the frames channel holds no more than this unsent (one chunk): what went before is on the wire. */
export const BACKLOG_BYTES = 16 * 1024;

/** What the peers need of the node: the screens' own handlers, and the hub. */
export type RtcSeams = {
  /** A watch frame for the screens, as if it came from the hub. */
  watch(frame: BrowserWatchFrame): void;
  /** A person's input for the screens, as if it came from the hub. */
  input(sessionId: string, input: BrowserInput): void;
  report(report: BrowserRtcReport): void;
  /** The machine the measures say the screen runs on (../screen/perf_machine.ts, absent); null for none: a box's own
   * reads would be its host's. */
  machine?: ((now: number) => MachineNow) | null;
};

/** The few calls of werift's channel a peer makes; tests give their own. */
type Channel = {
  label: string;
  readyState: string;
  bufferedAmount: number;
  bufferedAmountLowThreshold: number;
  bufferedAmountLow?: { subscribe(fn: () => void): unknown };
  send(data: Buffer | string): void;
  close(): void;
  onopen?: (() => void) | null;
  onclose?: (() => void) | null;
  onmessage?: ((e: { data: unknown }) => void) | null;
};

const bytesOf = (f: BrowserFrame) => Math.floor((f.jpegB64 ?? f.h264B64 ?? "").length / 4) * 3;

class Peer {
  frames: Channel | undefined;
  input: Channel | undefined;
  open = false;
  ended = false;
  /** Its frames, paced to the app's acks; it starts at a whole picture. */
  readonly sender: FrameSender<BrowserFrame>;
  private last: number | undefined;
  /** The newest measures not sent yet: they go, with this peer's link's, on the next frame that does. */
  private perf: ScreenPerf | undefined;
  private hb: ReturnType<typeof setInterval> | undefined;
  private openTimer: ReturnType<typeof setTimeout> | undefined;
  private downTimer: ReturnType<typeof setTimeout> | undefined;
  private inputAt: number | undefined;

  constructor(
    private readonly peers: Peers,
    readonly id: string,
    readonly sessionId: string,
    readonly mayInput: boolean,
    readonly pc: RTCPeerConnection,
  ) {
    this.sender = new FrameSender<BrowserFrame>(
      {
        send: (f) => this.send(f.data),
        key: () => this.peers.key(sessionId),
        budget: () => this.peers.budget(sessionId),
        room: () => (this.frames?.bufferedAmount ?? 0) <= BACKLOG_BYTES,
      },
      undefined,
      true,
    );
    this.openTimer = setTimeout(() => this.end("its channels didn't open"), OPEN_MS);
    pc.ondatachannel = ({ channel }) => this.channel(channel as unknown as Channel);
    pc.connectionStateChange.subscribe((state) => {
      if (state === "failed" || state === "closed") this.end(`its connection ${state}`);
      else if (state === "disconnected") this.downTimer ??= setTimeout(() => this.end("its connection was lost"), DISCONNECTED_MS);
      else if (state === "connected") {
        clearTimeout(this.downTimer);
        this.downTimer = undefined;
      }
    });
  }

  private channel(ch: Channel): void {
    if (ch.label === "frames") {
      this.frames = ch;
      ch.bufferedAmountLowThreshold = BACKLOG_BYTES;
      ch.bufferedAmountLow?.subscribe(() => this.sender.pump());
    } else if (ch.label === "input") this.input = ch;
    else return ch.close();
    ch.onclose = () => this.end(`its ${ch.label} channel closed`);
    if (ch.label === "input") ch.onmessage = (e) => this.fromApp(e.data);
    if (ch.readyState === "open") this.opened();
    else ch.onopen = () => this.opened();
  }

  private opened(): void {
    if (this.open || this.ended || this.frames?.readyState !== "open" || this.input?.readyState !== "open") return;
    this.open = true;
    clearTimeout(this.openTimer);
    this.hb = setInterval(() => this.text({ t: "hb" }), RTC_HB_MS);
    this.peers.opened(this);
  }

  private text(m: RtcFromNode): void {
    if (this.open && this.frames?.readyState === "open") this.frames.send(JSON.stringify(m));
  }

  private fromApp(data: unknown): void {
    if (typeof data !== "string" && !(data instanceof Buffer)) return;
    let m: RtcFromApp;
    try {
      m = JSON.parse(String(data)) as RtcFromApp;
    } catch {
      return;
    }
    const now = performance.now();
    if (m.t === "ack" && typeof m.seq === "number") this.sender.ack(m.seq);
    else if (m.t === "input" && typeof m.input === "object" && m.input !== null) {
      // Only a key that may drive the screen, and only while the screen says a person drives it.
      if (!this.mayInput || this.peers.control(this.sessionId) !== "human") return;
      this.peers.seams.input(this.sessionId, m.input);
      if (this.inputAt === undefined || now - this.inputAt >= RTC_INPUT_EVERY_MS) {
        this.inputAt = now;
        this.peers.seams.report({ sessionId: this.sessionId, peer: this.id, input: true });
      }
    }
  }

  /** A frame of its session's. */
  offer(frame: BrowserFrame): void {
    if (!this.open || this.last === frame.seq) return;
    this.last = frame.seq;
    if (frame.perf !== undefined) this.perf = frame.perf;
    this.sender.offer({ seq: frame.seq, bytes: bytesOf(frame), h264: frame.h264B64 !== undefined, key: frame.key === true, data: frame });
  }

  private send(frame: BrowserFrame): void {
    const ch = this.frames;
    if (!ch || ch.readyState !== "open") return;
    const { h264B64, jpegB64, perf: _perf, ...head } = frame;
    const data = Buffer.from(h264B64 ?? jpegB64 ?? "", "base64");
    const link = this.perf === undefined ? undefined : this.sender.stats();
    const perf = this.perf === undefined ? undefined : { ...this.perf, ...(link === undefined ? {} : { link }) };
    this.perf = undefined;
    ch.send(JSON.stringify({ ...head, ...(perf === undefined ? {} : { perf }), t: "frame", kind: h264B64 === undefined ? "jpeg" : "h264", bytes: data.length } satisfies RtcFromNode));
    for (let at = 0; at < data.length; at += RTC_CHUNK) ch.send(data.subarray(at, at + RTC_CHUNK));
  }

  /** Ends the peer; `why` undefined: the hub closed it, so it isn't told. */
  end(why: string | undefined): void {
    if (this.ended) return;
    this.ended = true;
    this.open = false;
    clearTimeout(this.openTimer);
    clearTimeout(this.downTimer);
    clearInterval(this.hb);
    this.sender.end();
    void this.pc.close().catch(() => {});
    this.peers.ended(this, why);
  }
}

export class Peers {
  readonly peers = new Map<string, Peer>();
  /** The hub's last watch frame of each watched session, which keys and budgets are asked through. */
  private readonly watches = new Map<string, BrowserWatchFrame>();
  /** Each session's newest frame, the whole picture a new peer starts at when it's a JPEG. */
  private readonly newest = new Map<string, BrowserFrame>();
  private readonly told = new Map<string, { kbps: number | undefined; at: number }>();
  /** Who drives each session as the hub last said it (`browser_control`), until its screen's next frame. */
  private readonly toldControl = new Map<string, string>();
  private readonly keyed = new Map<string, number>();

  constructor(
    readonly seams: RtcSeams,
    private readonly make: (config: ConstructorParameters<typeof RTCPeerConnection>[0]) => RTCPeerConnection = (c) => new RTCPeerConnection(c),
  ) {}

  /** The hub's watch frame, on its way to the screens: kept, its budget the lower of its own and the peers'. */
  fromHub(frame: BrowserWatchFrame): BrowserWatchFrame {
    const id = frame.sessionId;
    if (!frame.on) {
      this.watches.delete(id);
      this.told.delete(id);
      this.newest.delete(id);
      this.toldControl.delete(id);
      return frame;
    }
    this.watches.set(id, frame);
    const kbps = this.kbps(id);
    this.told.set(id, { kbps, at: performance.now() });
    return kbps === frame.kbps ? frame : { ...frame, kbps };
  }

  /** A screen's frame on its way to the hub: to its session's peers. False: the link needn't carry it. */
  frame(frame: BrowserFrame): boolean {
    const id = frame.sessionId;
    // Every kind's frames pass here: the second's measures go on the next of each screen's (../screen/perf.ts).
    stamp(frame, performance.now(), this.seams.machine === null ? undefined : (this.seams.machine ?? machineNow));
    this.newest.set(id, frame);
    this.toldControl.delete(id);
    let open = false;
    for (const p of this.peers.values()) {
      if (p.sessionId !== id) continue;
      p.offer(frame);
      open ||= p.open;
    }
    return this.watches.get(id)?.relay !== false || !open;
  }

  control(sessionId: string): string | undefined {
    return this.toldControl.get(sessionId) ?? this.newest.get(sessionId)?.control;
  }

  /** The hub's `browser_control`, on its way to the screens: who drives, until the screen's next frame says. */
  fromHubControl(frame: BrowserControlFrame): void {
    this.toldControl.set(frame.sessionId, frame.control === "human" ? "human" : "handing_back");
  }

  /** The hub's `browser_rtc`: a peer's offer, answered, or its close. */
  async rtc(frame: BrowserRtcFrame): Promise<void> {
    const old = this.peers.get(frame.peer);
    if (frame.offer === undefined || old) return old?.end(undefined);
    const report = (r: Omit<BrowserRtcReport, "sessionId" | "peer">) => this.seams.report({ sessionId: frame.sessionId, peer: frame.peer, ...r });
    if (this.peers.size >= MAX_PEERS) return report({ error: `this machine has ${MAX_PEERS} screen peers open already` });
    const pc = this.make({ iceServers: RTC_STUN.map((urls) => ({ urls })) });
    const peer = new Peer(this, frame.peer, frame.sessionId, frame.input === true, pc);
    this.peers.set(frame.peer, peer);
    try {
      await pc.setRemoteDescription({ type: "offer", sdp: frame.offer });
      // werift's answer carries its ICE candidates, STUN's among them, once gathered: no trickle to send after.
      await pc.setLocalDescription(await pc.createAnswer());
      const sdp = pc.localDescription?.sdp;
      if (peer.ended) return;
      if (!sdp) throw new Error("no answer");
      report({ answer: sdp });
    } catch (e) {
      peer.end(`its offer couldn't be answered: ${(e as Error).message}`);
    }
  }

  /** A peer's channels are open: it starts at the newest JPEG, or at a keyframe asked of the screen. */
  opened(peer: Peer): void {
    const newest = this.newest.get(peer.sessionId);
    if (newest?.jpegB64 !== undefined) peer.offer(newest);
    this.key(peer.sessionId, true);
  }

  ended(peer: Peer, why: string | undefined): void {
    if (this.peers.get(peer.id) !== peer) return;
    this.peers.delete(peer.id);
    if (why !== undefined) this.seams.report({ sessionId: peer.sessionId, peer: peer.id, closed: true, error: why });
    this.budget(peer.sessionId, true);
  }

  /** The link ended: every peer with it. */
  closeAll(): void {
    for (const p of [...this.peers.values()]) p.end(undefined);
  }

  /** A peer of `sessionId` lost an H.264 frame, or is new: the screen sends a whole picture next. */
  key(sessionId: string, force = false): void {
    const w = this.watches.get(sessionId);
    if (!w) return;
    const now = performance.now();
    const last = this.keyed.get(sessionId);
    if (!force && last !== undefined && now - last < KEY_EVERY) return;
    this.keyed.set(sessionId, now);
    this.seams.watch({ ...w, kbps: this.told.get(sessionId)?.kbps ?? w.kbps, key: true });
  }

  /** The lowest of the hub's budget for `sessionId` and its peers' own: undefined while every link keeps up. */
  private kbps(sessionId: string): number | undefined {
    let min = this.watches.get(sessionId)?.kbps;
    for (const p of this.peers.values()) {
      const k = p.sessionId === sessionId && p.open ? p.sender.flow.kbps() : undefined;
      if (k !== undefined && (min === undefined || k < min)) min = k;
    }
    return min;
  }

  /** A peer's budget may have moved: the screen is told the session's, as hub/browser/live.ts's Budgets retell. */
  budget(sessionId: string, force = false): void {
    const w = this.watches.get(sessionId);
    if (!w) return;
    const next = this.kbps(sessionId);
    const told = this.told.get(sessionId);
    const moved = told?.kbps !== undefined && next !== undefined ? Math.abs(told.kbps - next) > told.kbps * RETELL_SHARE : told?.kbps !== next;
    const now = performance.now();
    if (!moved || (!force && told !== undefined && now - told.at < RETELL_EVERY)) return;
    this.told.set(sessionId, { kbps: next, at: now });
    const { key: _key, ...frame } = w;
    this.seams.watch({ ...frame, kbps: next });
  }
}

/** The node's peers, once `start` wired them. */
export const peers = (node: Node) => node.area("rtc", () => ({ peers: undefined as Peers | undefined }));

/**
 * Wires the peers into the node, after every screen area took its hub frames: the hub's watch frames go through them
 * to the screens, the screens' frames through them to the link, and the hub's `browser_rtc` here.
 */
export function start(node: Node, make?: ConstructorParameters<typeof Peers>[1]): Peers {
  const link = node.area("link");
  const screens = link.handler("browser_watch");
  const input = link.handler("browser_input");
  const control = link.handler("browser_control");
  const ctx = () => link.current;
  const p = new Peers(
    {
      watch: (frame) => {
        const c = ctx();
        if (c) screens?.({ t: "browser_watch", ...frame } as never, c);
      },
      input: (sessionId, i) => {
        const c = ctx();
        if (c) input?.({ t: "browser_input", sessionId, input: i } as never, c);
      },
      report: (r) => void link.send({ t: "browser_rtc", ...r } as never),
    },
    make,
  );
  link.on("browser_watch", (frame, c) => screens?.({ ...(p.fromHub(frame as unknown as BrowserWatchFrame) as object), t: "browser_watch" } as never, c));
  link.on("browser_rtc", (frame) => void p.rtc(frame as unknown as BrowserRtcFrame));
  link.on("browser_control", (frame, c) => {
    p.fromHubControl(frame as unknown as BrowserControlFrame);
    return control?.(frame, c);
  });
  link.screens((frame) => p.frame(frame));
  link.onEnded(() => p.closeAll());
  node.area("caps").contribute(() => [CAP_BROWSER_RTC]);
  peers(node).peers = p;
  return p;
}

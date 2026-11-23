// A watched screen's peer (W837): its frames, and the person's input, go straight between this window and the
// screen's node over WebRTC data channels; the hub only passes the offer and the answer on (hub.rtc). The window
// offers as it starts watching, with its ICE candidates gathered (STUN only, no TURN). Until the peer's first frame
// comes, the window shows the hub's frames; from then on, only the peer's (the store's `browserRtc`), and the watch
// tells the hub to send none. The node starts a peer at a whole picture. A peer that fails, closes, or goes quiet for
// RTC_QUIET_MS hands the screen back to the hub, which starts again at a whole picture. The last picture stays up
// meanwhile, and a new peer is tried after RETRY_MS. A link that can't go peer to peer just stays on the hub. Each
// frame is acked on the peer as it lands, so the node paces it as the hub paces its socket.
import { RTC_QUIET_MS, RTC_STUN, type BrowserFrame, type BrowserInput, type RtcFromApp, type RtcFromNode } from "../../../shared/contracts";
import { toBase64 } from "../../../shared/base64";
import type { HubFrame } from "../../../shared/hub";
import type { DataLayer } from "../../src/data/queries";

/** The longest the window gathers its candidates before it offers what it has. */
export const GATHER_MS = 2_000;
/** An offer with no answer by then, or channels not open by then, is given up on. */
export const OPEN_MS = 15_000;
/** The waits before each new peer after one failed, the last repeating. */
export const RETRY_MS = [3_000, 15_000, 60_000] as const;

type Rtc = Extract<HubFrame, { t: "browser_rtc" }>;

/** What a viewer needs of its window: the hub's signalling, the store, and the browser's peer. */
export type RtcSeams = {
  /** An offer for the session, or null to close the peer (window.fleetd.hub.rtc). */
  signal(peer: string, offer: string | null): void;
  /** The peer the session's frames come on now, or null (window.fleetd.hub.rtcWatch). */
  watch(peer: string | null): void;
  /** A frame from the peer, into the store as main's go. */
  frame(frame: HubFrame): void;
  /** The session's frames come from main again. */
  off(): void;
  /** Main's `browser_rtc` frames, until the returned stop. */
  answers(fn: (frame: Rtc) => void): () => void;
  peer(config: RTCConfiguration): RTCPeerConnection;
};

const newId = () => `w${Math.random().toString(36).slice(2, 12)}`;

/** One watched session's peers, one at a time, from `start` until `stop`. */
export class RtcViewer {
  #pc: RTCPeerConnection | null = null;
  #input: RTCDataChannel | null = null;
  #peer: string | null = null;
  /** Peers started so far, and the `link` the current one's frames carry: each peer's own, below every hub link (a
   * machine link's id, 1 and up). A node counts `seq` from the start on a new peer (a new holder's box after a handover,
   * a node that restarted), and the store drops a lower seq only on the same link, so a new peer is a new stream. */
  #starts = 0;
  #link = 0;
  /** A frame of the peer's arrived: the session's frames come on it. */
  #carrying = false;
  #heard = 0;
  #head: Extract<RtcFromNode, { t: "frame" }> | null = null;
  #parts: Uint8Array[] = [];
  #got = 0;
  #timers = new Set<ReturnType<typeof setTimeout>>();
  #quiet: ReturnType<typeof setInterval> | null = null;
  #failures = 0;
  #stopped = true;
  #unlisten: (() => void) | null = null;

  constructor(
    readonly sessionId: string,
    private readonly seams: RtcSeams,
  ) {}

  /** Whether a person's input goes on the peer now. */
  get open(): boolean {
    return this.#carrying && this.#input?.readyState === "open";
  }

  start(): void {
    if (!this.#stopped) return;
    this.#stopped = false;
    this.#unlisten = this.seams.answers((f) => void this.#answer(f));
    void this.#connect();
  }

  stop(): void {
    if (this.#stopped) return;
    this.#stopped = true;
    this.#unlisten?.();
    this.#unlisten = null;
    for (const t of this.#timers) clearTimeout(t);
    this.#timers.clear();
    this.#end();
  }

  /** Sends `input` on the peer; false when it isn't open, for the hub to carry it instead. */
  input(input: BrowserInput): boolean {
    if (!this.open) return false;
    this.#send({ t: "input", input });
    return true;
  }

  #after(ms: number, fn: () => void): void {
    const t = setTimeout(() => {
      this.#timers.delete(t);
      fn();
    }, ms);
    this.#timers.add(t);
  }

  async #connect(): Promise<void> {
    if (this.#stopped) return;
    const peer = newId();
    let pc: RTCPeerConnection;
    try {
      pc = this.seams.peer({ iceServers: RTC_STUN.map((urls) => ({ urls })) });
    } catch {
      return;
    }
    this.#pc = pc;
    this.#peer = peer;
    this.#link = -++this.#starts;
    const frames = pc.createDataChannel("frames", { ordered: true });
    const input = pc.createDataChannel("input", { ordered: true });
    frames.binaryType = "arraybuffer";
    this.#input = input;
    frames.onmessage = (e: MessageEvent<unknown>) => this.#message(e.data);
    frames.onclose = () => this.#failed(peer);
    input.onclose = () => this.#failed(peer);
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === "failed" || pc.connectionState === "closed") this.#failed(peer);
    };
    this.#after(OPEN_MS, () => {
      if (this.#peer === peer && !this.#carrying) this.#failed(peer);
    });
    try {
      await pc.setLocalDescription(await pc.createOffer());
      await gathered(pc, GATHER_MS);
    } catch {
      return this.#failed(peer);
    }
    const sdp = pc.localDescription?.sdp;
    if (this.#peer !== peer || sdp === undefined) return;
    this.seams.signal(peer, sdp);
  }

  async #answer(f: Rtc): Promise<void> {
    if (f.peer !== this.#peer || f.session !== this.sessionId) return;
    if (f.error !== undefined) return this.#failed(f.peer);
    if (f.answer === undefined || this.#pc === null) return;
    const pc = this.#pc;
    try {
      await pc.setRemoteDescription({ type: "answer", sdp: f.answer });
    } catch {
      this.#failed(f.peer);
    }
  }

  #message(data: unknown): void {
    this.#heard = performance.now();
    if (typeof data === "string") {
      let m: RtcFromNode;
      try {
        m = JSON.parse(data) as RtcFromNode;
      } catch {
        return;
      }
      if (m.t === "frame") {
        this.#head = m;
        this.#parts = [];
        this.#got = 0;
        if (m.bytes === 0) this.#whole();
      }
      return;
    }
    if (!(data instanceof ArrayBuffer) || this.#head === null) return;
    this.#parts.push(new Uint8Array(data));
    this.#got += data.byteLength;
    if (this.#got >= this.#head.bytes) this.#whole();
  }

  #whole(): void {
    const head = this.#head;
    if (head === null) return;
    this.#head = null;
    const bytes = new Uint8Array(this.#got);
    let at = 0;
    for (const p of this.#parts) {
      bytes.set(p, at);
      at += p.byteLength;
    }
    this.#parts = [];
    this.#send({ t: "ack", seq: head.seq });
    const { t: _t, kind, bytes: _n, ...rest } = head;
    const b64 = toBase64(bytes);
    const frame: BrowserFrame = { ...rest, link: this.#link, ...(kind === "h264" ? { h264B64: b64 } : { jpegB64: b64 }) };
    this.seams.frame({ t: "browser_frame", frame, rtc: true });
    if (!this.#carrying && this.#peer !== null) {
      this.#carrying = true;
      this.#failures = 0;
      this.seams.watch(this.#peer);
      this.#quiet = setInterval(() => {
        if (performance.now() - this.#heard > RTC_QUIET_MS && this.#peer !== null) this.#failed(this.#peer);
      }, RTC_QUIET_MS / 4);
    }
  }

  #send(m: RtcFromApp): void {
    if (this.#input?.readyState === "open") this.#input.send(JSON.stringify(m));
  }

  /** The peer `peer` is no use: the hub's frames again, and another peer later. */
  #failed(peer: string): void {
    if (this.#peer !== peer) return;
    this.#end();
    if (this.#stopped) return;
    const wait = RETRY_MS[Math.min(this.#failures, RETRY_MS.length - 1)] ?? RETRY_MS[0];
    this.#failures++;
    this.#after(wait, () => void this.#connect());
  }

  #end(): void {
    const peer = this.#peer;
    const carried = this.#carrying;
    this.#peer = null;
    this.#carrying = false;
    this.#head = null;
    this.#parts = [];
    if (this.#quiet !== null) clearInterval(this.#quiet);
    this.#quiet = null;
    const pc = this.#pc;
    this.#pc = null;
    this.#input = null;
    if (pc !== null) {
      pc.onconnectionstatechange = null;
      pc.close();
    }
    if (peer !== null) this.seams.signal(peer, null);
    if (carried) {
      this.seams.watch(null);
      this.seams.off();
    }
  }
}

/** Resolves once `pc` has gathered its candidates, or after `ms` with those it has. */
function gathered(pc: RTCPeerConnection, ms: number): Promise<void> {
  if (pc.iceGatheringState === "complete") return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      pc.removeEventListener("icegatheringstatechange", check);
      resolve();
    };
    const check = () => {
      if (pc.iceGatheringState === "complete") done();
    };
    const timer = setTimeout(done, ms);
    pc.addEventListener("icegatheringstatechange", check);
  });
}

/** The viewers open in this window, by hub and session: input for a session goes on its peer while one is open. */
const viewers = new Map<string, RtcViewer>();
const keyOf = (hub: string, sessionId: string) => `${hub}\n${sessionId}`;

/** Whether a peer is worth building: the hub passes peers on (its `browser_rtc` feature) and the screen's machine answers one. */
export const peerWanted = (features: readonly string[], machineAnswers: boolean): boolean =>
  machineAnswers && features.includes(RTC_FEATURE) && typeof RTCPeerConnection !== "undefined";

/** The hub feature that says it passes screen peers on. */
export const RTC_FEATURE = "browser_rtc";

/**
 * Starts the window's peer for `sessionId` while it watches it; returns the stop. `machineAnswers`: the session says its
 * machine takes a peer (its `rtc`). None at all, no STUN asked either, where the hub, the machine or the browser has none.
 */
export function watchPeer(layer: DataLayer, sessionId: string, machineAnswers: boolean): () => void {
  if (!peerWanted(layer.store.getState().features, machineAnswers)) return () => undefined;
  const { hub } = layer;
  const api = window.fleetd.hub;
  const viewer = new RtcViewer(sessionId, {
    signal: (peer, offer) => void api.rtc(hub, sessionId, peer, offer),
    watch: (peer) => void api.rtcWatch(hub, sessionId, peer),
    frame: (f) => layer.frame(f),
    off: () => layer.store.setState((s) => (s.browserRtc === sessionId ? { browserRtc: undefined } : {})),
    answers: (fn) => layer.onRtc(fn),
    peer: (config) => new RTCPeerConnection(config),
  });
  const key = keyOf(hub, sessionId);
  viewers.get(key)?.stop();
  viewers.set(key, viewer);
  viewer.start();
  return () => {
    viewer.stop();
    if (viewers.get(key) === viewer) viewers.delete(key);
  };
}

/** A person's input to `sessionId`: on the window's peer while it's open, else through the hub. */
export function sendInput(hub: string, sessionId: string, input: BrowserInput): void {
  if (viewers.get(keyOf(hub, sessionId))?.input(input) === true) return;
  void window.fleetd.hub.input(hub, sessionId, input);
}

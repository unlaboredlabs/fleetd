import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RTC_QUIET_MS } from "../../../shared/contracts";
import type { HubFrame } from "../../../shared/hub";
import type { DataLayer } from "../../src/data/queries";
import { OPEN_MS, RETRY_MS, RTC_FEATURE, RtcViewer, watchPeer, type RtcSeams } from "./rtc";

const S = "B68722f97b065412024c7cda6c636fd9a";

/** `x`, there. */
function there<T>(x: T | undefined): T {
  if (x === undefined) throw new Error("missing");
  return x;
}

/** The few parts of a data channel the viewer uses. */
class Channel {
  readyState: RTCDataChannelState = "connecting";
  binaryType = "blob";
  sent: string[] = [];
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  constructor(readonly label: string) {}
  send(text: string) {
    this.sent.push(text);
  }
}

/** A peer that gathers at once and opens its channels when told. */
class Peer {
  channels: Channel[] = [];
  connectionState = "new";
  iceGatheringState = "complete";
  localDescription: { sdp: string } | null = null;
  remote: string | undefined;
  closed = false;
  onconnectionstatechange: (() => void) | null = null;
  constructor(readonly config: RTCConfiguration) {}
  createDataChannel(label: string) {
    const c = new Channel(label);
    this.channels.push(c);
    return c;
  }
  createOffer() {
    return Promise.resolve({ type: "offer", sdp: "v=0 offer" });
  }
  setLocalDescription(d: { sdp: string }) {
    this.localDescription = d;
    return Promise.resolve();
  }
  setRemoteDescription(d: { sdp: string }) {
    this.remote = d.sdp;
    return Promise.resolve();
  }
  close() {
    this.closed = true;
  }
  addEventListener() {}
  removeEventListener() {}
  channel(label: string) {
    return there(this.channels.find((c) => c.label === label));
  }
  /** Both channels open; the node's messages land on `frames`. */
  open() {
    for (const c of this.channels) c.readyState = "open";
  }
  deliver(data: unknown) {
    this.channel("frames").onmessage?.({ data });
  }
}

function harness() {
  const peers: Peer[] = [];
  const signals: [string, string | null][] = [];
  const watches: (string | null)[] = [];
  const frames: HubFrame[] = [];
  let offs = 0;
  let answer: ((f: Extract<HubFrame, { t: "browser_rtc" }>) => void) | undefined;
  const seams: RtcSeams = {
    signal: (peer, offer) => signals.push([peer, offer]),
    watch: (peer) => watches.push(peer),
    frame: (f) => frames.push(f),
    off: () => offs++,
    answers: (fn) => {
      answer = fn;
      return () => (answer = undefined);
    },
    peer: (config) => {
      const p = new Peer(config);
      peers.push(p);
      return p as unknown as RTCPeerConnection;
    },
  };
  const viewer = new RtcViewer(S, seams);
  return { viewer, peers, signals, watches, frames, offs: () => offs, answer: (f: Extract<HubFrame, { t: "browser_rtc" }>) => answer?.(f) };
}

const head = (seq: number, bytes: number, kind = "h264", key = true) =>
  JSON.stringify({ t: "frame", sessionId: S, seq, width: 800, height: 600, control: "agent", kind, bytes, ...(key ? { key } : {}) });

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("a screen's peer", () => {
  it("offers with STUN, takes the node's answer, and brings each frame whole into the store, acked", async () => {
    const h = harness();
    h.viewer.start();
    await vi.advanceTimersByTimeAsync(0);
    const p = there(h.peers[0]);
    expect(p.config.iceServers?.[0]?.urls).toMatch(/^stun:/u);
    expect(p.channels.map((c) => c.label)).toEqual(["frames", "input"]);
    const [peer, offer] = there(h.signals[0]);
    expect(offer).toBe("v=0 offer");
    h.answer({ t: "browser_rtc", session: S, peer: "someone else's", answer: "no" });
    h.answer({ t: "browser_rtc", session: S, peer, answer: "v=0 answer" });
    await vi.advanceTimersByTimeAsync(0);
    expect(p.remote).toBe("v=0 answer");
    p.open();
    // Input waits for the peer's first frame: until then it goes through the hub.
    expect(h.viewer.input({ kind: "key", action: "down", key: "a" })).toBe(false);
    p.deliver(head(5, 5));
    p.deliver(new Uint8Array([0, 0, 0, 1, 0x67]).buffer);
    expect(h.frames).toEqual([{ t: "browser_frame", rtc: true, frame: { sessionId: S, seq: 5, width: 800, height: 600, control: "agent", key: true, link: -1, h264B64: btoa("\u0000\u0000\u0000\u0001g") } }]);
    expect(h.watches).toEqual([peer]);
    expect(p.channel("input").sent).toEqual([JSON.stringify({ t: "ack", seq: 5 })]);
    // A JPEG in two pieces, a heartbeat between.
    p.deliver(head(6, 4, "jpeg", false));
    p.deliver(new Uint8Array([1, 2]).buffer);
    p.deliver(JSON.stringify({ t: "hb" }));
    p.deliver(new Uint8Array([3, 4]).buffer);
    expect(h.frames.at(-1)).toMatchObject({ frame: { seq: 6, jpegB64: btoa("\u0001\u0002\u0003\u0004") } });
    expect(p.channel("input").sent.slice(1)).toEqual([JSON.stringify({ t: "ack", seq: 6 })]);
    expect(h.viewer.input({ kind: "key", action: "down", key: "a" })).toBe(true);
    expect(p.channel("input").sent.at(-1)).toBe(JSON.stringify({ t: "input", input: { kind: "key", action: "down", key: "a" } }));
  });

  it("goes back to the hub when the peer goes quiet, and tries a new one later", async () => {
    const h = harness();
    h.viewer.start();
    await vi.advanceTimersByTimeAsync(0);
    const p = there(h.peers[0]);
    const [peer] = there(h.signals[0]);
    p.open();
    p.deliver(head(1, 0));
    // Heartbeats keep it.
    for (let i = 0; i < 4; i++) {
      await vi.advanceTimersByTimeAsync(RTC_QUIET_MS / 2);
      p.deliver(JSON.stringify({ t: "hb" }));
    }
    expect(h.offs()).toBe(0);
    await vi.advanceTimersByTimeAsync(RTC_QUIET_MS * 2);
    expect(h.offs()).toBe(1);
    expect(h.watches).toEqual([peer, null]);
    expect(h.signals.at(-1)).toEqual([peer, null]);
    expect(p.closed).toBe(true);
    expect(h.viewer.input({ kind: "key", action: "down", key: "a" })).toBe(false);
    await vi.advanceTimersByTimeAsync(RETRY_MS[0]);
    expect(h.peers).toHaveLength(2);
    expect(h.signals.at(-1)?.[1]).toBe("v=0 offer");
    // The next peer is a stream of its own: a node that counts from the start again (a new holder's box after a
    // server's handover) isn't taken for older than what the last peer showed.
    const next = there(h.peers[1]);
    next.open();
    next.deliver(head(1, 0));
    expect(h.frames.map((f) => (f.t === "browser_frame" ? [f.frame.seq, f.frame.link] : null))).toEqual([
      [1, -1],
      [1, -2],
    ]);
  });

  it("gives up on a peer the hub refuses or that never opens, without touching what the hub sends", async () => {
    const h = harness();
    h.viewer.start();
    await vi.advanceTimersByTimeAsync(0);
    const [peer] = there(h.signals[0]);
    h.answer({ t: "browser_rtc", session: S, peer, error: "too old" });
    expect(h.offs()).toBe(0);
    expect(h.watches).toEqual([]);
    // Waits longer after each failure.
    await vi.advanceTimersByTimeAsync(RETRY_MS[0]);
    expect(h.peers).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(OPEN_MS);
    expect(there(h.peers[1]).closed).toBe(true);
    await vi.advanceTimersByTimeAsync(RETRY_MS[0]);
    expect(h.peers).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(RETRY_MS[1] - RETRY_MS[0]);
    expect(h.peers).toHaveLength(3);
    h.viewer.stop();
    expect(there(h.peers[2]).closed).toBe(true);
    await vi.advanceTimersByTimeAsync(RETRY_MS[2] * 2);
    expect(h.peers).toHaveLength(3);
  });

  it("tries a new peer at once when the screen's machine is back after a wait, not at the end of its back-off", async () => {
    const h = harness();
    h.viewer.start();
    await vi.advanceTimersByTimeAsync(0);
    // While the machine is away each peer fails, and the wait grows to its longest.
    for (let i = 0; i < 3; i++) {
      const [peer] = there(h.signals.at(-1));
      h.answer({ t: "browser_rtc", session: S, peer, error: "machine away" });
      await vi.advanceTimersByTimeAsync(there(RETRY_MS[Math.min(i, RETRY_MS.length - 1)]));
    }
    expect(h.peers).toHaveLength(4);
    const [last] = there(h.signals.at(-1));
    h.answer({ t: "browser_rtc", session: S, peer: last, error: "machine away" });
    // It's back: a peer now, and the back-off starts again from its shortest.
    h.viewer.again();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.peers).toHaveLength(5);
    // One trying already, or open, isn't started again.
    h.viewer.again();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.peers).toHaveLength(5);
    const [now] = there(h.signals.at(-1));
    h.answer({ t: "browser_rtc", session: S, peer: now, error: "too old" });
    await vi.advanceTimersByTimeAsync(RETRY_MS[0]);
    expect(h.peers).toHaveLength(6);
    h.viewer.stop();
  });
});

describe("a window's peer for a screen", () => {
  const made: unknown[] = [];
  beforeEach(() => {
    made.length = 0;
    // The browser's peer, counted: none may be made, nor STUN asked, where nothing would answer it.
    vi.stubGlobal(
      "RTCPeerConnection",
      class {
        constructor() {
          made.push(this);
        }
        createDataChannel() {
          return { readyState: "connecting" };
        }
        createOffer() {
          return new Promise(() => undefined);
        }
        close() {}
      },
    );
    vi.stubGlobal("window", { fleetd: { hub: { rtc: vi.fn(() => Promise.resolve()), rtcWatch: vi.fn(() => Promise.resolve()), input: vi.fn() } } });
  });
  afterEach(() => vi.unstubAllGlobals());

  const layer = (features: string[]) =>
    ({
      hub: "devbox",
      store: { getState: () => ({ features }), setState: vi.fn(), subscribe: () => () => undefined },
      frame: vi.fn(),
      onRtc: () => () => undefined,
    }) as unknown as DataLayer;

  it("isn't made at all without the hub's feature or the screen's machine taking one", async () => {
    watchPeer(layer([]), S, true)();
    watchPeer(layer(["browser_sessions"]), S, true)();
    watchPeer(layer([RTC_FEATURE]), S, false)();
    await vi.advanceTimersByTimeAsync(RETRY_MS[2] * 3);
    expect(made).toHaveLength(0);
    const stop = watchPeer(layer([RTC_FEATURE]), S, true);
    await vi.advanceTimersByTimeAsync(0);
    expect(made).toHaveLength(1);
    stop();
  });
});

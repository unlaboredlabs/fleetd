// src/node/rtc: a screen's peer, answered by the node's werift and driven here by another werift peer as the app's
// RTCPeerConnection would: the offer with its two channels, frames from a whole picture on, chunked and whole again,
// relay off the link only while a peer is open, input only while a person has control, and the ends.
import { afterEach, expect, test } from "bun:test";
import { RTCPeerConnection } from "werift";
import { RTC_CHUNK, type BrowserFrame, type BrowserInput } from "../../src/shared/contracts.ts";
import type { BrowserRtcReport, BrowserWatchFrame } from "../../src/shared/screens_wire.ts";
import { Peers } from "../../src/node/rtc/index.ts";

type Got = { head: Record<string, unknown>; data: Buffer };

function harness() {
  const watches: BrowserWatchFrame[] = [];
  const inputs: { sessionId: string; input: BrowserInput }[] = [];
  const reports: BrowserRtcReport[] = [];
  // No STUN in a test: the peers meet on this machine's own addresses.
  const peers = new Peers(
    { watch: (f) => watches.push(f), input: (sessionId, input) => inputs.push({ sessionId, input }), report: (r) => reports.push(r) },
    () => new RTCPeerConnection({}),
  );
  return { peers, watches, inputs, reports };
}

const until = async (what: () => boolean, ms = 10_000) => {
  const end = performance.now() + ms;
  while (!what()) {
    if (performance.now() > end) throw new Error("timed out");
    await Bun.sleep(10);
  }
};

const apps: RTCPeerConnection[] = [];
afterEach(async () => {
  for (const a of apps.splice(0)) await a.close().catch(() => {});
});

/** The app's side: offers, takes the answer, and gathers what the frames channel brings. */
async function app(h: ReturnType<typeof harness>, peer = "p1", input = true) {
  const pc = new RTCPeerConnection({});
  apps.push(pc);
  const frames = pc.createDataChannel("frames", { ordered: true });
  const inputCh = pc.createDataChannel("input", { ordered: true });
  const got: Got[] = [];
  const texts: string[] = [];
  let pending: Got | undefined;
  let need = 0;
  frames.onmessage = ({ data }) => {
    if (typeof data === "string") {
      texts.push(data);
      const m = JSON.parse(data) as { t: string; bytes: number };
      if (m.t !== "frame") return;
      pending = { head: m, data: Buffer.alloc(0) };
      need = m.bytes;
      if (need === 0) got.push(pending);
      return;
    }
    if (!pending) return;
    pending.data = Buffer.concat([pending.data, data as Buffer]);
    if (pending.data.length >= need) {
      got.push(pending);
      inputCh.send(JSON.stringify({ t: "ack", seq: pending.head.seq }));
      pending = undefined;
    }
  };
  await pc.setLocalDescription(await pc.createOffer());
  await h.peers.rtc({ sessionId: "s1", peer, offer: pc.localDescription!.sdp, input });
  const answer = h.reports.find((r) => r.peer === peer && r.answer !== undefined);
  expect(answer?.answer).toContain("a=candidate");
  await pc.setRemoteDescription({ type: "answer", sdp: answer!.answer! });
  await until(() => frames.readyState === "open" && inputCh.readyState === "open" && h.peers.peers.get(peer)?.open === true);
  return { pc, frames, input: inputCh, got, texts };
}

const frame = (seq: number, f: Partial<BrowserFrame>): BrowserFrame => ({ sessionId: "s1", seq, width: 800, height: 600, control: "agent", ...f });
const b64 = (n: number, fill: number) => Buffer.alloc(n, fill).toString("base64");

test("a peer starts at a keyframe it asks for, and gets each frame whole, in chunks", async () => {
  const h = harness();
  h.peers.fromHub({ sessionId: "s1", on: true, video: true, kbps: 900 });
  const a = await app(h);
  // Opened: the screen is asked for a whole picture with the hub's own watch.
  expect(h.watches.at(-1)).toMatchObject({ sessionId: "s1", on: true, video: true, key: true, kbps: 900 });
  h.peers.frame(frame(1, { h264B64: b64(100, 1) }));
  const big = RTC_CHUNK * 2 + 17;
  h.peers.frame(frame(2, { h264B64: b64(big, 2), key: true }));
  h.peers.frame(frame(3, { h264B64: b64(50, 3) }));
  await until(() => a.got.length >= 2);
  // The delta before the keyframe never went.
  expect(a.got.map((g) => g.head.seq)).toEqual([2, 3]);
  expect(a.got[0]!.head).toMatchObject({ kind: "h264", key: true, bytes: big, width: 800 });
  expect(a.got[0]!.data.equals(Buffer.alloc(big, 2))).toBe(true);
  expect(a.got[1]!.data.equals(Buffer.alloc(50, 3))).toBe(true);
});

test("a JPEG screen's peer starts at its newest picture; the link carries frames unless the hub says every watcher has a peer", async () => {
  const h = harness();
  h.peers.fromHub({ sessionId: "s1", on: true });
  expect(h.peers.frame(frame(7, { jpegB64: b64(10, 7) }))).toBe(true);
  const a = await app(h);
  await until(() => a.got.length === 1);
  expect(a.got[0]!.head).toMatchObject({ kind: "jpeg", seq: 7 });
  // Still relayed: the hub hasn't said otherwise.
  expect(h.peers.frame(frame(8, { jpegB64: b64(10, 8) }))).toBe(true);
  h.peers.fromHub({ sessionId: "s1", on: true, relay: false });
  expect(h.peers.frame(frame(9, { jpegB64: b64(10, 9) }))).toBe(false);
  // No open peer: the link carries it, whatever the hub last said.
  h.peers.closeAll();
  expect(h.peers.frame(frame(10, { jpegB64: b64(10, 10) }))).toBe(true);
  // The hub closed it (closeAll is the link's end): nothing reported.
  expect(h.reports.filter((r) => r.closed)).toEqual([]);
});

test("input reaches the screen only while a person has control, and only from a key that may drive it", async () => {
  const h = harness();
  h.peers.fromHub({ sessionId: "s1", on: true });
  const a = await app(h);
  const tap = { kind: "mouse", action: "down", x: 1, y: 2 } as unknown as BrowserInput;
  h.peers.frame(frame(1, { jpegB64: b64(4, 1) }));
  a.input.send(JSON.stringify({ t: "input", input: tap }));
  await Bun.sleep(100);
  expect(h.inputs).toEqual([]);
  h.peers.frame(frame(2, { jpegB64: b64(4, 2), control: "human" }));
  a.input.send(JSON.stringify({ t: "input", input: tap }));
  a.input.send(JSON.stringify({ t: "input", input: tap }));
  await until(() => h.inputs.length === 2);
  expect(h.inputs[0]).toEqual({ sessionId: "s1", input: tap });
  // The hub hears of it once a while, for its idle clock.
  expect(h.reports.filter((r) => r.input)).toHaveLength(1);

  const b = await app(h, "p2", false);
  b.input.send(JSON.stringify({ t: "input", input: tap }));
  await Bun.sleep(100);
  expect(h.inputs).toHaveLength(2);
});

test("a person who takes a still screen over drives it at once: the hub's word counts until the screen's next frame", async () => {
  const h = harness();
  h.peers.fromHub({ sessionId: "s1", on: true });
  const a = await app(h);
  const tap = { kind: "mouse", action: "down", x: 1, y: 2 } as unknown as BrowserInput;
  h.peers.frame(frame(1, { jpegB64: b64(4, 1) }));
  // The screen stays still: no frame says the takeover, only the hub's browser_control does.
  h.peers.fromHubControl({ sessionId: "s1", control: "human", by: "human:desk" });
  a.input.send(JSON.stringify({ t: "input", input: tap }));
  await until(() => h.inputs.length === 1);
  // Handed back: refused again at once, and the screen's own next frame is what counts from then on.
  h.peers.fromHubControl({ sessionId: "s1", control: "agent", by: "human:desk" });
  a.input.send(JSON.stringify({ t: "input", input: tap }));
  await Bun.sleep(100);
  expect(h.inputs).toHaveLength(1);
  h.peers.fromHubControl({ sessionId: "s1", control: "human", by: "human:desk" });
  h.peers.frame(frame(2, { jpegB64: b64(4, 2), control: "agent" }));
  a.input.send(JSON.stringify({ t: "input", input: tap }));
  await Bun.sleep(100);
  expect(h.inputs).toHaveLength(1);
});

test("an app that goes ends its peer, and the hub hears so", async () => {
  const h = harness();
  h.peers.fromHub({ sessionId: "s1", on: true });
  const a = await app(h);
  a.frames.close();
  await until(() => h.reports.some((r) => r.closed));
  expect(h.peers.peers.size).toBe(0);
  expect(h.reports.find((r) => r.closed)).toMatchObject({ peer: "p1", sessionId: "s1" });
});

test("a close from the hub ends the peer without a report", async () => {
  const h = harness();
  h.peers.fromHub({ sessionId: "s1", on: true });
  await app(h);
  await h.peers.rtc({ sessionId: "s1", peer: "p1" });
  expect(h.peers.peers.size).toBe(0);
  expect(h.reports.filter((r) => r.closed)).toEqual([]);
});

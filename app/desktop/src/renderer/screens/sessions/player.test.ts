import { describe, expect, it } from "vitest";
import { chunkData, readMp4, shownAt, type Track } from "./mp4";
import { type Decoder, type Picture, Replay } from "./player";

// An MP4 as the node writes one (fleetd/src/node/screen/mp4.ts): ftyp, a moov with an avc3 entry, then a moof + mdat a
// frame, timed in ms. Built here box by box, so the reader is held to the layout, not to the writer's code.
const box = (type: string, ...parts: number[][]): number[] => {
  const body = parts.flat();
  const size = 8 + body.length;
  return [(size >>> 24) & 255, (size >>> 16) & 255, (size >>> 8) & 255, size & 255, ...Array.from(new TextEncoder().encode(type)), ...body];
};
const u16 = (n: number) => [(n >> 8) & 255, n & 255];
const u32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const u64 = (n: number) => [...u32(Math.floor(n / 2 ** 32)), ...u32(n >>> 0)];
const full = (type: string, version: number, flags: number, ...parts: number[][]) => box(type, [version, (flags >> 16) & 255, (flags >> 8) & 255, flags & 255], ...parts);
const zeros = (n: number) => new Array<number>(n).fill(0);

function nodeMp4(frames: { at: number; ms: number; key: boolean; byte: number }[], size: [number, number] = [1600, 1126]): Uint8Array {
  const avcC = box("avcC", [1, 0x4d, 0, 0x1f, 0xff, 0xe0, 0]);
  const avc3 = box("avc3", zeros(6), u16(1), zeros(16), u16(size[0]), u16(size[1]), u32(0x00480000), u32(0x00480000), zeros(4), u16(1), zeros(32), u16(0x18), u16(0xffff), avcC);
  const stbl = box("stbl", full("stsd", 0, 0, u32(1), avc3), full("stts", 0, 0, u32(0)), full("stsc", 0, 0, u32(0)), full("stsz", 0, 0, u32(0), u32(0)), full("stco", 0, 0, u32(0)));
  const mdia = box("mdia", full("mdhd", 0, 0, u32(0), u32(0), u32(1000), u32(0), u16(0x55c4), u16(0)), full("hdlr", 0, 0, u32(0), Array.from(new TextEncoder().encode("vide")), zeros(12), [0]), box("minf", stbl));
  const tkhd = full("tkhd", 0, 3, u32(0), u32(0), u32(1), u32(0), u32(0), zeros(52), u32(size[0] << 16), u32(size[1] << 16));
  const out = [...box("ftyp", Array.from(new TextEncoder().encode("iso6")), u32(0)), ...box("moov", full("mvhd", 0, 0, zeros(96)), box("trak", tkhd, mdia), box("mvex", full("trex", 0, 0, u32(1), u32(1), u32(0), u32(0), u32(0))))];
  frames.forEach((f, i) => {
    // One NAL unit: a slice whose one byte names the frame.
    const sample = [0, 0, 0, 2, f.key ? 0x65 : 0x41, f.byte];
    const traf = (offset: number) => box("traf", full("tfhd", 0, 0x020000, u32(1)), full("tfdt", 1, 0, u64(f.at)), full("trun", 0, 0x701, u32(1), u32(offset), u32(f.ms), u32(sample.length), u32(f.key ? 0x02000000 : 0x01010000)));
    const moof = (offset: number) => box("moof", full("mfhd", 0, 0, u32(i + 1)), traf(offset));
    out.push(...moof(moof(0).length + 8), ...box("mdat", sample));
  });
  return Uint8Array.from(out);
}

/** A decoder stand-in: each chunk a picture at its time as soon as it is fed (as a low-latency decoder gives them),
 * and what it was given kept. */
function fakeDecoder() {
  const fed: { type: string; timestamp: number; first: number }[] = [];
  let output: (p: Picture) => void = () => {};
  let pending: { timestamp: number }[] = [];
  const decoder: Decoder = {
    decodeQueueSize: 0,
    state: "unconfigured",
    configure() {
      (decoder as { state: string }).state = "configured";
    },
    decode(c) {
      fed.push({ type: c.type, timestamp: c.timestamp, first: c.data[5] ?? -1 });
      pending.push({ timestamp: c.timestamp });
      drain();
    },
    flush() {
      drain();
      return Promise.resolve();
    },
    reset() {
      pending = [];
    },
    close() {},
  };
  const drain = () => {
    const now = pending;
    pending = [];
    for (const p of now) output({ timestamp: p.timestamp, displayWidth: 1600, displayHeight: 1126, close() {} });
  };
  return { decoder, fed, drain, make: (out: (p: Picture) => void) => ((output = out), decoder) };
}

/** A page's clock and animation frames, both moved by the test. */
function fakePage() {
  let now = 0;
  let frames: (() => void)[] = [];
  return {
    now: () => now,
    frame: (fn: () => void) => void frames.push(fn),
    advance(ms: number, step = 16) {
      for (let t = 0; t < ms; t += step) {
        now += step;
        const run = frames;
        frames = [];
        for (const fn of run) fn();
      }
    },
  };
}

const FRAMES = [
  { at: 500, ms: 40, key: true, byte: 1 },
  { at: 540, ms: 40, key: false, byte: 2 },
  { at: 580, ms: 1_420, key: false, byte: 3 },
  { at: 2_000, ms: 40, key: true, byte: 4 },
  { at: 2_040, ms: 40, key: false, byte: 5 },
  { at: 2_080, ms: 40, key: false, byte: 6 },
  { at: 2_120, ms: 2_880, key: false, byte: 7 },
];

describe("a recording's MP4", () => {
  it("reads the node's fragments as samples on the screen's clock, keyframes marked, Annex B for avc3", () => {
    const file = nodeMp4(FRAMES);
    const track = readMp4(file) as Track;
    expect(track.codec).toBe("avc3.4d001f");
    expect(track.description).toBeUndefined();
    expect([track.width, track.height]).toEqual([1600, 1126]);
    expect(track.samples.map((s) => [s.dts, s.pts, s.key])).toEqual(FRAMES.map((f) => [f.at, f.at, f.key]));
    expect(track.endMs).toBeGreaterThan(2_120);
    expect([...chunkData(file, track, track.samples[1] ?? track.samples[0] ?? { dts: 0, pts: 0, key: false, offset: 0, size: 0 })]).toEqual([0, 0, 0, 1, 0x41, 2]);
  });

  it("stops at a fragment cut short: the frames before it play", () => {
    const file = nodeMp4(FRAMES);
    const track = readMp4(file.subarray(0, file.length - 3)) as Track;
    expect(track.samples.length).toBe(FRAMES.length - 1);
  });

  it("finds the picture shown at a time and the keyframe its decode starts from", () => {
    const track = readMp4(nodeMp4(FRAMES)) as Track;
    expect(shownAt(track.samples, 2_090)).toEqual({ shown: 5, from: 3, pts: 2_080 });
    expect(shownAt(track.samples, 1_000)).toEqual({ shown: 2, from: 0, pts: 580 });
    // Before the first picture: the first.
    expect(shownAt(track.samples, 0)).toEqual({ shown: 0, from: 0, pts: 500 });
  });
});

describe("the screen player's replay", () => {
  const setup = () => {
    const file = nodeMp4(FRAMES);
    const track = readMp4(file) as Track;
    const dec = fakeDecoder();
    const page = fakePage();
    const drawn: number[] = [];
    const times: number[] = [];
    const replay = new Replay(file, track, { draw: () => {} }, { onDraw: (pts) => drawn.push(pts), onTime: (t) => times.push(t) }, { make: dec.make, now: page.now, frame: page.frame });
    return { replay, dec, page, drawn, times };
  };

  it("seeks paused to the picture shown then, decoded from the keyframe before, drawing none on the way", async () => {
    const { replay, dec, drawn } = setup();
    replay.seek(2_100);
    await Promise.resolve();
    await Promise.resolve();
    // Decoded from the keyframe at 2 000: 4, 5, 6 (and 7, past it, while it might reorder); only 6 drawn.
    expect(dec.fed.map((f) => f.first)).toEqual([4, 5, 6]);
    expect(dec.fed[0]?.type).toBe("key");
    expect(drawn).toEqual([2_080]);
  });

  it("plays every picture in order at 1×, then at 4× without decoding anything again, and a seek while playing jumps straight to its picture", async () => {
    const { replay, dec, page, drawn } = setup();
    replay.seek(0);
    await Promise.resolve();
    await Promise.resolve();
    expect(drawn).toEqual([500]);
    replay.play();
    page.advance(700);
    expect(drawn).toEqual([500, 540, 580]);
    const fedBefore = dec.fed.length;
    replay.speed(4);
    page.advance(400);
    // 4× from ~730: past 2 000 within 400 ms, in order (two pictures due in one animation frame show the newer), every
    // one decoded once: the change of speed fed nothing twice.
    expect(drawn.slice(3).at(-1)).toBe(2_120);
    expect(drawn).toEqual([...drawn].sort((a, b) => a - b));
    // (The first, decoded for the paused picture, again as play starts from its keyframe.)
    expect(dec.fed.map((f) => f.first)).toEqual([1, 1, 2, 3, 4, 5, 6, 7]);
    expect(fedBefore).toBeLessThanOrEqual(5);
    // Back to 600 while playing: decoded again from the keyframe at 500, only the picture at 580 on.
    drawn.length = 0;
    replay.seek(600);
    page.advance(32);
    expect(drawn).toEqual([580]);
    // Never a picture from before the time asked for.
    expect(drawn.every((p) => p >= 580)).toBe(true);
  });

  it("past the end (a session longer than its video) shows its last picture, paused", async () => {
    const { replay, dec, page, drawn } = setup();
    replay.play();
    replay.seek(60_000);
    await Promise.resolve();
    await Promise.resolve();
    dec.drain();
    page.advance(16);
    expect(replay.playing()).toBe(false);
    expect(drawn.at(-1)).toBe(2_120);
  });
});

// The screen video's MP4 writer (src/node/screen/mp4.ts): what it writes, frame for frame, and a file a stopped node left
// going on where it ended.
import { afterEach, expect, test } from "bun:test";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fragment, lengthPrefixed, Mp4Writer, nalUnits, resumeAt } from "../src/node/screen/mp4.ts";
import { displayOf } from "../src/node/screen/mac_frames.ts";
import { tempHome } from "./helpers.ts";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const c of cleanups.splice(0)) c();
});

const SPS = [0x67, 0x4d, 0x00, 0x1f, 0xaa];
const PPS = [0x68, 0xee, 0x3c];
const au = (key: boolean, n: number) => Uint8Array.from([...(key ? [0, 0, 0, 1, ...SPS, 0, 0, 1, ...PPS] : []), 0, 0, 0, 1, key ? 0x65 : 0x41, n]);

/** Each top-level box: its type and bytes. */
function boxes(file: Uint8Array): { type: string; bytes: Uint8Array }[] {
  const out: { type: string; bytes: Uint8Array }[] = [];
  const v = new DataView(file.buffer, file.byteOffset, file.length);
  for (let at = 0; at + 8 <= file.length; ) {
    const size = v.getUint32(at);
    out.push({ type: new TextDecoder().decode(file.subarray(at + 4, at + 8)), bytes: file.subarray(at, at + size) });
    at += size;
  }
  return out;
}

test("an Annex B access unit's NAL units, with 3- and 4-byte start codes, become length-prefixed", () => {
  const units = nalUnits(au(true, 7));
  expect(units.map((u) => u[0])).toEqual([0x67, 0x68, 0x65]);
  const prefixed = lengthPrefixed(au(true, 7));
  expect([...prefixed.subarray(0, 4)]).toEqual([0, 0, 0, SPS.length]);
  expect(prefixed.length).toBe(units.reduce((n, u) => n + 4 + u.length, 0));
});

test("frames become one fragment each, timed from the screen's start, the first a keyframe, each written once the next comes", () => {
  const home = tempHome();
  cleanups.push(home.done);
  const path = join(home.dir, "video.mp4");
  writeFileSync(path, "");
  const w = new Mp4Writer((b) => appendFileSync(path, b));
  // A frame before any keyframe decodes to nothing: let go.
  w.frame({ data: au(false, 0), key: false, atMs: 100, size: [640, 1386] });
  expect(w.has()).toBe(false);
  w.frame({ data: au(true, 1), key: true, atMs: 250, size: [640, 1386] });
  w.frame({ data: au(false, 2), key: false, atMs: 290, size: [640, 1386] });
  // Turned: another size, its own parameter sets in the stream, the same track.
  w.frame({ data: au(true, 3), key: true, atMs: 1_000, size: [1386, 640] });
  w.end(4_000);
  const file = readFileSync(path);
  const all = boxes(file);
  expect(all.map((b) => b.type)).toEqual(["ftyp", "moov", "moof", "mdat", "moof", "mdat", "moof", "mdat"]);
  const moov = Buffer.from(all[1]!.bytes);
  expect(moov.includes(Buffer.from("avc3"))).toBe(true);
  expect(moov.includes(Buffer.from("avcC"))).toBe(true);
  expect(resumeAt(path)).toEqual({ sequence: 3, endMs: 4_000, bytes: file.length });
  // Each fragment says its start, its length and whether it is a keyframe.
  const third = fragment(3, 1_000, 3_000, true, lengthPrefixed(au(true, 3)));
  expect(Buffer.from(file.subarray(file.length - third.length)).equals(Buffer.from(third))).toBe(true);
});

test("a file cut short mid-fragment goes on from its last whole one", () => {
  const home = tempHome();
  cleanups.push(home.done);
  const path = join(home.dir, "video.mp4");
  writeFileSync(path, "");
  const w = new Mp4Writer((b) => appendFileSync(path, b));
  w.frame({ data: au(true, 1), key: true, atMs: 0, size: [640, 1386] });
  w.frame({ data: au(false, 2), key: false, atMs: 40, size: [640, 1386] });
  w.end(80);
  const whole = readFileSync(path).length;
  // The node stopped while writing the next: half a moof.
  appendFileSync(path, fragment(3, 80, 40, false, lengthPrefixed(au(false, 3))).subarray(0, 30));
  expect(resumeAt(path)).toEqual({ sequence: 2, endMs: 80, bytes: whole });
  expect(resumeAt(join(home.dir, "none.mp4"))).toBeUndefined();
});

test("fleetd-frames' display word reads as the display it shows", () => {
  expect(displayOf("display primary-1 3 2853 2007")).toEqual({ name: "primary-1", orientation: 3, width: 2853, height: 2007 });
  expect(displayOf("display - 0 1206 2622")).toEqual({ name: "", orientation: 0, width: 1206, height: 2622 });
  expect(displayOf("input")).toBeUndefined();
});

// A screen's picture as its encoder takes it (NV12, only what changed converted again) and the fixed rules its frame
// rate follows: src/node/screen/nv12.ts, src/node/screen/live.ts.
import { expect, test } from "bun:test";
import { BURST, BUSY, fpsFor, HARDWARE_FPS, KBIT_PER_FRAME, Pace, VERY_BUSY } from "../src/node/screen/live.ts";
import { Nv12 } from "../src/node/screen/nv12.ts";

/** A BGRA screen of one colour ([r, g, b]). */
const screen = (w: number, h: number, [r, g, b]: number[]) => {
  const out = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) out.set([b!, g!, r!, 255], i * 4);
  return out;
};

test("NV12 is BT.601 limited range, as ffmpeg's own conversion makes it, at the screen's size cut to even", () => {
  const nv12 = new Nv12();
  const yuv = (rgb: number[]) => {
    const p = nv12.update(screen(5, 3, rgb), 5, 3);
    return [p[0], p[nv12.width * nv12.height], p[nv12.width * nv12.height + 1]];
  };
  expect(yuv([0, 0, 0])).toEqual([16, 128, 128]);
  expect(yuv([255, 255, 255])).toEqual([235, 128, 128]);
  expect(yuv([255, 0, 0])).toEqual([82, 90, 240]);
  expect([nv12.width, nv12.height]).toEqual([4, 2]);
  expect(nv12.data.length).toBe((4 * 2 * 3) / 2);
});

test("only the box that changed is converted again, out to whole 2x2s; a new size converts it all", () => {
  const [w, h] = [8, 6];
  const nv12 = new Nv12();
  const black = screen(w, h, [0, 0, 0]);
  nv12.update(black, w, h);
  // The whole screen turns white, but the grab says only (3, 1)..(4, 2) changed: that 2x2's luma, and its even box
  // (2, 0)..(6, 4), is what moves.
  const white = screen(w, h, [255, 255, 255]);
  const p = nv12.update(white, w, h, [3, 1, 5, 3]);
  const lumaWhite = [...p.subarray(0, w * h)].map((v, i) => [i % w, Math.floor(i / w), v]).filter(([, , v]) => v === 235).map(([x, y]) => `${x},${y}`);
  expect(lumaWhite).toEqual(["2,0", "3,0", "4,0", "5,0", "2,1", "3,1", "4,1", "5,1", "2,2", "3,2", "4,2", "5,2", "2,3", "3,3", "4,3", "5,3"]);
  // Another size: all of it, whatever the box says.
  const q = nv12.update(screen(4, 4, [255, 255, 255]), 4, 4, [0, 0, 1, 1]);
  expect([...q.subarray(0, 16)].every((v) => v === 235)).toBe(true);
});

test("the frame rate follows the screen's encoder, the watchers' link and the machine's load by fixed steps", () => {
  // Hardware, a link that keeps up, an idle machine: 60.
  expect(fpsFor(HARDWARE_FPS, 2_500, 0)).toBe(60);
  // x264's 30, whatever the link carries past it.
  expect(fpsFor(30, 2_500, 0)).toBe(30);
  // A link gives each frame KBIT_PER_FRAME at least: 800 kbit/s is 20 frames, 560 is 14, so 10.
  expect(fpsFor(60, 20 * KBIT_PER_FRAME, 0)).toBe(20);
  expect(fpsFor(60, 560, 0)).toBe(10);
  expect(fpsFor(60, 50, 0)).toBe(5);
  // JPEG (no bit rate): the link doesn't cut it here, its frames are fitted as they go.
  expect(fpsFor(30, undefined, 0)).toBe(30);
  // A busy machine halves it, a very busy one takes a third.
  expect(fpsFor(30, undefined, BUSY - 0.01)).toBe(30);
  expect(fpsFor(30, undefined, BUSY)).toBe(15);
  expect(fpsFor(60, undefined, BUSY)).toBe(30);
  expect(fpsFor(30, undefined, VERY_BUSY)).toBe(10);
  // What the watcher asked for, at the step at or under it.
  expect(fpsFor(60, undefined, 0, 24)).toBe(20);
  expect(fpsFor(10, undefined, 0, 60)).toBe(10);
});

test("frames are paced at the rate with two in reserve: a change alone goes at once, only frames sent spend", () => {
  const gap = 33;
  const pace = new Pace(0, gap);
  // After a quiet spell, BURST frames go back to back; the next waits a whole gap, and a run goes one a gap.
  for (let i = 0; i < BURST; i++) {
    expect(pace.waitMs(0, gap)).toBe(0);
    pace.spend(0, gap);
  }
  expect(pace.waitMs(0, gap)).toBe(gap);
  expect(pace.waitMs(10, gap)).toBe(gap - 10);
  pace.spend(gap, gap);
  expect(pace.waitMs(gap, gap)).toBe(gap);
  // Reads that found nothing spend nothing: the next change after them goes at once.
  expect(pace.waitMs(gap * 3, gap)).toBe(0);
  // The reserve is BURST frames at most, however long the quiet.
  pace.spend(10_000, gap);
  pace.spend(10_000, gap);
  expect(pace.waitMs(10_000, gap)).toBe(gap);
});

// x264 for live views without a hardware encoder (src/node/screen/x264.ts): its FLV read into Annex B frames however
// the chunks cut it, and, where the pinned ffmpeg is at hand, a real encoder's frames.
import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { chmodSync, writeFileSync } from "node:fs";
import { encoderArgs, FlvReader, kbpsFor, LiveEncoder, paramSets, X264, type Encoded } from "../src/node/screen/x264.ts";
import { tempHome } from "./helpers.ts";

/** An FLV as ffmpeg writes it: header, then tags (11-byte header, data, previous tag size). */
function flv(tags: { type: number; data: number[] }[]): Uint8Array {
  const out = [0x46, 0x4c, 0x56, 1, 1, 0, 0, 0, 9, 0, 0, 0, 0];
  for (const t of tags) {
    const n = t.data.length;
    out.push(t.type, (n >> 16) & 255, (n >> 8) & 255, n & 255, 0, 0, 0, 0, 0, 0, 0, ...t.data, 0, 0, (n + 11) >> 8, (n + 11) & 255);
  }
  return Uint8Array.from(out);
}

const SPS = [0x67, 0x64, 0x00, 0x28];
const PPS = [0x68, 0xee];
const record = [1, 0x64, 0, 0x28, 0xff, 0xe1, 0, SPS.length, ...SPS, 1, 0, PPS.length, ...PPS];

test("FLV's video tags come out as Annex B access units, the parameter sets before each keyframe, however the chunks fall", () => {
  expect(paramSets(Uint8Array.from(record)).map((p) => [...p])).toEqual([SPS, PPS]);
  const frames: Encoded[] = [];
  const r = new FlvReader((f) => frames.push({ data: Uint8Array.from(f.data), key: f.key }));
  const stream = flv([
    { type: 18, data: [2, 0, 4] },
    { type: 9, data: [0x17, 0, 0, 0, 0, ...record] },
    { type: 9, data: [0x17, 1, 0, 0, 0, 0, 0, 0, 2, 0x65, 0x88] },
    { type: 9, data: [0x27, 1, 0, 0, 0, 0, 0, 0, 2, 0x41, 0x9a, 0, 0, 0, 1, 0x41] },
  ]);
  for (let i = 0; i < stream.length; i += 7) r.push(stream.subarray(i, i + 7));
  expect(frames.map((f) => [f.key, [...f.data]])).toEqual([
    [true, [0, 0, 0, 1, ...SPS, 0, 0, 0, 1, ...PPS, 0, 0, 0, 1, 0x65, 0x88]],
    [false, [0, 0, 0, 1, 0x41, 0x9a, 0, 0, 0, 1, 0x41]],
  ]);
  expect(() => new FlvReader(() => {}).push(new Uint8Array(13))).toThrow("not FLV");
});

test("the encoder's arguments: raw pixels or JPEGs in, no B-frames, no keyframe but the first, the bit rate bounded", () => {
  const raw = encoderArgs({ raw: [1280, 800] }, 1000);
  expect(raw.slice(raw.indexOf("-f"), raw.indexOf("-f") + 6)).toEqual(["-f", "rawvideo", "-pix_fmt", "bgra", "-s", "1280x800"]);
  expect(raw).toContain("zerolatency");
  expect(raw.join(" ")).toContain("-g 100000 -bf 0 -crf 26 -maxrate 1000k -bufsize 500k");
  expect(raw.at(-2)).toBe("flv");
  const jpeg = encoderArgs({ jpeg: [1280, 800] }, 2500);
  expect(jpeg.slice(jpeg.indexOf("-f"), jpeg.indexOf("-f") + 2)).toEqual(["-f", "mjpeg"]);
});

// The pinned ffmpeg, where a node has fetched it (Android's, the same file) or $FLEETD_TEST_FFMPEG names it: a real
// encoder, one frame out per frame in.
const ffmpeg = process.env.FLEETD_TEST_FFMPEG ?? join(process.env.HOME ?? "", ".fleetd/node/device/ffmpeg/ffmpeg-6.0.1-amd64-static/ffmpeg");
test.skipIf(!existsSync(ffmpeg))("a real x264 makes a keyframe first, then one frame for each frame in, each as it comes", async () => {
  const frames: Encoded[] = [];
  const x = new X264(ffmpeg, { raw: [64, 48] }, 500, (f) => frames.push(f));
  const screen = new Uint8Array(64 * 48 * 4);
  for (let i = 0; i < 5; i++) {
    screen.fill(i * 40);
    x.put(screen);
    const deadline = Date.now() + 5_000;
    while (frames.length <= i && Date.now() < deadline) await Bun.sleep(2);
  }
  x.stop();
  expect(frames.map((f) => f.key)).toEqual([true, false, false, false, false]);
  expect([...frames[0]!.data.subarray(0, 5)]).toEqual([0, 0, 0, 1, 0x67]);
});

test("a live view's encoder: JPEG until ffmpeg is here, a new encoder for a keyframe, a new size or a bit rate half again off, JPEG for good once one fails", async () => {
  const home = tempHome();
  // A stand-in ffmpeg: each run notes its arguments, then reads its input and says nothing (no frames: enough here).
  const runs = join(home.dir, "runs");
  const ff = join(home.dir, "ffmpeg");
  writeFileSync(runs, "");
  writeFileSync(ff, `#!/bin/sh\necho "$*" >> "${runs}"\ncat > /dev/null\n`);
  chmodSync(ff, 0o755);
  let fetched: (path: string) => void = () => {};
  const failed: string[] = [];
  const e = new LiveEncoder(() => new Promise((r) => (fetched = r)), () => {}, (why) => failed.push(why));
  const frame = new Uint8Array(16);
  const raw = { raw: [2, 2] as [number, number] };
  expect(e.put(raw, frame, undefined)).toBe(false);
  fetched(ff);
  await Bun.sleep(5);
  const started = () => readFileSync(runs, "utf8").trim().split("\n").filter(Boolean);
  const until = async (n: number) => {
    for (let i = 0; i < 500 && started().length < n; i++) await Bun.sleep(5);
  };
  expect(e.put(raw, frame, undefined)).toBe(true);
  await until(1);
  expect(started()[0]).toContain(`-maxrate ${kbpsFor(undefined)}k`);
  // The same: one encoder. A keyframe asked, a new size, a much slower link: a new one each.
  e.put(raw, frame, undefined);
  e.key();
  e.put(raw, frame, undefined);
  await until(2);
  e.put({ raw: [4, 2] }, frame, undefined);
  await until(3);
  e.put({ raw: [4, 2] }, frame, 1000);
  await until(4);
  e.put({ raw: [4, 2] }, frame, 900);
  await Bun.sleep(50);
  expect(started().length).toBe(4);
  expect(started()[3]).toContain("-maxrate 700k");
  e.stop();

  // One that fails: the screen sends JPEG from then on, and says why once.
  writeFileSync(ff, "#!/bin/sh\necho 'Unknown encoder libx264' >&2\nexit 1\n");
  const broken = new LiveEncoder(async () => ff, () => {}, (why) => failed.push(why));
  broken.put(raw, frame, undefined);
  await Bun.sleep(5);
  expect(broken.put(raw, frame, undefined)).toBe(true);
  for (let i = 0; i < 500 && !failed.length; i++) await Bun.sleep(5);
  expect(failed).toEqual(["Unknown encoder libx264"]);
  expect(broken.put(raw, frame, undefined)).toBe(false);
  home.done();
});

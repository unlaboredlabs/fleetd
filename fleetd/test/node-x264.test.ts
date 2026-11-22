// x264 for live views without a hardware encoder (src/node/screen/x264.ts): its FLV read into Annex B frames however
// the chunks cut it, and, where the pinned ffmpeg is at hand, a real encoder's frames.
import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { chmodSync, writeFileSync } from "node:fs";
import { encoderArgs, FlvReader, KEY_EVERY, kbpsFor, LiveEncoder, paramSets, X264, type Encoded } from "../src/node/screen/x264.ts";
import { avcConfig, H264Video, mkvFrame, nalUnits } from "../src/node/browser/recording.ts";
import { Mp4Sink } from "../src/node/browser/record.ts";
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

test("the encoder's arguments: raw pixels or JPEGs in, no B-frames, a keyframe each KEY_EVERY frames, the bit rate bounded", () => {
  const raw = encoderArgs({ raw: [1280, 800] }, 1000);
  expect(raw.slice(raw.indexOf("-f"), raw.indexOf("-f") + 6)).toEqual(["-f", "rawvideo", "-pix_fmt", "bgra", "-s", "1280x800"]);
  expect(raw).toContain("zerolatency");
  expect(raw.join(" ")).toContain(`-g ${KEY_EVERY} -bf 0 -crf 26 -maxrate 1000k -bufsize 500k`);
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

test("a video of H.264 starts at a keyframe with its parameter sets as the track's, each frame shown until the next, the last until the end", async () => {
  const sps = [0x67, 0x64, 0x00, 0x28, 0xac];
  const pps = [0x68, 0xee, 0x3c];
  expect(nalUnits(Uint8Array.from([0, 0, 0, 1, ...sps, 0, 0, 1, ...pps, 0, 0, 0, 1, 0x65, 0x88])).map((u) => [...u])).toEqual([sps, pps, [0x65, 0x88]]);
  expect([...avcConfig(Uint8Array.from(sps), Uint8Array.from(pps))]).toEqual([1, 0x64, 0x00, 0x28, 0xff, 0xe1, 0, 5, ...sps, 1, 0, 3, ...pps]);
  const written: Uint8Array[] = [];
  let ended = false;
  const v = new H264Video({ write: (b) => void written.push(Uint8Array.from(b)), end: async () => ((ended = true), undefined) });
  const key = Uint8Array.from([0, 0, 0, 1, ...sps, 0, 0, 0, 1, ...pps, 0, 0, 0, 1, 0x65, 0x88]);
  const delta = Uint8Array.from([0, 0, 0, 1, 0x41, 0x9a]);
  // A frame before any keyframe can't be shown: nothing yet.
  v.frame(delta, false, [64, 48], 0);
  expect(written).toEqual([]);
  v.frame(key, true, [64, 48], 100);
  // The header, with the track's AVC record; the keyframe waits to know how long it shows.
  expect(written.length).toBe(1);
  expect(Buffer.from(written[0]!).includes(Buffer.from("V_MPEG4/ISO/AVC"))).toBe(true);
  expect(Buffer.from(written[0]!).includes(Buffer.from(avcConfig(Uint8Array.from(sps), Uint8Array.from(pps))))).toBe(true);
  v.frame(delta, false, [64, 48], 340);
  // Same time again: a millisecond later, as each frame must be.
  v.frame(delta, false, [64, 48], 340);
  // Each frame as NAL units after their lengths, shown until the next.
  expect(written.slice(1)).toEqual([mkvFrame(Uint8Array.from([0, 0, 0, 5, ...sps, 0, 0, 0, 3, ...pps, 0, 0, 0, 2, 0x65, 0x88]), 100, 240, true), mkvFrame(Uint8Array.from([0, 0, 0, 2, 0x41, 0x9a]), 340, 1, false)]);
  expect(await v.finish(1_000)).toBeUndefined();
  expect(ended).toBe(true);
  expect(written.at(-1)).toEqual(mkvFrame(Uint8Array.from([0, 0, 0, 2, 0x41, 0x9a]), 341, 659, false));
  // A frame that isn't a keyframe says it refers to one before it.
  expect(Buffer.from(mkvFrame(Uint8Array.of(1), 0, 1, false)).includes(Buffer.from([0xfb, 0x81, 0xff]))).toBe(true);
  expect(Buffer.from(mkvFrame(Uint8Array.of(1), 0, 1, true)).includes(Buffer.from([0xfb, 0x81, 0xff]))).toBe(false);
  // One that never saw a keyframe has no video.
  const none = new H264Video({ write: () => {}, end: async () => undefined });
  none.frame(delta, false, [64, 48], 0);
  expect(await none.finish(10)).toBe("the screen sent no keyframe");
});

test.skipIf(!existsSync(ffmpeg))("a real x264's frames copied into an MP4 play back whole, at the times they were put, a keyframe each KEY_EVERY frames", async () => {
  const home = tempHome();
  const out = join(home.dir, "video.mp4");
  const sink = new Mp4Sink(ffmpeg, out);
  let n = 0;
  const keys: number[] = [];
  const x = new X264(ffmpeg, { raw: [64, 48] }, 500, (f, atMs) => {
    if (f.key) keys.push(n);
    n++;
    sink.frame(f.data, f.key, [64, 48], atMs);
  });
  // A screen that changes a little each frame (no scene cut): only the keyframe interval makes keyframes.
  const screen = new Uint8Array(64 * 48 * 4);
  const count = 2 * KEY_EVERY + 1;
  for (let i = 0; i < count; i++) {
    screen.fill(128);
    screen.fill(255, (i % 48) * 64 * 4, ((i % 48) + 1) * 64 * 4);
    x.put(screen, i * 10);
    const deadline = Date.now() + 5_000;
    while (n <= i && Date.now() < deadline) await Bun.sleep(1);
  }
  x.stop();
  expect(await sink.finish(count * 10 + 1_000)).toBeUndefined();
  // Decoded again: every frame, the last shown until the end, and a keyframe to seek to each KEY_EVERY frames.
  const decoded = (extra: string[]) =>
    Bun.spawnSync([ffmpeg, "-v", "error", ...extra, "-i", out, "-fps_mode", "passthrough", "-f", "framemd5", "-"], { stdout: "pipe" })
      .stdout.toString()
      .split("\n")
      .filter((l) => /^0,/.test(l)).length;
  expect(decoded([])).toBe(count);
  expect(keys[0]).toBe(0);
  expect(Math.max(...keys.slice(1).map((k, i) => k - keys[i]!), count - keys.at(-1)!)).toBeLessThanOrEqual(KEY_EVERY);
  expect(decoded(["-skip_frame", "nokey"])).toBe(keys.length);
  const info = Bun.spawnSync([ffmpeg, "-i", out], { stderr: "pipe" }).stderr.toString();
  expect(info).toContain("Video: h264");
  expect(info).toMatch(/Duration: 00:00:04\.0/);
  home.done();
});

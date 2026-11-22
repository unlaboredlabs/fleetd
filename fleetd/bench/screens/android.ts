// An Android screen measured on this machine with the node's own pieces (src/node/device): the pinned SDK installed
// into a home of the bench's own (the first run downloads ~1.5 GB and makes the snapshot: the cold start), an emulator
// booted from that snapshot (the warm start), scrcpy's H.264 stream decoded into JPEGs as the live view gets them, and
// a person's touches through scrcpy's control socket. Prints one JSON line.
//
//   bun bench/screens/android.ts <home>      (Linux x86_64 with KVM; <home> is kept between runs)
import { adb, install, sdkAt } from "../../src/node/device/sdk.ts";
import { spawnEmulator, waitBooted } from "../../src/node/device/emulator.ts";
import { Stream } from "../../src/node/device/scrcpy.ts";
import { CpuSpan, nextFrame, rate, round, type Seen, settle, spread } from "./meter.ts";

const home = process.argv[2];
if (!home) throw new Error("usage: bun bench/screens/android.ts <home>");
const t0 = performance.now();
await install(home);
const installMs = performance.now() - t0;
// The snapshot's boot started an adb server on the node's port: this bench's, so it ends it (never a running node's:
// it checks that no node's own SDK is in use first by keeping to its own home).
await Bun.spawn([sdkAt(home).adb, "-P", "15037", "kill-server"], { stdout: "ignore", stderr: "ignore" }).exited;
// Its own adb server, apart from any node's.
const sdk = { ...sdkAt(home), adbPort: 15099 };
const pids: number[] = [];

const tBoot = performance.now();
const emulator = spawnEmulator(sdk, 5730, true);
pids.push(emulator.pid);
await waitBooted(sdk, emulator.serial, emulator, 180_000);
const bootMs = performance.now() - tBoot;

const frames: Seen[] = [];
let h264 = 0;
const tStream = performance.now();
const stream = await Stream.start(sdk, emulator.serial, false, sdk.ffmpeg, tStream, (f) => frames.push({ at: performance.now(), bytes: f.jpeg.length, wire: f.jpeg.length }));
// The H.264 that comes off the device, as a passthrough would send it.
const video = (stream as unknown as { video: { data: { onData: (c: Uint8Array) => void } } }).video;
const write = video.data.onData;
video.data.onData = (c) => {
  h264 += c.length;
  write(c);
};
await nextFrame(frames, 30_000);
const firstFrameMs = performance.now() - tStream;
const [w, h] = stream.size() ?? [720, 1600];

await settle(frames, 1000, 10_000);
let span = new CpuSpan(() => pids);
let from = performance.now();
let h0 = h264;
await Bun.sleep(5_000);
const idle = { ...rate(frames, from, performance.now()), h264PerSec: (h264 - h0) / 5, cpu: span.end() };

// Moving: the home screen's app drawer dragged up and down by a finger, as a person would.
span = new CpuSpan(() => pids);
from = performance.now();
h0 = h264;
const until = performance.now() + 5_000;
for (let up = true; performance.now() < until; up = !up) {
  const [y0, y1] = up ? [h * 0.8, h * 0.3] : [h * 0.3, h * 0.8];
  stream.send({ kind: "touch", action: "down", x: w / 2, y: y0 });
  for (let i = 1; i <= 10; i++) {
    stream.send({ kind: "touch", action: "move", x: w / 2, y: y0 + ((y1 - y0) * i) / 10 });
    await Bun.sleep(16);
  }
  stream.send({ kind: "touch", action: "up", x: w / 2, y: y1 });
  await Bun.sleep(150);
}
const secs = (performance.now() - from) / 1000;
const active = { ...rate(frames, from, performance.now()), h264PerSec: (h264 - h0) / secs, cpu: span.end() };
await adb(sdk, emulator.serial, ["shell", "input", "keyevent", "KEYCODE_HOME"]);
await settle(frames, 1000, 10_000);

// Input to pixel: a tap on the home screen's search bar area, Back after; each shows a change.
const taps: number[] = [];
for (let i = 0; i < 6; i++) {
  await settle(frames, 400, 5_000);
  const at = performance.now();
  stream.send({ kind: "touch", action: "down", x: w / 2, y: h * 0.5 });
  stream.send({ kind: "touch", action: "move", x: w / 2, y: h * 0.25 });
  stream.send({ kind: "touch", action: "up", x: w / 2, y: h * 0.25 });
  const f = await nextFrame(frames, 3_000);
  taps.push(f ? f.at - at : Number.NaN);
  await Bun.sleep(600);
  await adb(sdk, emulator.serial, ["shell", "input", "keyevent", "KEYCODE_HOME"]);
}

console.log(
  JSON.stringify({
    kind: "android",
    size: [w, h],
    startup: { installMs: round(installMs), bootMs: round(bootMs), firstFrameMs: round(firstFrameMs) },
    idle: { fps: round(idle.fps, 1), bytesPerSec: round(idle.bytesPerSec), h264PerSec: round(idle.h264PerSec), cpu: { node: round(idle.cpu.node, 1), screen: round(idle.cpu.screen, 1) } },
    active: {
      fps: round(active.fps, 1),
      kbPerFrame: round(active.meanBytes / 1024, 1),
      bytesPerSec: round(active.bytesPerSec),
      h264PerSec: round(active.h264PerSec),
      cpu: { node: round(active.cpu.node, 1), screen: round(active.cpu.screen, 1) },
    },
    inputToPixel: { swipe: spread(taps) },
  }),
);
stream.stop();
emulator.kill();
// The bench's own adb server goes with it (started on its own port, never a node's).
await adb(sdk, emulator.serial, ["kill-server"]).catch(() => undefined);
process.exit(0);

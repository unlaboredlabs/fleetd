// An iOS simulator's screen on the agents' Mac, its parts (node/device/ios/screen.ts, sim_screen.ts): the
// screenshot loop, a person's gestures as agent-device commands, their queue against a stand-in agent-device, and
// simctl's recording against a stand-in. Nothing here starts a real simulator, and none of it needs a Mac.
import { afterEach, expect, test } from "bun:test";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Input } from "../src/node/device/scrcpy.ts";
import { coalesce, commandArgs, Gestures, Hands, heldBy, inSession, type Runner, Shooter } from "../src/node/device/ios/screen.ts";
import { fileGrowing, screenName, startRecording } from "../src/node/device/ios/sim_screen.ts";
import type { StreamFrame } from "../src/node/screen/mac_frames.ts";
import { recordingStarted } from "../src/node/device/ios/simctl.ts";
import { tempHome } from "./helpers.ts";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
});

/** Waits until `ok`, 5 s at most. */
const until = async (ok: () => boolean) => {
  const deadline = Date.now() + 5_000;
  while (!ok()) {
    if (Date.now() > deadline) throw new Error("timed out");
    await Bun.sleep(2);
  }
};
const touch = (action: "down" | "up" | "move", x: number, y: number): Input => ({ kind: "touch", action, x, y });
/** A JPEG as far as its size goes: 640×1386, with `tag` making each one's bytes differ. */
const jpeg = (tag: number) => Uint8Array.from([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x05, 0x6a, 0x02, 0x80, 0x03, 0, 0, 0, 0, 0, 0, 0, 0, 0, tag, 0xff, 0xd9]);

test("a tap is a press in points, a drag a swipe and a hold a longpress", () => {
  const g = new Gestures(3);
  expect(g.feed(touch("down", 300, 600), 0)).toBeUndefined();
  expect(g.feed(touch("up", 303, 600), 80)).toEqual(["press", "100", "200"]);
  g.feed(touch("down", 300, 1500), 0);
  expect(g.feed(touch("move", 300, 1000), 50)).toBeUndefined();
  expect(g.feed(touch("up", 300, 600), 200)).toEqual(["swipe", "100", "500", "100", "200"]);
  g.feed(touch("down", 30, 30), 0);
  expect(g.feed(touch("up", 30, 30), 1000)).toEqual(["longpress", "10", "10"]);
  expect(g.feed(touch("up", 30, 30), 0)).toBeUndefined();
});

test("the wheel swipes against it, keys have their commands, and typed text is never a flag", () => {
  const g = new Gestures(3);
  // Scrolling down drags the content up.
  expect(g.feed({ kind: "scroll", x: 600, y: 1500, dx: 0, dy: 300 }, 0)).toEqual(["swipe", "200", "500", "200", "400"]);
  const key = (k: string, down: boolean): Input => ({ kind: "key", down, key: k, modifiers: 0 });
  expect(g.feed(key("Enter", true), 0)).toEqual(["keyboard", "return"]);
  expect(g.feed(key("Enter", false), 0)).toBeUndefined();
  expect(g.feed(key("BrowserHome", true), 0)).toEqual(["home"]);
  expect(g.feed(key("F13", true), 0)).toBeUndefined();
  const typed = g.feed({ kind: "text", text: "-rf --help" }, 0)!;
  // agent-device reads `type -x` as an unknown flag, and everything after `--` as text: the device's flags go before it.
  expect(commandArgs(typed, "U1")).toEqual(["type", "--platform", "ios", "--udid", "U1", "--", "-rf --help"]);
  expect(commandArgs(["keyboard", "return"], "U1")).toEqual(["keyboard", "--platform", "ios", "--udid", "U1", "return"]);
});

test("scrolls and typing that piled up go as one", () => {
  const scroll = (dy: number): Input => ({ kind: "scroll", x: 10, y: 20, dx: 0, dy });
  expect(coalesce([scroll(100), scroll(50), { kind: "text", text: "ab" }, { kind: "text", text: "c" }, touch("down", 1, 1), scroll(-10)])).toEqual([
    scroll(150),
    { kind: "text", text: "abc" },
    touch("down", 1, 1),
    scroll(-10),
  ]);
});

/**
 * A stand-in for agent-device that, as agent-device 0.21.31 does, refuses every input until a session is open on the
 * simulator (`open`), and logs each command it is given.
 */
function standIn(dir: string): Runner {
  const wrapper = join(dir, "agent-device");
  writeFileSync(
    wrapper,
    `#!/bin/sh
echo "$*" >> "$LOG"
if [ "$1" = open ]; then touch "$OPENED"; echo 'Opened: default'; exit 0; fi
if [ ! -e "$OPENED" ]; then echo 'Error (SESSION_NOT_FOUND): No active session. Run open first.' >&2; exit 1; fi
`,
  );
  chmodSync(wrapper, 0o755);
  return { wrapper, env: { PATH: process.env.PATH ?? "/usr/bin:/bin", LOG: join(dir, "log"), OPENED: join(dir, "opened") }, udid: "U1" };
}

test("a person's taps, drags and typing reach a simulator no agent opened a session on, through its agent-device", async () => {
  const home = tempHome();
  cleanups.push(home.done);
  const ran: string[] = [];
  const hands = new Hands(standIn(home.dir), 3, (args, r) => ran.push(`${args[0]} ${r.ok ? "ok" : "failed"}`));
  cleanups.push(() => hands.stop());
  for (const input of [touch("down", 300, 600), touch("up", 300, 600), { kind: "text", text: "hi" } as Input, touch("down", 300, 1500), touch("up", 300, 600)]) {
    expect(hands.send(input)).toBe(true);
  }
  const deadline = Date.now() + 20_000;
  const log = join(home.dir, "log");
  while ((existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").length : 0) < 5 && Date.now() < deadline) await Bun.sleep(20);
  await hands.idle();
  expect(readFileSync(log, "utf8").trim().split("\n")).toEqual([
    "press --platform ios --udid U1 100 200",
    "open --platform ios --udid U1",
    "press --platform ios --udid U1 100 200",
    "type --platform ios --udid U1 -- hi",
    "swipe --platform ios --udid U1 100 500 100 200",
  ]);
  expect(ran).toEqual(["press ok", "type ok", "swipe ok"]);
  // Handed back: the session the person's inputs opened closes, so the agent's own `open` isn't refused.
  hands.release();
  await hands.idle();
  expect(readFileSync(log, "utf8").trim().split("\n").at(-1)).toBe("close --platform ios --udid U1");
  hands.stop();
  expect(hands.send(touch("down", 1, 1))).toBe(false);
});

/**
 * agent-device 0.21.31 on a simulator the agent opened from its job folder: its session holds the simulator, an `open`
 * from any other folder (the node's) is refused naming it, and only a command that names it (`--session`) goes.
 */
function agentsSession(dir: string, name: string): Runner {
  const wrapper = join(dir, "agent-device");
  writeFileSync(
    wrapper,
    `#!/bin/sh
echo "$*" >> "$LOG"
case "$*" in *"--session ${name}"*) exit 0 ;; esac
if [ "$1" = open ]; then echo 'Error (DEVICE_IN_USE): Device is already in use by workspace session "${name}".' >&2; exit 1; fi
echo 'Error (SESSION_NOT_FOUND): No active session. Run open first.' >&2; exit 1
`,
  );
  chmodSync(wrapper, 0o755);
  return { wrapper, env: { PATH: process.env.PATH ?? "/usr/bin:/bin", LOG: join(dir, "log") }, udid: "U1" };
}

test("a person's taps reach a simulator the agent's own session holds: in that session, by name", async () => {
  const home = tempHome();
  cleanups.push(home.done);
  const ran: string[] = [];
  const hands = new Hands(agentsSession(home.dir, "cwd:f659d6f3f36057dc:ios"), 3, (args, r) => ran.push(`${args.join(" ")} ${r.ok ? "ok" : "failed"}`));
  cleanups.push(() => hands.stop());
  for (const input of [touch("down", 300, 600), touch("up", 300, 600), { kind: "text", text: "-x" } as Input]) hands.send(input);
  const log = join(home.dir, "log");
  const deadline = Date.now() + 20_000;
  while ((existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").length : 0) < 4 && Date.now() < deadline) await Bun.sleep(20);
  await hands.idle();
  hands.release();
  await hands.idle();
  expect(readFileSync(log, "utf8").trim().split("\n")).toEqual([
    "press --platform ios --udid U1 100 200",
    "open --platform ios --udid U1",
    "press --platform ios --udid U1 --session cwd:f659d6f3f36057dc:ios 100 200",
    // Remembered: the next input goes straight to it, and hand-back closes nothing of the agent's.
    "type --platform ios --udid U1 --session cwd:f659d6f3f36057dc:ios -- -x",
  ]);
  // The screen's log keeps the person's command as they made it.
  expect(ran).toEqual(["press 100 200 ok", "type -- -x ok"]);
});

test("agent-device's refusal names the session holding the simulator", () => {
  expect(heldBy('Error (DEVICE_IN_USE): Device is already in use by workspace session "cwd:8a5edab282632443:ios".\nHint: …')).toBe("cwd:8a5edab282632443:ios");
  expect(heldBy("Error (SESSION_NOT_FOUND): No active session.")).toBeUndefined();
  expect(commandArgs(inSession(["type", "--", "hi"], "s1"), "U1")).toEqual(["type", "--platform", "ios", "--udid", "U1", "--session", "s1", "--", "hi"]);
  expect(inSession(["home"], undefined)).toEqual(["home"]);
});

test("the live view shoots only while someone watches, at most one frame each 100 ms, and skips a still screen", async () => {
  let watching = true;
  let shots = 0;
  const gaps: number[] = [];
  const frames: { seq: number; width: number; height: number }[] = [];
  // Three shots of one screen, then a change.
  const shooter = new Shooter(
    async () => jpeg(++shots < 4 ? 1 : 2),
    performance.now(),
    () => watching,
    (f) => frames.push({ seq: f.seq, width: f.width, height: f.height }),
    async (ms) => {
      gaps.push(ms);
      if (shots >= 5) watching = false;
    },
  );
  shooter.run();
  shooter.run();
  const deadline = Date.now() + 5_000;
  while (watching && Date.now() < deadline) await Bun.sleep(5);
  await Bun.sleep(10);
  expect(shots).toBe(5);
  expect(frames).toEqual([
    { seq: 1, width: 640, height: 1386 },
    { seq: 2, width: 640, height: 1386 },
  ]);
  // Each wait makes the gap since the shot began up to 100 ms.
  expect(gaps.every((g) => g > 0 && g <= 100)).toBe(true);
  // Nobody watches: the loop has ended; a new watcher starts it again.
  watching = true;
  shooter.run();
  while (watching && Date.now() < deadline) await Bun.sleep(5);
  expect(shots).toBe(6);
  // Stopped for good: it never shoots again.
  shooter.stop();
  watching = true;
  shooter.run();
  await Bun.sleep(20);
  expect(shots).toBe(6);
});

test("the live view streams the simulator's frames while someone watches, a still for a new watcher, and screenshots once the stream fails", async () => {
  let watching = true;
  let shots = 0;
  const frames: { seq: number; width: number; height: number }[] = [];
  const asked: string[] = [];
  let onFrame: (f: StreamFrame) => void = () => {};
  const send = (data: Uint8Array, w: number, h: number) => onFrame({ kind: "jpeg", key: true, screen: [w, h], data });
  let end: (why: string) => void = () => {};
  let starts = 0;
  const shooter = new Shooter(
    async () => jpeg(100 + ++shots),
    performance.now(),
    () => watching,
    (f) => frames.push({ seq: f.seq, width: f.width, height: f.height }),
    (ms) => Bun.sleep(Math.min(ms, 5)),
    async (fn) => {
      starts += 1;
      onFrame = fn;
      return { still: () => asked.push("still"), tell: () => {}, stop: () => asked.push("stop"), ended: new Promise<string | undefined>((r) => (end = r)) };
    },
  );
  shooter.run();
  await until(() => starts === 1);
  // Frames as the stream sends them, sized in the screen's pixels whatever the picture's: the same one twice is one.
  send(jpeg(1), 1206, 2622);
  send(jpeg(1), 1206, 2622);
  send(jpeg(2), 1206, 2622);
  expect(frames).toEqual([
    { seq: 1, width: 1206, height: 2622 },
    { seq: 2, width: 1206, height: 2622 },
  ]);
  expect(shots).toBe(0);
  // Another watcher meanwhile: the screen now, at once.
  shooter.run();
  expect(asked).toEqual(["still"]);
  // Nobody watches: the stream stops; a watcher again starts a new one.
  watching = false;
  await until(() => asked.includes("stop"));
  watching = true;
  shooter.run();
  await until(() => starts === 2);
  // The stream dies (the private framework moved, say): screenshots from then on, for good.
  end("fleetd-frames: no simulator service");
  await until(() => shots > 0);
  watching = false;
  await Bun.sleep(30);
  watching = true;
  shooter.run();
  await Bun.sleep(30);
  expect(starts).toBe(2);
  shooter.stop();
});

test("with every watcher decoding H.264 the stream sends it, the screen anew when a frame was lost, its bit rate under the links' budget", async () => {
  const told: string[] = [];
  let onFrame: (f: StreamFrame) => void = () => {};
  const frames: { seq: number; jpeg: number; video?: { key: boolean; bytes: number } }[] = [];
  let watching = true;
  const shooter = new Shooter(
    async () => jpeg(1),
    performance.now(),
    () => watching,
    (f) => frames.push({ seq: f.seq, jpeg: f.jpeg.length, ...(f.video ? { video: { key: f.video.key, bytes: f.video.data.length } } : {}) }),
    (ms) => Bun.sleep(Math.min(ms, 5)),
    async (fn) => {
      onFrame = fn;
      return { still: () => told.push("still"), tell: (c) => told.push(c), stop: () => {}, ended: new Promise<string | undefined>(() => {}) };
    },
  );
  // Asked before the stream runs: told as it starts.
  shooter.want(true, undefined);
  shooter.run();
  await until(() => told.length > 0);
  // VideoToolbox's 60 frames a second; a slow link (560 kbit/s of H.264) 10.
  expect(told).toEqual(["h264", "kbps 2500", "fps 60"]);
  onFrame({ kind: "jpeg", key: true, screen: [1206, 2622], data: jpeg(1) });
  onFrame({ kind: "h264", key: true, screen: [1206, 2622], data: new Uint8Array(900) });
  onFrame({ kind: "h264", key: false, screen: [1206, 2622], data: new Uint8Array(40) });
  // H.264 is never skipped as the same picture.
  onFrame({ kind: "h264", key: false, screen: [1206, 2622], data: new Uint8Array(40) });
  expect(frames).toEqual([
    { seq: 1, jpeg: 24 },
    { seq: 2, jpeg: 0, video: { key: true, bytes: 900 } },
    { seq: 3, jpeg: 0, video: { key: false, bytes: 40 } },
    { seq: 4, jpeg: 0, video: { key: false, bytes: 40 } },
  ]);
  told.length = 0;
  shooter.key();
  // A slow watcher's link (800 kbit/s): the video takes 70% of it. One that can't decode H.264: JPEG again.
  shooter.want(true, 800);
  shooter.want(false, undefined);
  expect(told).toEqual(["still", "h264", "kbps 560", "fps 10", "jpeg", "kbps 2500"]);
  watching = false;
  shooter.stop();
});

test("a stream that can't start (no swiftc) falls back to screenshots", async () => {
  let shots = 0;
  const shooter = new Shooter(
    async () => jpeg(++shots),
    performance.now(),
    () => shots < 3,
    () => {},
    (ms) => Bun.sleep(Math.min(ms, 5)),
    async () => {
      throw new Error("fleetd-frames did not build: xcrun: error: unable to find utility swiftc");
    },
  );
  shooter.run();
  await until(() => shots >= 3);
  shooter.stop();
});

test("a failed screenshot waits a second before the next, and the screen's name is its device and agent", async () => {
  let shots = 0;
  const gaps: number[] = [];
  const shooter = new Shooter(
    async () => {
      shots += 1;
      throw new Error("Invalid device state");
    },
    performance.now(),
    () => shots < 2,
    () => {},
    async (ms) => void gaps.push(ms),
  );
  shooter.run();
  await Bun.sleep(20);
  expect(gaps[0]).toBeGreaterThan(900);
  expect(screenName("iPhone 17 on iOS 26.1", "T3965")).toBe("iPhone 17 · T3965");
});

test("simctl's recording is stopped with SIGINT only once it has started, and says when it wrote no video", async () => {
  const home = tempHome();
  cleanups.push(home.done);
  // A stand-in recordVideo: says it started, and on SIGINT writes its file and ends.
  const script = join(home.dir, "record");
  writeFileSync(
    script,
    `#!/bin/sh
trap 'printf video > "$1"; exit 0' INT
echo "Recording started"
while :; do sleep 0.05; done
`,
  );
  chmodSync(script, 0o755);
  const path = join(home.dir, "r", "video.mp4");
  const recording = startRecording([script, path], path, recordingStarted);
  expect(await recording.finish()).toBeUndefined();
  expect(readFileSync(path, "utf8")).toBe("video");
  // One that ends without a file says so.
  const empty = join(home.dir, "empty");
  writeFileSync(empty, "#!/bin/sh\necho 'Recording started'\nexit 0\n");
  chmodSync(empty, 0o755);
  expect(await startRecording([empty, join(home.dir, "none.mp4")], join(home.dir, "none.mp4"), recordingStarted).finish()).toBe("simctl wrote no video");
  expect(fileGrowing(undefined, 10)).toBe(false);
  expect(fileGrowing(10, 20)).toBe(true);
  expect(fileGrowing(20, 20)).toBe(false);
});

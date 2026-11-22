// node/desktop: Linux desktop sessions, against stand-ins only. The X server is test/fake_x.ts (in this process, or
// as the fake Xvfb a display starts), the container runtime a shell script; no real X server, window manager, xdotool
// or docker ever runs, and every socket and lock file is under $TMPDIR.
import { afterEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { broker, start as startBrowser } from "../src/node/browser/index.ts";
import { DOCKERFILE, image, Runtime } from "../src/node/desktop/container.ts";
import { xauth } from "../src/node/desktop/display.ts";
import {
  CAP_SESSION_DESKTOP,
  capabilities,
  Desktops,
  desktopConfig,
  enabled,
  forgetRuntimeCheck,
  healthOf,
  recordingsDir,
  hostCheck,
  start as startDesktop,
  worktreeMount,
} from "../src/node/desktop/index.ts";
import { bmp, jpeg } from "../src/node/desktop/screen.ts";
import { NO_VIDEO, Session, SETTLE } from "../src/node/desktop/session.ts";
import type { MakeEncoder } from "../src/node/screen/live.ts";
import { recordingsDir as iosSimRecordingsDir } from "../src/node/device/ios/sim_screen.ts";
import { Masker } from "../src/node/mask.ts";
import { charKeysym, keysym, parseChord, X } from "../src/node/desktop/x11.ts";
import { router } from "../src/node/device/router.ts";
import { start as startRoute } from "../src/node/session_route/index.ts";
import { cookieOf, FakeX } from "./fake_x.ts";
import { noSharedPlaywright, tempHome } from "./helpers.ts";
import { testNode } from "./node_helpers.ts";

noSharedPlaywright();

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
});

const scratch = () => {
  const home = tempHome();
  cleanups.push(home.done);
  return home.dir;
};

const until = async (what: string, ok: () => boolean, ms = 15_000) => {
  const end = Date.now() + ms;
  while (!ok()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(10);
  }
};

async function fakeX(dir: string, opts: { damage?: boolean } = {}) {
  const cookie = crypto.getRandomValues(new Uint8Array(16));
  const server = new FakeX(cookie, 64, 40, opts.damage ?? true);
  const socket = join(dir, "X5");
  await server.listen(socket);
  cleanups.push(() => server.close());
  return { server, socket, cookie };
}

test("keys go by their xdotool names, browser names or characters", () => {
  expect(keysym("Return")).toBe(0xff0d);
  expect(keysym("enter")).toBe(0xff0d);
  expect(keysym("ArrowLeft")).toBe(0xff51);
  expect(keysym("F5")).toBe(0xffc2);
  expect(keysym("F25")).toBeUndefined();
  expect(keysym("a")).toBe(0x61);
  expect(keysym("é")).toBe(0xe9);
  expect(keysym("nope")).toBeUndefined();
  expect(charKeysym("\n")).toBe(0xff0d);
  expect(charKeysym("€")).toBe(0x0100_0000 | 0x20ac);
  expect(parseChord("ctrl+shift+t")).toEqual([0xffe3, 0xffe1, 0x74]);
  expect(parseChord("+")).toEqual([0x2b]);
  expect(() => parseChord("ctrl+")).toThrow("names an empty key");
  expect(() => parseChord("hyper+x")).toThrow("is not a key name");
});

test("the cookie file names the cookie for any display", () => {
  const cookie = new Uint8Array(16).fill(7);
  const file = xauth(cookie);
  expect([...file.subarray(0, 2)]).toEqual([0xff, 0xff]);
  expect(Buffer.from(file).includes(Buffer.from("MIT-MAGIC-COOKIE-1"))).toBe(true);
  expect([...cookieOf(file)]).toEqual([...cookie]);
});

test("the pinned image is tagged by its Dockerfile, from a base pinned by digest", () => {
  expect(image()).toMatch(/^localhost\/fleetd-desktop:[0-9a-f]{12}$/);
  expect(DOCKERFILE).toContain("@sha256:");
});

test("a container sees only the session's own worktree, read-only", () => {
  const home = scratch();
  const runtime = Runtime.find("/usr/bin/podman", home)!;
  expect(runtime.podman).toBe(true);
  const args = runtime.runArgs("fleetd-desktop-x", "img", "/d/x11", "/d/xauth", "/w/repo");
  expect(args.slice(0, 6)).toEqual(["run", "-d", "--rm", "--init", "--name", "fleetd-desktop-x"]);
  expect(args).toContain("/w/repo:/w/repo:ro");
  expect(args).toContain("/d/xauth:/fleetd/xauth:ro");
  expect(args).toContain("--userns=keep-id");
  expect(args.at(-1)).toBe("img");
  expect(args).toContain(`fleetd.desktop=${runtime.label}`);
  const worktree = join(home, "repo");
  mkdirSync(worktree);
  expect(worktreeMount("container", false, worktree)).toBe(worktree);
  expect(worktreeMount("xvfb", false, worktree)).toBeUndefined();
  expect(worktreeMount("container", true, worktree)).toBeUndefined();
  expect(worktreeMount("container", false, "/")).toBeUndefined();
  expect(worktreeMount("container", false, join(home, "gone"))).toBeUndefined();
});

test("a screen's pixels go to a JPEG by Bun's own encoder, red as red", async () => {
  const red = new Uint8Array(16 * 8 * 4);
  for (let i = 0; i < red.length; i += 4) red[i + 2] = 255;
  expect(bmp(red, 16, 8).length).toBe(54 + red.length);
  const out = await jpeg(red, 16, 8);
  expect([...out.subarray(0, 3)]).toEqual([0xff, 0xd8, 0xff]);
  const meta = await new Bun.Image(out).metadata();
  expect([meta.width, meta.height, meta.format]).toEqual([16, 8, "jpeg"]);
});

test("the node's X connection reads the screen and types, clicks and scrolls through XTEST", async () => {
  const dir = scratch();
  const { server, socket, cookie } = await fakeX(dir);
  await expect(X.connect(socket, new Uint8Array(16))).rejects.toThrow("refused the connection");
  const x = await X.connect(socket, cookie);
  cleanups.push(() => x.close());
  expect(x.size()).toEqual([64, 40]);
  // Changed until the first grab reads it.
  expect(x.changed()).toBe(true);
  await x.grabRaw();
  expect(x.changed()).toBe(false);
  server.paint(10, 20, 30);
  await until("damage", () => x.changed());
  const shot = await x.grab();
  expect([shot.width, shot.height]).toEqual([64, 40]);
  expect([...shot.jpeg.subarray(0, 2)]).toEqual([0xff, 0xd8]);

  await x.click(10, 12, 1, 2);
  expect(server.inputs).toEqual([
    { type: 6, detail: 0, x: 10, y: 12 },
    { type: 4, detail: 1, x: 0, y: 0 },
    { type: 5, detail: 1, x: 0, y: 0 },
    { type: 4, detail: 1, x: 0, y: 0 },
    { type: 5, detail: 1, x: 0, y: 0 },
  ]);
  expect(await x.pointer()).toEqual([10, 12]);
  server.inputs.length = 0;
  // Off the screen: clamped to its edge.
  await x.scroll(500, -3, 0, -2);
  expect(server.inputs.map((i) => [i.type, i.detail])).toEqual([[6, 0], [4, 4], [5, 4], [4, 4], [5, 4]]);
  expect(server.pointer).toEqual([63, 0]);

  server.inputs.length = 0;
  await x.typeText("aB!");
  const shift = server.codeOf(0xffe1)!;
  const a = server.codeOf(0x61)!;
  const b = server.codeOf(0x62)!;
  // `!` isn't on the keyboard: bound to a free keycode while typed.
  const bang = server.codeOf(0x21)!;
  expect(bang).toBeGreaterThan(200);
  expect(server.inputs.map((i) => [i.type, i.detail])).toEqual([
    [2, a], [3, a],
    [2, shift], [2, b], [3, b], [3, shift],
    [2, bang], [3, bang],
  ]);
  server.inputs.length = 0;
  await x.chord("ctrl+a");
  const ctrl = server.codeOf(0xffe3)!;
  expect(server.inputs.map((i) => [i.type, i.detail])).toEqual([[2, ctrl], [2, a], [3, a], [3, ctrl]]);
  await expect(x.chord("hyper+x")).rejects.toThrow("is not a key name");
});

test("with DAMAGE a grab reads only what changed, patched into the screen before, and a change wakes a wait", async () => {
  const dir = scratch();
  const { server, socket, cookie } = await fakeX(dir);
  server.paint(0, 0, 200);
  const x = await X.connect(socket, cookie);
  cleanups.push(() => x.close());
  const first = await x.grabRaw();
  expect(server.pixelsRead).toBe(64 * 40);
  expect([...first.data.subarray(0, 4)]).toEqual([0, 0, 200, 0]);

  // A wait for a change ends with the change, long before its time.
  const waited = performance.now();
  const woke = x.nextChange!(5_000);
  server.paint(255, 0, 0, [10, 5, 4, 3]);
  server.paint(255, 0, 0, [20, 30, 2, 2]);
  await woke;
  expect(performance.now() - waited).toBeLessThan(1_000);
  await until("both boxes", () => x.changed());
  await Bun.sleep(20);
  const before = server.pixelsRead;
  const patched = await x.grabRaw();
  // The two boxes' bounding box only: 12 wide (10..22), 27 tall (5..32).
  expect(server.pixelsRead - before).toBe(12 * 27);
  expect([...patched.data]).toEqual([...server.pixels]);
  expect(x.changed()).toBe(false);

  // A window moved: no DamageNotify, but the root's structure changed, so the next grab reads it whole.
  const moved = server.pixelsRead;
  server.moveWindow(0, 255, 0, [30, 20, 6, 6]);
  await until("the move", () => x.changed());
  expect([...(await x.grabRaw()).data]).toEqual([...server.pixels]);
  expect(server.pixelsRead - moved).toBe(64 * 40);
  // An agent's screenshot reads the whole screen and leaves a change to the capture loop's next grab.
  server.paint(7, 7, 7, [1, 1, 1, 1]);
  await until("damage", () => x.changed());
  await x.grab();
  expect(x.changed()).toBe(true);
  await x.grabRaw();
  // Nothing changed: no read at all, the same screen; and a wait runs out.
  const still = server.pixelsRead;
  expect([...(await x.grabRaw()).data]).toEqual([...server.pixels]);
  expect(server.pixelsRead).toBe(still);
  await x.nextChange!(10);
  // `whole` reads every pixel again.
  await x.grabRaw(true);
  expect(server.pixelsRead - still).toBe(64 * 40);
  // Each grab says which rows really changed: a whole read of a screen that changed in one pixel, that pixel's row; a
  // read of a box that was painted the same again, none.
  server.paint(1, 2, 3, [5, 7, 1, 1]);
  await until("damage", () => x.changed());
  expect((await x.grabRaw(true)).changed).toEqual([0, 7, 64, 8]);
  server.paint(1, 2, 3, [5, 7, 1, 1]);
  await until("damage", () => x.changed());
  expect((await x.grabRaw()).changed).toBeNull();
  expect((await x.grabRaw()).changed).toBeNull();
  server.paint(9, 9, 9, [2, 3, 4, 2]);
  await until("damage", () => x.changed());
  expect((await x.grabRaw()).changed).toEqual([2, 3, 6, 5]);
});

test("a watched desktop sends a frame when its screen changes, read as only the part that changed, and none while still", async () => {
  const dir = scratch();
  const { server, socket, cookie } = await fakeX(dir);
  const x = await X.connect(socket, cookie);
  const lent = { launch: async () => ({ pid: 0 }), drop: async () => {} };
  const session = new Session(lent, x, { id: "d1", thread: "t1", cwd: dir, purpose: "watch", secrets: [], kind: "linux_desktop" });
  cleanups.push(() => void session.close());
  const frames: { seq: number; at: number }[] = [];
  session.open();
  session.setWatcher({ kbps: undefined, send: (f) => frames.push({ seq: f.seq, at: performance.now() }) });
  await until("the first frame", () => frames.length > 0);
  await Bun.sleep(300);
  const still = frames.length;
  const read = server.pixelsRead;
  await Bun.sleep(300);
  expect(frames.length).toBe(still);
  expect(server.pixelsRead).toBe(read);
  server.paint(255, 0, 0, [3, 4, 5, 6]);
  await until("the changed screen's frame", () => frames.length > still);
  expect(server.pixelsRead - read).toBe(5 * 6);
  // Still SETTLE after that, it is read whole once (what DAMAGE doesn't tell shows then), and not again.
  await until("the settle read", () => server.pixelsRead - read === 5 * 6 + 64 * 40);
  await Bun.sleep(SETTLE + 100);
  expect(server.pixelsRead - read).toBe(5 * 6 + 64 * 40);
});

test("a desktop's grabs go to its H.264 encoder for a watcher that decodes it; a key request sends the screen anew, newer than every frame, and a budget told again sends nothing", async () => {
  const dir = scratch();
  const { server, socket, cookie } = await fakeX(dir);
  const x = await X.connect(socket, cookie);
  const lent = { launch: async () => ({ pid: 0 }), drop: async () => {} };
  // A stand-in encoder: each grab is a frame at once, the first after a key request a keyframe.
  const asked: string[] = [];
  let keyNext = true;
  const encoder: MakeEncoder = (onFrame) => ({
    key: () => void (asked.push("key"), (keyNext = true)),
    put: (input, data) => {
      onFrame({ data: data.subarray(0, 4), key: keyNext }, input, 0);
      keyNext = false;
      return true;
    },
    stop: () => {},
  });
  const session = new Session(lent, x, { id: "d2", thread: "t1", cwd: dir, purpose: "watch", secrets: [], kind: "linux_desktop", encoder });
  cleanups.push(() => void session.close());
  const frames: { seq: number; h264: boolean; key: boolean }[] = [];
  session.open();
  session.setWatcher({ kbps: undefined, video: true, send: (f) => frames.push({ seq: f.seq, h264: f.h264B64 !== undefined, key: f.key === true }) });
  await until("the first H.264 frame", () => frames.some((f) => f.h264));
  server.paint(255, 0, 0, [3, 4, 5, 6]);
  await until("a delta", () => frames.filter((f) => f.h264).length >= 2);
  const sent = frames.length;
  const newest = Math.max(...frames.map((f) => f.seq));
  // A budget told again: nothing.
  session.setBudget(5_000, true);
  await Bun.sleep(100);
  expect(frames.length).toBe(sent);
  // A lost frame: the screen now as a JPEG, under a seq past every frame sent, and the next H.264 a keyframe.
  session.key();
  await until("the screen anew", () => frames.length > sent);
  expect(frames[sent]).toMatchObject({ h264: false });
  expect(frames[sent]!.seq).toBeGreaterThan(newest);
  server.paint(0, 255, 0, [3, 4, 5, 6]);
  await until("the next H.264 frame", () => frames.slice(sent + 1).some((f) => f.h264));
  expect(frames.slice(sent + 1).find((f) => f.h264)).toMatchObject({ key: true });
  expect(asked).toEqual(["key", "key"]);
});

test("a Linux desktop encodes each grab once: its video is the encoder's H.264, and a JPEG is made only for a watcher that needs one", async () => {
  const dir = scratch();
  const { server, socket, cookie } = await fakeX(dir);
  const x = await X.connect(socket, cookie);
  let jpegs = 0;
  const encode = x.encode.bind(x);
  x.encode = (raw) => (jpegs++, encode(raw));
  const lent = { launch: async () => ({ pid: 0 }), drop: async () => {} };
  // A stand-in encoder that takes a moment to be ready (its ffmpeg fetched), then makes each grab a frame at once.
  let keyNext = true;
  const encoder: MakeEncoder = (onFrame) => ({
    key: () => void (keyNext = true),
    put: (input, data, _kbps, atMs) => {
      onFrame({ data: data.subarray(0, 4), key: keyNext }, input, atMs ?? 0);
      keyNext = false;
      return true;
    },
    stop: () => {},
    ready: () => Bun.sleep(30).then(() => true),
  });
  const recorded: { kind: "jpeg" | "h264"; key?: boolean; atMs: number }[] = [];
  const recording = {
    append: () => {},
    filled: () => {},
    end: async () => ({ files: [] }),
    video: {
      frame: (_jpeg: Uint8Array, atMs: number) => void recorded.push({ kind: "jpeg", atMs }),
      h264: (_au: Uint8Array, key: boolean, _size: [number, number], atMs: number) => (recorded.push({ kind: "h264", key, atMs }), true),
      tick: () => {},
      finish: async () => undefined,
    },
  };
  const session = new Session(lent, x, { id: "d3", thread: "t1", cwd: dir, purpose: "record", secrets: [], kind: "linux_desktop", encoder, recording });
  cleanups.push(() => void session.close());
  session.open();
  // Nobody watches: the video gets H.264 from the first grab on, and nothing is made a JPEG.
  await until("the first H.264 frame recorded", () => recorded.length > 0);
  server.paint(255, 0, 0, [3, 4, 5, 6]);
  await until("a second", () => recorded.length > 1);
  expect(recorded.every((r) => r.kind === "h264")).toBe(true);
  expect(recorded[0]!.key).toBe(true);
  expect(recorded[1]!.atMs).toBeGreaterThan(recorded[0]!.atMs);
  expect(jpegs).toBe(0);

  // A watcher that decodes H.264: the screen now, made a JPEG of the last grab only now, then the same encoder's frames.
  const frames: { seq: number; h264: boolean; key: boolean }[] = [];
  session.setWatcher({ kbps: undefined, video: true, send: (f) => frames.push({ seq: f.seq, h264: f.h264B64 !== undefined, key: f.key === true }) });
  await until("the screen now", () => frames.length > 0);
  expect(frames[0]).toMatchObject({ h264: false });
  expect(jpegs).toBe(1);
  server.paint(0, 255, 0, [3, 4, 5, 6]);
  await until("an H.264 frame", () => frames.some((f) => f.h264));
  expect(frames.find((f) => f.h264)).toMatchObject({ key: true });
  expect(jpegs).toBe(1);
  const both = recorded.length;
  expect(recorded.at(-1)!.kind).toBe("h264");

  // A watcher that can't decode it: a JPEG for each change, and the video still the encoder's.
  session.setBudget(undefined, false);
  server.paint(0, 0, 255, [3, 4, 5, 6]);
  await until("a JPEG", () => frames.at(-1)?.h264 === false && jpegs > 1);
  await until("its frame recorded", () => recorded.length > both);
  expect(recorded.every((r) => r.kind === "h264")).toBe(true);
});

test("a slow H.264 viewer gets an encode of its own at its link's rate, and the video keeps its own; back on a fast link, the video's again from a keyframe", async () => {
  const dir = scratch();
  const { server, socket, cookie } = await fakeX(dir);
  const x = await X.connect(socket, cookie);
  const lent = { launch: async () => ({ pid: 0 }), drop: async () => {} };
  // Stand-in encoders, each noting the bit rate it was put at and marking its frames; each one's first frame a keyframe.
  type Made = { n: number; kbps: (number | undefined)[]; stopped: boolean };
  const made: Made[] = [];
  const encoder: MakeEncoder = (onFrame) => {
    const me: Made = { n: made.length, kbps: [], stopped: false };
    made.push(me);
    let keyNext = true;
    return {
      key: () => void (keyNext = true),
      put: (input, _data, kbps, atMs) => {
        me.kbps.push(kbps);
        onFrame({ data: Uint8Array.of(me.n), key: keyNext }, input, atMs ?? 0);
        keyNext = false;
        return true;
      },
      stop: () => void (me.stopped = true),
      ready: async () => true,
    };
  };
  const recorded: number[] = [];
  const recording = {
    append: () => {},
    filled: () => {},
    end: async () => ({ files: [] }),
    video: { frame: () => {}, h264: (au: Uint8Array) => (recorded.push(au[0]!), true), tick: () => {}, finish: async () => undefined },
  };
  const session = new Session(lent, x, { id: "d4", thread: "t1", cwd: dir, purpose: "slow", secrets: [], kind: "linux_desktop", encoder, recording });
  cleanups.push(() => void session.close());
  session.open();
  await until("the video's first frame", () => recorded.length > 0);
  const frames: { from: number; key: boolean }[] = [];
  const paint = (i: number) => server.paint(i * 20, 0, 0, [3, 4, 5, 6]);
  // A link of 1 Mbit/s: H.264 at 700 kbit/s, far under the video's 2.5 Mbit/s.
  session.setWatcher({ kbps: 1_000, video: true, send: (f) => f.h264B64 && frames.push({ from: Buffer.from(f.h264B64, "base64")[0]!, key: f.key === true }) });
  for (let i = 1; !frames.some((f) => f.from === 1) && i < 200; i++) {
    paint(i);
    await Bun.sleep(40);
  }
  // Its own encoder (the second made) at the link's rate, from a keyframe; the video's still at its own (undefined:
  // the most), and only the video's frames recorded.
  expect(made).toHaveLength(2);
  expect(made[1]!.kbps.every((k) => k === 1_000)).toBe(true);
  expect(made[0]!.kbps.every((k) => k === undefined)).toBe(true);
  expect(frames.find((f) => f.from === 1)).toMatchObject({ key: true });
  expect(recorded.every((n) => n === 0)).toBe(true);
  // A fast link again: the watcher's encoder stops, and its frames are the video's from the video's next keyframe.
  session.setBudget(undefined, true);
  const at = frames.length;
  for (let i = 1; !frames.slice(at).some((f) => f.from === 0) && i < 200; i++) {
    paint(i + 100);
    await Bun.sleep(40);
  }
  expect(made[1]!.stopped).toBe(true);
  expect(frames.slice(at).find((f) => f.from === 0)).toMatchObject({ key: true });
});

test("without DAMAGE the screen counts as changed at every look", async () => {
  const dir = scratch();
  const { socket, cookie } = await fakeX(dir, { damage: false });
  const x = await X.connect(socket, cookie);
  cleanups.push(() => x.close());
  expect(x.changed()).toBe(true);
  await x.grabRaw();
  expect(x.changed()).toBe(true);
  // It can't say when the screen changes: the session reads it on a timer.
  expect(x.nextChange).toBeUndefined();
});

/** A fake `docker` that answers `info` as given, and a fake Xvfb starting test/fake_x.ts. */
function fakes(dir: string, dockerInfo: "ok" | "fail") {
  const bin = join(dir, "bin");
  mkdirSync(bin, { recursive: true });
  const docker = join(bin, "docker");
  writeFileSync(
    docker,
    `#!/bin/sh\ncase "$1" in info) ${dockerInfo === "ok" ? "echo ok; exit 0" : 'echo "Cannot connect to the Docker daemon" >&2; exit 1'};; *) exit 1;; esac\n`,
  );
  chmodSync(docker, 0o755);
  const xvfb = join(bin, "Xvfb");
  writeFileSync(xvfb, `#!/bin/sh\nexec "${process.execPath}" "${join(import.meta.dir, "fake_x.ts")}" "$@"\n`);
  chmodSync(xvfb, 0o755);
  const x11 = join(dir, "x11");
  const locks = join(dir, "locks");
  mkdirSync(x11, { recursive: true });
  mkdirSync(locks, { recursive: true });
  process.env.FAKE_X11_DIR = x11;
  process.env.FAKE_X_LOCK_DIR = locks;
  return { docker, xvfb, x11, locks };
}

test("health says what desktop sessions run in, and why not", async () => {
  if (process.platform !== "linux") return;
  const dir = scratch();
  const { docker, xvfb } = fakes(dir, "fail");
  forgetRuntimeCheck();
  const both = await healthOf(dir, { runtime: docker, xvfb });
  expect(both).toMatchObject({ state: "ready", backend: "xvfb" });
  expect(both!.message).toContain("not in containers: `docker info` failed: Cannot connect");
  forgetRuntimeCheck();
  // Nothing works: said, with what to install, on every Linux machine (no switch asks for them).
  const nothing = await healthOf(dir, { runtime: docker, backend: "container" });
  expect(nothing).toMatchObject({ state: "unavailable", backend: "container" });
  expect(nothing!.fix).toContain("xvfb");
  expect(await hostCheck(dir, { runtime: docker, backend: "container" })).toMatchObject({ host: "desktop", ready: false, off: "missing", idleMinutes: 30 });
  // Where the node lends none (the agents' Mac, the hub's runner): none, and it can't.
  expect(await healthOf(dir, { enabled: false, xvfb })).toBeUndefined();
  const none = await hostCheck(dir, { enabled: false });
  expect(none).toMatchObject({ host: "desktop", ready: false, off: "unsupported", idleMinutes: 30 });
  expect(none).not.toHaveProperty("on");
  const ok = fakes(dir, "ok");
  forgetRuntimeCheck();
  expect(await healthOf(dir, { runtime: ok.docker })).toMatchObject({ state: "ready", backend: "container" });
});

test("the heartbeat's load.desktop says what desktop sessions run in, as Rust's node/load.rs does", async () => {
  if (process.platform !== "linux") return;
  const dir = scratch();
  const { xvfb, x11, locks } = fakes(dir, "fail");
  const t = testNode("devbox", { desktop: { backend: "xvfb", xvfb, x11Dir: x11, lockDir: locks, windowManagers: [], pool: 0 } });
  cleanups.push(t.done);
  forgetRuntimeCheck();
  const d = startDesktop(t.node);
  cleanups.push(() => d.shutdown());
  const hb = { load: { cpus: 4, load1: 0, limits: [] }, steps: [] as unknown[], busy: { threads: 0, screens: 0, uploads: 0, hosted: 0 } };
  await t.node.area("hb").fill(hb as never);
  expect((hb.load as { desktop?: unknown }).desktop).toMatchObject({ state: "ready", backend: "xvfb" });
});

test("an agent opens a desktop, screenshots, clicks, types and launches on it, a person takes over, and it ends", async () => {
  if (process.platform !== "linux") return;
  const dir = scratch();
  const { xvfb, x11, locks } = fakes(dir, "fail");
  const t = testNode("devbox", {
    desktop: { backend: "xvfb", xvfb, x11Dir: x11, lockDir: locks, windowManagers: [], pool: 0 },
  });
  cleanups.push(t.done);
  const reports: Record<string, unknown>[] = [];
  const parts: Record<string, unknown>[] = [];
  t.link.answer = async (op, args) => {
    if (op === "session_route") return { runner: "devbox", here: true };
    if (op === "browser_session") reports.push(args);
    if (op === "browser_recording_part") {
      parts.push(args);
      return { bytes: Number(args.offset) + Buffer.from(String(args.dataB64), "base64").length };
    }
    return {};
  };
  // The agent session's secret: its recording never holds it, in any form a page or a log shows it.
  t.node.area("sessions", () => ({
    maskFor: () => new Masker(),
    secretsFor: (thread: string) => (thread === "thread-1" ? [["DEPLOY_TOKEN", "tok-hunter2-secret"]] : []),
    sessionCwd: () => undefined,
  }));
  startBrowser(t.node);
  startRoute(t.node);
  const d = startDesktop(t.node);
  cleanups.push(() => broker(t.node).shutdown());
  cleanups.push(() => d.shutdown());
  expect(router(t.node).desktops).toBe(d);
  // An Xvfb is there: the hello lists desktop sessions before the first one prepares them, and the node links anew.
  let relinks = 0;
  t.node.area("caps").onChanged(() => relinks++);
  expect(await capabilities(t.node)).toEqual([CAP_SESSION_DESKTOP]);
  await d.refreshCaps();
  expect(t.node.area("caps").list()).toContain(CAP_SESSION_DESKTOP);
  expect(relinks).toBeLessThanOrEqual(1);

  // The session starts in the agent's own working directory, as its call's frame names it: its apps start there.
  const worktree = join(dir, "worktree");
  mkdirSync(worktree, { recursive: true });
  const local = (op: string, call: Record<string, unknown>) =>
    t.node.area("local").answer("thread-1", { id: op, cwd: worktree, call: { ...call, op } }) as Promise<{ result?: Record<string, unknown> }>;
  const started = (await local("session_start", { kind: "linux_desktop", purpose: "check the app" })).result!;
  expect(started).toMatchObject({ op: "session_start", desktop: "xvfb" });
  const id = String(started.sessionId);
  expect(id).toMatch(/^B[0-9a-f]{32}$/);
  expect(reports.at(-1)).toMatchObject({ sessionId: id, kind: "linux_desktop", state: "live", threadId: "thread-1" });
  expect(router(t.node).live("thread-1")).toBe(true);
  expect(await capabilities(t.node)).toEqual([CAP_SESSION_DESKTOP]);
  // Another start of the same agent's is refused.
  await expect(t.local.call("session_start", { kind: "linux_desktop", purpose: "again" }, "thread-1")).rejects.toThrow("is open");

  const shot = (await t.local.call("desktop", { action: "screenshot" }, "thread-1")) as Record<string, unknown>;
  expect(shot).toMatchObject({ op: "desktop", message: "The screen, 1280x800.", width: 1280, height: 800 });
  expect(Buffer.from(String(shot.jpegB64), "base64").subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]));
  expect(await t.local.call("desktop", { action: "left_click", coordinate: [5, 6] }, "thread-1")).toMatchObject({ message: "left_click at (5, 6)." });
  expect(await t.local.call("desktop", { action: "cursor_position" }, "thread-1")).toMatchObject({ message: "The mouse is at (5, 6)." });
  expect(await t.local.call("desktop", { action: "type", text: "hi" }, "thread-1")).toMatchObject({ message: "Typed 2 characters." });
  await t.local.call("desktop", { action: "type", text: "tok-hunter2-secret" }, "thread-1");
  await expect(t.local.call("desktop", { action: "mouse_move" }, "thread-1")).rejects.toThrow("mouse_move needs coordinate");
  const launched = (await t.local.call("desktop", { action: "launch", text: "echo $DISPLAY on $HOME; exit 3" }, "thread-1")) as { message: string };
  expect(launched.message).toMatch(/exited at once with code 3: :\d+ on .*\/home/);
  expect((await local("desktop", { action: "launch", text: "pwd; exit 4" })).result?.message).toBe(`\`pwd; exit 4\` exited at once with code 4: ${worktree}`);
  const running = (await t.local.call("desktop", { action: "launch", text: "sleep 30" }, "thread-1")) as { message: string };
  expect(running.message).toMatch(/^Started `sleep 30` \(pid \d+\)/);

  // The hub watches: the newest frame goes at once, as a browser's do.
  t.link.deliver({ t: "browser_watch", sessionId: id, on: true });
  await until("a frame", () => t.link.sent.some((f) => f.t === "browser_frame" && f.sessionId === id));
  const frame = t.link.sent.find((f) => f.t === "browser_frame")!;
  expect(frame).toMatchObject({ width: 1280, height: 800, control: "agent" });

  // A person takes over: the agent is refused, and their input lands on the screen.
  t.link.deliver({ t: "browser_control", sessionId: id, control: "human", by: "ada" });
  await expect(t.local.call("desktop", { action: "screenshot" }, "thread-1")).rejects.toThrow("A person has control");
  expect(reports.at(-1)).toMatchObject({ control: "human" });
  t.link.deliver({ t: "browser_control", sessionId: id, control: "agent", by: "ada" });
  expect(d.session("thread-1")!.control()).toBe("handing_back");
  await t.local.call("desktop", { action: "wait", duration: 1 }, "thread-1");
  expect(d.session("thread-1")!.control()).toBe("agent");
  expect(d.steps()[0]!.step).toMatchObject({ tool: "desktop", ok: true });
  const tools = d.session("thread-1")!.steps.map((s) => s.tool);
  expect(tools).toEqual(expect.arrayContaining(["session_start", "takeover", "handback", "agent_resumed", "desktop"]));

  const root = join(t.node.home, "desktop", "displays");
  expect(readdirSync(root).length).toBe(1);
  const ended = (await t.local.call("session_end", {}, "thread-1")) as Record<string, unknown>;
  // Recorded as a browser session is: its action log here (no ffmpeg in this test, so no video), then to the hub.
  expect(ended).toMatchObject({ op: "session_end", sessionId: id, kind: "linux_desktop", files: [{ file: "actions" }], note: NO_VIDEO });
  await until("its upload", () => reports.at(-1)?.state === "recorded");
  expect(reports.at(-1)).toMatchObject({ sessionId: id, kind: "linux_desktop", files: [{ file: "actions" }] });
  const log = parts.filter((p) => p.file === "actions").map((p) => Buffer.from(String(p.dataB64), "base64").toString()).join("");
  const logged = log.trim().split("\n").map((l) => JSON.parse(l) as { tool: string; args: Record<string, unknown> });
  expect(logged.map((l) => l.tool)).toEqual(expect.arrayContaining(["session_start", "desktop", "takeover", "handback", "session_end"]));
  expect(log).toContain("***DEPLOY_TOKEN***");
  expect(log).not.toContain("hunter2");
  await until("its folder to go", () => !existsSync(join(t.node.home, "desktop", "recordings", id)));
  // The display goes with everything on it: its folder, its X server's socket and lock.
  expect(readdirSync(root)).toEqual([]);
  expect(readdirSync(x11)).toEqual([]);
  expect(readdirSync(locks)).toEqual([]);
  await expect(t.local.call("desktop", { action: "screenshot" }, "thread-1")).rejects.toThrow("No desktop session is open");
  // A real Xvfb and the processes launched on it: a loaded machine (CI, or a busy devbox) takes longer than bun's 5 s
  // default.
}, 30_000);

test("a start on a machine that can't prepare says why at once, and the hub's session_end ends a desktop", async () => {
  if (process.platform !== "linux") return;
  const dir = scratch();
  const { docker } = fakes(dir, "fail");
  forgetRuntimeCheck();
  const t = testNode("devbox", { desktop: { backend: "container", runtime: docker, pool: 0 } });
  cleanups.push(t.done);
  t.link.answer = async (op) => (op === "session_route" ? { runner: "devbox", here: true } : {});
  startBrowser(t.node);
  startRoute(t.node);
  const d = startDesktop(t.node);
  cleanups.push(() => broker(t.node).shutdown());
  cleanups.push(() => d.shutdown());
  await expect(t.local.call("session_start", { kind: "linux_desktop", purpose: "x" }, "t")).rejects.toThrow(
    "This machine can't host desktop sessions: `docker info` failed: Cannot connect",
  );
  expect(existsSync(join(t.node.home, "desktop", "state.json"))).toBe(true);
  expect(await capabilities(t.node)).toEqual([]);
  await d.refreshCaps();
  expect(t.node.area("caps").list()).not.toContain(CAP_SESSION_DESKTOP);
  expect(await hostCheck(t.node.home, d.config)).toMatchObject({ ready: false, off: "missing" });
  // A desktop the hub says ends goes; any other id is left.
  expect(d.endScreen("t", "Bnope")).toBe(false);
  expect(new Desktops(t.node, { enabled: false }).count()).toBe(0);
});

test("no switch: an older node.json's desktop.enabled turns nothing off; only the agents' Mac and the hub's runner lend none", () => {
  const old = testNode("devbox", { desktop: { enabled: false, backend: "xvfb" } });
  cleanups.push(old.done);
  expect(desktopConfig(old.node)).toEqual({ backend: "xvfb" });
  expect(enabled(desktopConfig(old.node))).toBe(process.platform === "linux");
  for (const config of [{ agentsMac: true }, { runner: true }]) {
    const t = testNode("devbox", config);
    cleanups.push(t.done);
    expect(enabled(desktopConfig(t.node))).toBe(false);
  }
});

test("desktop recordings a stopped node left are ended and go to the hub; a live iOS simulator screen's are not the desktop's", async () => {
  const t = testNode("devbox");
  cleanups.push(t.done);
  const reports: Record<string, unknown>[] = [];
  t.link.answer = async (op, args) => {
    if (op === "browser_session") reports.push(args);
    if (op === "browser_recording_part") return { bytes: Number(args.offset) + Buffer.from(String(args.dataB64), "base64").length };
    return {};
  };
  const d = new Desktops(t.node, { enabled: false });
  const write = (dir: string, meta: Record<string, unknown>) => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "session.json"), JSON.stringify(meta));
    writeFileSync(join(dir, "actions.jsonl"), '{"seq":1,"tool":"session_start"}\n');
  };
  const base = { kind: "linux_desktop", threadId: "t1", cwd: "/", purpose: "look", startedAt: "2026-11-01T10:00:00.000Z", credentialsFilled: 0 };
  const ended = join(recordingsDir(t.node.home), `B${"1".repeat(32)}`);
  write(ended, { ...base, sessionId: `B${"1".repeat(32)}`, endedAt: "2026-11-01T10:05:00.000Z" });
  const cut = join(recordingsDir(t.node.home), `B${"2".repeat(32)}`);
  write(cut, { ...base, sessionId: `B${"2".repeat(32)}` });
  // An iOS simulator's screen on the agents' Mac records under device/ios/recordings while it is live (sim_screen.ts),
  // and SimScreens sends what a stopped node left there: the desktop's sweep never ends it, however long it is still.
  const sim = join(iosSimRecordingsDir(t.node.home), `B${"4".repeat(32)}`);
  write(sim, { ...base, kind: "ios", sessionId: `B${"4".repeat(32)}` });
  // A session still opening (its folder is new and it hasn't ended) is left alone; so is a live one.
  const opening = join(recordingsDir(t.node.home), `B${"3".repeat(32)}`);
  write(opening, { ...base, sessionId: `B${"3".repeat(32)}` });
  await d.sweep(Date.now() + 60_000);
  expect(existsSync(ended)).toBe(false);
  expect(existsSync(opening)).toBe(true);
  // Ten minutes on, those a node stopped during are ended with a note, and go too.
  await d.sweep(Date.now() + 10 * 60_000);
  expect(existsSync(cut)).toBe(false);
  expect(existsSync(sim)).toBe(true);
  expect(readFileSync(join(sim, "session.json"), "utf8")).not.toContain("endedAt");
  const recorded = reports.filter((r) => r.state === "recorded");
  expect(recorded.map((r) => r.sessionId).sort()).toEqual([`B${"1".repeat(32)}`, `B${"2".repeat(32)}`, `B${"3".repeat(32)}`]);
  expect(recorded.find((r) => r.sessionId === `B${"2".repeat(32)}`)).toMatchObject({ note: "the node stopped during this session; its video may end early", files: [{ file: "actions" }] });
});

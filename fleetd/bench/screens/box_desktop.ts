// A Linux desktop in a box, driven from outside it as fleetd's cloud drives one, measured on this machine: a real Xvfb
// (src/node/desktop/display.ts) stands for the box's display, and every connection between the box and its holder goes
// through a link shaped like the cloud's (LINK: 13 ms each way, ~11 MB/s, as measured between fleetd's computers and
// the service's hosts). Prints one JSON line per run: key → pixel at the holder, fps and bytes on the link while a
// terminal scrolls, and the CPU of each side.
//
//   bun bench/screens/box_desktop.ts --mode remote|box [--video <ffmpeg>]   (needs Xvfb and xterm on the PATH)
//
// - remote: the session reads the display over the link (X11 GetImage), as the cloud did before box-frames.
// - box: `fleetd box-frames` reads and encodes it next to the display (this repo's src/main.ts, its own process), and
//   only frames cross; the session's X11 connection carries input alone.
// Both record a JPEG video, as the cloud's recordings take it. With --video, the watcher decodes H.264 (x264 in the
// ffmpeg named: in the box with `box`, here with `remote`).
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { connect, createServer, type Socket } from "node:net";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Duplex } from "node:stream";
import { openPicture } from "../../src/node/desktop/picture_link.ts";
import { Display } from "../../src/node/desktop/display.ts";
import { onPath } from "../../src/node/desktop/paths.ts";
import type { Lent } from "../../src/node/desktop/screen.ts";
import { Session } from "../../src/node/desktop/session.ts";
import { X } from "../../src/node/desktop/x11.ts";
import { liveEncoder } from "../../src/node/screen/x264.ts";
import type { Recording } from "../../src/node/browser/recording.ts";
import type { BrowserInput } from "../../src/shared/contracts.ts";
import { CpuSpan, nextFrame, rate, round, type Seen, settle, spread } from "./meter.ts";

const LINK = { oneWayMs: 13, bytesPerMs: 11_000 };
const ACTIVE_MS = 5_000;

const arg = (name: string) => {
  const at = process.argv.indexOf(name);
  return at < 0 ? undefined : process.argv[at + 1];
};
const mode = arg("--mode");
if (mode !== "remote" && mode !== "box") throw new Error("--mode remote|box");
const ffmpeg = arg("--video");
const xvfb = onPath("Xvfb");
if (!xvfb || !onPath("xterm")) throw new Error("needs Xvfb and xterm");
const root = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "screens-box-"));

/** Bytes that crossed the link, box to holder. */
let linkBytes = 0;

/** One direction of the link: each chunk waits for the link to be free, takes its time on it, then the delay. */
function shape(from: Socket, to: Socket, count: boolean): void {
  let free = 0;
  from.on("data", (chunk: Buffer) => {
    const now = performance.now();
    const start = Math.max(now, free);
    free = start + chunk.length / LINK.bytesPerMs;
    if (count) linkBytes += chunk.length;
    setTimeout(() => to.destroyed || to.write(chunk), free + LINK.oneWayMs - now);
  });
  from.on("close", () => setTimeout(() => to.destroy(), Math.max(0, free - performance.now()) + LINK.oneWayMs));
}

/** A connection from the holder to `target` in the box, over the shaped link. */
async function dial(target: () => Socket): Promise<Duplex> {
  const path = join(root, `link-${Math.random().toString(36).slice(2)}`);
  const server = createServer((holder) => {
    const box = target();
    shape(holder, box, false);
    shape(box, holder, true);
    holder.on("error", () => box.destroy());
    box.on("error", () => holder.destroy());
  });
  await new Promise<void>((resolve) => server.listen(path, resolve));
  return await new Promise<Duplex>((resolve, reject) => {
    const s = connect(path);
    s.once("connect", () => resolve(s)).once("error", reject);
  });
}

const display = await Display.start({ backend: "xvfb", image: "", xvfb, root });
const pids: number[] = [Number(readFileSync(join(display.dir, "xvfb.pid"), "utf8").split(" ")[0])];
let boxPid: number | undefined;

// The video the cloud records: JPEG frames, counted.
let videoFrames = 0;
const recording: Recording = {
  append: () => {},
  video: { frame: () => void videoFrames++, tick: () => {}, finish: async () => undefined },
  filled: () => {},
  end: async () => ({ files: [] }),
};

let lent: Lent = display;
if (mode === "box") {
  const port = 20_000 + Math.floor(Math.random() * 30_000);
  const proc = Bun.spawn(["bun", join(import.meta.dir, "../../src/main.ts"), "box-frames", "--display", display.name, "--port", String(port), "--video", "jpeg"], {
    env: { ...process.env, FLEETD_FRAMES_COOKIE: Buffer.from(display.cookie).toString("hex"), ...(ffmpeg ? { FLEETD_FFMPEG: ffmpeg } : {}) },
    stdout: "inherit",
    stderr: "inherit",
  });
  boxPid = proc.pid;
  lent = {
    launch: (command, cwd) => display.launch(command, cwd),
    drop: () => display.drop(),
    picture: async (video, on) => {
      for (let i = 0; ; i++) {
        try {
          const s = await new Promise<Socket>((resolve, reject) => {
            const s = connect(port, "127.0.0.1");
            s.once("connect", () => resolve(s)).once("error", reject);
          });
          s.destroy();
          break;
        } catch (e) {
          if (i > 100) throw e;
          await Bun.sleep(50);
        }
      }
      void video;
      return openPicture(await dial(() => connect(port, "127.0.0.1")), display.cookie, on);
    },
  };
}
const x = await X.connect(() => dial(() => connect(display.socket)), display.cookie);
const session = new Session(lent, x, {
  id: "bench",
  thread: "t1",
  cwd: root,
  purpose: "bench",
  secrets: [],
  kind: "linux_desktop",
  recording,
  // Only `remote` encodes here: in the box, the box's does.
  ...(ffmpeg && mode === "remote" ? { encoder: liveEncoder(async () => ffmpeg) } : {}),
});
session.open();

const frames: Seen[] = [];
session.setWatcher({
  kbps: undefined,
  video: ffmpeg !== undefined,
  send: (f) => frames.push({ at: performance.now(), bytes: Math.floor(((f.jpegB64 ?? f.h264B64 ?? "").length * 3) / 4), wire: 0 }),
});
await nextFrame(frames, 10_000);
const term = await display.launch("xterm -geometry 100x30+0+0 -e cat", root);
pids.push(term.pid);
await settle(frames, 500, 5_000);

/** The box's processes: its Xvfb and apps, and box-frames with its encoder. */
const boxSide = () => [...pids, ...(boxPid ? [boxPid] : [])];
const scroller = await display.launch("xterm -geometry 100x20+0+420 -e sh -c 'while :; do date +%s.%N; done'", root);
pids.push(scroller.pid);
await Bun.sleep(500);
const span = new CpuSpan(boxSide);
const bytes0 = linkBytes;
const from = performance.now();
await Bun.sleep(ACTIVE_MS);
const active = { ...rate(frames, from, performance.now()), cpu: span.end(), linkPerSec: ((linkBytes - bytes0) * 1000) / ACTIVE_MS };
process.kill(-scroller.pid, "SIGTERM");
await settle(frames, 500, 5_000);

session.setControl("human", "bench");
const input = (i: BrowserInput) => session.queueInput(i);
const timed = async (go: () => void): Promise<number> => {
  await settle(frames, 250, 3_000);
  const at = performance.now();
  go();
  const f = await nextFrame(frames, 3_000);
  return f ? f.at - at : Number.NaN;
};
input({ kind: "mouse", action: "pressed", x: 200, y: 100, button: "left", clickCount: 1 });
input({ kind: "mouse", action: "released", x: 200, y: 100, button: "left", clickCount: 1 });
const typing: number[] = [];
for (const ch of "fleetd screens on the cloud") {
  typing.push(
    await timed(() => {
      input({ kind: "key", action: "down", key: ch, text: ch });
      input({ kind: "key", action: "up", key: ch });
    }),
  );
}
const clicks: number[] = [];
for (let i = 0; i < 6; i++) {
  clicks.push(
    await timed(() => {
      input({ kind: "mouse", action: "pressed", x: 30, y: 8, button: "left", clickCount: 2 });
      input({ kind: "mouse", action: "released", x: 30, y: 8, button: "left", clickCount: 2 });
    }),
  );
  input({ kind: "mouse", action: "pressed", x: 400, y: 300, button: "left", clickCount: 1 });
  input({ kind: "mouse", action: "released", x: 400, y: 300, button: "left", clickCount: 1 });
}
const shot0 = performance.now();
const shot = await session.act({ action: "screenshot" });
const shotMs = performance.now() - shot0;

console.log(
  JSON.stringify({
    kind: "linux_desktop_in_a_box",
    mode,
    codec: ffmpeg ? "h264" : "jpeg",
    link: LINK,
    inputToPixelAtHolder: { typing: spread(typing), click: spread(clicks) },
    scrolling: {
      fps: round(active.fps, 1),
      kbPerFrame: round(active.meanBytes / 1024, 1),
      linkKBPerSec: round(active.linkPerSec / 1024),
      cpu: { holder: round(active.cpu.node, 1), holderEncoder: round(active.cpu.encoder, 1), box: round(active.cpu.screen, 1) },
      holderCpuMsPerFrame: round((active.cpu.node * 10) / Math.max(active.fps, 0.1), 2),
      boxCpuMsPerFrame: round((active.cpu.screen * 10) / Math.max(active.fps, 0.1), 2),
    },
    videoFrames,
    screenshot: { ms: round(shotMs), size: [shot.width, shot.height] },
  }),
);
await session.close();
rmSync(root, { recursive: true, force: true });
process.exit(0);

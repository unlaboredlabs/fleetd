// A Linux desktop screen measured on this machine: the node's real display (an Xvfb of its own, src/node/desktop/
// display.ts), its real session and capture loop (session.ts, x11.ts), and each frame through the link and the hub as
// fleetd carries it (./wire.ts). Prints one JSON line: startup by phase, fps, bytes a second and CPU idle and while a
// terminal scrolls, a person's takeover, and input-to-pixel for typing, clicks and drags.
//
//   bun bench/screens/desktop.ts            (needs Xvfb and xterm on the PATH)
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Display } from "../../src/node/desktop/display.ts";
import { onPath } from "../../src/node/desktop/paths.ts";
import { Session } from "../../src/node/desktop/session.ts";
import type { BrowserFrame, BrowserInput } from "../../src/shared/contracts.ts";
import { CpuSpan, nextFrame, rate, round, type Seen, settle, spread } from "./meter.ts";
import { Wire } from "./wire.ts";

const xvfb = onPath("Xvfb");
if (!xvfb || !onPath("xterm")) throw new Error("needs Xvfb and xterm");
const root = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "screens-desktop-"));
const IDLE_MS = 5_000;
const ACTIVE_MS = 5_000;

const t0 = performance.now();
const display = await Display.start({ backend: "xvfb", image: "", xvfb, root });
const tDisplay = performance.now();
const x = await display.connect();
const tX = performance.now();
const xvfbPid = Number(readFileSync(join(display.dir, "xvfb.pid"), "utf8").split(" ")[0]);
const pids = [xvfbPid];
const session = new Session(display, x, { id: "bench", thread: "t1", cwd: root, purpose: "bench", secrets: [], kind: "linux_desktop" });
session.open();

const frames: Seen[] = [];
const wire = new Wire();
let shown: BrowserFrame | undefined;
let carrying = Promise.resolve();
session.setWatcher({
  kbps: undefined,
  send: (f) => {
    // In order, as the links carry them; each counted where the app has it.
    carrying = carrying.then(async () => {
      const { frame, hops } = await wire.carry(f);
      shown = frame;
      frames.push({ at: performance.now(), bytes: Math.floor((frame.jpegB64.length * 3) / 4), wire: hops.appBytes });
    });
  },
});
const tWatch = performance.now();
await nextFrame(frames, 5_000);
const tFirst = performance.now();

// A terminal in the corner: `cat` echoes what's typed.
const term = await display.launch("xterm -geometry 100x30+0+0 -e cat", root);
pids.push(term.pid);
await settle(frames, 500, 5_000);
const tTerm = frames.at(-1)?.at ?? Number.NaN;

// Idle: nothing changes on the screen.
await settle(frames, 300, 3_000);
let span = new CpuSpan(() => pids);
let from = performance.now();
await Bun.sleep(IDLE_MS);
const idle = { ...rate(frames, from, performance.now()), cpu: span.end() };

// Active: a second terminal scrolls as fast as it can.
const scroller = await display.launch("xterm -geometry 100x20+0+420 -e sh -c 'while :; do date +%s.%N; done'", root);
pids.push(scroller.pid);
await Bun.sleep(500);
span = new CpuSpan(() => pids);
from = performance.now();
await Bun.sleep(ACTIVE_MS);
const active = { ...rate(frames, from, performance.now()), cpu: span.end() };
process.kill(-scroller.pid, "SIGTERM");
await settle(frames, 500, 5_000);

// Takeover: the node's side of it (the hub's is a message on the link).
const tk0 = performance.now();
session.setControl("human", "bench");
await nextFrame(frames, 1_000);
const takeoverMs = performance.now() - tk0;

const input = (i: BrowserInput) => session.queueInput(i);
const timed = async (go: () => void): Promise<number> => {
  await settle(frames, 250, 3_000);
  const at = performance.now();
  go();
  const f = await nextFrame(frames, 2_000);
  return f ? f.at - at : Number.NaN;
};
// Focus the terminal, then type: each key is a frame when its echo lands.
input({ kind: "mouse", action: "pressed", x: 200, y: 100, button: "left", clickCount: 1 });
input({ kind: "mouse", action: "released", x: 200, y: 100, button: "left", clickCount: 1 });
const typing: number[] = [];
for (const ch of "fleetd screens") {
  typing.push(
    await timed(() => {
      input({ kind: "key", action: "down", key: ch, text: ch });
      input({ kind: "key", action: "up", key: ch });
    }),
  );
}
// A click that selects a word (a double click), and a drag that selects a line: xterm highlights each.
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
const drags: number[] = [];
for (let i = 0; i < 6; i++) {
  input({ kind: "mouse", action: "pressed", x: 5, y: 8, button: "left", clickCount: 1 });
  drags.push(await timed(() => input({ kind: "mouse", action: "moved", x: 60 + i * 30, y: 8, button: "left" })));
  input({ kind: "mouse", action: "released", x: 60 + i * 30, y: 8, button: "left", clickCount: 1 });
  // Past xterm's multi-click time, or the next press selects by word or line.
  await Bun.sleep(600);
}

const hb0 = performance.now();
session.setControl("handing_back", "bench");
await nextFrame(frames, 1_000);
const handbackMs = performance.now() - hb0;

await carrying;
const hops = wire.totals;
const per = (n: number) => round(n / Math.max(wire.frames, 1), 2);
console.log(
  JSON.stringify({
    kind: "linux_desktop",
    size: shown ? [shown.width, shown.height] : null,
    startup: {
      displayMs: round(tDisplay - t0),
      connectMs: round(tX - tDisplay),
      firstFrameMs: round(tFirst - tWatch),
      totalMs: round(tFirst - t0),
      terminalShownMs: round(tTerm - tFirst),
    },
    idle: { fps: round(idle.fps, 1), bytesPerSec: round(idle.wirePerSec), cpu: { node: round(idle.cpu.node, 1), screen: round(idle.cpu.screen, 1) } },
    active: {
      fps: round(active.fps, 1),
      kbPerFrame: round(active.meanBytes / 1024, 1),
      bytesPerSec: round(active.wirePerSec),
      cpu: { node: round(active.cpu.node, 1), screen: round(active.cpu.screen, 1) },
    },
    takeover: { nodeMs: round(takeoverMs, 1), handbackNodeMs: round(handbackMs, 1) },
    inputToPixel: { typing: spread(typing), click: spread(clicks), drag: spread(drags) },
    hopsPerFrameMs: { node: per(hops.nodeMs), hub: per(hops.hubMs), app: per(hops.appMs) },
  }),
);
wire.close();
await session.close();
rmSync(root, { recursive: true, force: true });
process.exit(0);

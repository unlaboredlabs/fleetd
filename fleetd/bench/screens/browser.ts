// A browser screen measured on this machine: the node's real broker and a real headless Chrome (src/node/browser),
// started as an agent's session_start starts one, watched through the node's link as the hub watches it, each frame
// carried through the link and the hub as fleetd carries it (./wire.ts). Prints one JSON line: startup by phase, fps,
// bytes a second and CPU idle and while the page animates, a person's takeover, and input-to-pixel for typing,
// clicks and drags.
//
//   bun bench/screens/browser.ts [--video <ffmpeg>]   (needs Playwright's Chrome: ~/.cache/ms-playwright)
//
// With --video, the watcher decodes H.264: the screencast goes through x264 in the ffmpeg named (the node's pinned one).
import { homedir } from "node:os";
import { join } from "node:path";
import { findChrome, launch } from "../../src/node/browser/chrome.ts";
import { Broker, start } from "../../src/node/browser/index.ts";
import { liveEncoder } from "../../src/node/screen/x264.ts";
import type { BrowserFrame, BrowserInput } from "../../src/shared/contracts.ts";
import { tempHome } from "../../test/helpers.ts";
import { testNode } from "../../test/node_helpers.ts";
import { CpuSpan, nextFrame, rate, round, type Seen, settle, spread } from "./meter.ts";
import { Wire } from "./wire.ts";

const chrome = findChrome(join(homedir(), ".cache", "ms-playwright"));
if (!chrome) throw new Error("no Chrome under ~/.cache/ms-playwright");
const at = process.argv.indexOf("--video");
const ffmpeg = at < 0 ? undefined : process.argv[at + 1];
const IDLE_MS = 5_000;
const ACTIVE_MS = 5_000;

// The page: a box that a click, a key or a drag repaints at once, and a spinner the bench turns on.
const PAGE = `data:text/html,${encodeURIComponent(`<!doctype html><body style="margin:0;font:40px sans-serif">
<div id=b style="width:100vw;height:50vh;background:#246"></div><canvas id=c width=1280 height=380></canvas>
<script>let n=0,spin=false;const b=document.getElementById('b'),c=document.getElementById('c').getContext('2d');
const hit=()=>{n++;b.style.background='hsl('+(n*47%360)+',60%,40%)';b.textContent=n};
addEventListener('mousedown',hit);addEventListener('keydown',hit);addEventListener('mousemove',e=>{if(e.buttons)hit()});
const frame=t=>{if(spin){c.fillStyle='#fff';c.fillRect(0,0,1280,380);c.fillStyle='#c33';for(let i=0;i<40;i++)c.fillRect((t/3+i*37)%1280,(i*53+t/5)%380,60,60)}requestAnimationFrame(frame)};
requestAnimationFrame(frame);window.setSpin=v=>{spin=v}</script>`)}`;

const node = testNode();
// The broker's encoder: the ffmpeg named, else none (JPEG).
const fromHost = ffmpeg === undefined ? undefined : liveEncoder(async () => ffmpeg);
const profiles = tempHome();
const pids: number[] = [];
const broker = start(
  node.node,
  new Broker(node.node, async () => {
    const b = await launch(chrome, join(profiles.dir, "profiles"), true);
    const pid = (b as unknown as { child?: { pid?: number } }).child?.pid;
    if (pid) pids.push(pid);
    return b;
  }),
);
// Its encoder's ffmpeg is the one named, not one fetched into the throwaway home.
(broker as unknown as { host: { encoder?: unknown } }).host.encoder = fromHost;
// The node's reports to the hub: a takeover is live once the node says who drives now.
const reports: { at: number; control: unknown }[] = [];
node.link.answer = async (op, args) => {
  if (op === "browser_session") reports.push({ at: performance.now(), control: args.control });
  return {};
};
const reported = async (control: string, ms: number) => {
  const until = performance.now() + ms;
  while (performance.now() < until) {
    const r = reports.find((x) => x.control === control);
    if (r) return r.at;
    await Bun.sleep(1);
  }
  return Number.NaN;
};

const frames: Seen[] = [];
const wire = new Wire();
let shown: BrowserFrame | undefined;
let carrying = Promise.resolve();
const sent = node.link.sent;
sent.push = (...items: Record<string, unknown>[]) => {
  for (const f of items) {
    if (f.t !== "browser_frame") continue;
    const { t: _, ...frame } = f;
    carrying = carrying.then(async () => {
      const { frame: atApp, hops } = await wire.carry(frame as unknown as BrowserFrame);
      shown = atApp;
      frames.push({ at: performance.now(), bytes: Math.floor(((atApp.jpegB64 ?? atApp.h264B64 ?? "").length * 3) / 4), wire: hops.appBytes });
    });
  }
  return 0;
};

const t0 = performance.now();
const started = (await node.local.call("session_start", { purpose: "screens bench" }, "t1")) as { sessionId: string; cdp: string };
const tStarted = performance.now();
const id = started.sessionId;
// H.264 goes to a browser's watchers once their link is the bound: a budget, as the hub names one for a slow link.
node.link.deliver({ t: "browser_watch", sessionId: id, on: true, ...(ffmpeg ? { video: true, kbps: 3000 } : {}) });
await nextFrame(frames, 10_000);
const tFirst = performance.now();

// The agent's driver, as agent-browser is: CDP through the node's proxy.
const ws = new WebSocket(started.cdp);
const answers = new Map<number, (m: unknown) => void>();
ws.onmessage = (e) => {
  const m = JSON.parse(String(e.data)) as { id?: number };
  if (m.id !== undefined) answers.get(m.id)?.(m);
};
await new Promise((r) => (ws.onopen = r));
let next = 1;
const cdp = (method: string, params: Record<string, unknown> = {}, sessionId?: string) =>
  new Promise<{ result?: Record<string, unknown> }>((resolve) => {
    const n = next++;
    answers.set(n, resolve as never);
    ws.send(JSON.stringify({ id: n, method, params, ...(sessionId ? { sessionId } : {}) }));
  });
const targets = await cdp("Target.getTargets");
const page = (targets.result!.targetInfos as { targetId: string; type: string }[]).find((t) => t.type === "page")!;
const s = (await cdp("Target.attachToTarget", { targetId: page.targetId, flatten: true })).result!.sessionId as string;
const tNav = performance.now();
await cdp("Page.navigate", { url: PAGE }, s);
await settle(frames, 500, 5_000);
const tPage = frames.at(-1)?.at ?? Number.NaN;

let span = new CpuSpan(() => pids);
let from = performance.now();
await Bun.sleep(IDLE_MS);
const idle = { ...rate(frames, from, performance.now()), cpu: span.end() };

await cdp("Runtime.evaluate", { expression: "setSpin(true)" }, s);
await Bun.sleep(300);
span = new CpuSpan(() => pids);
from = performance.now();
await Bun.sleep(ACTIVE_MS);
const active = { ...rate(frames, from, performance.now()), cpu: span.end() };
await cdp("Runtime.evaluate", { expression: "setSpin(false)" }, s);
await settle(frames, 500, 5_000);

const tk0 = performance.now();
reports.length = 0;
node.link.deliver({ t: "browser_control", sessionId: id, control: "human", by: "bench" });
const takeoverMs = (await reported("human", 2_000)) - tk0;

const input = (i: BrowserInput) => node.link.deliver({ t: "browser_input", sessionId: id, input: i as never });
const timed = async (go: () => void): Promise<number> => {
  await settle(frames, 250, 3_000);
  const at = performance.now();
  go();
  const f = await nextFrame(frames, 2_000);
  return f ? f.at - at : Number.NaN;
};
const typing: number[] = [];
for (const ch of "fleetd screens") typing.push(await timed(() => input({ kind: "key", action: "down", key: ch, code: `Key${ch.toUpperCase()}`, text: ch, modifiers: 0 })));
const clicks: number[] = [];
for (let i = 0; i < 8; i++) {
  clicks.push(await timed(() => input({ kind: "mouse", action: "pressed", x: 300, y: 100, button: "left", clickCount: 1, modifiers: 0 })));
  input({ kind: "mouse", action: "released", x: 300, y: 100, button: "left", clickCount: 1, modifiers: 0 });
}
const drags: number[] = [];
input({ kind: "mouse", action: "pressed", x: 100, y: 100, button: "left", clickCount: 1, modifiers: 0 });
for (let i = 0; i < 8; i++) drags.push(await timed(() => input({ kind: "mouse", action: "moved", x: 120 + i * 20, y: 100, button: "left", modifiers: 0 })));
input({ kind: "mouse", action: "released", x: 300, y: 100, button: "left", clickCount: 1, modifiers: 0 });

// Take over → the first tap's pixels: handed back, then taken over and tapped at once (a press repaints the box).
const firstTap: number[] = [];
// The first frame after `at` that isn't the same picture again (a change of who drives sends the last one anew).
const changed = async (at: number): Promise<number> => {
  const before = frames.at(-1)?.bytes;
  const from = frames.length;
  while (performance.now() - at < 2_000) {
    const f = frames.slice(from).find((x) => x.bytes !== before);
    if (f) return f.at - at;
    await Bun.sleep(1);
  }
  return Number.NaN;
};
for (let i = 0; i < 5; i++) {
  node.link.deliver({ t: "browser_control", sessionId: id, control: "agent", by: "bench" });
  await Bun.sleep(400);
  await settle(frames, 250, 3_000);
  const at = performance.now();
  node.link.deliver({ t: "browser_control", sessionId: id, control: "human", by: "bench" });
  input({ kind: "mouse", action: "pressed", x: 300, y: 100, button: "left", clickCount: 1, modifiers: 0 });
  firstTap.push(await changed(at));
  input({ kind: "mouse", action: "released", x: 300, y: 100, button: "left", clickCount: 1, modifiers: 0 });
}
node.link.deliver({ t: "browser_control", sessionId: id, control: "human", by: "bench" });
await Bun.sleep(200);

const hb0 = performance.now();
reports.length = 0;
node.link.deliver({ t: "browser_control", sessionId: id, control: "agent", by: "bench" });
const handbackMs = (await reported("handing_back", 2_000)) - hb0;

await carrying;
const per = (n: number) => round(n / Math.max(wire.frames, 1), 2);
console.log(
  JSON.stringify({
    kind: "browser",
    codec: ffmpeg ? "h264" : "jpeg",
    size: shown ? [shown.width, shown.height] : null,
    startup: { sessionStartMs: round(tStarted - t0), firstFrameMs: round(tFirst - tStarted), totalMs: round(tFirst - t0), pageShownMs: round(tPage - tNav) },
    idle: { fps: round(idle.fps, 1), bytesPerSec: round(idle.wirePerSec), cpu: { node: round(idle.cpu.node, 1), screen: round(idle.cpu.screen, 1) } },
    active: {
      fps: round(active.fps, 1),
      kbPerFrame: round(active.meanBytes / 1024, 1),
      bytesPerSec: round(active.wirePerSec),
      cpu: { node: round(active.cpu.node, 1), screen: round(active.cpu.screen, 1) },
    },
    takeover: { nodeMs: round(takeoverMs, 1), handbackNodeMs: round(handbackMs, 1), firstTap: spread(firstTap) },
    inputToPixel: { typing: spread(typing), click: spread(clicks), drag: spread(drags) },
    hopsPerFrameMs: { node: per(wire.totals.nodeMs), hub: per(wire.totals.hubMs), app: per(wire.totals.appMs) },
  }),
);
ws.close();
wire.close();
await node.local.call("session_end", {}, "t1");
await broker.shutdown();
node.done();
profiles.done();
process.exit(0);

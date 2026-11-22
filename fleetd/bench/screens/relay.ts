// screen-relay's engine (github.com/vercel-labs/screen-relay, its relay-engine binary) on the same display and workload
// as ./desktop.ts, for a side by side: an Xvfb of the node's own, the engine attached to it, a view-only /stream
// whose every frame is ACKed at once (as its viewer does after drawing), and typing through the node's own X input.
// Prints one JSON line: fps, bytes a second and the engine's CPU idle and while a terminal scrolls, and input-to-pixel.
//
//   bun bench/screens/relay.ts <relay-engine> <viewer-dir> [--fps N] [--bitrate BPS]   (needs Xvfb and xterm)
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Display } from "../../src/node/desktop/display.ts";
import { onPath } from "../../src/node/desktop/paths.ts";
import { personInput } from "../../src/node/desktop/session.ts";
import { CpuSpan, nextFrame, rate, round, type Seen, settle, spread } from "./meter.ts";

const [engine, viewer] = process.argv.slice(2);
if (!engine || !viewer) throw new Error("usage: bun bench/screens/relay.ts <relay-engine> <viewer-dir> [--fps N] [--bitrate BPS]");
const arg = (name: string, d: string) => (process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1]! : d);
const fps = arg("--fps", "30");
const bitrate = arg("--bitrate", "2500000");
const xvfb = onPath("Xvfb");
if (!xvfb || !onPath("xterm")) throw new Error("needs Xvfb and xterm");
const root = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "screens-relay-"));
const display = await Display.start({ backend: "xvfb", image: "", xvfb, root });
const x = await display.connect();
const pids = [Number(readFileSync(join(display.dir, "xvfb.pid"), "utf8").split(" ")[0])];
const port = 18_000 + Math.floor(Math.random() * 2_000);
const proc = Bun.spawn([engine, "--viewer-dir", viewer, "--port", String(port), "--fps", fps, "--bitrate-min", "250000", "--bitrate-start", bitrate, "--bitrate-max", bitrate], {
  env: { ...process.env, DISPLAY: display.name, XAUTHORITY: join(display.dir, "xauth") },
  stdout: "ignore",
  stderr: "pipe",
});
const said = new Response(proc.stderr).text();
// Whatever happens, the engine and the display go.
const cleanup = () => {
  proc.kill();
  void display.drop();
};
process.on("exit", cleanup);
for (let i = 0; i < 100; i++) {
  if (await fetch(`http://127.0.0.1:${port}/capabilities`).then((r) => r.ok, () => false)) break;
  await Bun.sleep(50);
}

const frames: Seen[] = [];
let keyframes = 0;
const ws = new WebSocket(`ws://127.0.0.1:${port}/stream?view=1`);
ws.binaryType = "arraybuffer";
ws.onmessage = (e) => {
  const m = new DataView(e.data as ArrayBuffer);
  if (m.getUint8(5) !== 1) return;
  const bytes = m.getUint32(16);
  frames.push({ at: performance.now(), bytes, wire: bytes + 20 });
  if (m.getUint16(6) & 1) keyframes++;
  // The ACK: type 2, the frame's generation and sequence, no wait in the viewer.
  const ack = new Uint8Array(20);
  ack.set([0x4e, 0x53, 0x4c, 0x31, 1, 2]);
  const v = new DataView(ack.buffer);
  v.setUint32(8, m.getUint32(8));
  v.setUint32(12, m.getUint32(12));
  ws.send(ack);
};
await new Promise((r, j) => ((ws.onopen = r), (ws.onerror = () => (cleanup(), void said.then((t) => j(new Error(`no stream: ${t}`)))))));
await nextFrame(frames, 5_000);

const term = await display.launch("xterm -geometry 100x30+0+0 -e cat", root);
pids.push(term.pid);
await settle(frames, 500, 5_000);
await settle(frames, 300, 3_000);
// The engine is the node's part here: its CPU is counted apart from the screen's (Xvfb and the terminals).
let span = new CpuSpan(() => pids);
let engineAt = cpu(proc.pid);
let from = performance.now();
await Bun.sleep(5_000);
const idle = { ...rate(frames, from, performance.now()), cpu: span.end(), engine: ((cpu(proc.pid) - engineAt) / 5_000) * 100 };

const scroller = await display.launch("xterm -geometry 100x20+0+420 -e sh -c 'while :; do date +%s.%N; done'", root);
pids.push(scroller.pid);
await Bun.sleep(500);
span = new CpuSpan(() => pids);
engineAt = cpu(proc.pid);
from = performance.now();
await Bun.sleep(5_000);
const secs = (performance.now() - from) / 1000;
const active = { ...rate(frames, from, performance.now()), cpu: span.end(), engine: ((cpu(proc.pid) - engineAt) / (secs * 1000)) * 100 };
process.kill(-scroller.pid, "SIGTERM");
await settle(frames, 500, 5_000);

// Typing into the first terminal, as ./desktop.ts types: each key is a frame when its echo lands.
await personInput(x, { kind: "mouse", action: "pressed", x: 200, y: 100, button: "left", clickCount: 1 });
await personInput(x, { kind: "mouse", action: "released", x: 200, y: 100, button: "left", clickCount: 1 });
const typing: number[] = [];
for (const ch of "fleetd screens") {
  await settle(frames, 250, 3_000);
  const at = performance.now();
  void personInput(x, { kind: "key", action: "down", key: ch, text: ch }).then(() => personInput(x, { kind: "key", action: "up", key: ch }));
  const f = await nextFrame(frames, 2_000);
  typing.push(f ? f.at - at : Number.NaN);
}

ws.close();
proc.kill();
await proc.exited;
// What it says as it ends: each stage's time over the whole run (wall time in its capture thread), per frame encoded.
const stats = Object.fromEntries([...(await said).matchAll(/(\w+)=(\d+)/g)].map((m) => [m[1]!, Number(m[2])]));
const perFrame = (k: string) => round((stats[k] ?? Number.NaN) / 1e6 / Math.max(stats.encoded ?? 0, 1), 2);
console.log(
  JSON.stringify({
    kind: "relay-engine",
    fps: Number(fps),
    idle: { fps: round(idle.fps, 1), bytesPerSec: round(idle.wirePerSec), engine: round(idle.engine, 1) },
    active: {
      fps: round(active.fps, 1),
      kbPerFrame: round(active.meanBytes / 1024, 1),
      bytesPerSec: round(active.wirePerSec),
      engine: round(active.engine, 1),
      screen: round(active.cpu.screen, 1),
      cpuMsPerFrame: round((active.engine * 10) / Math.max(active.fps, 0.1), 2),
    },
    keyframes,
    stageMsPerFrame: { capture: perFrame("capture_ns"), convert: perFrame("convert_ns"), encode: perFrame("encode_ns"), encoded: stats.encoded ?? null, captures: stats.captures ?? null },
    inputToPixel: { typing: spread(typing) },
  }),
);
x.close();
await display.drop();
rmSync(root, { recursive: true, force: true });
process.exit(0);

/** A process's CPU in ms, its threads included (utime + stime). */
function cpu(pid: number): number {
  const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
  const f = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
  return ((Number(f[11]) + Number(f[12])) * 1000) / 100;
}
